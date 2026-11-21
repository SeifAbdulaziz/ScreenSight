//! ScreenSight Camera Actor & Windows Registry Auto-Yield Guard
//!
//! This module manages physical webcam access via Windows Media Foundation:
//! - Physical camera enumeration (`nokhwa::query`)
//! - Dedicated OS thread actor to safely isolate Windows Media Foundation's `!Send` handles
//! - Windows Registry ConsentStore polling to detect Zoom, Meet, Teams, Discord, OBS
//! - RAII handle surrender (`active_camera.take()`) to avoid hardware locks

use nokhwa::query;
use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat,
    RequestedFormatType, Resolution,
};
use nokhwa::Camera;
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_registry::CURRENT_USER;

// ==============================================================================
// Data Transfer Types for IPC Telemetry
// ==============================================================================

/// Discovered physical webcam hardware info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDeviceInfo {
    pub index: u32,
    pub name: String,
    pub description: String,
}

/// Real-time camera status reported to the frontend dashboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraStatus {
    pub is_streaming: bool,
    pub camera_index: u32,
    pub camera_name: String,
    pub target_fps: u32,
    pub auto_yield: bool,
    pub is_yielded: bool,
    pub yielded_to_app: Option<String>,
}

impl Default for CameraStatus {
    fn default() -> Self {
        Self {
            is_streaming: false,
            camera_index: 0,
            camera_name: "Default Webcam".to_string(),
            target_fps: 15,
            auto_yield: true,
            is_yielded: false,
            yielded_to_app: None,
        }
    }
}

// ==============================================================================
// 1. Windows Registry ConsentStore Auto-Yield Guard
// ==============================================================================

/// Scans Windows CapabilityAccessManager ConsentStore to determine if another application
/// (e.g. Google Meet, Zoom, Microsoft Teams, Discord, OBS) is actively streaming video.
///
/// RUST LEARN NOTE:
/// Windows records camera access in the registry under two distinct paths:
/// 1. Packaged: UWP/Windows Store apps (e.g. Windows Camera, new Teams).
/// 2. NonPackaged: Classic Win32 applications (Chrome, Zoom, OBS, Discord).
///
/// Each subkey contains two 64-bit FILETIME values:
/// - `LastUsedTimeStart`: Timestamp when the stream started.
/// - `LastUsedTimeStop`: Timestamp when the stream closed (0 if still open!).
///
/// If `LastUsedTimeStart > 0 && LastUsedTimeStop == 0`, that application holds an active stream.
pub fn get_other_active_camera_user() -> Option<String> {
    let own_exe_name = env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
        .unwrap_or_else(|| "screensight".to_string());

    // 1. Check Win32 desktop applications (Chrome, Zoom, Meet, Teams, OBS)
    if let Some(app) = check_consent_path(
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged",
        &own_exe_name,
        true,
    ) {
        return Some(app);
    }

    // 2. Check UWP / Packaged applications (Windows Camera, Teams Store App)
    if let Some(app) = check_consent_path(
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam",
        &own_exe_name,
        false,
    ) {
        return Some(app);
    }

    None
}

/// Helper to scan a ConsentStore registry key for active streams.
fn check_consent_path(path: &str, own_exe_name: &str, is_non_packaged: bool) -> Option<String> {
    let parent_key = CURRENT_USER.open(path).ok()?;

    if let Ok(keys) = parent_key.keys() {
        for subkey_name in keys {
            let subkey_lower = subkey_name.to_lowercase();

            // Skip our own process so ScreenSight doesn't yield to itself
            if subkey_lower.contains(own_exe_name) || subkey_lower.contains("screensight") {
                continue;
            }

            // In the root webcam path, ignore the "NonPackaged" subkey container itself
            if !is_non_packaged && subkey_name == "NonPackaged" {
                continue;
            }

            if let Ok(app_key) = parent_key.open(&subkey_name) {
                let start = app_key.get_u64("LastUsedTimeStart").unwrap_or(0);
                let stop = app_key.get_u64("LastUsedTimeStop").unwrap_or(0);

                // Active stream condition: Start is set and Stop is 0 (stream in progress)
                if start > 0 && stop == 0 {
                    return Some(clean_app_name(&subkey_name, is_non_packaged));
                }
            }
        }
    }

    None
}

/// Formats raw registry subkey strings into user-friendly names.
/// E.g.: `C:#Program Files#Google#Chrome#Application#chrome.exe` -> `Google Chrome (chrome.exe)`
fn clean_app_name(raw_name: &str, is_non_packaged: bool) -> String {
    if is_non_packaged {
        let parts: Vec<&str> = raw_name.split('#').collect();
        if let Some(exe) = parts.last() {
            if exe.eq_ignore_ascii_case("chrome.exe") {
                return "Google Meet / Chrome".to_string();
            } else if exe.eq_ignore_ascii_case("zoom.exe") {
                return "Zoom Video Call".to_string();
            } else if exe.eq_ignore_ascii_case("teams.exe") || exe.eq_ignore_ascii_case("ms-teams.exe") {
                return "Microsoft Teams".to_string();
            } else if exe.eq_ignore_ascii_case("discord.exe") {
                return "Discord Call".to_string();
            } else if exe.eq_ignore_ascii_case("obs64.exe") || exe.eq_ignore_ascii_case("obs32.exe") {
                return "OBS Studio".to_string();
            }
            return exe.to_string();
        }
    } else {
        if raw_name.starts_with("Microsoft.WindowsCamera") {
            return "Windows Camera App".to_string();
        } else if raw_name.contains("Teams") {
            return "Microsoft Teams (Store)".to_string();
        }
    }

    raw_name.to_string()
}

// ==============================================================================
// 2. Hardware Webcam Enumeration & Stream Negotiation
// ==============================================================================

/// Queries available physical webcams using Microsoft Media Foundation.
pub fn list_available_cameras() -> Result<Vec<CameraDeviceInfo>, String> {
    let devices = query(ApiBackend::MediaFoundation)
        .map_err(|e| format!("Failed to query Media Foundation webcams: {}", e))?;

    let mut result = Vec::new();
    for (i, info) in devices.into_iter().enumerate() {
        let index = match info.index() {
            CameraIndex::Index(idx) => *idx,
            CameraIndex::String(s) => s.parse::<u32>().unwrap_or(i as u32),
        };

        result.push(CameraDeviceInfo {
            index,
            name: info.human_name(),
            description: info.description().to_string(),
        });
    }

    Ok(result)
}

/// Opens a shared webcam handle with paced MJPEG format fallback.
pub fn open_camera_stream(index: u32, target_fps: u32) -> Result<Camera, String> {
    // RUST LEARN NOTE (Format Negotiation):
    // Many USB webcams only advertise standard hardware rates like 15 FPS or 30 FPS.
    // We request Closest(...) matching 640x480 MJPEG at target_fps with YUYV fallback.
    let requested_format = RequestedFormat::with_formats(
        RequestedFormatType::Closest(CameraFormat::new(
            Resolution::new(640, 480),
            FrameFormat::MJPEG,
            target_fps.clamp(5, 60),
        )),
        &[FrameFormat::MJPEG, FrameFormat::YUYV],
    );

    let mut camera = Camera::new(CameraIndex::Index(index), requested_format)
        .map_err(|e| format!("Failed to initialize camera {}: {}", index, e))?;

    camera
        .open_stream()
        .map_err(|e| format!("Failed to open Media Foundation stream on camera {}: {}", index, e))?;

    Ok(camera)
}

// ==============================================================================
// 3. Camera Actor Thread (Isolating !Send Handles)
// ==============================================================================

enum CameraActorMsg {
    UpdateConfig {
        camera_index: u32,
        target_fps: u32,
        auto_yield: bool,
    },
}

/// Thread-safe handle for communicating with the dedicated Camera Actor.
///
/// RUST LEARN NOTE (Actor Pattern & !Send Isolation):
/// Windows Media Foundation COM objects are apartment-threaded, making `nokhwa::Camera`
/// `!Send` (it cannot cross thread boundaries).
///
/// To solve this safely without unsafe transmutes:
/// We spawn a dedicated OS thread that OWNS the camera handle exclusively.
/// Tauri commands communicate via standard message-passing channels (`Sender<CameraActorMsg>`)
/// and read shared telemetry from an `Arc<Mutex<CameraStatus>>`.
#[derive(Clone)]
pub struct CameraActorHandle {
    sender: Sender<CameraActorMsg>,
    status: Arc<Mutex<CameraStatus>>,
}

impl CameraActorHandle {
    pub fn new(initial_index: u32, initial_fps: u32, initial_auto_yield: bool) -> Self {
        let (tx, rx) = channel::<CameraActorMsg>();
        let status = Arc::new(Mutex::new(CameraStatus {
            is_streaming: false,
            camera_index: initial_index,
            camera_name: "Default Webcam".to_string(),
            target_fps: initial_fps,
            auto_yield: initial_auto_yield,
            is_yielded: false,
            yielded_to_app: None,
        }));

        let thread_status = Arc::clone(&status);

        // Spawn dedicated Camera Actor thread
        thread::Builder::new()
            .name("screensight-camera-actor".to_string())
            .spawn(move || {
                run_camera_actor(rx, thread_status, initial_index, initial_fps, initial_auto_yield);
            })
            .expect("Failed to spawn camera actor thread");

        Self {
            sender: tx,
            status,
        }
    }

    pub fn get_status(&self) -> CameraStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn update_config(&self, camera_index: u32, target_fps: u32, auto_yield: bool) -> CameraStatus {
        let _ = self.sender.send(CameraActorMsg::UpdateConfig {
            camera_index,
            target_fps,
            auto_yield,
        });

        // Return immediate optimistic status
        let mut st = self.status.lock().unwrap();
        st.camera_index = camera_index;
        st.target_fps = target_fps;
        st.auto_yield = auto_yield;
        st.clone()
    }
}

fn run_camera_actor(
    rx: Receiver<CameraActorMsg>,
    status: Arc<Mutex<CameraStatus>>,
    mut camera_index: u32,
    mut target_fps: u32,
    mut auto_yield: bool,
) {
    let mut active_camera: Option<Camera> = None;
    let mut is_yielded = false;
    let mut yielded_to_app: Option<String> = None;
    let mut last_conflict_check = Instant::now();

    loop {
        // 1. Process pending configuration changes from Tauri IPC
        while let Ok(msg) = rx.try_recv() {
            match msg {
                CameraActorMsg::UpdateConfig {
                    camera_index: new_idx,
                    target_fps: new_fps,
                    auto_yield: new_yield,
                } => {
                    let needs_reopen = camera_index != new_idx || target_fps != new_fps;
                    camera_index = new_idx;
                    target_fps = new_fps;
                    auto_yield = new_yield;

                    if needs_reopen {
                        // Drop existing camera handle immediately to allow reopening
                        active_camera.take();
                    }
                }
            }
        }

        // 2. Poll Windows Registry ConsentStore for active video call conflicts
        if last_conflict_check.elapsed().as_millis() >= 300 {
            last_conflict_check = Instant::now();

            if auto_yield {
                if let Some(conflicting_app) = get_other_active_camera_user() {
                    if !is_yielded {
                        // RUST LEARN NOTE (RAII Handle Surrender):
                        // active_camera.take() extracts the Camera from the Option, dropping it instantly.
                        // This immediately signals Windows Media Foundation to release the hardware lock,
                        // allowing Zoom, Google Meet, or Teams to acquire the stream without error!
                        let _ = active_camera.take();
                        is_yielded = true;
                        yielded_to_app = Some(conflicting_app);
                    }
                } else if is_yielded {
                    // Call ended: Reclaim the camera handle!
                    is_yielded = false;
                    yielded_to_app = None;
                }
            }
        }

        // 3. Acquire camera stream if not yielded and not currently opened
        if !is_yielded && active_camera.is_none() {
            match open_camera_stream(camera_index, target_fps) {
                Ok(cam) => {
                    active_camera = Some(cam);
                    yielded_to_app = None;
                }
                Err(err) => {
                    // Camera might still be briefly held by closing call
                    is_yielded = true;
                    yielded_to_app = Some(format!("Device busy ({})", err));
                }
            }
        }

        // 4. Publish latest telemetry to thread-safe container
        {
            if let Ok(mut st) = status.lock() {
                st.is_streaming = active_camera.is_some() && !is_yielded;
                st.camera_index = camera_index;
                st.target_fps = target_fps;
                st.auto_yield = auto_yield;
                st.is_yielded = is_yielded;
                st.yielded_to_app = yielded_to_app.clone();
            }
        }

        // Sleep throttled loop (50ms when idle/streaming)
        thread::sleep(Duration::from_millis(50));
    }
}

// Global thread-safe camera state container for Tauri IPC
pub struct SharedCameraState(pub CameraActorHandle);

// ==============================================================================
// Unit & Integration Tests (Ponytail verification rule)
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_app_name_formatting() {
        let chrome_path = r"C:#Program Files#Google#Chrome#Application#chrome.exe";
        assert_eq!(clean_app_name(chrome_path, true), "Google Meet / Chrome");

        let zoom_path = r"C:#Users#User#AppData#Roaming#Zoom#bin#zoom.exe";
        assert_eq!(clean_app_name(zoom_path, true), "Zoom Video Call");

        let obs_path = r"C:#Program Files#obs-studio#bin#64bit#obs64.exe";
        assert_eq!(clean_app_name(obs_path, true), "OBS Studio");

        let uwp_camera = "Microsoft.WindowsCamera_8wekyb3d8bbwe";
        assert_eq!(clean_app_name(uwp_camera, false), "Windows Camera App");
    }

    #[test]
    fn test_consent_store_query_no_crash() {
        let active_user = get_other_active_camera_user();
        let _ = active_user;
    }

    #[test]
    fn test_camera_actor_handle_creation() {
        let handle = CameraActorHandle::new(0, 15, true);
        let st = handle.get_status();
        assert_eq!(st.target_fps, 15);
        assert_eq!(st.camera_index, 0);
        assert!(st.auto_yield);
    }
}
