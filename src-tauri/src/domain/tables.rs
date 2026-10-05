//! Catalog of imported data tables and access to their rows.
//!
//! All SQL against `data_<id>` tables goes through this module so the storage
//! layout can change (e.g. to Parquet) without touching callers.

use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::import::convert::ColumnKind;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub kind: ColumnKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub id: i64,
    pub name: String,
    pub source_path: Option<String>,
    pub row_count: i64,
    pub imported_at: String,
    pub columns: Vec<ColumnInfo>,
}

pub(crate) fn data_table_name(id: i64) -> String {
    format!("data_{id}")
}

pub(crate) fn column_sql_name(ordinal: usize) -> String {
    format!("c{ordinal}")
}

pub(crate) fn kind_sql(kind: ColumnKind) -> (&'static str, &'static str) {
    match kind {
        ColumnKind::Number => ("number", "REAL"),
        ColumnKind::Datetime => ("datetime", "INTEGER"),
        ColumnKind::Text | ColumnKind::Skip => ("text", "TEXT"),
    }
}

fn parse_kind(s: &str) -> ColumnKind {
    match s {
        "number" => ColumnKind::Number,
        "datetime" => ColumnKind::Datetime,
        _ => ColumnKind::Text,
    }
}

pub fn name_exists(conn: &Connection, name: &str) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM data_table WHERE name = ?1)", [name], |r| r.get(0))?)
}

pub fn list(conn: &Connection) -> AppResult<Vec<TableInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, source_path, row_count, imported_at FROM data_table ORDER BY name",
    )?;
    let mut tables = stmt
        .query_map([], |r| {
            Ok(TableInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                source_path: r.get(2)?,
                row_count: r.get(3)?,
                imported_at: r.get(4)?,
                columns: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for t in &mut tables {
        t.columns = columns(conn, t.id)?;
    }
    Ok(tables)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<TableInfo> {
    list(conn)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("no table with id {id}")))
}

fn columns(conn: &Connection, table_id: i64) -> AppResult<Vec<ColumnInfo>> {
    let mut stmt =
        conn.prepare("SELECT name, kind FROM data_column WHERE table_id = ?1 ORDER BY ordinal")?;
    let cols = stmt
        .query_map([table_id], |r| {
            Ok(ColumnInfo { name: r.get(0)?, kind: parse_kind(&r.get::<_, String>(1)?) })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(cols)
}

/// A page of rows in import order. Datetime cells are epoch ms (UTC).
pub fn rows(conn: &Connection, id: i64, offset: i64, limit: i64) -> AppResult<Vec<Vec<Value>>> {
    let exists: Option<i64> =
        conn.query_row("SELECT id FROM data_table WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    if exists.is_none() {
        return Err(AppError::InvalidInput(format!("no table with id {id}")));
    }
    let ncols = columns(conn, id)?.len();
    let select = (0..ncols).map(column_sql_name).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT {select} FROM \"{}\" ORDER BY _row LIMIT ?1 OFFSET ?2",
        data_table_name(id)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            (0..ncols)
                .map(|i| {
                    Ok(match r.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => Value::from(n),
                        ValueRef::Real(f) => Value::from(f),
                        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
                        ValueRef::Blob(_) => Value::Null,
                    })
                })
                .collect::<Result<Vec<_>, rusqlite::Error>>()
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete(conn: &mut Connection, id: i64) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute(&format!("DROP TABLE IF EXISTS \"{}\"", data_table_name(id)), [])?;
    if tx.execute("DELETE FROM data_table WHERE id = ?1", [id])? == 0 {
        return Err(AppError::InvalidInput(format!("no table with id {id}")));
    }
    tx.commit()?;
    Ok(())
}
