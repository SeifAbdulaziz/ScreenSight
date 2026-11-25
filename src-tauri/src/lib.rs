pub mod camera_guard;
pub mod state;
pub mod vision_worker;
pub mod win32_focus;

use camera_guard::{
    list_available_cameras, CameraActorHandle, CameraDeviceInfo, CameraStatus, SharedCameraState,
};
use state::{
    build_monitor_nodes, build_telemetry_payload, derive_tracker_status, load_persisted_config,
    save_persisted_config, sync_config_to_workers, AppConfig, DeskPoint, MonitorCalibration,
    MonitorNode, SharedAppConfig, TrackerStatus,
};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use vision_worker::{
    HeadPose, SharedVisionState, VisionConfig, VisionTelemetry, VisionWorkerHandle,
};
use win32_focus::{OsRect, SystemMonitor, TopWindowInfo};

struct TrayControls {
    status_item: MenuItem<Wry>,
    toggle_item: MenuItem<Wry>,
}

fn format_status_label(status: &TrackerStatus, fps: u32) -> String {
    match status {
        TrackerStatus::Active => format!("Status: Active ({fps} FPS)"),
        TrackerStatus::ManuallyPaused => "Status: Paused".to_string(),
        TrackerStatus::YieldedToApp(app) => format!("Status: Yielded ({app})"),
        TrackerStatus::PausedFullscreen => "Status: Gaming Paused".to_string(),
        TrackerStatus::NoCamera => "Status: Waiting for Camera".to_string(),
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn apply_tracking_enabled(app: &AppHandle, enabled: bool) {
    if let Some(vision) = app.try_state::<SharedVisionState>() {
        vision.0.set_tracking_enabled(enabled);
    }
    if let Some(tray) = app.try_state::<TrayControls>() {
        let label = if enabled {
            "Pause Tracking"
        } else {
            "Resume Tracking"
        };
        let _ = tray.toggle_item.set_text(label);
    }
    let status = if enabled {
        TrackerStatus::Active
    } else {
        TrackerStatus::ManuallyPaused
    };
    let _ = app.emit("screensight://status", status);
}

// ==============================================================================
// Frameless Window Control Commands
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
    // Hide to System Tray instead of terminating background gaze tracking.
    let _ = window.hide();
}

// ==============================================================================
// Phase 2: Win32 Multi-Monitor & Focus IPC Commands
// ==============================================================================

#[tauri::command]
fn get_system_monitors() -> Vec<SystemMonitor> {
    win32_focus::get_system_monitors()
}

#[tauri::command]
fn debug_focus_monitor(
    monitor_id: String,
    teleport_cursor: bool,
    excluded_processes: Option<Vec<String>>,
) -> Result<Option<TopWindowInfo>, String> {
    let exclusions = excluded_processes.unwrap_or_default();
    win32_focus::switch_focus_to_monitor(&monitor_id, teleport_cursor, &exclusions)
}

#[tauri::command]
fn check_fullscreen_state() -> bool {
    win32_focus::is_fullscreen_game_active()
}

// ==============================================================================
// Phase 3: Webcam Enumeration & Auto-Yield Guard IPC Commands
// ==============================================================================

#[tauri::command]
fn list_cameras() -> Result<Vec<CameraDeviceInfo>, String> {
    list_available_cameras()
}

#[tauri::command]
fn get_camera_status(state: tauri::State<'_, SharedCameraState>) -> CameraStatus {
    state.0.get_status()
}

#[tauri::command]
fn set_camera_config(
    camera_index: u32,
    target_fps: u32,
    auto_yield: bool,
    app: AppHandle,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    cam_state: tauri::State<'_, SharedCameraState>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> CameraStatus {
    if let Ok(mut cfg) = app_cfg.0.write() {
        cfg.camera_index = camera_index;
        cfg.target_fps = target_fps.clamp(5, 60);
        cfg.auto_yield_camera = auto_yield;
        let _ = save_persisted_config(&app, &cfg);
    }
    vision_state.0.update_target_fps(target_fps);
    cam_state.0.update_config(camera_index, target_fps, auto_yield)
}

#[tauri::command]
fn check_camera_conflict() -> Option<String> {
    camera_guard::get_other_active_camera_user()
}

// ==============================================================================
// Phase 4: Vision Pipeline Telemetry Commands
// ==============================================================================

#[tauri::command]
fn get_vision_telemetry(state: tauri::State<'_, SharedVisionState>) -> VisionTelemetry {
    state.0.get_telemetry()
}

#[tauri::command]
fn update_vision_config(
    mut config: VisionConfig,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    vision_state: tauri::State<'_, SharedVisionState>,
) {
    // Preserve persisted calibration anchors when caller sends uncalibrated monitor metadata.
    if let Ok(guard) = app_cfg.0.read() {
        for m in &mut config.monitors {
            if let Some(cal) = guard.monitor_configs.get(&m.id) {
                if m.anchor_yaw.is_none() {
                    m.anchor_yaw = cal.anchor_yaw;
                }
                if m.anchor_pitch.is_none() {
                    m.anchor_pitch = cal.anchor_pitch;
                }
            }
        }
    }
    vision_state.0.update_config(config);
}

#[tauri::command]
fn get_vision_config(state: tauri::State<'_, SharedVisionState>) -> VisionConfig {
    state.0.get_config()
}

// ==============================================================================
// Phase 5: Unified Config, Calibration, Desk Layout, Overlays & Store IPC
// ==============================================================================

/// Returns merged $N$-monitor nodes (`osRect`, `deskPos`, `enabled`, `anchor`, active window).
#[tauri::command]
fn get_monitors(
    app_cfg: tauri::State<'_, SharedAppConfig>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> Vec<MonitorNode> {
    let sys_monitors = win32_focus::get_system_monitors();
    let cfg = app_cfg
        .0
        .read()
        .map(|c| c.clone())
        .unwrap_or_default();
    let tel = vision_state.0.get_telemetry();
    let titles = win32_focus::find_top_windows_for_monitors(&sys_monitors, &cfg.excluded_processes);
    build_monitor_nodes(
        &sys_monitors,
        &cfg,
        tel.focused_monitor_id.as_deref(),
        Some(&titles),
    )
}

#[tauri::command]
fn get_config(app_cfg: tauri::State<'_, SharedAppConfig>) -> AppConfig {
    app_cfg.0.read().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
fn update_config(
    mut config: AppConfig,
    app: AppHandle,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    cam_state: tauri::State<'_, SharedCameraState>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> Result<AppConfig, String> {
    config.sanitize();
    if let Ok(mut guard) = app_cfg.0.write() {
        *guard = config.clone();
    }
    sync_config_to_workers(&config, &vision_state.0, &cam_state.0);
    save_persisted_config(&app, &config)?;
    let _ = app.emit("screensight://monitors-changed", ());
    Ok(config)
}

#[tauri::command]
fn set_tracking_enabled(enabled: bool, app: AppHandle) {
    apply_tracking_enabled(&app, enabled);
}

/// Samples head pose over 300 ms while the user looks at `monitor_id`, averages `(yaw, pitch)`,
/// and persists the calibrated anchor in `settings.json`.
#[tauri::command]
async fn calibrate_monitor(
    monitor_id: String,
    app: AppHandle,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    cam_state: tauri::State<'_, SharedCameraState>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> Result<HeadPose, String> {
    let vision_handle = vision_state.0.clone();

    let anchor = tauri::async_runtime::spawn_blocking(move || -> Result<HeadPose, String> {
        let mut sum_yaw = 0.0_f32;
        let mut sum_pitch = 0.0_f32;
        let mut sum_roll = 0.0_f32;
        let mut samples = 0_u32;

        for _ in 0..6 {
            let tel = vision_handle.get_telemetry();
            if tel.face_detected {
                sum_yaw += tel.smoothed_yaw;
                sum_pitch += tel.smoothed_pitch;
                sum_roll += tel.smoothed_roll;
                samples += 1;
            }
            thread::sleep(Duration::from_millis(50));
        }

        if samples == 0 {
            return Err(
                "No face detected during 300ms calibration. Please look at the display and retry."
                    .to_string(),
            );
        }

        Ok(HeadPose {
            yaw: sum_yaw / samples as f32,
            pitch: sum_pitch / samples as f32,
            roll: sum_roll / samples as f32,
        })
    })
    .await
    .map_err(|e| format!("Calibration task failed: {e}"))??;

    let updated_cfg = {
        let mut guard = app_cfg
            .0
            .write()
            .map_err(|_| "Failed to lock AppConfig".to_string())?;
        let entry = guard
            .monitor_configs
            .entry(monitor_id)
            .or_insert_with(MonitorCalibration::default);
        entry.anchor_yaw = Some(anchor.yaw);
        entry.anchor_pitch = Some(anchor.pitch);
        guard.clone()
    };

    sync_config_to_workers(&updated_cfg, &vision_state.0, &cam_state.0);
    save_persisted_config(&app, &updated_cfg)?;
    let _ = app.emit("screensight://monitors-changed", ());

    Ok(anchor)
}

#[tauri::command]
fn set_monitor_enabled(
    monitor_id: String,
    enabled: bool,
    app: AppHandle,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    cam_state: tauri::State<'_, SharedCameraState>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> Result<(), String> {
    let updated_cfg = {
        let mut guard = app_cfg
            .0
            .write()
            .map_err(|_| "Failed to lock AppConfig".to_string())?;
        let entry = guard
            .monitor_configs
            .entry(monitor_id)
            .or_insert_with(MonitorCalibration::default);
        entry.enabled = enabled;
        guard.clone()
    };

    sync_config_to_workers(&updated_cfg, &vision_state.0, &cam_state.0);
    save_persisted_config(&app, &updated_cfg)?;
    let _ = app.emit("screensight://monitors-changed", ());
    Ok(())
}

/// Persists Arrange Mode `deskPos` overrides and immediately updates `is_2d_layout`.
#[tauri::command]
fn update_monitor_desk_layout(
    positions: HashMap<String, DeskPoint>,
    app: AppHandle,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    cam_state: tauri::State<'_, SharedCameraState>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> Result<(), String> {
    let updated_cfg = {
        let mut guard = app_cfg
            .0
            .write()
            .map_err(|_| "Failed to lock AppConfig".to_string())?;
        for (id, point) in positions {
            let entry = guard
                .monitor_configs
                .entry(id)
                .or_insert_with(MonitorCalibration::default);
            entry.desk_pos = Some(point);
        }
        guard.clone()
    };

    sync_config_to_workers(&updated_cfg, &vision_state.0, &cam_state.0);
    save_persisted_config(&app, &updated_cfg)?;
    let _ = app.emit("screensight://monitors-changed", ());
    Ok(())
}

/// Clears custom `deskPos` overrides so the canvas aligns back to physical Windows `osRect`.
#[tauri::command]
fn reset_monitor_desk_layout(
    app: AppHandle,
    app_cfg: tauri::State<'_, SharedAppConfig>,
    cam_state: tauri::State<'_, SharedCameraState>,
    vision_state: tauri::State<'_, SharedVisionState>,
) -> Result<(), String> {
    let updated_cfg = {
        let mut guard = app_cfg
            .0
            .write()
            .map_err(|_| "Failed to lock AppConfig".to_string())?;
        for cal in guard.monitor_configs.values_mut() {
            cal.desk_pos = None;
        }
        guard.clone()
    };

    sync_config_to_workers(&updated_cfg, &vision_state.0, &cam_state.0);
    save_persisted_config(&app, &updated_cfg)?;
    let _ = app.emit("screensight://monitors-changed", ());
    Ok(())
}

/// Spawns brief (2.5s), transparent, always-on-top, click-through overlay badges displaying
/// `1`, `2`, `3`, ... at the center of each connected physical monitor.
#[tauri::command]
fn identify_monitors(app: AppHandle) -> Result<(), String> {
    let sys_monitors = win32_focus::get_system_monitors();
    let mut spawned_labels = Vec::with_capacity(sys_monitors.len());

    for m in sys_monitors {
        let label = format!("identify-overlay-{}", m.display_index);
        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.close();
        }

        let url = WebviewUrl::App(format!("index.html?identify={}", m.display_index).into());
        let overlay = WebviewWindowBuilder::new(&app, &label, url)
            .title(format!("ScreenSight Identify {}", m.display_index))
            .inner_size(120.0, 120.0)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .build()
            .map_err(|e| format!("Failed to create identify overlay '{label}': {e}"))?;

        let size = overlay
            .outer_size()
            .unwrap_or(PhysicalSize::new(120, 120));
        let px = m.os_rect.center_x() - (size.width as i32) / 2;
        let py = m.os_rect.center_y() - (size.height as i32) / 2;
        let _ = overlay.set_position(PhysicalPosition::new(px, py));
        let _ = overlay.set_ignore_cursor_events(true);

        spawned_labels.push(label);
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(2500));
        for label in spawned_labels {
            if let Some(win) = app_handle.get_webview_window(&label) {
                let _ = win.close();
            }
        }
    });

    Ok(())
}

// ==============================================================================
// Background Telemetry, Hot-Plug & Tray Sync Loop
// ==============================================================================

fn start_runtime_monitor_loop(
    app: AppHandle,
    shared_cfg: Arc<RwLock<AppConfig>>,
    camera: CameraActorHandle,
    vision: VisionWorkerHandle,
) {
    thread::Builder::new()
        .name("screensight-runtime-monitor".to_string())
        .spawn(move || {
            let mut last_snapshot: Vec<(String, OsRect)> = win32_focus::get_system_monitors()
                .into_iter()
                .map(|m| (m.id, m.os_rect))
                .collect();
            let mut last_status: Option<TrackerStatus> = None;
            let mut cached_titles: HashMap<String, String> = HashMap::new();
            let mut tick: u64 = 0;

            loop {
                thread::sleep(Duration::from_millis(150));
                tick = tick.wrapping_add(1);

                let cfg = shared_cfg
                    .read()
                    .map(|c| c.clone())
                    .unwrap_or_default();

                // 1. Hot-plug & orientation watcher every ~2 seconds
                // shortcut: polls get_system_monitors every ~2s instead of a dedicated WM_DISPLAYCHANGE Win32 message window.
                let sys_monitors = if tick.is_multiple_of(13) {
                    let current = win32_focus::get_system_monitors();
                    let snapshot: Vec<(String, OsRect)> =
                        current.iter().map(|m| (m.id.clone(), m.os_rect)).collect();
                    if snapshot != last_snapshot {
                        last_snapshot = snapshot;
                        sync_config_to_workers(&cfg, &vision, &camera);
                        let _ = app.emit("screensight://monitors-changed", ());
                    }
                    Some(current)
                } else {
                    None
                };

                // 2. Compute unified TrackerStatus and update System Tray only on transitions
                let cam_status = camera.get_status();
                let tracking_enabled = vision.is_tracking_enabled();
                let fullscreen_blocked =
                    cfg.auto_pause_fullscreen && win32_focus::is_fullscreen_game_active();
                let status = derive_tracker_status(tracking_enabled, &cam_status, fullscreen_blocked);

                if last_status.as_ref() != Some(&status) {
                    if let Some(tray) = app.try_state::<TrayControls>() {
                        let _ = tray
                            .status_item
                            .set_text(format_status_label(&status, cfg.target_fps));
                    }
                    let _ = app.emit("screensight://status", &status);
                    last_status = Some(status.clone());
                }

                // 3. Emit high-frequency telemetry ONLY while main window is visible (zero tray IPC cost)
                let is_visible = app
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);

                if is_visible {
                    let monitors = sys_monitors.unwrap_or_else(win32_focus::get_system_monitors);
                    if tick.is_multiple_of(5) {
                        cached_titles = win32_focus::find_top_windows_for_monitors(
                            &monitors,
                            &cfg.excluded_processes,
                        );
                    }
                    let vision_tel = vision.get_telemetry();
                    let payload = build_telemetry_payload(
                        &cfg,
                        &monitors,
                        &vision_tel,
                        status,
                        Some(&cached_titles),
                    );
                    let _ = app.emit("screensight://telemetry", &payload);
                }
            }
        })
        .expect("Failed to spawn runtime monitor thread");
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
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle();
            let config = load_persisted_config(app_handle);

            let camera_handle = CameraActorHandle::new(
                config.camera_index,
                config.target_fps,
                config.auto_yield_camera,
            );
            let resource_dir = app.path().resource_dir().ok();
            let vision_handle = VisionWorkerHandle::start(camera_handle.clone(), resource_dir);

            // Sync persisted monitor overrides & parameters immediately
            sync_config_to_workers(&config, &vision_handle, &camera_handle);

            let shared_cfg = Arc::new(RwLock::new(config.clone()));
            app.manage(SharedAppConfig(Arc::clone(&shared_cfg)));
            app.manage(SharedCameraState(camera_handle.clone()));
            app.manage(SharedVisionState(vision_handle.clone()));

            // ------------------------------------------------------------------
            // 2. Build System Tray & Menu
            // ------------------------------------------------------------------
            let status_item = MenuItem::with_id(
                app,
                "status",
                format_status_label(&TrackerStatus::Active, config.target_fps),
                false,
                None::<&str>,
            )?;
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Pause Tracking", true, Some(&config.global_shortcut))?;
            let calibrate_item =
                MenuItem::with_id(app, "calibrate", "Calibrate Displays...", true, None::<&str>)?;
            let open_item =
                MenuItem::with_id(app, "open", "Open Settings", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit ScreenSight", true, None::<&str>)?;
            let separator_top = PredefinedMenuItem::separator(app)?;
            let separator_bottom = PredefinedMenuItem::separator(app)?;

            let tray_menu = Menu::with_items(
                app,
                &[
                    &status_item,
                    &separator_top,
                    &toggle_item,
                    &calibrate_item,
                    &open_item,
                    &separator_bottom,
                    &quit_item,
                ],
            )?;

            app.manage(TrayControls {
                status_item,
                toggle_item,
            });

            let mut tray_builder = TrayIconBuilder::with_id("screensight-tray")
                .tooltip("ScreenSight — Gaze Focus Switcher")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => {
                        let currently_enabled = app
                            .try_state::<SharedVisionState>()
                            .map(|v| v.0.is_tracking_enabled())
                            .unwrap_or(true);
                        apply_tracking_enabled(app, !currently_enabled);
                    }
                    "calibrate" => {
                        show_main_window(app);
                        let _ = app.emit("screensight://open-calibration", ());
                    }
                    "open" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder.build(app)?;

            // ------------------------------------------------------------------
            // 3. Register Global Pause/Resume Shortcut (Ctrl + Alt + G default)
            // ------------------------------------------------------------------
            if let Err(err) = app.global_shortcut().on_shortcut(
                config.global_shortcut.as_str(),
                |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let currently_enabled = app
                            .try_state::<SharedVisionState>()
                            .map(|v| v.0.is_tracking_enabled())
                            .unwrap_or(true);
                        apply_tracking_enabled(app, !currently_enabled);
                    }
                },
            ) {
                eprintln!(
                    "ScreenSight: global shortcut '{}' unavailable ({err}); continuing without hotkey.",
                    config.global_shortcut
                );
            }

            // ------------------------------------------------------------------
            // 4. Start Visibility-Gated Telemetry, Hot-Plug & Tray Sync Loop
            // ------------------------------------------------------------------
            start_runtime_monitor_loop(
                app_handle.clone(),
                shared_cfg,
                camera_handle,
                vision_handle,
            );

            Ok(())
        })
        // Intercept Close button / Alt+F4 to hide to System Tray instead of terminating worker
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize_window,
            close_window,
            get_system_monitors,
            debug_focus_monitor,
            check_fullscreen_state,
            list_cameras,
            get_camera_status,
            set_camera_config,
            check_camera_conflict,
            get_vision_telemetry,
            update_vision_config,
            get_vision_config,
            get_monitors,
            get_config,
            update_config,
            set_tracking_enabled,
            calibrate_monitor,
            set_monitor_enabled,
            update_monitor_desk_layout,
            reset_monitor_desk_layout,
            identify_monitors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScreenSight Tauri application");
}
