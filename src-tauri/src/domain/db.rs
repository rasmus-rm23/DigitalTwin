//! SQLite schema migrations for the project file.
//!
//! Migrations are applied in order and tracked with `PRAGMA user_version`.
//! Never edit an existing migration — append a new one.

use rusqlite::Connection;

use crate::error::AppResult;

const MIGRATIONS: &[&str] = &[
    // 1: project metadata
    r#"
    CREATE TABLE project_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // 2: imported data tables. Each table's rows live in `data_<id>` with columns
    //    c0, c1, ... (REAL for number, TEXT for text, INTEGER epoch ms UTC for datetime).
    r#"
    CREATE TABLE data_table (
        id             INTEGER PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
        source_path    TEXT,
        import_options TEXT NOT NULL,
        row_count      INTEGER NOT NULL,
        imported_at    TEXT NOT NULL
    );
    CREATE TABLE data_column (
        table_id INTEGER NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
        ordinal  INTEGER NOT NULL,
        name     TEXT NOT NULL,
        kind     TEXT NOT NULL CHECK (kind IN ('number', 'text', 'datetime')),
        PRIMARY KEY (table_id, ordinal)
    );
    "#,
    // 3: P&ID diagrams. Element/connection ids are client-generated strings.
    //    An element may link to a data column; deleting the table clears the link.
    r#"
    CREATE TABLE pid_diagram (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE pid_element (
        diagram_id     INTEGER NOT NULL REFERENCES pid_diagram(id) ON DELETE CASCADE,
        id             TEXT NOT NULL,
        kind           TEXT NOT NULL,
        tag            TEXT NOT NULL DEFAULT '',
        label          TEXT NOT NULL DEFAULT '',
        x              REAL NOT NULL,
        y              REAL NOT NULL,
        width          REAL NOT NULL,
        height         REAL NOT NULL,
        rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
        props          TEXT NOT NULL DEFAULT '{}',
        table_id       INTEGER,
        column_ordinal INTEGER,
        PRIMARY KEY (diagram_id, id),
        FOREIGN KEY (table_id, column_ordinal)
            REFERENCES data_column(table_id, ordinal) ON DELETE SET NULL
    );
    CREATE TABLE pid_connection (
        diagram_id    INTEGER NOT NULL REFERENCES pid_diagram(id) ON DELETE CASCADE,
        id            TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('process', 'signal')),
        source_id     TEXT NOT NULL,
        source_handle TEXT,
        target_id     TEXT NOT NULL,
        target_handle TEXT,
        label         TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (diagram_id, id),
        FOREIGN KEY (diagram_id, source_id) REFERENCES pid_element(diagram_id, id) ON DELETE CASCADE,
        FOREIGN KEY (diagram_id, target_id) REFERENCES pid_element(diagram_id, id) ON DELETE CASCADE
    );
    "#,
    // 4: plot sheets. The sheet configuration (source, batches, plots) is one JSON document,
    //    validated by `domain::plots`.
    r#"
    CREATE TABLE plot_sheet (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        config     TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
    // 5: ML models. `config` is the editable definition; `trained_config` is the definition the
    //    stored result/artifact were trained with. `artifact` is the base64 pickled model.
    r#"
    CREATE TABLE model (
        id             INTEGER PRIMARY KEY,
        name           TEXT NOT NULL,
        config         TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'trained', 'failed')),
        trained_config TEXT,
        result         TEXT,
        artifact       TEXT,
        error          TEXT,
        trained_at     TEXT,
        updated_at     TEXT NOT NULL
    );
    "#,
];

pub fn migrate(conn: &mut Connection) -> AppResult<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn schema_version() -> usize {
    MIGRATIONS.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_db_to_latest() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v as usize, schema_version());
        // Re-running is a no-op.
        migrate(&mut conn).unwrap();
    }
}
