use std::sync::Mutex;

use crate::domain::project::Project;
use crate::sidecar::Sidecar;

/// Process-wide state owned by the Rust core. One window = one project.
#[derive(Default)]
pub struct AppState {
    pub project: Mutex<Option<Project>>,
    pub sidecar: Mutex<Option<Sidecar>>,
}
