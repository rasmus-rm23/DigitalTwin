//! CSV / spreadsheet import into project tables.
//!
//! Flow: `preview` detects settings and infers columns from the first rows; the UI lets
//! the user adjust them; `run` streams the whole file into a new `data_<id>` table.

pub mod convert;
pub mod source;

use std::collections::HashSet;
use std::path::Path;

use chrono_tz::Tz;
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use self::convert::{convert_cell, infer_kind, parse_number, ColumnKind, Converted, Localizer};
use self::source::{FileFormat, RawCell};
use super::tables::{self, column_sql_name, data_table_name, kind_sql, TableInfo};
use crate::error::{AppError, AppResult};

const PREVIEW_ROWS: usize = 100;
const PROGRESS_EVERY: u64 = 10_000;
const MAX_WARNING_EXAMPLES: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    /// Zero-based column position in the source file.
    pub source_index: usize,
    pub name: String,
    pub kind: ColumnKind,
    /// chrono format string, `"rfc3339"`, or `None` for native spreadsheet dates / auto.
    pub datetime_format: Option<String>,
}

/// Settings that control how the file is split into cells. `None` means detect.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSettings {
    pub format: Option<FileFormat>,
    pub decimal: Option<char>,
    pub header_row: Option<bool>,
    pub skip_rows: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub format: FileFormat,
    /// Sheet names for spreadsheets; empty for CSV.
    pub sheets: Vec<String>,
    pub decimal: char,
    pub header_row: bool,
    pub skip_rows: usize,
    pub columns: Vec<ColumnSpec>,
    /// First data rows as display text, one entry per column.
    pub rows: Vec<Vec<String>>,
    pub suggested_table_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub format: FileFormat,
    pub decimal: char,
    pub header_row: bool,
    pub skip_rows: usize,
    /// IANA zone of wall-clock timestamps in the file, e.g. "Europe/Copenhagen" or "UTC".
    pub timezone: String,
    pub table_name: String,
    pub columns: Vec<ColumnSpec>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub table: TableInfo,
    pub warnings: Vec<String>,
}

pub fn preview(conn: &Connection, path: &Path, settings: PreviewSettings) -> AppResult<Preview> {
    let skip_rows = settings.skip_rows.unwrap_or(0);
    let is_spreadsheet = source::is_spreadsheet(path);
    let sheets = if is_spreadsheet { source::sheet_names(path)? } else { Vec::new() };

    let format = match settings.format {
        Some(f) => f,
        None if is_spreadsheet => FileFormat::Spreadsheet {
            sheet: sheets.first().cloned().ok_or_else(|| {
                AppError::InvalidInput("the workbook has no sheets".into())
            })?,
        },
        None => {
            let encoding = source::detect_encoding(path)?;
            let lines = source::head_lines(path, encoding, skip_rows + 30)?;
            let delimiter = source::detect_delimiter(&lines[skip_rows.min(lines.len())..]);
            FileFormat::Csv { delimiter, encoding }
        }
    };

    let mut raw: Vec<Vec<RawCell>> = Vec::new();
    source::read_rows(path, &format, |line, row| {
        if line > skip_rows as u64 && !row.iter().all(RawCell::is_empty) {
            raw.push(row);
        }
        Ok(raw.len() <= PREVIEW_ROWS)
    })?;

    let header_row = settings
        .header_row
        .unwrap_or_else(|| raw.first().is_some_and(|r| looks_like_header(r)));
    let header = if header_row && !raw.is_empty() { Some(raw.remove(0)) } else { None };
    raw.truncate(PREVIEW_ROWS);

    let decimal = settings.decimal.unwrap_or_else(|| match &format {
        FileFormat::Csv { delimiter: ',', .. } => '.',
        _ => detect_decimal(&raw),
    });

    let ncols = raw.iter().chain(header.iter()).map(Vec::len).max().unwrap_or(0);
    let names = column_names(header.as_deref(), ncols);
    let columns = names
        .into_iter()
        .enumerate()
        .map(|(i, name)| {
            let sample: Vec<&RawCell> = raw.iter().filter_map(|r| r.get(i)).collect();
            let (kind, datetime_format) = infer_kind(&sample, decimal);
            ColumnSpec { source_index: i, name, kind, datetime_format }
        })
        .collect();

    let rows = raw
        .iter()
        .map(|r| (0..ncols).map(|i| r.get(i).map(RawCell::display).unwrap_or_default()).collect())
        .collect();

    Ok(Preview {
        format,
        sheets,
        decimal,
        header_row,
        skip_rows,
        columns,
        rows,
        suggested_table_name: unique_table_name(conn, path)?,
    })
}

/// Imports the whole file into a new table. `on_progress` receives the number of rows written.
pub fn run(
    conn: &mut Connection,
    path: &Path,
    opts: &ImportOptions,
    mut on_progress: impl FnMut(u64),
) -> AppResult<ImportResult> {
    let table_name = opts.table_name.trim();
    if table_name.is_empty() {
        return Err(AppError::InvalidInput("table name is empty".into()));
    }
    if tables::name_exists(conn, table_name)? {
        return Err(AppError::InvalidInput(format!("a table named \"{table_name}\" already exists")));
    }
    let tz: Tz = opts
        .timezone
        .parse()
        .map_err(|_| AppError::InvalidInput(format!("unknown time zone \"{}\"", opts.timezone)))?;
    let cols: Vec<&ColumnSpec> = opts.columns.iter().filter(|c| c.kind != ColumnKind::Skip).collect();
    if cols.is_empty() {
        return Err(AppError::InvalidInput("no columns selected for import".into()));
    }
    let mut seen = HashSet::new();
    for c in &cols {
        let name = c.name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput(format!("column {} has no name", c.source_index + 1)));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(AppError::InvalidInput(format!("duplicate column name \"{name}\"")));
        }
    }

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO data_table (name, source_path, import_options, row_count, imported_at)
         VALUES (?1, ?2, ?3, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![table_name, path.display().to_string(), serde_json::to_string(opts)?],
    )?;
    let id = tx.last_insert_rowid();

    let mut col_defs = vec!["_row INTEGER PRIMARY KEY".to_owned()];
    for (ordinal, c) in cols.iter().enumerate() {
        let (kind_name, sql_type) = kind_sql(c.kind);
        tx.execute(
            "INSERT INTO data_column (table_id, ordinal, name, kind) VALUES (?1, ?2, ?3, ?4)",
            params![id, ordinal as i64, c.name.trim(), kind_name],
        )?;
        col_defs.push(format!("{} {sql_type}", column_sql_name(ordinal)));
    }
    tx.execute_batch(&format!(
        "CREATE TABLE \"{}\" ({})",
        data_table_name(id),
        col_defs.join(", ")
    ))?;

    let placeholders = vec!["?"; cols.len()].join(", ");
    let insert_sql = format!(
        "INSERT INTO \"{}\" ({}) VALUES ({placeholders})",
        data_table_name(id),
        (0..cols.len()).map(column_sql_name).collect::<Vec<_>>().join(", ")
    );

    let mut localizers: Vec<Localizer> = cols.iter().map(|_| Localizer::new(tz)).collect();
    let mut invalid: Vec<(u64, Vec<String>)> = vec![(0, Vec::new()); cols.len()];
    let mut written: u64 = 0;
    {
        let mut stmt = tx.prepare(&insert_sql)?;
        let mut header_pending = opts.header_row;
        source::read_rows(path, &opts.format, |line, row| {
            if line <= opts.skip_rows as u64 || row.iter().all(RawCell::is_empty) {
                return Ok(true);
            }
            // The header is the first non-empty row after the skipped rows (matches preview).
            if header_pending {
                header_pending = false;
                return Ok(true);
            }
            let values: Vec<Value> = cols
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let cell = row.get(c.source_index).unwrap_or(&RawCell::Empty);
                    match convert_cell(cell, c.kind, opts.decimal, c.datetime_format.as_deref(), &mut localizers[i]) {
                        Converted::Null => Value::Null,
                        Converted::Real(f) => Value::Real(f),
                        Converted::Text(s) => Value::Text(s),
                        Converted::Time(ms) => Value::Integer(ms),
                        Converted::Invalid => {
                            let (count, examples) = &mut invalid[i];
                            *count += 1;
                            if examples.len() < MAX_WARNING_EXAMPLES {
                                examples.push(format!("row {line}: \"{}\"", cell.display()));
                            }
                            Value::Null
                        }
                    }
                })
                .collect();
            stmt.execute(params_from_iter(values))?;
            written += 1;
            if written % PROGRESS_EVERY == 0 {
                on_progress(written);
            }
            Ok(true)
        })?;
    }
    tx.execute("UPDATE data_table SET row_count = ?1 WHERE id = ?2", params![written as i64, id])?;
    tx.commit()?;
    on_progress(written);

    let mut warnings = Vec::new();
    for (i, c) in cols.iter().enumerate() {
        let (count, examples) = &invalid[i];
        if *count > 0 {
            warnings.push(format!(
                "{}: {count} value(s) could not be read as {} and were left empty (e.g. {})",
                c.name.trim(),
                kind_sql(c.kind).0,
                examples.join(", ")
            ));
        }
        let loc = &localizers[i];
        if loc.ambiguous > 0 {
            warnings.push(format!(
                "{}: {} timestamp(s) fell in the repeated hour when DST ended; resolved by row order",
                c.name.trim(),
                loc.ambiguous
            ));
        }
        if loc.nonexistent > 0 {
            warnings.push(format!(
                "{}: {} timestamp(s) fell in the skipped hour when DST started; shifted forward 1 hour",
                c.name.trim(),
                loc.nonexistent
            ));
        }
    }

    Ok(ImportResult { table: tables::get(conn, id)?, warnings })
}

/// A first row whose non-empty cells are all non-numeric text is taken as a header.
fn looks_like_header(row: &[RawCell]) -> bool {
    let cells: Vec<&RawCell> = row.iter().filter(|c| !c.is_empty()).collect();
    !cells.is_empty()
        && cells.iter().all(|c| {
            matches!(c, RawCell::Text(s) if parse_number(s, '.').is_none() && parse_number(s, ',').is_none())
        })
}

fn detect_decimal(rows: &[Vec<RawCell>]) -> char {
    let (mut comma, mut dot) = (0, 0);
    for cell in rows.iter().flatten() {
        if let RawCell::Text(s) = cell {
            if looks_decimal(s.trim(), ',') {
                comma += 1;
            } else if looks_decimal(s.trim(), '.') {
                dot += 1;
            }
        }
    }
    if comma > dot { ',' } else { '.' }
}

/// `-12,5` style: optional sign, digits, exactly one separator, digits.
fn looks_decimal(s: &str, sep: char) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    match s.split_once(sep) {
        Some((a, b)) => {
            !a.is_empty()
                && !b.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// Names from the header row; blanks become "Column N" and duplicates get a suffix.
fn column_names(header: Option<&[RawCell]>, ncols: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    (0..ncols)
        .map(|i| {
            let base = header
                .and_then(|h| h.get(i))
                .map(|c| c.display().trim().to_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Column {}", i + 1));
            let mut name = base.clone();
            let mut n = 2;
            while !seen.insert(name.to_lowercase()) {
                name = format!("{base} ({n})");
                n += 1;
            }
            name
        })
        .collect()
}

fn unique_table_name(conn: &Connection, path: &Path) -> AppResult<String> {
    let base = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Table").to_owned();
    let mut name = base.clone();
    let mut n = 2;
    while tables::name_exists(conn, &name)? {
        name = format!("{base} ({n})");
        n += 1;
    }
    Ok(name)
}

#[cfg(test)]
mod tests;
