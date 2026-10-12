//! Domain core. Every user action is a function here; Tauri commands and
//! (later) MCP tools are thin wrappers over it.

pub mod column_type;
pub mod db;
pub mod import;
pub mod pid;
pub mod project;
pub mod tables;
