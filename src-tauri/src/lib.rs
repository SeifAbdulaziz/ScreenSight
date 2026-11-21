pub mod win32_focus;

use tauri::Manager;
use win32_focus::{SystemMonitor, TopWindowInfo};

// ==============================================================================
// Frameless Window Control Commands
// Since decorations are set to false in tauri.conf.json, the frontend TitleBar
// triggers these Rust commands to minimize, toggle maximize, or hide/close the window.
// ==============================================================================

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) {
    if let Ok(is_maximized) = window.is_maximized() {
        if is_maximized {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

// ==============================================================================
// Phase 2: Win32 Multi-Monitor & Focus IPC Commands
// ==============================================================================

/// Queries real Windows display topology and virtual desktop coordinates (osRect).
#[tauri::command]
fn get_system_monitors() -> Vec<SystemMonitor> {
    win32_focus::get_system_monitors()
}

/// Shifts OS keyboard and window focus to the top visible application on the target monitor.
/// Bypasses the Windows foreground lock via input queue attachment and respects gaming auto-pause.
#[tauri::command]
fn debug_focus_monitor(
    monitor_id: String,
    teleport_cursor: bool,
    excluded_processes: Option<Vec<String>>,
) -> Result<Option<TopWindowInfo>, String> {
    let exclusions = excluded_processes.unwrap_or_default();
    win32_focus::switch_focus_to_monitor(&monitor_id, teleport_cursor, &exclusions)
}

/// Checks whether an exclusive DirectX/Direct3D fullscreen game is currently active.
#[tauri::command]
fn check_fullscreen_state() -> bool {
    win32_focus::is_fullscreen_game_active()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ----------------------------------------------------------------------
        // 1. Single-Instance Lock (CRITICAL GUARDRAIL)
        // Must be registered FIRST so secondary processes exit immediately,
        // refocusing the primary instance instead of opening duplicate hooks.
        // ----------------------------------------------------------------------
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize_window,
            close_window,
            get_system_monitors,
            debug_focus_monitor,
            check_fullscreen_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScreenSight Tauri application");
}
