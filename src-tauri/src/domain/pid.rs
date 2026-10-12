//! P&ID diagrams: equipment, valves, instruments and the lines between them.
//!
//! The editor saves whole diagrams (`save` replaces all elements and connections in one
//! transaction); the normalised tables keep the content queryable, e.g. which column an
//! instrument is linked to.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Symbol kinds known to the editor. Keep in sync with `src/pid/symbols.tsx`.
pub const ELEMENT_KINDS: &[&str] = &[
    "column",
    "vessel",
    "tank",
    "pump",
    "heat_exchanger",
    "valve",
    "control_valve",
    "instrument",
    "connector",
    "label",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    /// Process line (pipe).
    Process,
    /// Instrument signal line.
    Signal,
}

impl ConnectionKind {
    fn as_str(self) -> &'static str {
        match self {
            ConnectionKind::Process => "process",
            ConnectionKind::Signal => "signal",
        }
    }
}

/// A data column, by table id and zero-based column position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub table_id: i64,
    pub ordinal: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    pub kind: String,
    /// Plant tag, e.g. "C-101" or "TI-101".
    #[serde(default)]
    pub tag: String,
    /// Free description, e.g. "Destillationskolonne".
    #[serde(default)]
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub rotation: i64,
    /// Kind-specific settings (e.g. instrument location).
    #[serde(default = "empty_object")]
    pub props: Value,
    #[serde(default)]
    pub column: Option<ColumnRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PidConnection {
    pub id: String,
    pub kind: ConnectionKind,
    pub source: String,
    #[serde(default)]
    pub source_handle: Option<String>,
    pub target: String,
    #[serde(default)]
    pub target_handle: Option<String>,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagram {
    pub id: i64,
    pub name: String,
    pub elements: Vec<Element>,
    pub connections: Vec<PidConnection>,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

/// The project's main diagram, created empty on first use.
pub fn get_or_create_main(conn: &Connection) -> AppResult<Diagram> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM pid_diagram ORDER BY id LIMIT 1", [], |r| r.get(0))
        .optional()?;
    let id = match id {
        Some(id) => id,
        None => {
            conn.execute(
                "INSERT INTO pid_diagram (name, updated_at)
                 VALUES ('P&ID', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [],
            )?;
            conn.last_insert_rowid()
        }
    };
    get(conn, id)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Diagram> {
    let name: String = conn
        .query_row("SELECT name FROM pid_diagram WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::InvalidInput(format!("no diagram with id {id}")))?;

    let mut stmt = conn.prepare(
        "SELECT id, kind, tag, label, x, y, width, height, rotation, props, table_id, column_ordinal
         FROM pid_element WHERE diagram_id = ?1 ORDER BY rowid",
    )?;
    let elements = stmt
        .query_map([id], |r| {
            let props: String = r.get(9)?;
            let table_id: Option<i64> = r.get(10)?;
            let ordinal: Option<i64> = r.get(11)?;
            Ok(Element {
                id: r.get(0)?,
                kind: r.get(1)?,
                tag: r.get(2)?,
                label: r.get(3)?,
                x: r.get(4)?,
                y: r.get(5)?,
                width: r.get(6)?,
                height: r.get(7)?,
                rotation: r.get(8)?,
                props: serde_json::from_str(&props).unwrap_or_else(|_| empty_object()),
                column: table_id.zip(ordinal).map(|(table_id, ordinal)| ColumnRef { table_id, ordinal }),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, kind, source_id, source_handle, target_id, target_handle, label
         FROM pid_connection WHERE diagram_id = ?1 ORDER BY rowid",
    )?;
    let connections = stmt
        .query_map([id], |r| {
            let kind: String = r.get(1)?;
            Ok(PidConnection {
                id: r.get(0)?,
                kind: if kind == "signal" { ConnectionKind::Signal } else { ConnectionKind::Process },
                source: r.get(2)?,
                source_handle: r.get(3)?,
                target: r.get(4)?,
                target_handle: r.get(5)?,
                label: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Diagram { id, name, elements, connections })
}

/// Replaces the diagram's content with `diagram` after validating it.
pub fn save(conn: &mut Connection, diagram: &Diagram) -> AppResult<()> {
    validate(conn, diagram)?;
    let tx = conn.transaction()?;
    let updated = tx.execute(
        "UPDATE pid_diagram SET name = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?2",
        params![diagram.name, diagram.id],
    )?;
    if updated == 0 {
        return Err(AppError::InvalidInput(format!("no diagram with id {}", diagram.id)));
    }
    // Deleting elements cascades to their connections.
    tx.execute("DELETE FROM pid_element WHERE diagram_id = ?1", [diagram.id])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO pid_element
             (diagram_id, id, kind, tag, label, x, y, width, height, rotation, props, table_id, column_ordinal)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for e in &diagram.elements {
            insert.execute(params![
                diagram.id,
                e.id,
                e.kind,
                e.tag,
                e.label,
                e.x,
                e.y,
                e.width,
                e.height,
                e.rotation,
                e.props.to_string(),
                e.column.map(|c| c.table_id),
                e.column.map(|c| c.ordinal),
            ])?;
        }
        let mut insert = tx.prepare(
            "INSERT INTO pid_connection
             (diagram_id, id, kind, source_id, source_handle, target_id, target_handle, label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for c in &diagram.connections {
            insert.execute(params![
                diagram.id,
                c.id,
                c.kind.as_str(),
                c.source,
                c.source_handle,
                c.target,
                c.target_handle,
                c.label,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn validate(conn: &Connection, d: &Diagram) -> AppResult<()> {
    let invalid = |msg: String| Err(AppError::InvalidInput(msg));
    let mut ids = HashSet::new();
    for e in &d.elements {
        if !ids.insert(e.id.as_str()) {
            return invalid(format!("duplicate element id \"{}\"", e.id));
        }
        if !ELEMENT_KINDS.contains(&e.kind.as_str()) {
            return invalid(format!("unknown element kind \"{}\"", e.kind));
        }
        if ![0, 90, 180, 270].contains(&e.rotation) {
            return invalid(format!("rotation must be 0, 90, 180 or 270 (got {})", e.rotation));
        }
        if !(e.width > 0.0 && e.height > 0.0) {
            return invalid(format!("element \"{}\" must have a positive size", e.id));
        }
        if !e.props.is_object() {
            return invalid(format!("props of element \"{}\" must be an object", e.id));
        }
        if let Some(c) = e.column {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM data_column WHERE table_id = ?1 AND ordinal = ?2)",
                params![c.table_id, c.ordinal],
                |r| r.get(0),
            )?;
            if !exists {
                return invalid(format!("element \"{}\" links to a column that does not exist", e.id));
            }
        }
    }
    let mut conn_ids = HashSet::new();
    for c in &d.connections {
        if !conn_ids.insert(c.id.as_str()) {
            return invalid(format!("duplicate connection id \"{}\"", c.id));
        }
        for end in [&c.source, &c.target] {
            if !ids.contains(end.as_str()) {
                return invalid(format!("connection \"{}\" refers to missing element \"{end}\"", c.id));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::project::Project;
    use serde_json::json;

    fn project(dir: &std::path::Path) -> Project {
        Project::create(&dir.join("p.dtwin"), "Test").unwrap()
    }

    fn element(id: &str, kind: &str) -> Element {
        Element {
            id: id.into(),
            kind: kind.into(),
            tag: String::new(),
            label: String::new(),
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 40.0,
            rotation: 0,
            props: json!({}),
            column: None,
        }
    }

    fn line(id: &str, kind: ConnectionKind, from: &str, to: &str) -> PidConnection {
        PidConnection {
            id: id.into(),
            kind,
            source: from.into(),
            source_handle: Some("r".into()),
            target: to.into(),
            target_handle: None,
            label: String::new(),
        }
    }

    /// A one-column table to link instruments to.
    fn add_table(p: &Project) -> i64 {
        p.conn
            .execute_batch(
                "INSERT INTO data_table (id, name, import_options, row_count, imported_at)
                 VALUES (7, 'scada', '{}', 0, 'now');
                 INSERT INTO data_column (table_id, ordinal, name, kind) VALUES (7, 0, 'T', 'number');",
            )
            .unwrap();
        7
    }

    #[test]
    fn creates_empty_main_diagram_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = project(dir.path());
        let a = get_or_create_main(&p.conn).unwrap();
        let b = get_or_create_main(&p.conn).unwrap();
        assert_eq!(a.id, b.id);
        assert!(a.elements.is_empty());
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = project(dir.path());
        let table_id = add_table(&p);
        let mut d = get_or_create_main(&p.conn).unwrap();

        let mut col = element("c1", "column");
        col.tag = "C-101".into();
        col.rotation = 90;
        let mut ti = element("i1", "instrument");
        ti.tag = "TI-101".into();
        ti.props = json!({ "location": "dcs" });
        ti.column = Some(ColumnRef { table_id, ordinal: 0 });
        d.elements = vec![col, ti, element("v1", "valve")];
        d.connections = vec![
            line("e1", ConnectionKind::Process, "c1", "v1"),
            line("e2", ConnectionKind::Signal, "i1", "c1"),
        ];
        save(&mut p.conn, &d).unwrap();
        assert_eq!(get(&p.conn, d.id).unwrap(), d);

        // Saving again replaces content.
        d.elements.truncate(1);
        d.connections.clear();
        save(&mut p.conn, &d).unwrap();
        assert_eq!(get(&p.conn, d.id).unwrap().elements.len(), 1);
    }

    #[test]
    fn deleting_table_clears_column_link() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = project(dir.path());
        let table_id = add_table(&p);
        let mut d = get_or_create_main(&p.conn).unwrap();
        let mut ti = element("i1", "instrument");
        ti.column = Some(ColumnRef { table_id, ordinal: 0 });
        d.elements = vec![ti];
        save(&mut p.conn, &d).unwrap();

        crate::domain::tables::delete(&mut p.conn, table_id).unwrap();
        let loaded = get(&p.conn, d.id).unwrap();
        assert_eq!(loaded.elements.len(), 1, "element kept");
        assert_eq!(loaded.elements[0].column, None, "link cleared");
    }

    #[test]
    fn rejects_invalid_diagrams() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = project(dir.path());
        let base = get_or_create_main(&p.conn).unwrap();

        let mut d = base.clone();
        d.elements = vec![element("a", "spaceship")];
        assert!(save(&mut p.conn, &d).is_err(), "unknown kind");

        let mut d = base.clone();
        d.elements = vec![element("a", "pump")];
        d.connections = vec![line("e", ConnectionKind::Process, "a", "missing")];
        assert!(save(&mut p.conn, &d).is_err(), "dangling connection");

        let mut d = base.clone();
        let mut ti = element("a", "instrument");
        ti.column = Some(ColumnRef { table_id: 99, ordinal: 0 });
        d.elements = vec![ti];
        assert!(save(&mut p.conn, &d).is_err(), "missing column");

        let mut d = base;
        let mut v = element("a", "valve");
        v.rotation = 45;
        d.elements = vec![v];
        assert!(save(&mut p.conn, &d).is_err(), "bad rotation");
    }
}
