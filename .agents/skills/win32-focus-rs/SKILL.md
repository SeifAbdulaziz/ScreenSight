---
name: win32-focus-rs
description: Use when writing or debugging Windows OS integrations in ScreenSight using the `windows` (0.62+) and `windows-registry` crates, including monitor enumeration, HWND focus switching, DWM cloaked window filtering, fullscreen gaming detection, or webcam ConsentStore registry polling. Do not use for React UI or ONNX ML inference.
---

# Win32 Focus & System Guards (Rust)

## Crate Conventions
- Use Microsoft's official `windows` crate (0.62+) and `windows-registry` crate.
- Always prefer Wide (`W`) UTF-16 APIs (`GetWindowTextW`, `GetMonitorInfoW`) and convert buffers with `String::from_utf16_lossy(&buf[..len as usize])`.
- Isolate every `unsafe` Win32 call inside small, documented safe wrapper functions in `src-tauri/src/win32_focus.rs` or `src-tauri/src/camera_guard.rs`.
- Never leak raw `HWND` pointers across threads; serialize stable Win32 monitor device names (`szDevice`, e.g., `\\.\DISPLAY1`) or `isize` handles at boundaries.

## Mandatory Window Filtering Rules
When enumerating windows via `EnumWindows`:
1. Skip windows where `!IsWindowVisible(hwnd).as_bool()`.
2. Skip windows with `GetWindowTextW` length `== 0`.
3. Skip cloaked UWP/Virtual Desktop windows by querying `DwmGetWindowAttribute` with `DWMWA_CLOAKED` (skip if `cloaked != 0`).
4. Skip tool windows (`WS_EX_TOOLWINDOW`) and ScreenSight's own window handle.

## Reliable Focus Switching (Foreground Lock Workaround)
`SetForegroundWindow` alone often flashes the taskbar instead of shifting focus. Always:
1. Restore minimized windows first (`if IsIconic(hwnd).as_bool() { ShowWindow(hwnd, SW_RESTORE); }`).
2. Compare `GetWindowThreadProcessId` of `GetForegroundWindow()` and the target `hwnd`.
3. If they differ, temporarily attach with `AttachThreadInput(fg_tid, target_tid, true)`, call `SetForegroundWindow(hwnd)`, and detach in all exit paths (`AttachThreadInput(fg_tid, target_tid, false)`).
4. Optional Cursor Teleport: only call `SetCursorPos` to the target monitor's center if `config.cursor_teleport == true`.

## Multi-Monitor Topology
- Query physical monitor bounds using `EnumDisplayMonitors` + `GetMonitorInfoW` (`MONITORINFOEXW`).
- Treat `osRect` from Windows as read-only truth for hit-testing windows. Never overwrite `osRect` with user-edited UI `deskPos`.
- Listen for `WM_DISPLAYCHANGE` to emit `monitors-changed` to the frontend.

## Smart Safeguards
- **Fullscreen Auto-Pause:** Query `SHQueryUserNotificationState`; pause focus switching when state is `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN`, or `QUNS_PRESENTATION_MODE`.
- **Camera Auto-Yield:** Inspect `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam` and `\NonPackaged`. Ignore our own `.exe` name. If any other app has `LastUsedTimeStart > 0` and `LastUsedTimeStop == 0`, signal the vision worker to drop `nokhwa::Camera`.