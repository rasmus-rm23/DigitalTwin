//! Plot sheets: which data to plot (source table, batch and time columns, selected batches)
//! and the plots themselves, plus the batch-aligned time series they display.
//!
//! Each batch is shifted so that its first sample is at t = 0 h.

use std::collections::HashSet;

use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::column_type::index_name;
use super::import::convert::ColumnKind;
use super::tables::{self, column_sql_name, data_table_name, TableInfo};
use crate::error::{AppError, AppResult};

const MS_PER_HOUR: f64 = 3_600_000.0;

/// Where the plotted data comes from. Columns are zero-based positions in the table.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotSource {
    pub table_id: i64,
    /// Column identifying the batch; `None` treats the whole table as one batch.
    pub batch_column: Option<i64>,
    /// Date/time column giving each sample's time.
    pub time_column: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PlotLayout {
    /// One plot per row.
    #[default]
    Stacked,
    /// Two plots side by side.
    Pairs,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDef {
    pub column: i64,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotDef {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub series: Vec<SeriesDef>,
    /// Fixed y-axis range; `None` scales automatically.
    #[serde(default)]
    pub y_min: Option<f64>,
    #[serde(default)]
    pub y_max: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotConfig {
    #[serde(default)]
    pub source: Option<PlotSource>,
    /// Batch keys to render (as returned by `batches`).
    #[serde(default)]
    pub selected_batches: Vec<String>,
    #[serde(default)]
    pub layout: PlotLayout,
    /// Height of each plot in px.
    #[serde(default = "default_height")]
    pub plot_height: f64,
    /// Overlay model simulations (no models yet).
    #[serde(default)]
    pub show_simulations: bool,
    #[serde(default)]
    pub plots: Vec<PlotDef>,
}

fn default_height() -> f64 {
    240.0
}

impl Default for PlotConfig {
    fn default() -> Self {
        Self {
            source: None,
            selected_batches: Vec::new(),
            layout: PlotLayout::default(),
            plot_height: default_height(),
            show_simulations: false,
            plots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotSheet {
    pub id: i64,
    pub name: String,
    pub config: PlotConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInfo {
    /// Batch value as text; "" when the source has no batch column.
    pub key: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub rows: i64,
}

/// One batch's samples: time in hours since the batch's first sample, and one value
/// array per requested column (NULL -> None).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSeries {
    pub key: String,
    pub hours: Vec<f64>,
    pub values: Vec<Vec<Option<f64>>>,
}

/// The project's plot sheet, created on first use.
pub fn get_or_create_main(conn: &Connection) -> AppResult<PlotSheet> {
    let row: Option<(i64, String, String)> = conn
        .query_row("SELECT id, name, config FROM plot_sheet ORDER BY id LIMIT 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let (id, name, config) = match row {
        Some((id, name, raw)) => (id, name, serde_json::from_str(&raw).unwrap_or_default()),
        None => {
            let config = PlotConfig::default();
            conn.execute(
                "INSERT INTO plot_sheet (name, config, updated_at)
                 VALUES ('Plots', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [serde_json::to_string(&config)?],
            )?;
            (conn.last_insert_rowid(), "Plots".to_owned(), config)
        }
    };
    let mut sheet = PlotSheet { id, name, config };
    sanitize(conn, &mut sheet.config)?;
    Ok(sheet)
}

pub fn save(conn: &Connection, sheet: &PlotSheet) -> AppResult<()> {
    validate(conn, &sheet.config)?;
    let n = conn.execute(
        "UPDATE plot_sheet SET name = ?1, config = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?3",
        params![sheet.name, serde_json::to_string(&sheet.config)?, sheet.id],
    )?;
    if n == 0 {
        return Err(AppError::InvalidInput(format!("no plot sheet with id {}", sheet.id)));
    }
    Ok(())
}

fn column_in_range(table: &TableInfo, column: i64) -> bool {
    column >= 0 && (column as usize) < table.columns.len()
}

fn validate(conn: &Connection, config: &PlotConfig) -> AppResult<()> {
    let invalid = |m: String| Err(AppError::InvalidInput(m));
    if !(config.plot_height >= 80.0 && config.plot_height <= 2000.0) {
        return invalid(format!("plot height must be 80-2000 px (got {})", config.plot_height));
    }
    let mut ids = HashSet::new();
    for p in &config.plots {
        if !ids.insert(p.id.as_str()) {
            return invalid(format!("duplicate plot id \"{}\"", p.id));
        }
        if let (Some(lo), Some(hi)) = (p.y_min, p.y_max) {
            if lo >= hi {
                return invalid(format!("plot \"{}\": y min must be below y max", p.title));
            }
        }
    }
    let Some(src) = config.source else { return Ok(()) };
    let table = tables::get(conn, src.table_id)?;
    let in_range = |c: i64| column_in_range(&table, c);
    if !in_range(src.time_column) || src.batch_column.is_some_and(|c| !in_range(c)) {
        return invalid("source column out of range".into());
    }
    if config.plots.iter().flat_map(|p| &p.series).any(|s| !in_range(s.column)) {
        return invalid("plotted column out of range".into());
    }
    Ok(())
}

/// Drops references to tables or columns that no longer exist (e.g. a deleted table).
fn sanitize(conn: &Connection, config: &mut PlotConfig) -> AppResult<()> {
    let Some(src) = config.source else { return Ok(()) };
    let table = match tables::get(conn, src.table_id) {
        Ok(t) => t,
        Err(AppError::InvalidInput(_)) => {
            config.source = None;
            config.selected_batches.clear();
            for p in &mut config.plots {
                p.series.clear();
            }
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    if !column_in_range(&table, src.time_column) || src.batch_column.is_some_and(|c| !column_in_range(&table, c)) {
        config.source = None;
    }
    for p in &mut config.plots {
        p.series.retain(|s| column_in_range(&table, s.column));
    }
    Ok(())
}

/// Checks the source columns' types and returns (table, time column SQL, batch expression).
fn resolve(conn: &Connection, src: &PlotSource) -> AppResult<(TableInfo, String, Option<String>)> {
    let table = tables::get(conn, src.table_id)?;
    let time = table
        .columns
        .get(src.time_column as usize)
        .filter(|_| src.time_column >= 0)
        .ok_or_else(|| AppError::InvalidInput("time column out of range".into()))?;
    if time.kind != ColumnKind::Datetime {
        return Err(AppError::InvalidInput(format!(
            "the time column \"{}\" is {}, not date/time. Change its type in the table view first.",
            time.name,
            if time.kind == ColumnKind::Text { "text" } else { "a number" }
        )));
    }
    let batch_expr = match src.batch_column {
        None => None,
        Some(c) => {
            let col = table
                .columns
                .get(c as usize)
                .filter(|_| c >= 0)
                .ok_or_else(|| AppError::InvalidInput("batch column out of range".into()))?;
            let name = column_sql_name(c as usize);
            Some(if col.kind == ColumnKind::Text { name } else { format!("CAST({name} AS TEXT)") })
        }
    };
    Ok((table, column_sql_name(src.time_column as usize), batch_expr))
}

/// Batches in the source, ordered by start time.
pub fn batches(conn: &Connection, src: &PlotSource) -> AppResult<Vec<BatchInfo>> {
    let (_, time, batch) = resolve(conn, src)?;
    let data = data_table_name(src.table_id);
    let Some(batch) = batch else {
        let sql = format!("SELECT MIN({time}), MAX({time}), COUNT(*) FROM \"{data}\" WHERE {time} IS NOT NULL");
        let (start, end, rows): (Option<i64>, Option<i64>, i64) =
            conn.query_row(&sql, [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        return Ok(match (start, end) {
            (Some(start_ms), Some(end_ms)) => vec![BatchInfo { key: String::new(), start_ms, end_ms, rows }],
            _ => Vec::new(),
        });
    };
    // An index on the batch column keeps per-batch queries fast on large tables.
    if let Some(c) = src.batch_column {
        conn.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS \"{}\" ON \"{data}\" ({})",
            index_name(src.table_id, c),
            column_sql_name(c as usize)
        ))?;
    }
    let sql = format!(
        "SELECT {batch}, MIN({time}), MAX({time}), COUNT(*) FROM \"{data}\"
         WHERE {batch} IS NOT NULL AND {time} IS NOT NULL
         GROUP BY {batch} ORDER BY MIN({time})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(BatchInfo { key: r.get(0)?, start_ms: r.get(1)?, end_ms: r.get(2)?, rows: r.get(3)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Samples of one batch for the given number columns, time-shifted to start at 0 h.
pub fn batch_series(conn: &Connection, src: &PlotSource, key: &str, columns: &[i64]) -> AppResult<BatchSeries> {
    let (table, time, batch) = resolve(conn, src)?;
    for &c in columns {
        match table.columns.get(c as usize).filter(|_| c >= 0) {
            Some(col) if col.kind == ColumnKind::Number => {}
            Some(col) => {
                return Err(AppError::InvalidInput(format!("column \"{}\" is not numeric", col.name)))
            }
            None => return Err(AppError::InvalidInput(format!("column {c} out of range"))),
        }
    }
    let select: String = std::iter::once(time.clone())
        .chain(columns.iter().map(|&c| column_sql_name(c as usize)))
        .collect::<Vec<_>>()
        .join(", ");
    let filter = batch.map_or(String::new(), |b| format!("AND {b} = ?1"));
    let sql = format!(
        "SELECT {select} FROM \"{}\" WHERE {time} IS NOT NULL {filter} ORDER BY {time}, _row",
        data_table_name(src.table_id)
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = if src.batch_column.is_some() { stmt.query([key])? } else { stmt.query([])? };

    let mut hours = Vec::new();
    let mut values: Vec<Vec<Option<f64>>> = vec![Vec::new(); columns.len()];
    let mut start: Option<i64> = None;
    while let Some(r) = rows.next()? {
        let t: i64 = r.get(0)?;
        let t0 = *start.get_or_insert(t);
        hours.push((t - t0) as f64 / MS_PER_HOUR);
        for (i, v) in values.iter_mut().enumerate() {
            v.push(match r.get_ref(i + 1)? {
                ValueRef::Real(f) => Some(f),
                ValueRef::Integer(n) => Some(n as f64),
                _ => None,
            });
        }
    }
    Ok(BatchSeries { key: key.to_owned(), hours, values })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::import::{self, PreviewSettings};
    use crate::domain::project::Project;

    /// Two batches, 30 min apart samples; batch B2 starts later; one NULL value.
    fn setup(dir: &std::path::Path) -> (Project, i64) {
        let mut p = Project::create(&dir.join("p.dtwin"), "T").unwrap();
        let file = dir.join("d.csv");
        std::fs::write(
            &file,
            "Batch;Time;Temp;Note\n\
             B1;2026-01-01 00:00;10;a\n\
             B1;2026-01-01 00:30;11;b\n\
             B1;2026-01-01 01:00;;c\n\
             B2;2026-01-02 06:00;20;d\n\
             B2;2026-01-02 07:30;23;e\n",
        )
        .unwrap();
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

    #[test]
    fn lists_batches_and_aligns_series_at_zero() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let src = PlotSource { table_id: id, batch_column: Some(0), time_column: 1 };

        let b = batches(&p.conn, &src).unwrap();
        assert_eq!(b.iter().map(|b| (b.key.as_str(), b.rows)).collect::<Vec<_>>(), [("B1", 3), ("B2", 2)]);

        let s = batch_series(&p.conn, &src, "B2", &[2]).unwrap();
        assert_eq!(s.hours, [0.0, 1.5]);
        assert_eq!(s.values, [vec![Some(20.0), Some(23.0)]]);

        let s = batch_series(&p.conn, &src, "B1", &[2]).unwrap();
        assert_eq!(s.hours, [0.0, 0.5, 1.0]);
        assert_eq!(s.values[0][2], None, "empty cell");
    }

    #[test]
    fn without_batch_column_the_table_is_one_batch() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let src = PlotSource { table_id: id, batch_column: None, time_column: 1 };
        let b = batches(&p.conn, &src).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].rows, 5);
        assert_eq!(batch_series(&p.conn, &src, "", &[2]).unwrap().hours.last(), Some(&31.5));
    }

    #[test]
    fn rejects_wrong_column_types() {
        let dir = tempfile::tempdir().unwrap();
        let (p, id) = setup(dir.path());
        let text_time = PlotSource { table_id: id, batch_column: Some(0), time_column: 3 };
        let err = batches(&p.conn, &text_time).unwrap_err().to_string();
        assert!(err.contains("not date/time"), "{err}");
        let src = PlotSource { table_id: id, batch_column: Some(0), time_column: 1 };
        assert!(batch_series(&p.conn, &src, "B1", &[3]).is_err(), "text column");
    }

    #[test]
    fn sheet_roundtrip_validation_and_cleanup_after_table_delete() {
        let dir = tempfile::tempdir().unwrap();
        let (mut p, id) = setup(dir.path());
        let mut sheet = get_or_create_main(&p.conn).unwrap();
        assert_eq!(sheet.config, PlotConfig::default());

        sheet.config.source = Some(PlotSource { table_id: id, batch_column: Some(0), time_column: 1 });
        sheet.config.selected_batches = vec!["B1".into()];
        sheet.config.layout = PlotLayout::Pairs;
        sheet.config.plots = vec![PlotDef {
            id: "p1".into(),
            title: "Temp".into(),
            series: vec![SeriesDef { column: 2, color: Some("#ff0000".into()) }],
            y_min: Some(0.0),
            y_max: Some(50.0),
        }];
        save(&p.conn, &sheet).unwrap();
        assert_eq!(get_or_create_main(&p.conn).unwrap(), sheet);

        let mut bad = sheet.clone();
        bad.config.plots[0].y_min = Some(60.0);
        assert!(save(&p.conn, &bad).is_err(), "y min above y max");
        let mut bad = sheet.clone();
        bad.config.plots[0].series[0].column = 99;
        assert!(save(&p.conn, &bad).is_err(), "column out of range");

        tables::delete(&mut p.conn, id).unwrap();
        let cleaned = get_or_create_main(&p.conn).unwrap();
        assert_eq!(cleaned.config.source, None);
        assert!(cleaned.config.plots[0].series.is_empty());
        assert_eq!(cleaned.config.plots[0].title, "Temp", "plots themselves are kept");
    }
}
