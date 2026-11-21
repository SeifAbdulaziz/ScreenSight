use tauri::Manager;

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
    // In later phases, close will hide to system tray. For Phase 1, we close/hide gracefully.
    let _ = window.close();
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
            // When a secondary instance launches, bring the main window to front.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize_window,
            close_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScreenSight Tauri application");
}
