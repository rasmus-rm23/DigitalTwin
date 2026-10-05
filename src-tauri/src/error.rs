use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("no project is open")]
    NoProject,
    #[error("{0}")]
    InvalidInput(String),
    #[error("sidecar error: {0}")]
    Sidecar(String),
    #[error("could not read file: {0}")]
    Parse(String),
}

impl From<calamine::Error> for AppError {
    fn from(e: calamine::Error) -> Self {
        AppError::Parse(e.to_string())
    }
}

/// Errors cross the Tauri/MCP boundary as `{ kind, message }`.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::NoProject => "noProject",
            AppError::InvalidInput(_) => "invalidInput",
            AppError::Sidecar(_) => "sidecar",
            AppError::Parse(_) => "parse",
        };
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
