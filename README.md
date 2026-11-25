# ScreenSight

**ScreenSight** is a local, privacy-first Windows utility that lives in the System Tray and automatically shifts OS window and keyboard focus to whichever display you are looking at—across 2-, 3-, or $N$-monitor horizontal, portrait, ultrawide, and vertically stacked ($2 \times 2$ / $1$-over-$2$) setups.

> Built with **Rust**, **Tauri 2**, **Win32 API (`windows`)**, **Media Foundation (`nokhwa`)**, **ONNX Runtime (`ort`)**, **React**, **TypeScript**, **Tailwind CSS v4**, and **shadcn/ui**.
>
> **Platform Support:** **Windows 10 / 11 (x64) only** — Linux and macOS are not currently supported (display discovery, focus switching, fullscreen checks, and webcam auto-yield rely on native Win32, Windows Media Foundation, and Windows Registry APIs).

---

## Key Features

- **100% Local & Volatile RAM:** Webcam frames stay strictly in volatile RAM for on-device inference and are discarded immediately after each frame—no cloud uploads, no video disk writes.
- **Two-Stage CPU ONNX Vision Pipeline:**
  - **Stage 1 (`face_detector.onnx` / YuNet):** Aspect-preserving letterboxing, confidence-weighted primary face selection, and sub-pixel bounding-box stabilization (`1.5 px` deadband + EMA).
  - **Stage 2 (`head_pose.onnx` / FSANet):** Expanded square face crop (`+30%` padding) normalized to `[0, 1]` BGR for stabilized $(\text{pitch}, \text{yaw}, \text{roll})$ estimation.
  - Configurable capture rate (`10`, `15` default, `24`, or `30 FPS`) using wall-clock `Instant` dwell and cooldown timers.
- **Adaptive 1D & 2D Stacked Monitor Matching:**
  - Separates read-only Windows desktop coordinates (`osRect` via `EnumDisplayMonitors`) from user-customizable virtual desk arrangements (`deskPos`).
  - Automatically switches between **1D Yaw Zone** matching (horizontal rigs) and **Weighted 2D Gaze Pad** matching ($w_p = 1.6$ on pitch for stacked rigs) with hysteresis margin, dwell delay, and Arrange Mode edge snapping.
- **Reliable Win32 Keyboard Focus Transfer:**
  - Filters cloaked UWP/Virtual Desktop windows (`DWMWA_CLOAKED`), tool/overlay windows (`WS_EX_TOOLWINDOW`, `WS_EX_NOACTIVATE`), minimized windows, and shell chrome.
  - Synchronizes with active OS foreground changes (`GetForegroundWindow`) after manual clicks or `Alt+Tab`, and transfers keyboard focus across processes using message-queue-initialized multi-thread `AttachThreadInput`.
- **Smart Windows Safeguards:**
  - **Webcam Auto-Yield:** Watches Windows `HKCU\...\ConsentStore\webcam` and releases the camera handle immediately when Zoom, Google Meet, Microsoft Teams, Discord, or OBS opens the camera.
  - **Fullscreen Auto-Pause:** Queries `SHQueryUserNotificationState` to pause switching during fullscreen Direct3D games or media playback.
  - **Process Exclusions, Cursor Teleport & Autostart:** Per-executable exclusion dialog, optional cursor centering, launch on startup, global `Ctrl+Alt+G` toggle, single-instance tray behavior, and click-through `Identify` display overlays.
  - **UAC / UIPI Safe:** Runs with standard user privileges by default (Windows UIPI blocks non-elevated apps from switching focus onto Administrator-elevated windows such as elevated terminals or Task Manager).

---

## Tech Stack & Project Layout

```text
ScreenSight/
├── src/                               # React + TypeScript + shadcn/ui dashboard
│   ├── App.tsx                        # Main 2x2 dark-mode dashboard & Tauri IPC coordinator
│   ├── main.tsx                       # App entry + click-through ?identify=N overlay renderer
│   ├── components/
│   │   ├── TitleBar.tsx               # Frameless window controls, status pill, FPS badge, master toggle
│   │   ├── ActiveDisplaysCard.tsx     # N-monitor canvas, Arrange Mode snap-drag, Popover, Identify & Sync
│   │   ├── TrackingSettingsCard.tsx   # Camera source, Target FPS, Switch Margin & Dwell sliders
│   │   ├── HeadPoseCard.tsx           # Adaptive 1D Yaw Zone / 2D Gaze Pad + guided Calibrate All
│   │   ├── SmartSafeguardsCard.tsx    # Auto-Yield, Fullscreen Auto-Pause, Cursor Teleport & Autostart
│   │   ├── ExclusionsDialog.tsx       # Ignored .exe manager & UIPI boundary note
│   │   └── StatusFooter.tsx           # Tray status indicator & active global hotkey hint
│   ├── lib/
│   │   ├── monitorLayout.ts           # Proportional 2D canvas projection & AABB edge snapping
│   │   └── gazeGeometry.ts            # 1D yaw zone midpoints, 2D gaze projection & IPC helpers
│   └── types/screensight.ts           # Shared TypeScript schemas aligned with Rust state.rs
├── src-tauri/                         # Rust + Tauri 2 + Win32 backend
│   ├── capabilities/default.json      # Scoped Tauri 2 permissions (window, events, store, shortcut, autostart)
│   ├── models/                        # Bundled CPU ONNX models (YuNet + FSANet)
│   └── src/
│       ├── lib.rs                     # Tauri setup, plugins, System Tray, hot-plug loop & IPC commands
│       ├── state.rs                   # AppConfig schema, MonitorNode telemetry & tauri-plugin-store I/O
│       ├── vision_worker.rs           # Nokhwa decode, YuNet + FSANet inference, EMA & 2D GazeEngine
│       ├── camera_guard.rs            # Media Foundation camera actor & Registry ConsentStore watcher
│       └── win32_focus.rs             # EnumDisplayMonitors, EnumWindows filtering, AttachThreadInput & UIPI checks
└── tests/                             # Node test suite for 2D layout & gaze geometry math
```

---

## Prerequisites (Windows)

- **Windows 10 / 11 (x64)** with WebView2 Runtime (pre-installed on modern Windows)
- **Rust Toolchain** (`rustup` stable with MSVC target)
- **Visual Studio Build Tools** (*Desktop development with C++* workload)
- **Node.js (LTS)** & npm

---

## Getting Started

1. **Install frontend dependencies:**
   ```bash
   npm install
   ```

2. **Run in development mode:**
   ```bash
   npm run tauri dev
   ```

3. **Build the optimized release binary & Windows installers (`.msi` / `-setup.exe`):**
   ```bash
   npm run tauri build
   ```
   Outputs are written under `src-tauri/target/release/` (`screensight.exe` and `bundle/msi/`, `bundle/nsis/`).

---

## Usage & Calibration

1. Launch **ScreenSight** and confirm your webcam and connected monitors appear in **Active Displays**.
2. Click **Identify** to flash numbered overlays on your physical monitors.
3. If screens are stacked vertically (e.g., laptop below an external monitor or a $2 \times 2$ grid), toggle **Arrange**, drag tiles into position (edges snap magnetically), and click **Done** to persist `deskPos` without altering Windows Display Settings.
4. Click **Calibrate All** in **Head Pose**, look naturally at each highlighted monitor, and press **Space** (or click **Capture**) on each step.
5. Toggle tracking anytime from the System Tray or press **`Ctrl + Alt + G`**. Closing the main window hides it to the System Tray while tracking remains active.

---

## Testing & Verification

```bash
# Frontend TypeScript build + unit tests
npm run build
npm test

# Rust lint + unit & ONNX pipeline tests
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# Release-mode ONNX pipeline benchmark & test verification
cargo test --release --manifest-path src-tauri/Cargo.toml -- --nocapture
```
