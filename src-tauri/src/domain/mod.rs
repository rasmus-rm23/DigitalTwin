//! Domain core. Every user action is a function here; Tauri commands and
//! (later) MCP tools are thin wrappers over it.

pub mod db;
pub mod project;
