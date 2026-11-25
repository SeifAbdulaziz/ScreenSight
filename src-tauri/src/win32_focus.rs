//! ScreenSight Win32 Display Topology & Window Focus Management
//!
//! This module provides safe Rust abstractions over low-level Windows APIs:
//! - Multi-monitor discovery via `EnumDisplayMonitors`
//! - Top-most visible window hit-testing via `EnumWindows` + `DWMWA_CLOAKED` filtering
//! - Foreground Lock bypass using `AttachThreadInput` + `SetForegroundWindow`
//! - Fullscreen / Direct3D gaming detection via `SHQueryUserNotificationState`

use serde::{Deserialize, Serialize};
use std::mem::size_of;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFOEXW,
    MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess,
    QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GetClassNameW, GetForegroundWindow,
    GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, PeekMessageW, SetCursorPos, SetForegroundWindow, ShowWindow, ASFW_ANY,
    GWL_EXSTYLE, MSG, PM_NOREMOVE, SW_RESTORE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// 2D Rect in Windows Virtual Desktop coordinates.
///
/// NOTE FOR LEARNER: Windows virtual screen coordinates can be negative
/// when secondary monitors are placed to the left or above the primary monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OsRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl OsRect {
    #[inline]
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    #[inline]
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    #[inline]
    pub fn center_x(&self) -> i32 {
        self.left + self.width() / 2
    }

    #[inline]
    pub fn center_y(&self) -> i32 {
        self.top + self.height() / 2
    }

    #[inline]
    pub fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// Representation of a physical display detected by Windows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMonitor {
    /// Persistent Win32 device identifier (e.g. `\\.\DISPLAY1`)
    pub id: String,
    /// 1-based display index for UI badges
    pub display_index: u32,
    /// True if this is the Windows primary monitor (at coordinate origin 0,0)
    pub is_primary: bool,
    /// Physical virtual desktop bounding rectangle
    pub os_rect: OsRect,
}

/// Information about the top visible window on a given monitor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopWindowInfo {
    pub title: String,
    pub hwnd: usize, // Window handle serialized as integer for frontend telemetry
}

// ==============================================================================
// 1. Monitor Topology Enumeration
// ==============================================================================

/// Discovers all active physical and virtual displays attached to the Windows desktop.
pub fn get_system_monitors() -> Vec<SystemMonitor> {
    let mut monitors: Vec<SystemMonitor> = Vec::new();

    // RUST LEARN NOTE:
    // We pass a raw pointer to our `monitors` Vec as `LPARAM` into the C-ABI callback.
    // The callback dereferences this pointer inside `unsafe {}` to append each monitor.
    unsafe {
        let lparam = LPARAM(&mut monitors as *mut Vec<SystemMonitor> as isize);
        let _ = EnumDisplayMonitors(None, None, Some(enum_monitor_callback), lparam);
    }

    monitors
}

unsafe extern "system" fn enum_monitor_callback(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    // Cast LPARAM back to our mutable Vec reference.
    let monitors = &mut *(lparam.0 as *mut Vec<SystemMonitor>);

    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;

    // Query geometry and device name for this monitor handle
    if GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut _).as_bool() {
        // szDevice is a null-terminated UTF-16 array ([u16; 32]).
        // Find the null terminator to extract the exact device name string.
        let name_len = info
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.szDevice.len());
        let id = String::from_utf16_lossy(&info.szDevice[..name_len]);

        // Primary monitor is marked with MONITORINFOF_PRIMARY (0x1)
        let is_primary = (info.monitorInfo.dwFlags & 1) != 0;
        let r = info.monitorInfo.rcMonitor;

        let display_index = (monitors.len() + 1) as u32;
        monitors.push(SystemMonitor {
            id,
            display_index,
            is_primary,
            os_rect: OsRect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            },
        });
    }

    BOOL(1) // Return TRUE to continue enumerating remaining monitors
}

// ==============================================================================
// 2. Z-Order Window Traversal & Cloaked Filter
// ==============================================================================

struct WindowSearchState<'a> {
    target_rect: &'a OsRect,
    own_pid: u32,
    excluded_names: &'a [String],
    found_hwnd: Option<HWND>,
    found_title: String,
}

/// Finds the highest Z-order, visible, non-cloaked application window
/// whose center point falls inside `target_rect`.
pub fn find_top_window_on_monitor(
    target_rect: &OsRect,
    excluded_names: &[String],
) -> Option<(HWND, String)> {
    let own_pid = unsafe { GetCurrentProcessId() };

    let mut state = WindowSearchState {
        target_rect,
        own_pid,
        excluded_names,
        found_hwnd: None,
        found_title: String::new(),
    };

    unsafe {
        let lparam = LPARAM(&mut state as *mut WindowSearchState as isize);
        let _ = EnumWindows(Some(enum_windows_callback), lparam);
    }

    state.found_hwnd.map(|hwnd| (hwnd, state.found_title))
}

struct MultiMonitorWindowSearch<'a> {
    monitors: &'a [SystemMonitor],
    own_pid: u32,
    excluded_names: &'a [String],
    found: std::collections::HashMap<String, String>,
}

/// Single-pass `EnumWindows` traversal that records the top visible, non-cloaked
/// window title for every connected monitor in one Z-order walk.
pub fn find_top_windows_for_monitors(
    monitors: &[SystemMonitor],
    excluded_names: &[String],
) -> std::collections::HashMap<String, String> {
    let own_pid = unsafe { GetCurrentProcessId() };
    let mut state = MultiMonitorWindowSearch {
        monitors,
        own_pid,
        excluded_names,
        found: std::collections::HashMap::with_capacity(monitors.len()),
    };

    unsafe {
        let lparam = LPARAM(&mut state as *mut MultiMonitorWindowSearch as isize);
        let _ = EnumWindows(Some(enum_multi_windows_callback), lparam);
    }

    state.found
}

/// Extracts the Win32 `szDevice` monitor identifier (e.g. `\\.\DISPLAY1`) for a window handle.
pub fn get_monitor_id_for_hwnd(hwnd: HWND) -> Option<String> {
    if hwnd.0.is_null() {
        return None;
    }

    unsafe {
        let hmonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL);
        if hmonitor.0.is_null() {
            return None;
        }

        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut _).as_bool() {
            let name_len = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            return Some(String::from_utf16_lossy(&info.szDevice[..name_len]));
        }
        None
    }
}

/// Returns `(hwnd_as_usize, monitor_id)` for the OS window currently receiving keyboard input.
///
/// Used by the vision worker so manual mouse clicks or Alt+Tab immediately keep `GazeEngine`
/// aligned with real Windows keyboard focus instead of assuming the previously focused screen.
pub fn get_foreground_window_monitor() -> Option<(usize, String)> {
    unsafe {
        let fg_hwnd = GetForegroundWindow();
        if fg_hwnd.0.is_null() {
            return None;
        }
        get_monitor_id_for_hwnd(fg_hwnd).map(|id| (fg_hwnd.0 as usize, id))
    }
}

fn is_non_app_shell_class(hwnd: HWND) -> bool {
    let mut cls_buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut cls_buf) };
    if len <= 0 {
        return false;
    }
    let class_name = String::from_utf16_lossy(&cls_buf[..len as usize]);
    matches!(
        class_name.as_str(),
        "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "Progman"
            | "WorkerW"
            | "Windows.UI.Core.CoreWindow"
    )
}

/// Shared eligibility filter for Z-order window enumeration across both single-monitor
/// focus switching and multi-monitor dashboard title snapshots.
unsafe fn extract_eligible_window(
    hwnd: HWND,
    own_pid: u32,
    excluded_names: &[String],
) -> Option<(RECT, String)> {
    // 1. Window must be marked visible and not minimized to taskbar (-32000,-32000).
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return None;
    }

    // 2. Skip DWM-cloaked UWP/suspended windows and windows on other Virtual Desktops.
    let mut cloaked: u32 = 0;
    let hr = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut _,
        size_of::<u32>() as u32,
    );
    if hr.is_ok() && cloaked != 0 {
        return None;
    }

    // 3. Skip floating tool windows and non-activatable HUD/overlay windows.
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0)) != 0 {
        return None;
    }

    // 4. Skip ScreenSight's own UI/overlays and Windows desktop/taskbar shell frames.
    let mut window_pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut window_pid));
    if window_pid == 0 || window_pid == own_pid || is_non_app_shell_class(hwnd) {
        return None;
    }

    // 5. Apply user process exclusion rules (e.g. games, OBS).
    if !excluded_names.is_empty() {
        if let Some(exe_name) = get_window_process_name(hwnd) {
            let lower_exe = exe_name.to_lowercase();
            if excluded_names
                .iter()
                .any(|ex| lower_exe.contains(&ex.to_lowercase()))
            {
                return None;
            }
        }
    }

    // 6. Validate window bounds and non-empty title.
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return None;
    }
    if (rect.right - rect.left) <= 10 || (rect.bottom - rect.top) <= 10 {
        return None;
    }

    let mut text_buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut text_buf);
    if len <= 0 {
        return None;
    }

    let title = String::from_utf16_lossy(&text_buf[..len as usize]);
    if title.trim().is_empty() || title == "Program Manager" {
        return None;
    }

    Some((rect, title))
}

unsafe extern "system" fn enum_multi_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut MultiMonitorWindowSearch);

    if state.found.len() >= state.monitors.len() {
        return BOOL(0);
    }

    let Some((rect, title)) = extract_eligible_window(hwnd, state.own_pid, state.excluded_names)
    else {
        return BOOL(1);
    };

    let center_x = rect.left + (rect.right - rect.left) / 2;
    let center_y = rect.top + (rect.bottom - rect.top) / 2;

    if let Some(monitor) = state
        .monitors
        .iter()
        .find(|m| !state.found.contains_key(&m.id) && m.os_rect.contains_point(center_x, center_y))
    {
        state.found.insert(monitor.id.clone(), title);
    }

    BOOL(1)
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut WindowSearchState);

    let Some((rect, title)) = extract_eligible_window(hwnd, state.own_pid, state.excluded_names)
    else {
        return BOOL(1);
    };

    let center_x = rect.left + (rect.right - rect.left) / 2;
    let center_y = rect.top + (rect.bottom - rect.top) / 2;

    // EnumWindows traverses top-to-bottom in Z-order, so the first hit is top-most.
    if state.target_rect.contains_point(center_x, center_y) {
        state.found_hwnd = Some(hwnd);
        state.found_title = title;
        return BOOL(0);
    }

    BOOL(1)
}

/// Helper to query the base `.exe` image filename for a given window handle.
pub fn get_window_process_name(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;

        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );

        if res.is_ok() && len > 0 {
            let full_path = String::from_utf16_lossy(&buf[..len as usize]);
            // Extract the filename from the full path
            let exe_name = full_path.rsplit('\\').next().unwrap_or(&full_path);
            Some(exe_name.to_string())
        } else {
            None
        }
    }
}

// ==============================================================================
// 3. Focus Switching with Foreground Lock Bypass
// ==============================================================================

/// Shifts active OS keyboard and window focus to `target_hwnd`.
///
/// RUST LEARN NOTE (Message Queue + Multi-Thread `AttachThreadInput`):
/// 1. `AttachThreadInput` fails silently if a background worker thread has never created a
///    Win32 USER message queue; calling `PeekMessageW(..., PM_NOREMOVE)` initializes it.
/// 2. We attach our thread to BOTH the current foreground thread AND `target_hwnd`'s thread
///    (as well as `foreground <-> target`) so Windows transfers true keyboard input focus
///    across distinct processes instead of only flashing the taskbar button.
/// 3. We verify `GetForegroundWindow()` afterward rather than trusting `SetForegroundWindow()`'s
///    return value blindly.
pub fn focus_window(target_hwnd: HWND, cursor_teleport: Option<(i32, i32)>) -> bool {
    unsafe {
        if IsIconic(target_hwnd).as_bool() {
            let _ = ShowWindow(target_hwnd, SW_RESTORE);
        }

        let foreground_hwnd = GetForegroundWindow();
        if foreground_hwnd == target_hwnd {
            if let Some((cx, cy)) = cursor_teleport {
                let _ = SetCursorPos(cx, cy);
            }
            return true;
        }

        // Ensure this worker thread owns a Win32 message queue before calling AttachThreadInput.
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);

        let foreground_tid = if foreground_hwnd.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground_hwnd, None)
        };
        let target_tid = GetWindowThreadProcessId(target_hwnd, None);
        let current_tid = GetCurrentThreadId();

        let attach_fg = foreground_tid != 0
            && foreground_tid != current_tid
            && AttachThreadInput(current_tid, foreground_tid, true).as_bool();
        let attach_target = target_tid != 0
            && target_tid != current_tid
            && target_tid != foreground_tid
            && AttachThreadInput(current_tid, target_tid, true).as_bool();
        let attach_fg_target = foreground_tid != 0
            && target_tid != 0
            && foreground_tid != target_tid
            && AttachThreadInput(foreground_tid, target_tid, true).as_bool();

        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let _ = BringWindowToTop(target_hwnd);
        let api_ok = SetForegroundWindow(target_hwnd).as_bool();

        if attach_fg_target {
            let _ = AttachThreadInput(foreground_tid, target_tid, false);
        }
        if attach_target {
            let _ = AttachThreadInput(current_tid, target_tid, false);
        }
        if attach_fg {
            let _ = AttachThreadInput(current_tid, foreground_tid, false);
        }

        let fg_after = GetForegroundWindow();
        // Verify focus actually moved away from the previous window (or landed on target/child).
        let switched = fg_after == target_hwnd
            || (api_ok && !fg_after.0.is_null() && fg_after != foreground_hwnd);

        if switched {
            if let Some((cx, cy)) = cursor_teleport {
                let _ = SetCursorPos(cx, cy);
            }
        }

        switched
    }
}

// ==============================================================================
// 4. Fullscreen & Direct3D Gaming Auto-Pause Guard
// ==============================================================================

/// Queries Windows shell notification state to determine if an exclusive
/// Direct3D game or presentation is running full-screen.
pub fn is_fullscreen_game_active() -> bool {
    unsafe {
        match SHQueryUserNotificationState() {
            Ok(state) => {
                // QUNS_RUNNING_D3D_FULL_SCREEN: Fullscreen DirectX/Vulkan game
                // QUNS_BUSY: Fullscreen exclusive app or presentation mode
                state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_BUSY
            }
            Err(_) => false,
        }
    }
}

/// Convenience high-level focus switch to a monitor by device ID.
pub fn switch_focus_to_monitor(
    monitor_id: &str,
    cursor_teleport: bool,
    excluded_names: &[String],
) -> Result<Option<TopWindowInfo>, String> {
    // 1. Safeguard: Never switch focus if a fullscreen game is active
    if is_fullscreen_game_active() {
        return Err("Focus shift blocked: Fullscreen game or D3D app is active.".into());
    }

    // 2. Locate monitor matching target ID
    let monitors = get_system_monitors();
    let target = monitors
        .iter()
        .find(|m| m.id == monitor_id)
        .ok_or_else(|| format!("Monitor '{}' not found in system displays", monitor_id))?;

    // 3. Find top visible window on this monitor's os_rect
    if let Some((hwnd, title)) = find_top_window_on_monitor(&target.os_rect, excluded_names) {
        let teleport_coords = if cursor_teleport {
            Some((target.os_rect.center_x(), target.os_rect.center_y()))
        } else {
            None
        };

        let ok = focus_window(hwnd, teleport_coords);
        if ok {
            Ok(Some(TopWindowInfo {
                title,
                hwnd: hwnd.0 as usize,
            }))
        } else {
            Err("Failed to set foreground window".into())
        }
    } else {
        // No windows open on this screen (desktop is showing)
        if cursor_teleport {
            unsafe {
                let _ = SetCursorPos(target.os_rect.center_x(), target.os_rect.center_y());
            }
        }
        Ok(None)
    }
}

// ==============================================================================
// Unit & Integration Tests (Ponytail verification rule)
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_os_rect_calculations() {
        let rect = OsRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };

        assert_eq!(rect.width(), 1920);
        assert_eq!(rect.height(), 1080);
        assert_eq!(rect.center_x(), -960);
        assert_eq!(rect.center_y(), 540);

        assert!(rect.contains_point(-1000, 500));
        assert!(rect.contains_point(-1920, 0)); // Top-left boundary included
        assert!(!rect.contains_point(0, 0)); // Right boundary excluded
        assert!(!rect.contains_point(100, 500));
    }

    #[test]
    fn test_live_system_monitors_enumeration() {
        let monitors = get_system_monitors();

        // Any Windows machine running this test must have at least 1 connected display
        assert!(!monitors.is_empty(), "Expected at least 1 connected monitor");

        let primary = monitors.iter().find(|m| m.is_primary);
        assert!(primary.is_some(), "Expected a designated primary monitor");

        let p = primary.unwrap();
        assert!(p.os_rect.width() > 0);
        assert!(p.os_rect.height() > 0);
        assert!(!p.id.is_empty());

        // Display indices must be 1, 2, 3...
        for (i, m) in monitors.iter().enumerate() {
            assert_eq!(m.display_index, (i + 1) as u32);
        }
    }

    #[test]
    fn test_fullscreen_query_safeguard() {
        // Must succeed without panicking and return a boolean
        let is_fullscreen = is_fullscreen_game_active();
        // Just verify it evaluates without crashing Win32 FFI
        let _ = is_fullscreen;
    }

    #[test]
    fn test_foreground_window_monitor_query_no_crash() {
        // Must evaluate safely even in headless/background test sessions; when a foreground window
        // exists, its monitor ID must belong to connected system displays.
        if let Some((hwnd, monitor_id)) = get_foreground_window_monitor() {
            assert_ne!(hwnd, 0);
            let monitors = get_system_monitors();
            assert!(monitors.iter().any(|m| m.id == monitor_id));
        }
    }
}
