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
