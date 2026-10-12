//! What-if simulations: a trained model, a simulation time and one setpoint profile per model
//! input (a fixed value, or setpoints at given times, linearly interpolated).
//!
//! The simulation itself runs in the sidecar (`simulate` method, `sidecar/.../simulation.py`).
//! The core assembles the request with `run_request`, calls the sidecar without holding the
//! project lock, and stores the response with `store_run`.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use super::models;
use super::tables;
use crate::error::{AppError, AppResult};

const MAX_DURATION_H: f64 = 10_000.0;
const MAX_STEP_MIN: f64 = 1440.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProfileMode {
    /// The same value for the whole simulation.
    #[default]
    Fixed,
    /// Setpoints at given times; linear in between, held before the first and after the last.
    /// Two setpoints at the same time give a step change.
    Points,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPoint {
    /// Hours since the simulation start.
    pub hours: f64,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputProfile {
    /// Column position of the input in the model's source table.
    pub column: i64,
    #[serde(default)]
    pub mode: ProfileMode,
    /// Value used in fixed mode.
    #[serde(default)]
    pub value: f64,
    /// Setpoints used in points mode.
    #[serde(default)]
    pub points: Vec<SetPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationConfig {
    #[serde(default)]
    pub model_id: Option<i64>,
    /// Simulation time in hours, from t = 0.
    #[serde(default = "default_duration")]
    pub duration_h: f64,
    /// Output resolution in minutes.
    #[serde(default = "default_step")]
    pub step_min: f64,
    #[serde(default)]
    pub inputs: Vec<InputProfile>,
}

fn default_duration() -> f64 {
    8.0
}
fn default_step() -> f64 {
    1.0
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self { model_id: None, duration_h: default_duration(), step_min: default_step(), inputs: Vec::new() }
    }
}

/// A model input with its measured range in the source table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimVariable {
    pub column: i64,
    pub name: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
}

/// The simulated model as the editor needs it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimModel {
    pub id: i64,
    pub name: String,
    /// False until the model has been trained; it cannot be simulated before.
    pub trained: bool,
    pub trained_at: Option<String>,
    /// The model definition changed since training; the trained version is simulated.
    pub model_stale: bool,
    pub inputs: Vec<SimVariable>,
    pub outputs: Vec<SimVariable>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationSummary {
    pub id: i64,
    pub name: String,
    /// Set once the simulation has a result.
    pub run_at: Option<String>,
    /// Source table of the simulated (trained) model; its columns are the simulation's variables.
    pub table_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulation {
    pub id: i64,
    pub name: String,
    pub config: SimulationConfig,
    pub model: Option<SimModel>,
    /// Time axis, input trajectories and predicted outputs of the last run.
    pub result: Option<Json>,
    pub error: Option<String>,
    pub run_at: Option<String>,
    /// The settings or the model changed since the stored result was computed.
    pub stale: bool,
}

pub fn list(conn: &Connection) -> AppResult<Vec<SimulationSummary>> {
    let mut stmt = conn.prepare("SELECT id, name, run_at, config FROM simulation ORDER BY name COLLATE NOCASE")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?)))?
        .collect::<Result<Vec<(i64, String, Option<String>, String)>, _>>()?;
    rows.into_iter()
        .map(|(id, name, run_at, config)| {
            let model_id = serde_json::from_str::<SimulationConfig>(&config).ok().and_then(|c| c.model_id);
            let table_id = match model_id {
                // A deleted model counts as no model.
                Some(mid) => match models::trained(conn, mid) {
                    Ok(t) => t.and_then(|t| t.config.source).map(|s| s.table_id),
                    Err(AppError::InvalidInput(_)) => None,
                    Err(e) => return Err(e),
                },
                None => None,
            };
            Ok(SimulationSummary { id, name, run_at, table_id })
        })
        .collect()
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Simulation> {
    type Row = (String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);
    let row: Option<Row> = conn
        .query_row(
            "SELECT name, config, result, run_config, run_model_trained_at, error, run_at FROM simulation WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let (name, config, result, run_config, run_trained_at, error, run_at) =
        row.ok_or_else(|| AppError::InvalidInput(format!("no simulation with id {id}")))?;
    let mut config: SimulationConfig = serde_json::from_str(&config).unwrap_or_default();
    let model = match config.model_id {
        Some(mid) => match model_info(conn, mid) {
            Ok(m) => Some(m),
            // The model was deleted.
            Err(AppError::InvalidInput(_)) => {
                config.model_id = None;
                None
            }
            Err(e) => return Err(e),
        },
        None => None,
    };
    let run_config: Option<SimulationConfig> = run_config.and_then(|c| serde_json::from_str(&c).ok());
    let stale = result.is_some()
        && (run_config.as_ref() != Some(&config) || model.as_ref().and_then(|m| m.trained_at.clone()) != run_trained_at);
    Ok(Simulation {
        id,
        name,
        config,
        model,
        result: result.and_then(|r| serde_json::from_str(&r).ok()),
        error,
        run_at,
        stale,
    })
}

/// Inputs and outputs of the model version that is simulated (the trained one, if any).
fn model_info(conn: &Connection, id: i64) -> AppResult<SimModel> {
    let model = models::get(conn, id)?;
    let trained = models::trained(conn, id)?;
    let config = trained.as_ref().map_or(&model.config, |t| &t.config);
    let table = match config.source {
        Some(src) => tables::get(conn, src.table_id).ok(),
        None => None,
    };
    let variable = |col: i64| -> AppResult<SimVariable> {
        let name = table
            .as_ref()
            .and_then(|t| t.columns.get(col as usize))
            .map_or_else(|| format!("column {}", col + 1), |c| c.name.clone());
        let (min, max, mean) = match &table {
            Some(t) if (col as usize) < t.columns.len() => tables::column_stats(conn, t.id, col)?,
            _ => (None, None, None),
        };
        Ok(SimVariable { column: col, name, min, max, mean })
    };
    Ok(SimModel {
        id,
        name: model.name,
        trained: trained.is_some(),
        trained_at: trained.as_ref().map(|t| t.trained_at.clone()),
        model_stale: model.stale,
        inputs: config.inputs.iter().map(|&c| variable(c)).collect::<AppResult<_>>()?,
        outputs: config.outputs.iter().map(|&c| variable(c)).collect::<AppResult<_>>()?,
    })
}

/// A new simulation of the most recently trained model, with every input fixed at its mean.
pub fn create(conn: &Connection, name: &str) -> AppResult<Simulation> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("simulation name is empty".into()));
    }
    let latest = models::list(conn)?
        .into_iter()
        .filter(|m| m.trained_at.is_some())
        .max_by(|a, b| a.trained_at.cmp(&b.trained_at));
    let mut config = SimulationConfig::default();
    if let Some(m) = latest {
        config.model_id = Some(m.id);
        config.inputs = default_profiles(&model_info(conn, m.id)?);
    }
    conn.execute(
        "INSERT INTO simulation (name, config, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![name, serde_json::to_string(&config)?],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// Every model input fixed at its mean value.
pub fn default_profiles(model: &SimModel) -> Vec<InputProfile> {
    model
        .inputs
        .iter()
        .map(|v| InputProfile {
            column: v.column,
            mode: ProfileMode::Fixed,
            value: round_sig(v.mean.unwrap_or(0.0)),
            points: Vec::new(),
        })
        .collect()
}

/// Rounds to 4 significant digits, for readable default setpoints.
fn round_sig(v: f64) -> f64 {
    if v == 0.0 || !v.is_finite() {
        return 0.0;
    }
    let scale = 10f64.powi(3 - v.abs().log10().floor() as i32);
    (v * scale).round() / scale
}

pub fn save(conn: &Connection, id: i64, name: &str, config: &SimulationConfig) -> AppResult<Simulation> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput("simulation name is empty".into()));
    }
    validate(conn, config)?;
    let n = conn.execute(
        "UPDATE simulation SET name = ?1, config = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?3",
        params![name.trim(), serde_json::to_string(config)?, id],
    )?;
    if n == 0 {
        return Err(AppError::InvalidInput(format!("no simulation with id {id}")));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    if conn.execute("DELETE FROM simulation WHERE id = ?1", [id])? == 0 {
        return Err(AppError::InvalidInput(format!("no simulation with id {id}")));
    }
    Ok(())
}

fn validate(conn: &Connection, c: &SimulationConfig) -> AppResult<()> {
    let invalid = |m: &str| Err(AppError::InvalidInput(m.to_owned()));
    if !(c.duration_h > 0.0 && c.duration_h <= MAX_DURATION_H) {
        return invalid("simulation time must be more than 0 and at most 10000 h");
    }
    if !(c.step_min > 0.0 && c.step_min <= MAX_STEP_MIN) {
        return invalid("time step must be more than 0 and at most 1440 min");
    }
    if c.duration_h * 60.0 / c.step_min > 200_000.0 {
        return invalid("too many time steps (max 200000); increase the time step");
    }
    let mut seen = HashSet::new();
    for p in &c.inputs {
        if !seen.insert(p.column) {
            return invalid("an input has more than one profile");
        }
        if !p.value.is_finite() {
            return invalid("input values must be numbers");
        }
        if p.points.iter().any(|s| !(s.hours.is_finite() && s.value.is_finite() && s.hours >= 0.0)) {
            return invalid("setpoint times must be 0 h or later, and values must be numbers");
        }
    }
    if let Some(mid) = c.model_id {
        models::get(conn, mid)?;
    }
    Ok(())
}

/// Validates a simulation for running and assembles the sidecar `simulate` request.
/// Returns the config and the model training time it is run with, for staleness checks.
pub fn run_request(conn: &Connection, id: i64) -> AppResult<(SimulationConfig, String, Json)> {
    let sim = get(conn, id)?;
    let c = sim.config;
    validate(conn, &c)?;
    let invalid = |m: String| Err(AppError::InvalidInput(m));
    let Some(model_id) = c.model_id else { return invalid("choose a model first".into()) };
    let Some(trained) = models::trained(conn, model_id)? else {
        return invalid("the model has not been trained yet; train it in the Models view".into());
    };
    let info = sim.model.expect("model exists when model_id is set");

    let mut profiles = serde_json::Map::new();
    let mut ranges = serde_json::Map::new();
    for v in &info.inputs {
        let Some(p) = c.inputs.iter().find(|p| p.column == v.column) else {
            return invalid(format!("set a value or setpoints for {}", v.name));
        };
        if p.mode == ProfileMode::Points && p.points.is_empty() {
            return invalid(format!("{}: add at least one setpoint", v.name));
        }
        profiles.insert(v.column.to_string(), serde_json::to_value(p)?);
        ranges.insert(v.column.to_string(), json!([v.min, v.max]));
    }
    let names: serde_json::Map<String, Json> =
        info.inputs.iter().chain(&info.outputs).map(|v| (v.column.to_string(), json!(v.name))).collect();
    let request = json!({
        "artifact": trained.artifact,
        "names": names,
        "durationH": c.duration_h,
        "stepMin": c.step_min,
        "profiles": profiles,
        "ranges": ranges,
    });
    Ok((c, trained.trained_at, request))
}

/// Stores the outcome of a run. A failed run keeps the previous result and records the error.
pub fn store_run(
    conn: &Connection,
    id: i64,
    config: &SimulationConfig,
    model_trained_at: &str,
    outcome: AppResult<Json>,
) -> AppResult<Simulation> {
    match outcome {
        Ok(result) => {
            conn.execute(
                "UPDATE simulation SET result = ?1, run_config = ?2, run_model_trained_at = ?3, error = NULL,
                 run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?4",
                params![result.to_string(), serde_json::to_string(config)?, model_trained_at, id],
            )?;
        }
        Err(e) => {
            conn.execute("UPDATE simulation SET error = ?1 WHERE id = ?2", params![e.to_string(), id])?;
        }
    }
    get(conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::import::{self, PreviewSettings};
    use crate::domain::models::{Dynamics, ModelConfig};
    use crate::domain::plots::PlotSource;
    use crate::domain::project::Project;

    /// A project with table (Batch, Time, x1, x2, y) and model "M" (x1, x2 -> y), not trained.
    fn setup(dir: &std::path::Path) -> (Project, i64, ModelConfig) {
        let mut p = Project::create(&dir.join("p.dtwin"), "T").unwrap();
        let mut csv = String::from("Batch;Time;x1;x2;y\n");
        for m in 0..30 {
            csv += &format!("B1;2026-01-01 00:{m:02};{m};{};{}\n", m * 2, m * 3);
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
        let config = ModelConfig {
            source: Some(PlotSource { table_id: t.id, batch_column: Some(0), time_column: 1 }),
            inputs: vec![2, 3],
            outputs: vec![4],
            dynamics: vec![
                Dynamics { input: 2, output: 4, delay_min: 5.0, sigma_min: 1.0, enabled: true },
                Dynamics { input: 3, output: 4, delay_min: 0.0, sigma_min: 0.0, enabled: true },
            ],
            batches: vec!["B1".into()],
            ..Default::default()
        };
        let m = models::create(&p.conn, "M").unwrap();
        models::save(&p.conn, m.id, "M", &config).unwrap();
        (p, m.id, config)
    }

    fn train(p: &Project, model_id: i64, config: &ModelConfig) {
        let response = json!({ "outputs": [], "warnings": [], "artifact": "QUJD" });
        models::store_training(&p.conn, model_id, config, Ok(response)).unwrap();
    }

    #[test]
    fn new_simulation_uses_the_latest_trained_model_with_inputs_at_their_mean() {
        let dir = tempfile::tempdir().unwrap();
        let (p, model_id, config) = setup(dir.path());
        assert_eq!(create(&p.conn, "S0").unwrap().config.model_id, None, "no trained model yet");

        train(&p, model_id, &config);
        let s = create(&p.conn, "S1").unwrap();
        assert_eq!(s.config.model_id, Some(model_id));
        let m = s.model.unwrap();
        assert!(m.trained);
        assert_eq!(m.inputs.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["x1", "x2"]);
        assert_eq!(m.outputs[0].name, "y");
        assert_eq!((m.inputs[0].min, m.inputs[0].max, m.inputs[0].mean), (Some(0.0), Some(29.0), Some(14.5)));
        assert_eq!(s.config.inputs.len(), 2);
        assert_eq!(s.config.inputs[1].mode, ProfileMode::Fixed);
        assert_eq!(s.config.inputs[1].value, 29.0);
        let summaries = list(&p.conn).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].table_id, None, "S0 has no model");
        assert_eq!(summaries[1].table_id, config.source.map(|s| s.table_id));
    }

    #[test]
    fn validation() {
        let dir = tempfile::tempdir().unwrap();
        let (p, model_id, _) = setup(dir.path());
        let s = create(&p.conn, "S").unwrap();
        let ok = SimulationConfig { model_id: Some(model_id), ..Default::default() };
        save(&p.conn, s.id, "S", &ok).unwrap();
        let bad = |f: &dyn Fn(&mut SimulationConfig)| {
            let mut c = ok.clone();
            f(&mut c);
            save(&p.conn, s.id, "S", &c).unwrap_err().to_string()
        };
        assert!(bad(&|c| c.duration_h = 0.0).contains("simulation time"));
        assert!(bad(&|c| c.step_min = -1.0).contains("time step"));
        assert!(bad(&|c| {
            c.duration_h = 10_000.0;
            c.step_min = 0.5
        })
        .contains("too many"));
        assert!(bad(&|c| c.model_id = Some(999)).contains("no model"));
        let point = |hours| SetPoint { hours, value: 1.0 };
        let profile = |points| InputProfile { column: 2, mode: ProfileMode::Points, value: 0.0, points };
        assert!(bad(&|c| c.inputs = vec![profile(vec![point(-1.0)])]).contains("0 h or later"));
        assert!(bad(&|c| c.inputs = vec![profile(vec![]), profile(vec![])]).contains("more than one"));
    }

    #[test]
    fn run_request_needs_a_trained_model_and_a_profile_per_input() {
        let dir = tempfile::tempdir().unwrap();
        let (p, model_id, config) = setup(dir.path());
        let s = create(&p.conn, "S").unwrap();
        let mut c = SimulationConfig { model_id: Some(model_id), duration_h: 2.0, ..Default::default() };
        save(&p.conn, s.id, "S", &c).unwrap();
        assert!(run_request(&p.conn, s.id).unwrap_err().to_string().contains("not been trained"));

        train(&p, model_id, &config);
        assert!(run_request(&p.conn, s.id).unwrap_err().to_string().contains("x1"));

        c.inputs = vec![
            InputProfile { column: 2, mode: ProfileMode::Fixed, value: 3.0, points: vec![] },
            InputProfile { column: 3, mode: ProfileMode::Points, value: 0.0, points: vec![] },
        ];
        save(&p.conn, s.id, "S", &c).unwrap();
        assert!(run_request(&p.conn, s.id).unwrap_err().to_string().contains("x2: add at least one setpoint"));

        c.inputs[1].points = vec![SetPoint { hours: 0.0, value: 1.0 }, SetPoint { hours: 1.5, value: 4.0 }];
        save(&p.conn, s.id, "S", &c).unwrap();
        let (_, trained_at, req) = run_request(&p.conn, s.id).unwrap();
        assert_eq!(req["artifact"], "QUJD");
        assert_eq!(req["durationH"], json!(2.0));
        assert_eq!(req["profiles"]["2"]["mode"], "fixed");
        assert_eq!(req["profiles"]["3"]["points"][1]["value"], json!(4.0));
        assert_eq!(req["ranges"]["2"], json!([0.0, 29.0]));
        assert_eq!(req["names"]["4"], "y");

        // Results go stale when the settings or the model change.
        let run = store_run(&p.conn, s.id, &c, &trained_at, Ok(json!({ "hours": [0.0] }))).unwrap();
        assert!(!run.stale && run.run_at.is_some());
        c.duration_h = 3.0;
        assert!(save(&p.conn, s.id, "S", &c).unwrap().stale);
        let failed = store_run(&p.conn, s.id, &c, &trained_at, Err(AppError::Sidecar("boom".into()))).unwrap();
        assert!(failed.error.unwrap().contains("boom") && failed.result.is_some());

        let (_, trained_at, _) = run_request(&p.conn, s.id).unwrap();
        store_run(&p.conn, s.id, &c, &trained_at, Ok(json!({}))).unwrap();
        p.conn.execute("UPDATE model SET trained_at = 'later' WHERE id = ?1", [model_id]).unwrap();
        assert!(get(&p.conn, s.id).unwrap().stale, "model retrained since the run");

        models::delete(&p.conn, model_id).unwrap();
        let orphan = get(&p.conn, s.id).unwrap();
        assert_eq!(orphan.config.model_id, None);
        assert!(orphan.model.is_none());
    }
}
