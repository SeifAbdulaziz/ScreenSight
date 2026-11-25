//! ScreenSight Shared State, Configuration Schema & Persistent Store
//!
//! Bridges Win32 display discovery (`osRect`), user-editable 2D desk layouts (`deskPos`),
//! calibrated gaze anchors, and `tauri-plugin-store` disk persistence (`settings.json`).

use crate::camera_guard::{CameraActorHandle, CameraStatus};
use crate::vision_worker::{
    DeskRect, GazeEngine, HeadPose, MonitorTrackingTarget, VisionConfig, VisionTelemetry,
    VisionWorkerHandle,
};
use crate::win32_focus::{self, OsRect, SystemMonitor};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const CONFIG_KEY: &str = "app_config";

fn default_true() -> bool {
    true
}

fn default_schema_version() -> u32 {
    1
}

fn default_target_fps() -> u32 {
    15
}

fn default_switch_margin() -> f32 {
    6.0
}

fn default_dwell_ms() -> u64 {
    300
}

fn default_cooldown_ms() -> u64 {
    800
}

fn default_smoothing_alpha() -> f32 {
    0.35
}

fn default_shortcut() -> String {
    "Ctrl+Alt+G".to_string()
}

// ==============================================================================
// 1. Serializable Config & Telemetry Schema (V1)
// ==============================================================================

/// User-editable 2D top-left corner on the virtual desk canvas (separate from `osRect`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskPoint {
    pub x: i32,
    pub y: i32,
}

/// Per-display calibration and layout overrides keyed by stable Win32 `szDevice` ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorCalibration {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub desk_pos: Option<DeskPoint>,
    pub anchor_yaw: Option<f32>,
    pub anchor_pitch: Option<f32>,
}

impl Default for MonitorCalibration {
    fn default() -> Self {
        Self {
            enabled: true,
            desk_pos: None,
            anchor_yaw: None,
            anchor_pitch: None,
        }
    }
}

/// Persistent application settings stored in `settings.json`.
///
/// RUST LEARN NOTE (`#[serde(default)]`):
/// Adding `#[serde(default)]` lets older `settings.json` files deserialize cleanly when
/// future releases add fields, automatically filling missing fields with `Default::default()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub camera_index: u32,
    #[serde(default = "default_target_fps")]
    pub target_fps: u32,
    #[serde(default = "default_switch_margin")]
    pub switch_margin_deg: f32,
    #[serde(default = "default_dwell_ms")]
    pub dwell_ms: u64,
    #[serde(default = "default_cooldown_ms")]
    pub cooldown_ms: u64,
    #[serde(default = "default_smoothing_alpha")]
    pub smoothing_alpha: f32,
    #[serde(default = "default_true")]
    pub auto_yield_camera: bool,
    #[serde(default = "default_true")]
    pub auto_pause_fullscreen: bool,
    pub teleport_cursor: bool,
    #[serde(default = "default_shortcut")]
    pub global_shortcut: String,
    pub excluded_processes: Vec<String>,
    pub monitor_configs: HashMap<String, MonitorCalibration>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            camera_index: 0,
            target_fps: default_target_fps(),
            switch_margin_deg: default_switch_margin(),
            dwell_ms: default_dwell_ms(),
            cooldown_ms: default_cooldown_ms(),
            smoothing_alpha: default_smoothing_alpha(),
            auto_yield_camera: true,
            auto_pause_fullscreen: true,
            teleport_cursor: false,
            global_shortcut: default_shortcut(),
            excluded_processes: Vec::new(),
            monitor_configs: HashMap::new(),
        }
    }
}

impl AppConfig {
    /// Clamps numeric fields to safe hardware/UX bounds at trust boundaries.
    pub fn sanitize(&mut self) {
        self.target_fps = self.target_fps.clamp(5, 60);
        self.switch_margin_deg = self.switch_margin_deg.clamp(2.0, 20.0);
        self.dwell_ms = self.dwell_ms.clamp(0, 2000);
        self.cooldown_ms = self.cooldown_ms.clamp(0, 5000);
        self.smoothing_alpha = self.smoothing_alpha.clamp(0.05, 1.0);
        if self.global_shortcut.trim().is_empty() {
            self.global_shortcut = default_shortcut();
        }
    }
}

/// Complete per-monitor snapshot emitted to the React dashboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorNode {
    pub id: String,
    pub index: u32,
    pub os_rect: OsRect,
    pub desk_pos: DeskRect,
    pub is_primary: bool,
    pub is_focused: bool,
    pub active_window_title: Option<String>,
    pub enabled: bool,
    pub anchor: Option<HeadPose>,
}

/// High-level tracker state driving header pills and System Tray status lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail")]
pub enum TrackerStatus {
    Active,
    ManuallyPaused,
    YieldedToApp(String),
    PausedFullscreen,
    NoCamera,
}

/// Unified telemetry event payload emitted over `screensight://telemetry` while visible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPayload {
    pub status: TrackerStatus,
    pub face_detected: bool,
    pub face_confidence: f32,
    pub smoothed_yaw: f32,
    pub smoothed_pitch: f32,
    pub smoothed_roll: f32,
    pub measured_fps: f32,
    pub focused_monitor_id: Option<String>,
    pub pending_monitor_id: Option<String>,
    pub pending_progress: f32,
    pub is_2d_layout: bool,
    pub monitors: Vec<MonitorNode>,
}

/// Thread-safe shared configuration state managed by Tauri.
pub struct SharedAppConfig(pub Arc<RwLock<AppConfig>>);

// ==============================================================================
// 2. Pure Topology Merging & Status Derivation Helpers
// ==============================================================================

/// Combines read-only Windows `SystemMonitor` geometry (`os_rect`) with user-saved
/// `MonitorCalibration` overrides (`desk_pos`, `enabled`, calibrated `(yaw, pitch)`).
pub fn to_vision_config(config: &AppConfig, system_monitors: &[SystemMonitor]) -> VisionConfig {
    let monitors = system_monitors
        .iter()
        .map(|m| {
            let cal = config.monitor_configs.get(&m.id);
            let desk_origin = cal
                .and_then(|c| c.desk_pos)
                .unwrap_or(DeskPoint {
                    x: m.os_rect.left,
                    y: m.os_rect.top,
                });

            MonitorTrackingTarget {
                id: m.id.clone(),
                display_index: m.display_index,
                enabled: cal.is_none_or(|c| c.enabled),
                desk_pos: DeskRect {
                    x: desk_origin.x,
                    y: desk_origin.y,
                    width: m.os_rect.width(),
                    height: m.os_rect.height(),
                },
                anchor_yaw: cal.and_then(|c| c.anchor_yaw),
                anchor_pitch: cal.and_then(|c| c.anchor_pitch),
            }
        })
        .collect();

    VisionConfig {
        target_fps: config.target_fps,
        switch_margin_deg: config.switch_margin_deg,
        dwell_ms: config.dwell_ms,
        cooldown_ms: config.cooldown_ms,
        smoothing_alpha: config.smoothing_alpha,
        auto_pause_fullscreen: config.auto_pause_fullscreen,
        teleport_cursor: config.teleport_cursor,
        excluded_processes: config.excluded_processes.clone(),
        monitors,
    }
}

/// Builds UI-facing `MonitorNode` snapshots for `get_monitors` and `TelemetryPayload`.
pub fn build_monitor_nodes(
    system_monitors: &[SystemMonitor],
    config: &AppConfig,
    focused_id: Option<&str>,
    window_titles: Option<&HashMap<String, String>>,
) -> Vec<MonitorNode> {
    system_monitors
        .iter()
        .map(|m| {
            let cal = config.monitor_configs.get(&m.id);
            let desk_origin = cal
                .and_then(|c| c.desk_pos)
                .unwrap_or(DeskPoint {
                    x: m.os_rect.left,
                    y: m.os_rect.top,
                });
            let anchor = match (
                cal.and_then(|c| c.anchor_yaw),
                cal.and_then(|c| c.anchor_pitch),
            ) {
                (Some(yaw), Some(pitch)) => Some(HeadPose {
                    yaw,
                    pitch,
                    roll: 0.0,
                }),
                _ => None,
            };

            MonitorNode {
                id: m.id.clone(),
                index: m.display_index,
                os_rect: m.os_rect,
                desk_pos: DeskRect {
                    x: desk_origin.x,
                    y: desk_origin.y,
                    width: m.os_rect.width(),
                    height: m.os_rect.height(),
                },
                is_primary: m.is_primary,
                is_focused: focused_id == Some(m.id.as_str()),
                active_window_title: window_titles.and_then(|t| t.get(&m.id).cloned()),
                enabled: cal.is_none_or(|c| c.enabled),
                anchor,
            }
        })
        .collect()
}

/// Computes `is_2d_layout` directly from the merged `AppConfig` + Windows display list.
pub fn compute_is_2d_layout(config: &AppConfig, system_monitors: &[SystemMonitor]) -> bool {
    let vision_cfg = to_vision_config(config, system_monitors);
    GazeEngine::detect_is_2d_layout(&vision_cfg.monitors)
}

/// Derives the single unified `TrackerStatus` shown across TitleBar and System Tray.
pub fn derive_tracker_status(
    tracking_enabled: bool,
    cam_status: &CameraStatus,
    fullscreen_blocked: bool,
) -> TrackerStatus {
    if !tracking_enabled {
        return TrackerStatus::ManuallyPaused;
    }
    if fullscreen_blocked {
        return TrackerStatus::PausedFullscreen;
    }
    if cam_status.is_yielded {
        return TrackerStatus::YieldedToApp(
            cam_status
                .yielded_to_app
                .clone()
                .unwrap_or_else(|| "Video Call".to_string()),
        );
    }
    if !cam_status.is_streaming {
        return TrackerStatus::NoCamera;
    }
    TrackerStatus::Active
}

/// Builds a full `TelemetryPayload` snapshot for IPC emission when the main window is visible.
pub fn build_telemetry_payload(
    config: &AppConfig,
    system_monitors: &[SystemMonitor],
    vision_tel: &VisionTelemetry,
    status: TrackerStatus,
    window_titles: Option<&HashMap<String, String>>,
) -> TelemetryPayload {
    let monitors = build_monitor_nodes(
        system_monitors,
        config,
        vision_tel.focused_monitor_id.as_deref(),
        window_titles,
    );

    TelemetryPayload {
        status,
        face_detected: vision_tel.face_detected,
        face_confidence: vision_tel.face_confidence,
        smoothed_yaw: vision_tel.smoothed_yaw,
        smoothed_pitch: vision_tel.smoothed_pitch,
        smoothed_roll: vision_tel.smoothed_roll,
        measured_fps: vision_tel.measured_fps,
        focused_monitor_id: vision_tel.focused_monitor_id.clone(),
        pending_monitor_id: vision_tel.pending_monitor_id.clone(),
        pending_progress: vision_tel.pending_progress,
        is_2d_layout: vision_tel.is_2d_layout,
        monitors,
    }
}

// ==============================================================================
// 3. Persistence & Worker Sync Helpers (`tauri-plugin-store`)
// ==============================================================================

/// Loads `AppConfig` from `settings.json`, falling back safely to defaults on first run.
pub fn load_persisted_config(app: &AppHandle) -> AppConfig {
    let Ok(store) = app.store(STORE_FILE) else {
        return AppConfig::default();
    };

    let mut cfg = store
        .get(CONFIG_KEY)
        .and_then(|val| serde_json::from_value::<AppConfig>(val).ok())
        .unwrap_or_default();
    cfg.sanitize();
    cfg
}

/// Persists `AppConfig` atomically to `settings.json` via `tauri-plugin-store`.
pub fn save_persisted_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open settings store: {e}"))?;
    let val = serde_json::to_value(config)
        .map_err(|e| format!("Failed to serialize AppConfig: {e}"))?;
    store.set(CONFIG_KEY, val);
    store
        .save()
        .map_err(|e| format!("Failed to write settings.json: {e}"))
}

/// Pushes an updated `AppConfig` to both `VisionWorkerHandle` and `CameraActorHandle`.
pub fn sync_config_to_workers(
    config: &AppConfig,
    vision: &VisionWorkerHandle,
    camera: &CameraActorHandle,
) {
    let system_monitors = win32_focus::get_system_monitors();
    let vision_cfg = to_vision_config(config, &system_monitors);
    vision.update_config(vision_cfg);
    camera.update_config(
        config.camera_index,
        config.target_fps,
        config.auto_yield_camera,
    );
}

// ==============================================================================
// 4. Unit Tests (Ponytail verification rule)
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sys_mon(id: &str, idx: u32, l: i32, t: i32, r: i32, b: i32) -> SystemMonitor {
        SystemMonitor {
            id: id.to_string(),
            display_index: idx,
            is_primary: idx == 1,
            os_rect: OsRect {
                left: l,
                top: t,
                right: r,
                bottom: b,
            },
        }
    }

    #[test]
    fn test_app_config_serde_backward_compatibility_and_sanitize() {
        // Minimal partial JSON simulates upgrading from an older config file
        let partial = r#"{"target_fps": 200, "switch_margin_deg": 1.0}"#;
        let mut cfg: AppConfig = serde_json::from_str(partial).expect("Should deserialize partial JSON");
        assert_eq!(cfg.schema_version, 1);
        assert!(cfg.auto_yield_camera);
        assert_eq!(cfg.global_shortcut, "Ctrl+Alt+G");

        cfg.sanitize();
        assert_eq!(cfg.target_fps, 60);
        assert_eq!(cfg.switch_margin_deg, 2.0);
    }

    #[test]
    fn test_desk_pos_override_updates_is_2d_layout_without_changing_os_rect() {
        let sys = vec![
            sys_mon("\\\\.\\DISPLAY1", 1, 0, 0, 1920, 1080),
            sys_mon("\\\\.\\DISPLAY2", 2, 1920, 0, 3840, 1080),
        ];

        let mut cfg = AppConfig::default();
        assert!(!compute_is_2d_layout(&cfg, &sys));

        // Stack DISPLAY2 vertically above DISPLAY1 via desk_pos override
        cfg.monitor_configs.insert(
            "\\\\.\\DISPLAY2".to_string(),
            MonitorCalibration {
                enabled: true,
                desk_pos: Some(DeskPoint { x: 0, y: -1080 }),
                anchor_yaw: Some(1.5),
                anchor_pitch: Some(11.0),
            },
        );

        assert!(compute_is_2d_layout(&cfg, &sys));

        let nodes = build_monitor_nodes(&sys, &cfg, Some("\\\\.\\DISPLAY2"), None);
        // os_rect remains unchanged (1920..3840), while desk_pos reflects stacked (-1080)
        assert_eq!(nodes[1].os_rect.left, 1920);
        assert_eq!(nodes[1].desk_pos.y, -1080);
        assert!(nodes[1].is_focused);
        assert_eq!(nodes[1].anchor.unwrap().pitch, 11.0);
    }

    #[test]
    fn test_tracker_status_precedence() {
        let streaming = CameraStatus {
            is_streaming: true,
            is_yielded: false,
            ..CameraStatus::default()
        };
        assert_eq!(derive_tracker_status(false, &streaming, true), TrackerStatus::ManuallyPaused);
        assert_eq!(derive_tracker_status(true, &streaming, true), TrackerStatus::PausedFullscreen);
        assert_eq!(derive_tracker_status(true, &streaming, false), TrackerStatus::Active);

        let yielded = CameraStatus {
            is_streaming: false,
            is_yielded: true,
            yielded_to_app: Some("Zoom Video Call".into()),
            ..CameraStatus::default()
        };
        assert_eq!(
            derive_tracker_status(true, &yielded, false),
            TrackerStatus::YieldedToApp("Zoom Video Call".into())
        );
    }
}
