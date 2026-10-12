//! Changing the type of an imported column in place (e.g. text timestamps to date/time),
//! keeping the table id and column position so links (P&ID, plots) stay valid.

use chrono::{SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{params, types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use super::import::convert::{convert_cell, infer_kind, ColumnKind, Converted, Localizer, RFC3339};
use super::import::source::RawCell;
use super::tables::{self, column_sql_name, data_table_name, kind_sql, TableInfo};
use crate::error::{AppError, AppResult};

const DETECT_SAMPLE: usize = 500;
const MAX_WARNING_EXAMPLES: usize = 3;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnConversion {
    pub kind: ColumnKind,
    /// chrono format or "rfc3339"; `None` detects it from the values.
    #[serde(default)]
    pub datetime_format: Option<String>,
    /// IANA zone of wall-clock timestamps, e.g. "Europe/Copenhagen".
    pub timezone: String,
    pub decimal: char,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub table: TableInfo,
    pub converted: i64,
    pub invalid: i64,
    /// The format used for date/time conversion (detected or given).
    pub datetime_format: Option<String>,
    pub warnings: Vec<String>,
}

pub fn convert_column(
    conn: &mut Connection,
    table_id: i64,
    ordinal: i64,
    conv: &ColumnConversion,
) -> AppResult<ConversionResult> {
    let table = tables::get(conn, table_id)?;
    let column = table
        .columns
        .get(usize::try_from(ordinal).unwrap_or(usize::MAX))
        .ok_or_else(|| AppError::InvalidInput(format!("table has no column {ordinal}")))?
        .clone();
    if conv.kind == ColumnKind::Skip {
        return Err(AppError::InvalidInput("cannot convert a column to 'skip'".into()));
    }
    let tz: Tz = conv
        .timezone
        .parse()
        .map_err(|_| AppError::InvalidInput(format!("unknown time zone \"{}\"", conv.timezone)))?;

    let data = data_table_name(table_id);
    let col = column_sql_name(ordinal as usize);

    // Read current values as raw cells, in row order.
    let mut cells: Vec<(i64, RawCell)> = Vec::new();
    {
        let mut stmt = conn.prepare(&format!("SELECT _row, {col} FROM \"{data}\" ORDER BY _row"))?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let cell = match r.get_ref(1)? {
                ValueRef::Null => RawCell::Empty,
                ValueRef::Integer(n) if column.kind == ColumnKind::Datetime => Utc
                    .timestamp_millis_opt(n)
                    .single()
                    .map_or(RawCell::Empty, |d| {
                        RawCell::Text(d.to_rfc3339_opts(SecondsFormat::Millis, true))
                    }),
                ValueRef::Integer(n) => RawCell::Number(n as f64),
                ValueRef::Real(f) => RawCell::Number(f),
                ValueRef::Text(t) => RawCell::Text(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => RawCell::Empty,
            };
            cells.push((r.get(0)?, cell));
        }
    }

    // Date/time conversion needs a format; detect it from the values when not given.
    let datetime_format = match (conv.kind, &conv.datetime_format) {
        (ColumnKind::Datetime, Some(f)) if !f.trim().is_empty() => Some(f.trim().to_owned()),
        (ColumnKind::Datetime, _) if column.kind == ColumnKind::Datetime => Some(RFC3339.to_owned()),
        (ColumnKind::Datetime, _) => {
            let sample: Vec<&RawCell> =
                cells.iter().map(|(_, c)| c).filter(|c| !c.is_empty()).take(DETECT_SAMPLE).collect();
            match infer_kind(&sample, conv.decimal) {
                (ColumnKind::Datetime, f) => f,
                _ => {
                    return Err(AppError::InvalidInput(
                        "could not detect the date/time format; enter it (e.g. %d/%m/%Y %H.%M)".into(),
                    ))
                }
            }
        }
        _ => None,
    };

    let mut localizer = Localizer::new(tz);
    let mut values: Vec<(i64, rusqlite::types::Value)> = Vec::with_capacity(cells.len());
    let (mut converted, mut invalid) = (0i64, 0i64);
    let mut examples = Vec::new();
    for (row, cell) in &cells {
        use rusqlite::types::Value as V;
        let v = match convert_cell(cell, conv.kind, conv.decimal, datetime_format.as_deref(), &mut localizer) {
            Converted::Null => V::Null,
            Converted::Real(f) => V::Real(f),
            Converted::Text(s) => V::Text(s),
            Converted::Time(ms) => V::Integer(ms),
            Converted::Invalid => {
                invalid += 1;
                if examples.len() < MAX_WARNING_EXAMPLES {
                    examples.push(format!("row {row}: \"{}\"", cell.display()));
                }
                V::Null
            }
        };
        if !matches!(v, rusqlite::types::Value::Null) {
            converted += 1;
        }
        values.push((*row, v));
    }

    // Rebuild the column with the new SQL type: add, fill, drop old, rename.
    let (kind_name, sql_type) = kind_sql(conv.kind);
    let tmp = format!("{col}__new");
    let tx = conn.transaction()?;
    tx.execute_batch(&format!(
        "DROP INDEX IF EXISTS \"{}\";
         ALTER TABLE \"{data}\" ADD COLUMN {tmp} {sql_type};",
        index_name(table_id, ordinal)
    ))?;
    {
        let mut update = tx.prepare(&format!("UPDATE \"{data}\" SET {tmp} = ?1 WHERE _row = ?2"))?;
        for (row, v) in &values {
            update.execute(params![v, row])?;
        }
    }
    tx.execute_batch(&format!(
        "ALTER TABLE \"{data}\" DROP COLUMN {col};
         ALTER TABLE \"{data}\" RENAME COLUMN {tmp} TO {col};"
    ))?;
    tx.execute(
        "UPDATE data_column SET kind = ?1 WHERE table_id = ?2 AND ordinal = ?3",
        params![kind_name, table_id, ordinal],
    )?;
    update_import_options(&tx, table_id, ordinal, conv.kind, datetime_format.as_deref())?;
    tx.commit()?;

    let mut warnings = Vec::new();
    if invalid > 0 {
        warnings.push(format!(
            "{}: {invalid} value(s) could not be read as {kind_name} and were left empty (e.g. {})",
            column.name,
            examples.join(", ")
        ));
    }
    if localizer.ambiguous > 0 {
        warnings.push(format!(
            "{}: {} timestamp(s) fell in the repeated hour when DST ended; resolved by row order",
            column.name, localizer.ambiguous
        ));
    }
    if localizer.nonexistent > 0 {
        warnings.push(format!(
            "{}: {} timestamp(s) fell in the skipped hour when DST started; shifted forward 1 hour",
            column.name, localizer.nonexistent
        ));
    }
    Ok(ConversionResult { table: tables::get(conn, table_id)?, converted, invalid, datetime_format, warnings })
}

/// Index name used for indexes on a data column (e.g. a batch column used by plots).
pub(crate) fn index_name(table_id: i64, ordinal: i64) -> String {
    format!("idx_data_{table_id}_c{ordinal}")
}

/// Keeps the stored import options in step, so a later re-import uses the new type.
fn update_import_options(
    conn: &Connection,
    table_id: i64,
    ordinal: i64,
    kind: ColumnKind,
    datetime_format: Option<&str>,
) -> AppResult<()> {
    let raw: String =
        conn.query_row("SELECT import_options FROM data_table WHERE id = ?1", [table_id], |r| r.get(0))?;
    let Ok(mut opts) = serde_json::from_str::<Json>(&raw) else { return Ok(()) };
    let Some(cols) = opts.get_mut("columns").and_then(Json::as_array_mut) else { return Ok(()) };
    // Catalog ordinals count imported (non-skipped) columns only.
    if let Some(spec) = cols
        .iter_mut()
        .filter(|c| c.get("kind").and_then(Json::as_str) != Some("skip"))
        .nth(ordinal as usize)
    {
        spec["kind"] = serde_json::to_value(kind)?;
        spec["datetimeFormat"] = datetime_format.map_or(Json::Null, |f| Json::String(f.to_owned()));
    }
    conn.execute(
        "UPDATE data_table SET import_options = ?1 WHERE id = ?2",
        params![opts.to_string(), table_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::import::{self, PreviewSettings};
    use crate::domain::project::Project;
    use serde_json::json;

    fn import_csv(p: &mut Project, dir: &std::path::Path, content: &str) -> TableInfo {
        let file = dir.join("t.csv");
        std::fs::write(&file, content).unwrap();
        let pv = import::preview(&p.conn, &file, PreviewSettings::default()).unwrap();
        let opts = import::ImportOptions {
            format: pv.format,
            decimal: pv.decimal,
            header_row: pv.header_row,
            skip_rows: pv.skip_rows,
            timezone: "UTC".into(),
            table_name: pv.suggested_table_name,
            columns: pv.columns,
        };
        import::run(&mut p.conn, &file, &opts, |_| {}).unwrap().table
    }

    fn conversion(kind: ColumnKind, format: Option<&str>) -> ColumnConversion {
        ColumnConversion {
            kind,
            datetime_format: format.map(str::to_owned),
            timezone: "Europe/Copenhagen".into(),
            decimal: '.',
        }
    }

    #[test]
    fn text_to_datetime_detects_format_and_keeps_position() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Project::create(&dir.path().join("p.dtwin"), "T").unwrap();
        // Force the time column to text, as an older import would have.
        let t = import_csv(&mut p, dir.path(), "Batch;Time;T\nB1;01/01/2026 00.00;1.5\nB1;01/01/2026 00.01;2.5\n");
        assert_eq!(t.columns[1].kind, ColumnKind::Datetime, "new importer detects it");
        convert_column(&mut p.conn, t.id, 1, &conversion(ColumnKind::Text, None)).unwrap();
        assert_eq!(tables::get(&p.conn, t.id).unwrap().columns[1].kind, ColumnKind::Text);

        // Text -> datetime with detection.
        let r = convert_column(&mut p.conn, t.id, 1, &conversion(ColumnKind::Datetime, None)).unwrap();
        assert_eq!(r.datetime_format.as_deref(), Some(RFC3339), "text written by the first conversion");
        assert_eq!(r.invalid, 0);
        let rows = tables::rows(&p.conn, t.id, 0, 10).unwrap();
        // Imported as UTC; the round trip through RFC 3339 text keeps the instant, and the
        // column order is unchanged.
        assert_eq!(rows[0], vec![json!("B1"), json!(1767225600000i64), json!(1.5)]);
        assert_eq!(rows[1], vec![json!("B1"), json!(1767225660000i64), json!(2.5)]);
    }

    #[test]
    fn text_with_dot_times_to_datetime() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Project::create(&dir.path().join("p.dtwin"), "T").unwrap();
        let t = import_csv(&mut p, dir.path(), "Time,V\n01/01/2026 00.00,1\n01/01/2026 00.01,2\nbad,3\n");
        // "bad" keeps the column as text on import.
        assert_eq!(t.columns[0].kind, ColumnKind::Text);
        let r = convert_column(&mut p.conn, t.id, 0, &conversion(ColumnKind::Datetime, Some("%d/%m/%Y %H.%M")))
            .unwrap();
        assert_eq!((r.converted, r.invalid), (2, 1));
        assert!(r.warnings[0].contains("row 3"), "{:?}", r.warnings);
        assert_eq!(r.table.columns[0].kind, ColumnKind::Datetime);

        let opts: Json = serde_json::from_str(
            &p.conn.query_row("SELECT import_options FROM data_table", [], |r| r.get::<_, String>(0)).unwrap(),
        )
        .unwrap();
        assert_eq!(opts["columns"][0]["kind"], json!("datetime"));
        assert_eq!(opts["columns"][0]["datetimeFormat"], json!("%d/%m/%Y %H.%M"));
    }

    #[test]
    fn undetectable_format_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Project::create(&dir.path().join("p.dtwin"), "T").unwrap();
        let t = import_csv(&mut p, dir.path(), "Name,V\nabc,1\ndef,2\n");
        assert!(convert_column(&mut p.conn, t.id, 0, &conversion(ColumnKind::Datetime, None)).is_err());
        assert_eq!(tables::get(&p.conn, t.id).unwrap().columns[0].kind, ColumnKind::Text, "unchanged");
    }
}
