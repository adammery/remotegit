#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    host: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    #[serde(default)]
    forward_agent: bool,
}

#[derive(Serialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    code: i32,
}

/// A server the UI talks to. The SSH process is (re)started lazily.
struct Conn {
    target: Target,
    session: Mutex<Option<ssh::Session>>,
}

impl Conn {
    fn spawn(&self) -> Result<ssh::Session, String> {
        let t = &self.target;
        let cmd = ssh::ssh_command(
            &t.host,
            t.user.as_deref(),
            t.port,
            t.identity_file.as_deref(),
            t.forward_agent,
        )?;
        ssh::Session::spawn(cmd)
    }

    fn exec(&self, script: &str, timeout: Duration) -> Result<ExecResult, String> {
        let mut guard = self.session.lock().map_err(|_| "Session lock poisoned")?;
        // Reconnect only when the old process is known to be gone before the
        // command is sent, so a non-idempotent command never runs twice.
        if !guard.as_mut().is_some_and(|s| s.is_alive()) {
            *guard = Some(self.spawn()?);
        }
        let session = guard.as_mut().expect("session present");
        session.exec(script, timeout).map(|o| ExecResult {
            stdout: o.stdout,
            stderr: o.stderr,
            code: o.code,
        })
    }
}

#[derive(Default)]
struct Conns(Mutex<HashMap<String, Arc<Conn>>>);

impl Conns {
    fn get(&self, id: &str) -> Result<Arc<Conn>, String> {
        self.0
            .lock()
            .map_err(|_| "State lock poisoned")?
            .get(id)
            .cloned()
            .ok_or_else(|| "Not connected to this server".to_string())
    }
}

/// SSH work blocks, so keep it off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_connect(state: State<'_, Conns>, id: String, target: Target) -> Result<(), String> {
    let conn = Arc::new(Conn { target, session: Mutex::new(None) });
    state
        .0
        .lock()
        .map_err(|_| "State lock poisoned")?
        .insert(id, conn.clone());
    blocking(move || conn.exec("true", Duration::from_secs(30)).map(|_| ())).await
}

#[tauri::command]
async fn ssh_exec(
    state: State<'_, Conns>,
    id: String,
    script: String,
    timeout_secs: Option<u64>,
) -> Result<ExecResult, String> {
    let conn = state.get(&id)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(60));
    blocking(move || conn.exec(&script, timeout)).await
}

#[tauri::command]
fn ssh_disconnect(state: State<'_, Conns>, id: String) {
    if let Ok(mut map) = state.0.lock() {
        map.remove(&id);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Conns::default())
        .invoke_handler(tauri::generate_handler![ssh_connect, ssh_exec, ssh_disconnect])
        .run(tauri::generate_context!())
        .expect("error while running RemoteGit");
}
