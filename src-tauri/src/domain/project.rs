use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use super::db;
use crate::error::{AppError, AppResult};

/// An open project: one SQLite file holding all project data.
pub struct Project {
    pub path: PathBuf,
    pub conn: Connection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub created_at: String,
    pub schema_version: usize,
}

impl Project {
    pub fn create(path: &Path, name: &str) -> AppResult<Self> {
        if path.exists() {
            return Err(AppError::InvalidInput(format!(
                "file already exists: {}",
                path.display()
            )));
        }
        let mut conn = Connection::open(path)?;
        configure(&conn)?;
        db::migrate(&mut conn)?;
        conn.execute(
            "INSERT INTO project_meta (key, value) VALUES
                ('name', ?1),
                ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [name],
        )?;
        Ok(Self { path: path.to_path_buf(), conn })
    }

    pub fn open(path: &Path) -> AppResult<Self> {
        let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        configure(&conn)?;
        let has_meta: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_meta')",
            [],
            |r| r.get(0),
        )?;
        if !has_meta {
            return Err(AppError::InvalidInput(format!(
                "not a DigitalTwin project: {}",
                path.display()
            )));
        }
        db::migrate(&mut conn)?;
        Ok(Self { path: path.to_path_buf(), conn })
    }

    pub fn info(&self) -> AppResult<ProjectInfo> {
        Ok(ProjectInfo {
            path: self.path.display().to_string(),
            name: self.meta("name")?.unwrap_or_default(),
            created_at: self.meta("created_at")?.unwrap_or_default(),
            schema_version: db::schema_version(),
        })
    }

    fn meta(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM project_meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_open_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("roundtrip.sqlite");
        let _ = std::fs::remove_file(&path);

        let created = Project::create(&path, "Plant A").unwrap();
        assert_eq!(created.info().unwrap().name, "Plant A");
        drop(created);

        let opened = Project::open(&path).unwrap();
        assert_eq!(opened.info().unwrap().name, "Plant A");
        assert!(Project::create(&path, "dup").is_err());

        drop(opened);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
