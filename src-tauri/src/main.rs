#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, State, WindowEvent};

const TRAY_ID: &str = "remotegit";

#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    host: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    #[serde(default)]
    forward_agent: bool,
    /// Repositories on this computer: a local shell instead of SSH.
    #[serde(default)]
    local: bool,
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
        if t.local {
            return ssh::Session::spawn(ssh::local_shell()?);
        }
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
    // Both windows connect to the same servers; reuse a live session.
    let existing = state.0.lock().map_err(|_| "State lock poisoned")?.get(&id).cloned();
    if let Some(conn) = existing.filter(|c| c.target == target) {
        return blocking(move || conn.exec("true", Duration::from_secs(30)).map(|_| ())).await;
    }
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

/// Whether the app lives only in the menu bar / system tray.
#[derive(Default)]
struct MenuBarOnly(AtomicBool);

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Opens the small tray window next to the icon: below it for the macOS menu
/// bar, above it for a taskbar at the bottom of the screen.
fn toggle_tray_window(app: &AppHandle, rect: Rect) {
    let Some(win) = app.get_webview_window("tray") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos: PhysicalPosition<f64> = rect.position.to_physical(scale);
    let icon: PhysicalSize<f64> = rect.size.to_physical(scale);
    let size = win.outer_size().unwrap_or_default();
    let x = pos.x + icon.width / 2.0 - size.width as f64 / 2.0;
    let y = if pos.y < 200.0 {
        pos.y + icon.height + 4.0
    } else {
        pos.y - size.height as f64 - 4.0
    };
    let _ = win.set_position(PhysicalPosition::new(x.max(0.0), y.max(0.0)));
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// The number next to the menu bar icon (macOS) / the tooltip (Windows).
#[tauri::command]
fn set_tray_status(app: AppHandle, title: Option<String>, tooltip: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(title.filter(|t| !t.is_empty()));
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[tauri::command]
fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(w) = app.get_webview_window("tray") {
            let _ = w.hide();
        }
    }
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => tray.set_visible(visible).map_err(|e| e.to_string()),
        None if visible => build_tray(&app).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
fn set_menu_bar_only(app: AppHandle, state: State<'_, MenuBarOnly>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let policy = if enabled { tauri::ActivationPolicy::Accessory } else { tauri::ActivationPolicy::Regular };
        let _ = app.set_activation_policy(policy);
        if !enabled {
            show_main(&app);
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(enabled);
    }
}

/// Created on first use: the icon only appears once the user turns it on.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open RemoteGit", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit RemoteGit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("RemoteGit")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                toggle_tray_window(tray.app_handle(), rect);
            }
        });
    // A black template image adapts to light and dark menu bars on macOS;
    // the Windows tray gets the full-color app icon.
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Conns::default())
        .manage(MenuBarOnly::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if window.label() == "tray" {
                    api.prevent_close();
                    let _ = window.hide();
                } else if app.state::<MenuBarOnly>().0.load(Ordering::Relaxed) {
                    // In menu bar mode closing the window keeps the app in the tray.
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_exec,
            ssh_disconnect,
            show_main_window,
            set_tray_status,
            set_tray_visible,
            set_menu_bar_only
        ])
        .run(tauri::generate_context!())
        .expect("error while running RemoteGit");
}
