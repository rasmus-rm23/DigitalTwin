//! ML process models: definition (inputs, outputs, per-pair delay and Gaussian smoothing,
//! algorithm, training batches), training-data assembly for the Python sidecar, and results.
//!
//! Training itself runs in the sidecar (`train` method, `sidecar/.../training.py`). The core
//! assembles the request here, calls the sidecar without holding the project lock, and stores
//! the response with `store_training`.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use super::import::convert::ColumnKind;
use super::plots::{self, PlotSource};
use super::tables;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AlgorithmKind {
    #[default]
    Linear,
    NeuralNetwork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Activation {
    #[default]
    Relu,
    Tanh,
    Logistic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Algorithm {
    #[serde(default)]
    pub kind: AlgorithmKind,
    /// Neurons per hidden layer (neural network only).
    #[serde(default = "default_layers")]
    pub hidden_layers: Vec<u32>,
    #[serde(default)]
    pub activation: Activation,
    /// L2 regularisation strength (neural network only).
    #[serde(default = "default_alpha")]
    pub alpha: f64,
    #[serde(default = "default_max_iter")]
    pub max_iter: u32,
}

fn default_layers() -> Vec<u32> {
    vec![16]
}
fn default_alpha() -> f64 {
    1e-4
}
fn default_max_iter() -> u32 {
    500
}
fn default_test_fraction() -> f64 {
    0.2
}

impl Default for Algorithm {
    fn default() -> Self {
        Self {
            kind: AlgorithmKind::default(),
            hidden_layers: default_layers(),
            activation: Activation::default(),
            alpha: default_alpha(),
            max_iter: default_max_iter(),
        }
    }
}

/// Delay and Gaussian smoothing of one input for one output, in minutes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dynamics {
    pub input: i64,
    pub output: i64,
    pub delay_min: f64,
    pub sigma_min: f64,
    /// False when the input cannot affect the output (e.g. it is downstream of it in the
    /// process); the input is then not used for that output.
    #[serde(default = "connected")]
    pub enabled: bool,
}

fn connected() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    #[serde(default)]
    pub source: Option<PlotSource>,
    #[serde(default)]
    pub inputs: Vec<i64>,
    #[serde(default)]
    pub outputs: Vec<i64>,
    #[serde(default)]
    pub dynamics: Vec<Dynamics>,
    #[serde(default)]
    pub algorithm: Algorithm,
    /// Batch keys used for training (and testing on the end of each batch).
    #[serde(default)]
    pub batches: Vec<String>,
    /// Share of each batch's duration, at its end, held out for testing.
    #[serde(default = "default_test_fraction")]
    pub test_fraction: f64,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            source: None,
            inputs: Vec::new(),
            outputs: Vec::new(),
            dynamics: Vec::new(),
            algorithm: Algorithm::default(),
            batches: Vec::new(),
            test_fraction: default_test_fraction(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelStatus {
    Draft,
    Trained,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub id: i64,
    pub name: String,
    pub status: ModelStatus,
    pub trained_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: i64,
    pub name: String,
    pub config: ModelConfig,
    pub status: ModelStatus,
    /// Metrics, coefficients and measured-vs-predicted series from the last training.
    pub result: Option<Json>,
    pub error: Option<String>,
    pub trained_at: Option<String>,
    /// The definition changed since the stored result was trained.
    pub stale: bool,
}

fn parse_status(s: &str) -> ModelStatus {
    match s {
        "trained" => ModelStatus::Trained,
        "failed" => ModelStatus::Failed,
        _ => ModelStatus::Draft,
    }
}

pub fn list(conn: &Connection) -> AppResult<Vec<ModelSummary>> {
    let mut stmt = conn.prepare("SELECT id, name, status, trained_at FROM model ORDER BY name COLLATE NOCASE")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ModelSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                status: parse_status(&r.get::<_, String>(2)?),
                trained_at: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Model> {
    type Row = (String, String, String, Option<String>, Option<String>, Option<String>, Option<String>);
    let row: Option<Row> = conn
        .query_row(
            "SELECT name, config, status, trained_config, result, error, trained_at FROM model WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let (name, config, status, trained_config, result, error, trained_at) =
        row.ok_or_else(|| AppError::InvalidInput(format!("no model with id {id}")))?;
    let mut config: ModelConfig = serde_json::from_str(&config).unwrap_or_default();
    sanitize(conn, &mut config)?;
    let trained: Option<ModelConfig> = trained_config.and_then(|c| serde_json::from_str(&c).ok());
    Ok(Model {
        id,
        name,
        stale: trained.as_ref().is_some_and(|t| t != &config),
        config,
        status: parse_status(&status),
        result: result.and_then(|r| serde_json::from_str(&r).ok()),
        error,
        trained_at,
    })
}

/// A new model, preset to the plot sheet's data source if one is set.
pub fn create(conn: &Connection, name: &str) -> AppResult<Model> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("model name is empty".into()));
    }
    let config = ModelConfig { source: plots::get_or_create_main(conn)?.config.source, ..Default::default() };
    conn.execute(
        "INSERT INTO model (name, config, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![name, serde_json::to_string(&config)?],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// Saves name and definition. Drafts may be incomplete; `training_request` checks completeness.
pub fn save(conn: &Connection, id: i64, name: &str, config: &ModelConfig) -> AppResult<Model> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput("model name is empty".into()));
    }
    validate_shape(conn, config)?;
    let n = conn.execute(
        "UPDATE model SET name = ?1, config = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?3",
        params![name.trim(), serde_json::to_string(config)?, id],
    )?;
    if n == 0 {
        return Err(AppError::InvalidInput(format!("no model with id {id}")));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    if conn.execute("DELETE FROM model WHERE id = ?1", [id])? == 0 {
        return Err(AppError::InvalidInput(format!("no model with id {id}")));
    }
    Ok(())
}

/// Checks that values are in range and refer to existing columns (incomplete drafts are fine).
fn validate_shape(conn: &Connection, c: &ModelConfig) -> AppResult<()> {
    let invalid = |m: String| Err(AppError::InvalidInput(m));
    if !(0.0..=0.9).contains(&c.test_fraction) {
        return invalid("test share must be between 0 and 90 %".into());
    }
    let a = &c.algorithm;
    if a.hidden_layers.is_empty() || a.hidden_layers.len() > 5 || a.hidden_layers.iter().any(|&n| n == 0 || n > 1024)
    {
        return invalid("hidden layers: 1-5 layers of 1-1024 neurons".into());
    }
    if !(a.alpha >= 0.0 && a.alpha.is_finite()) || a.max_iter == 0 || a.max_iter > 100_000 {
        return invalid("neural network: alpha >= 0 and 1-100000 iterations".into());
    }
    if c.dynamics.iter().any(|d| !(d.delay_min >= 0.0 && d.sigma_min >= 0.0 && d.delay_min.is_finite() && d.sigma_min.is_finite())) {
        return invalid("delays and smoothing must be 0 or positive".into());
    }
    if c.inputs.iter().any(|i| c.outputs.contains(i)) {
        return invalid("a column cannot be both input and output".into());
    }
    let Some(src) = c.source else { return Ok(()) };
    let table = tables::get(conn, src.table_id)?;
    let n = table.columns.len() as i64;
    if c.inputs.iter().chain(&c.outputs).any(|&col| col < 0 || col >= n) {
        return invalid("column out of range".into());
    }
    Ok(())
}

/// Drops references to a deleted table or missing columns.
fn sanitize(conn: &Connection, c: &mut ModelConfig) -> AppResult<()> {
    let Some(src) = c.source else { return Ok(()) };
    match tables::get(conn, src.table_id) {
        Ok(t) => {
            let n = t.columns.len() as i64;
            c.inputs.retain(|&i| i < n);
            c.outputs.retain(|&o| o < n);
        }
        Err(AppError::InvalidInput(_)) => {
            c.source = None;
            c.inputs.clear();
            c.outputs.clear();
            c.dynamics.clear();
            c.batches.clear();
        }
        Err(e) => return Err(e),
    }
    Ok(())
}

/// Validates a definition for training and assembles the sidecar `train` request
/// (all selected batches with their input and output columns).
pub fn training_request(conn: &Connection, id: i64) -> AppResult<(ModelConfig, Json)> {
    let model = get(conn, id)?;
    let c = model.config;
    let invalid = |m: &str| Err(AppError::InvalidInput(m.to_owned()));
    let Some(src) = c.source else { return invalid("choose a data table first") };
    if c.inputs.is_empty() {
        return invalid("select at least one input column");
    }
    if c.outputs.is_empty() {
        return invalid("select at least one output column");
    }
    if c.batches.is_empty() {
        return invalid("select at least one batch for training");
    }
    validate_shape(conn, &c)?;

    let table = tables::get(conn, src.table_id)?;
    for &col in c.inputs.iter().chain(&c.outputs) {
        let column = &table.columns[col as usize];
        if column.kind != ColumnKind::Number {
            return Err(AppError::InvalidInput(format!("\"{}\" is not a numeric column", column.name)));
        }
    }
    let pairs: HashMap<(i64, i64), &Dynamics> = c.dynamics.iter().map(|d| ((d.input, d.output), d)).collect();
    let mut dynamics = Vec::new();
    for &o in &c.outputs {
        for &i in &c.inputs {
            let d = pairs.get(&(i, o)).ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "set delay and smoothing for {} → {}",
                    table.columns[i as usize].name, table.columns[o as usize].name
                ))
            })?;
            dynamics.push(**d);
        }
        if !c.inputs.iter().any(|&i| pairs.get(&(i, o)).is_some_and(|d| d.enabled)) {
            return Err(AppError::InvalidInput(format!(
                "no input is connected to {}; connect at least one in the delay and smoothing table",
                table.columns[o as usize].name
            )));
        }
    }

    let available: HashSet<String> = plots::batches(conn, &src)?.into_iter().map(|b| b.key).collect();
    let columns: Vec<i64> = c.inputs.iter().chain(&c.outputs).copied().collect();
    let mut batches = Vec::new();
    for key in &c.batches {
        if !available.contains(key) {
            return Err(AppError::InvalidInput(format!("batch \"{key}\" no longer exists")));
        }
        let s = plots::batch_series(conn, &src, key, &columns)?;
        let cols: serde_json::Map<String, Json> =
            columns.iter().zip(s.values).map(|(c, v)| (c.to_string(), json!(v))).collect();
        batches.push(json!({ "key": key, "hours": s.hours, "columns": cols }));
    }
    let names: serde_json::Map<String, Json> =
        columns.iter().map(|&c| (c.to_string(), json!(table.columns[c as usize].name))).collect();

    let request = json!({
        "batches": batches,
        "inputs": c.inputs,
        "outputs": c.outputs,
        "names": names,
        "dynamics": dynamics,
        "algorithm": c.algorithm,
        "testFraction": c.test_fraction,
    });
    Ok((c, request))
}

/// Stores the outcome of a training run for the definition it was trained with.
pub fn store_training(conn: &Connection, id: i64, trained: &ModelConfig, outcome: AppResult<Json>) -> AppResult<Model> {
    match outcome {
        Ok(mut response) => {
            let artifact = response.as_object_mut().and_then(|o| o.remove("artifact"));
            conn.execute(
                "UPDATE model SET status = 'trained', trained_config = ?1, result = ?2, artifact = ?3, error = NULL,
                 trained_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?4",
                params![
                    serde_json::to_string(trained)?,
                    response.to_string(),
                    artifact.as_ref().and_then(Json::as_str),
                    id
                ],
            )?;
        }
        Err(e) => {
            // Keep the previous result (if any) but record the failure.
            conn.execute("UPDATE model SET status = 'failed', error = ?1 WHERE id = ?2", params![e.to_string(), id])?;
        }
    }
    get(conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::import::{self, PreviewSettings};
    use crate::domain::project::Project;

    /// Batch, time, two inputs (x1, x2), one output (y), one text column.
    fn setup(dir: &std::path::Path) -> (Project, i64) {
        let mut p = Project::create(&dir.join("p.dtwin"), "T").unwrap();
        let mut csv = String::from("Batch;Time;x1;x2;y;note\n");
        for b in ["B1", "B2"] {
            for m in 0..30 {
                csv += &format!("{b};2026-01-0{} 00:{m:02};{m};{};{};n\n", if b == "B1" { 1 } else { 2 }, m * 2, m * 3);
            }
        }
        let file = dir.join("d.csv");
        std::fs::write(&file, csv).unwrap();
        let pv = import::preview(&p.conn, &file, PreviewSettings::default()).unwrap();
        let opts = import::ImportOptions {
            format: pv.format,
            decimal: pv.decimal,
            header_row: pv.header_row,
            skip_rows: pv.skip_rows,
            timezone: "UTC".into(),
            table_name: "d".into(),
            columns: pv.columns,
        };
        let t = import::run(&mut p.conn, &file, &opts, |_| {}).unwrap().table;
        (p, t.id)
    }

    fn complete(table_id: i64) -> ModelConfig {
        ModelConfig {
            source: Some(PlotSource { table_id, batch_column: Some(0), time_column: 1 }),
            inputs: vec![2, 3],
            outputs: vec![4],
            dynamics: vec![
                Dynamics { input: 2, output: 4, delay_min: 5.0, sigma_min: 1.0, enabled: true },
                Dynamics { input: 3, output: 4, delay_min: 0.0, sigma_min: 0.0, enabled: true },
            ],
            batches: vec!["B2".into()],
            ..Default::default()
        }
    }

    #[test]
    fn create_save_list_delete() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let m = create(&p.conn, "Density").unwrap();
        assert_eq!(m.status, ModelStatus::Draft);
        assert_eq!(m.config.source, None, "no plot sheet source yet");

        let saved = save(&p.conn, m.id, "Density model", &complete(id)).unwrap();
        assert_eq!(saved.config, complete(id));
        assert_eq!(list(&p.conn).unwrap()[0].name, "Density model");

        let mut bad = complete(id);
        bad.outputs = vec![2];
        assert!(save(&p.conn, m.id, "x", &bad).is_err(), "input and output overlap");
        let mut bad = complete(id);
        bad.dynamics[0].delay_min = -1.0;
        assert!(save(&p.conn, m.id, "x", &bad).is_err(), "negative delay");

        delete(&p.conn, m.id).unwrap();
        assert!(list(&p.conn).unwrap().is_empty());
    }

    #[test]
    fn training_request_contains_selected_batches_and_pairs() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let m = create(&p.conn, "M").unwrap();
        save(&p.conn, m.id, "M", &complete(id)).unwrap();
        let (_, req) = training_request(&p.conn, m.id).unwrap();
        assert_eq!(req["batches"].as_array().unwrap().len(), 1);
        assert_eq!(req["batches"][0]["key"], "B2");
        assert_eq!(req["batches"][0]["hours"].as_array().unwrap().len(), 30);
        assert_eq!(req["batches"][0]["columns"]["4"][2], json!(6.0));
        assert_eq!(req["dynamics"].as_array().unwrap().len(), 2);
        assert_eq!(req["dynamics"][0]["delayMin"], json!(5.0));
        assert_eq!(req["names"]["4"], "y");
        assert_eq!(req["algorithm"]["kind"], "linear");
    }

    #[test]
    fn training_request_explains_what_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let m = create(&p.conn, "M").unwrap();
        let err = |c: &ModelConfig| {
            save(&p.conn, m.id, "M", c).unwrap();
            training_request(&p.conn, m.id).unwrap_err().to_string()
        };
        let mut c = complete(id);
        c.batches.clear();
        assert!(err(&c).contains("batch"));
        let mut c = complete(id);
        c.dynamics.pop();
        assert!(err(&c).contains("x2 → y"), "{}", err(&c));
        let mut c = complete(id);
        c.inputs = vec![5];
        c.dynamics = vec![Dynamics { input: 5, output: 4, delay_min: 0.0, sigma_min: 0.0, enabled: true }];
        assert!(err(&c).contains("not a numeric"));
    }

    #[test]
    fn output_without_connected_inputs_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let m = create(&p.conn, "M").unwrap();
        let mut c = complete(id);
        c.dynamics[0].enabled = false;
        save(&p.conn, m.id, "M", &c).unwrap();
        let (_, req) = training_request(&p.conn, m.id).unwrap();
        assert_eq!(req["dynamics"][0]["enabled"], json!(false), "passed on to the sidecar");

        c.dynamics[1].enabled = false;
        save(&p.conn, m.id, "M", &c).unwrap();
        let err = training_request(&p.conn, m.id).unwrap_err().to_string();
        assert!(err.contains("no input is connected to y"), "{err}");

        // Definitions saved before the flag existed count as connected.
        let old: Dynamics = serde_json::from_str(r#"{"input":2,"output":4,"delayMin":1,"sigmaMin":0}"#).unwrap();
        assert!(old.enabled);
    }

    #[test]
    fn stores_results_and_detects_stale_definitions() {
        let dir = tempfile::tempdir().unwrap();
        let (mut p, id) = setup(dir.path());
        let m = create(&p.conn, "M").unwrap();
        let cfg = complete(id);
        save(&p.conn, m.id, "M", &cfg).unwrap();

        let response = json!({ "outputs": [{ "column": 4, "r2Test": 0.9 }], "warnings": [], "artifact": "QUJD" });
        let trained = store_training(&p.conn, m.id, &cfg, Ok(response)).unwrap();
        assert_eq!(trained.status, ModelStatus::Trained);
        assert!(!trained.stale);
        assert_eq!(trained.result.as_ref().unwrap()["outputs"][0]["r2Test"], json!(0.9));
        assert!(trained.result.as_ref().unwrap().get("artifact").is_none(), "artifact stored separately");
        let artifact: String =
            p.conn.query_row("SELECT artifact FROM model WHERE id = ?1", [m.id], |r| r.get(0)).unwrap();
        assert_eq!(artifact, "QUJD");

        let mut changed = cfg.clone();
        changed.test_fraction = 0.3;
        assert!(save(&p.conn, m.id, "M", &changed).unwrap().stale);

        let failed = store_training(&p.conn, m.id, &changed, Err(AppError::Sidecar("boom".into()))).unwrap();
        assert_eq!(failed.status, ModelStatus::Failed);
        assert!(failed.error.unwrap().contains("boom"));
        assert!(failed.result.is_some(), "previous result kept");

        tables::delete(&mut p.conn, id).unwrap();
        let cleaned = get(&p.conn, m.id).unwrap();
        assert_eq!(cleaned.config.source, None);
        assert!(cleaned.config.inputs.is_empty());
    }
}
