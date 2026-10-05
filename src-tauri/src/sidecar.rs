//! Client for the Python data/ML sidecar: line-delimited JSON-RPC 2.0 over stdio.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

pub struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Sidecar {
    /// Dev launch: runs `python -m digitaltwin_sidecar` from `sidecar/`,
    /// preferring the project venv. Release packaging is not wired up yet.
    pub fn spawn() -> AppResult<Self> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar");
        let venv_python = dir.join(".venv/Scripts/python.exe");
        let python = if venv_python.exists() { venv_python } else { PathBuf::from("python") };

        let mut cmd = Command::new(python);
        cmd.args(["-m", "digitaltwin_sidecar"])
            .current_dir(&dir)
            .env("PYTHONPATH", dir.join("src"))
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Sidecar(format!("failed to start python sidecar: {e}")))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        Ok(Self { child, stdin, stdout, next_id: 1 })
    }

    pub fn call(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{req}")?;
        self.stdin.flush()?;

        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            return Err(AppError::Sidecar("sidecar exited".into()));
        }
        let resp: Value = serde_json::from_str(&line)?;
        if resp["id"] != json!(id) {
            return Err(AppError::Sidecar(format!("unexpected response id: {}", resp["id"])));
        }
        if let Some(err) = resp.get("error") {
            return Err(AppError::Sidecar(err["message"].as_str().unwrap_or("unknown").into()));
        }
        Ok(resp["result"].clone())
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
