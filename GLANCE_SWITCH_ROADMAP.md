# ScreenSight (Windows Edition) — Architecture & Phased Learning Guide

> **Document Version:** `v1.0 — Finalized Blueprint` (November 20, 2026)  
> **Status:** Locked & Ready for Phase 1 Implementation  
> **Tech Stack:** Rust + Tauri 2.0 + Windows API (`windows` & `windows-registry`) + `nokhwa` (Media Foundation) + `ort` (ONNX Runtime) + React + TypeScript + Tailwind CSS v4 + **shadcn/ui**

---

## 1. Project Overview & Architecture

**ScreenSight** is a lightweight, privacy-first Windows utility that runs silently in the System Tray. It captures your webcam locally at a user-configurable framerate (defaulting to $15\text{ FPS}$ to minimize CPU/GPU overhead), tracks your head orientation (**yaw and pitch** angles) to determine which monitor you are looking at across any 2-, 3-, or $N$-monitor setup—including horizontally arranged, portrait, ultrawide, and vertically stacked rigs (such as $2 \times 2$ or $1$-over-$2$)—and automatically shifts OS window and keyboard focus to that screen without requiring a mouse click.

### System Architecture Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WINDOWS DESKTOP & WEBCAM                            │
│                                                                             │
│  [Physical Webcam] ──► Windows Media Foundation (Frame Server)              │
│  [Displays & Win]  ──► user32.dll + dwmapi.dll (Monitors, Hot-Plug, Focus)  │
│  [Fullscreen API]  ──► shell32.dll (SHQueryUserNotificationState)           │
│  [Registry]        ──► HKCU\...\ConsentStore\webcam (Active App Check)      │
└──────────────┬───────────────────────────┬────────────────────────▲─────────┘
               │                           │                        │
               ▼                           ▼                        │
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RUST BACKEND (src-tauri/src/)                        │
│                                                                             │
│  ┌────────────────────┐    ┌────────────────────────┐    ┌───────────────┐  │
│  │  camera_guard.rs   │───►│    vision_worker.rs    │───►│ win32_focus.rs│  │
│  │ • Registry watcher │    │ • Dynamic FPS capture  │    │ • N-Monitor   │  │
│  │ • Auto-yield cam   │    │   (Default: 15 FPS)    │    │   osRect map  │  │
│  │ • Device & FPS cfg │    │ • Stage 1: Face crop   │    │ • Cloak filter│  │
│  └────────────────────┘    │ • Stage 2: Yaw + Pitch │    │ • Game pause  │  │
│                            │ • EMA + Weighted 2D    │    │ • Focus lock  │  │
│                            │   Nearest-Anchor       │    │ • Cursor jump │  │
│                            │ • Hysteresis + Dwell   │    └───────────────┘  │
│                            └───────────┬────────────┘                       │
│                                        │ Tauri Events & Commands            │
│                                        ▼                                    │
│                            ┌────────────────────────┐                       │
│                            │  lib.rs  &  state.rs   │                       │
│                            │ • Single-Instance Lock │                       │
│                            │ • osRect vs. deskPos   │                       │
│                            │ • Per-Monitor Anchors  │                       │
│                            │ • System Tray & Store  │                       │
│                            └───────────┬────────────┘                       │
└────────────────────────────────────────┼────────────────────────────────────┘
                                         │ IPC Bridge (invoke / listen)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 DARK-MODE SETTINGS & CALIBRATION DASHBOARD                  │
│             (React + TypeScript + Tailwind CSS v4 + shadcn/ui)              │
│                                                                             │
│  • Frameless Header: Live Status Badge, Actual FPS Telemetry & Master Switch│
│  • 2x2 Bento Grid: Interactive 2D N-Monitor Canvas | Tracking Settings      │
│                    Adaptive 1D/2D Gaze Pad         | Smart Safeguards       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Design Goals

1. **100% Local & Private:** Every camera frame lives strictly in RAM and is dropped immediately after inference—zero network calls, zero disk writes.
2. **True $N$-Monitor & 2D Stacked Support:** Supports 2, 3, or 6+ displays in horizontal, portrait, ultrawide, or vertically stacked arrangements (e.g., 2-on-top / 2-on-bottom). Separates read-only Windows coordinates (`osRect`) from editable physical desk layout (`deskPos`) so users can drag and stack screens directly inside the dashboard without altering Windows Display Settings.
3. **Video-Call Friendly:** Uses Windows Media Foundation (`ApiBackend::MediaFoundation`) for Windows 11 Multi-App Camera sharing **plus** an automatic Windows Registry yield mechanism so Google Meet, Zoom, and Discord are never blocked.
4. **Fullscreen & Gaming Safe:** Automatically detects exclusive fullscreen Direct3D games and media apps via `SHQueryUserNotificationState` (plus a user-defined App Exclusion List) so glancing at another monitor never accidentally alt-tabs you out of a match or movie.
5. **Tunable Efficiency:** Defaults to $640 \times 480$ at $15\text{ FPS}$ for negligible background CPU/battery usage, while letting users adjust the target FPS ($10$, $15$, $24$, or $30\text{ FPS}$) to trade power efficiency for faster responsiveness.

---

## 2. Prerequisites (Windows)

Before starting Phase 1, ensure your development machine has:

* **Rust Toolchain:** Latest stable Rust (`rustup update stable`, Rust $\ge 1.95$ recommended for the latest `windows-registry` and Tauri 2 crates).
* **C++ Build Tools:** Visual Studio Build Tools with the **"Desktop development with C++"** workload (needed by Cargo to link native Windows libraries and `nokhwa`/`ort`).
* **Node.js (LTS):** For Vite, React, TypeScript, and the `shadcn` CLI.
* **WebView2 Runtime:** Pre-installed on Windows 10/11 (used by Tauri 2 for the lightweight UI window).

---

## 3. Folder Structure

```text
screensight/
├── package.json
├── vite.config.ts                  # Vite + @tailwindcss/vite plugin + @/* path alias
├── tsconfig.json                   # Root TS config with @/* path mapping
├── tsconfig.app.json               # App TS config with @/* path mapping
├── components.json                 # shadcn/ui configuration
├── src/                            # Frontend (React + TypeScript + shadcn/ui)
│   ├── index.css                   # Tailwind CSS v4 entry (`@import "tailwindcss";`) + dark theme tokens
│   ├── lib/
│   │   ├── utils.ts                # shadcn/ui `cn()` helper
│   │   └── monitorLayout.ts        # Uniform 2D bounding-box projection & magnetic edge snapping
│   ├── components/
│   │   ├── ui/                     # Generated shadcn/ui primitives (Badge, Button, Card, Dialog, Input, Label, Popover, Select, Separator, Slider, Switch, Tooltip)
│   │   ├── TitleBar.tsx            # Frameless header: logo, status pill, FPS telemetry pill, master toggle & window controls
│   │   ├── ActiveDisplaysCard.tsx  # Interactive 2D N-monitor canvas: Live View, Arrange Mode drag-and-stack, Identify & Sync
│   │   ├── TrackingSettingsCard.tsx# Camera selector, Target FPS selector (default 15), Switch Margin & Dwell sliders
│   │   ├── HeadPoseCard.tsx        # Adaptive 1D multi-zone yaw bar or 2D (yaw, pitch) Gaze Pad + "Calibrate All" flow
│   │   ├── SmartSafeguardsCard.tsx # Auto-Yield, Fullscreen Auto-Pause, Cursor Teleport switches & Exclusions dialog trigger
│   │   ├── ExclusionsDialog.tsx    # Modal to manage ignored process names (e.g., games, OBS)
│   │   └── StatusFooter.tsx        # System Tray status indicator & global shortcut hint
│   ├── App.tsx                     # Main 2x2 dark-mode dashboard layout
│   └── main.tsx
└── src-tauri/                      # Backend (Rust + Tauri 2 + Win32)
    ├── Cargo.toml
    ├── tauri.conf.json             # App metadata, frameless window config, bundled ONNX resources
    ├── capabilities/
    │   └── default.json            # Tauri 2 security permissions for plugins, window controls, overlays & events
    ├── models/
    │   ├── face_detector.onnx      # Stage 1: Lightweight face bounding-box detector (e.g., YuNet / UltraFace)
    │   └── head_pose.onnx          # Stage 2: Head-pose yaw/pitch/roll estimator (e.g., FSANet / 6DRepNet)
    └── src/
        ├── main.rs                 # Binary entry point (calls `screensight_lib::run()`)
        ├── lib.rs                  # Tauri setup, plugins, System Tray, IPC commands, Identify overlays & hot-plug listener
        ├── state.rs                # Thread-safe AppConfig (`target_fps`, `desk_pos`, per-monitor anchors) & telemetry
        ├── win32_focus.rs          # Safe Rust wrappers for N-monitor `osRect` topology, cloak filtering, focus lock & fullscreen check
        ├── camera_guard.rs         # Webcam enumeration, dynamic FPS stream config & Registry auto-yield watcher
        └── vision_worker.rs        # Background thread: nokhwa -> Stage 1 & 2 ONNX -> EMA -> Weighted 2D Nearest-Anchor -> Dwell -> Focus
```

---

## 4. UI Design & Layout Specification (shadcn/ui)

ScreenSight uses a single-window, compact dark-mode dashboard ($\approx 880 \times 580$ default size) styled with **shadcn/ui** over a deep neutral surface (`bg-zinc-950` canvas, `bg-zinc-900/70` cards, subtle `border-zinc-800` outlines, and `emerald-500` active highlights).

### Dashboard Wireframe (Example: 2x2 Stacked Rig)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [◉] ScreenSight   (● Tracking Active)  [15 FPS · Media Foundation]           │
│                                                  ON (●──) Tracking  ─  □  ×  │
├──────────────────────────────────────┬───────────────────────────────────────┤
│ Active Displays  [Arrange][ID][Sync] │ Tracking Settings                     │
│                                      │                                       │
│    ┌─────────────┐ ┌═════════════┐   │ [Cam] Camera  [ 1080p USB Webcam  v ] │
│    │  Monitor 1  │ ║  Monitor 2  ║   │ [FPS] Rate    [ 15 FPS (Default)  v ] │
│    │   Discord   │ ║   Chrome    ║   │                                       │
│    └─────────────┘ └═════════════┘   │ Switch Margin ──────●──────    6 deg  │
│    ┌─────────────┐ ┌─────────────┐   │ Dwell Delay   ────●────────   300 ms  │
│    │  Monitor 3  │ │  Monitor 4  │   │                                       │
│    │   VS Code   │ │  Terminal   │   │                                       │
│    └─────────────┘ └─────────────┘   │                                       │
│ Focused: Monitor 2 · Chrome          │                                       │
├──────────────────────────────────────┼───────────────────────────────────────┤
│ Head Pose & Calibration (2D Gaze Pad)│ Smart Safeguards                      │
│                                      │                                       │
│     ┌─────────────────────────┐      │ Auto-Yield for Video Calls     (──●)  │
│ +15°│    (M1)         (M2) +  │      │ Fullscreen & Gaming Auto-Pause (──●)  │
│   0°│ ─ ─ ─ ─ ─ ─┼─ ─ ─ ─ ─ ─ │      │ Cursor Teleport                (●──)  │
│ -15°│    (M3)         (M4)    │      │                                       │
│     └─────────────────────────┘      │ [Manage Excluded Apps...]             │
│ Yaw: +17.2° · Pitch: +11.4° [Cal All]│                                       │
├──────────────────────────────────────┴───────────────────────────────────────┤
│ Running in System Tray                            Pause Shortcut: Ctrl+Alt+G │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Multi-Monitor & Stacked UX Breakdown

| Region | File | shadcn/ui Primitives | Key Behavior & Visual Design |
| :--- | :--- | :--- | :--- |
| **Top Header Bar** | `TitleBar.tsx` | `Badge`, `Switch`, `Button` | Uses `data-tauri-drag-region` for frameless dragging. Displays live status pill (`Tracking Active` emerald, `Yielded to chrome.exe` amber, `Fullscreen Paused` blue, `Paused` zinc), live telemetry pill (`15 FPS · Media Foundation`), master `Tracking` switch, and minimize/close-to-tray buttons. |
| **Active Displays** | `ActiveDisplaysCard.tsx` | `Card`, `Badge`, `Button`, `Popover`, `Switch`, `Tooltip` | Projects all $N$ displays proportionally from `deskPos` using `monitorLayout.ts` so $2 \times 2$ stacks, $1$-over-$2$ rigs, portrait screens, and ultrawides render cleanly with a $3\text{ px}$ inner gap. Includes a compact top-right toolbar: **Arrange** (enables pointer drag-and-drop with magnetic Top/Bottom/Left/Right edge snapping and overlap prevention), **Identify** (flashes transparent click-through `1`/`2`/`3`/`4` badges on physical monitors), and **Sync** (resets `deskPos` back to Windows `osRect`). Focused monitor gets an emerald glow (`border-emerald-500/80 bg-emerald-950/20`); newly detected or uncalibrated screens show a dashed border and amber status dot. Clicking any monitor in Live View opens a `Popover` to **Calibrate This Display** or toggle **Include in Tracking**. When a 4+ monitor rig shrinks a box below $110\text{ px}$ wide, interior text collapses to its number badge + status dot, revealing full details via `Tooltip` and the bottom `Focused:` summary line. |
| **Tracking Settings** | `TrackingSettingsCard.tsx` | `Card`, `Label`, `Select`, `Slider` | **Camera** picker (via `nokhwa::query`), **Target FPS** picker ($10\text{ FPS}$ Eco, $15\text{ FPS}$ Default, $24\text{ FPS}$ Smooth, $30\text{ FPS}$ Responsive), **Switch Margin (Hysteresis)** slider ($4^\circ$–$12^\circ$), and **Dwell Delay** slider ($150\text{ ms}$–$600\text{ ms}$). |
| **Head Pose & Calibration** | `HeadPoseCard.tsx` | `Card`, `Button` | Adapts automatically to `is_2d_layout`: renders a **1D Multi-Zone Yaw Bar** with $N$ dynamic midpoint dividers (`M1 | M2 | M3`) for horizontal-only setups, or switches to a compact **2D Gaze Pad** ($\text{Yaw}$ on X-axis, $\text{Pitch}$ on Y-axis) displaying each monitor's anchor dot and the live head-pose reticle when monitors are stacked vertically. Includes a guided **Calibrate All** button (*"Look at Monitor 1 -> Press Space -> Look at Monitor 2..."*). |
| **Smart Safeguards** | `SmartSafeguardsCard.tsx` | `Card`, `Switch`, `Button`, `Dialog`, `Input` | Emerald toggles for **Auto-Yield for Video Calls**, **Fullscreen & Gaming Auto-Pause**, **Cursor Teleport**, and **Launch on Startup**, plus a modal trigger for managing ignored process names. |
| **Status Footer** | `StatusFooter.tsx` | `Separator` | Subtle muted text (`text-xs text-zinc-500`) confirming background tray persistence on the left and the active global pause shortcut (`Ctrl + Alt + G`) on the right. |

### Required shadcn/ui CLI Install Command

```bash
npx shadcn@latest add badge button card dialog input label popover select separator slider switch tooltip
```

---

## 5. Phased Development & Learning Roadmap

Each phase is scoped to a single system layer so you can write, test, and understand every line before moving on.

### Phase 1: Project Initialization + Tailwind CSS v4, shadcn/ui & 2D Spatial Layout Engine

**Learning Focus:** Scaffolding a Tauri 2 + Vite + React + TypeScript workspace, configuring a frameless dark-mode window, wiring **shadcn/ui** with Tailwind CSS v4, and building a 2D monitor projector with magnetic edge snapping.

#### Tasks

1. **Scaffold the Tauri 2 project:**
   ```bash
   npm create tauri-app@latest screensight
   # Choose: TypeScript / JavaScript -> npm -> React -> TypeScript
   cd screensight
   npm install
   ```
2. **Install Tailwind CSS v4 (Vite plugin) & icons:**
   ```bash
   npm install tailwindcss @tailwindcss/vite lucide-react
   npm install -D @types/node
   ```
   Replace the contents of `src/index.css` with:
   ```css
   @import "tailwindcss";
   ```
3. **Configure the `@/*` import alias (required before running `shadcn init`):**
   * Add `"baseUrl": "."` and `"paths": { "@/*": ["./src/*"] }` inside `compilerOptions` in both `tsconfig.json` and `tsconfig.app.json`.
   * Register `tailwindcss()` and `resolve.alias` (`"@" -> path.resolve(__dirname, "./src")`) in `vite.config.ts`.
4. **Initialize shadcn/ui and install all required primitives:**
   ```bash
   npx shadcn@latest init
   npx shadcn@latest add badge button card dialog input label popover select separator slider switch tooltip
   ```
   * Set `<html class="dark">` in `index.html` so the dashboard uses the dark palette by default.
   * In `src-tauri/tauri.conf.json`, configure the main window to `width: 880`, `height: 580`, `minWidth: 820`, `minHeight: 540`, and `"decorations": false` for the custom frameless title bar.
5. **Build the 2D Spatial Projector & Edge-Snapper (`src/lib/monitorLayout.ts`):**
   * Maintain `osRect` (read-only Windows coordinates) separately from `deskPos` (editable drag-and-drop physical coordinates).
   * Compute the 2D bounding box across all monitors' `deskPos` and apply a uniform scale factor:
     $$\text{scale} = \min\left(\frac{W_{\text{canvas}} - 2p}{W_{\text{total}}},\; \frac{H_{\text{canvas}} - 2p}{H_{\text{total}}}\right)$$
     so portrait ($1080 \times 1920$), landscape ($2560 \times 1440$), and $2 \times 2$ stacked grids keep true proportions.
   * Implement `snapMonitorPosition(dragged, others)` with a magnetic threshold ($\approx 120$ virtual pixels) to snap top/bottom/left/right edges cleanly when arranging stacked monitors, rejecting overlapping drops and smoothly re-centering the canvas on pointer release.
6. **Verify:** Run `npm run tauri dev` and test `ActiveDisplaysCard.tsx` with mock 2-monitor, 3-monitor ($1$-over-$2$), and 4-monitor ($2 \times 2$ stacked) rigs—verifying drag-to-stack snapping, compact tiles below $110\text{ px}$, and `Popover`/`Tooltip` behavior.

---

### Phase 2: Win32 $N$-Monitor Topology, Hot-Plug Sync & Focus Switching (`win32_focus.rs`)

**Learning Focus:** Rust Ownership/Borrowing, scoped `unsafe {}` FFI blocks, Win32 Handles (`HWND`/`HMONITOR`), UTF-16 buffers (`*W`), `extern "system"` callbacks, and Windows window-management edge cases.

#### Tasks

1. **Enable the required Win32 features in `src-tauri/Cargo.toml`:**
   ```toml
   [dependencies.windows]
   version = "0.62.2"
   features = [
       "Win32_Foundation",
       "Win32_Graphics_Dwm",
       "Win32_Graphics_Gdi",
       "Win32_System_Threading",
       "Win32_UI_Shell",
       "Win32_UI_WindowsAndMessaging",
   ]
   ```
2. **Read Full $N$-Monitor `osRect` Topology (`get_monitors`):**
   * Use `EnumDisplayMonitors` and `GetMonitorInfoW` with `MONITORINFOEXW` to capture every display's:
     * Stable Win32 device name (`szDevice`, e.g., `\\.\DISPLAY1`) as its persistent `id`.
     * Virtual desktop `osRect` bounds (`left`, `top`, `right`, `bottom`, where screens left of or above the primary monitor have negative coordinates).
     * Primary display flag (`MONITORINFOF_PRIMARY`).
   * **Important Rule:** Always use `osRect`—never `deskPos`—when mapping windows from `GetWindowRect` to their host monitor.
   * Tauri 2 enables `PerMonitorV2` DPI awareness by default, keeping coordinates consistent across mixed scaling (e.g., $100\%$ and $125\%$).
3. **Monitor Hot-Plug & Orientation Change Detection:**
   * Listen for `WM_DISPLAYCHANGE` (or diff the monitor list on a lightweight watcher) so plugging in a new display, unplugging a monitor, rotating a screen to portrait mode, or rearranging monitors in Windows Display Settings emits `screensight://monitors-changed` to React immediately.
4. **Find the Real Top-Most Window on a Target Monitor (`find_top_window_on_monitor`):**
   * Enumerate windows in Z-order via `EnumWindows`.
   * **Filter out ghost & background windows** (critical on Windows 10/11):
     * Must pass `IsWindowVisible(hwnd)`.
     * Must **not** be cloaked by DWM (check `DwmGetWindowAttribute` with `DWMWA_CLOAKED`—skips suspended UWP apps and windows on other Virtual Desktops).
     * Must **not** have the `WS_EX_TOOLWINDOW` extended style (skips floating tooltips and tray popups).
     * Must **not** be ScreenSight's own window handle (`GetWindowThreadProcessId` $\neq$ current PID).
   * Check whether the window's center point falls inside the target monitor's `osRect`. Because `EnumWindows` walks front-to-back in Z-order, the first matching window is the top-most visible app on that monitor. Return both its `HWND` and title (`GetWindowTextW`) for the **Active Displays** card.
5. **Focus Switching & Bypassing Windows Foreground Lock (`focus_window`):**
   * If `IsIconic(hwnd)` is true, call `ShowWindow(hwnd, SW_RESTORE)`.
   * **Foreground Lock Workaround:** Attach briefly to the currently focused window's input thread via `GetWindowThreadProcessId(GetForegroundWindow(), ...)` + `AttachThreadInput(current_tid, foreground_tid, true)`, call `SetForegroundWindow(hwnd)`, and immediately detach (`AttachThreadInput(..., false)`).
   * **Optional Cursor Teleport:** If enabled in settings, call `SetCursorPos(center_x, center_y)` (using `osRect` center) so mouse-wheel scrolling immediately targets the newly focused display.
6. **Fullscreen / Gaming Auto-Pause (`is_fullscreen_or_excluded`):**
   * Call `SHQueryUserNotificationState()` and pause switching if Windows reports `QUNS_RUNNING_D3D_FULL_SCREEN` or `QUNS_BUSY`.
   * Query the active window's executable name via `OpenProcess` + `QueryFullProcessImageNameW` and compare against the user's **Ignored Apps List**.
7. **Verify:** Expose a temporary command `#[tauri::command] fn debug_focus_monitor(monitor_id: String)` and click each display inside **Active Displays** to confirm focus jumps reliably across all connected monitors, even after stacking them in Arrange Mode.

---

### Phase 3: Webcam Selection, Configurable FPS & Auto-Yield Guard (`camera_guard.rs`)

**Learning Focus:** Rust RAII (`Drop` trait via `Option<Camera>`), Windows Media Foundation, dynamic hardware format negotiation, and safe Registry queries via `windows-registry`.

#### Tasks

1. **Add camera & registry crates in `src-tauri/Cargo.toml`:**
   ```toml
   nokhwa = { version = "0.10.11", features = ["input-native"] }
   windows-registry = "0.100.0"
   image = "0.25"
   ```
   *(Note: `input-native` uses Microsoft Media Foundation on Windows, enabling compatibility with Windows 11's Multi-App Camera Frame Server.)*
2. **Enumerate Physical Webcams (`list_cameras`):**
   * Use `nokhwa::query(ApiBackend::MediaFoundation)` to return each available camera's index and friendly name to the frontend `Camera` selector (avoiding virtual cameras like OBS hijacking index `0`).
3. **Configurable Camera FPS (Default: $15\text{ FPS}$):**
   * Write `open_shared_camera(index: u32, target_fps: u32) -> Result<Camera, NokhwaError>`.
   * Request `CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, target_fps)` using `RequestedFormatType::Closest(...)`.
   * **Hardware Compatibility Note:** Many USB webcams only advertise hardware modes like $15\text{ FPS}$ and $30\text{ FPS}$ (not $10$ or $24$). Using `Closest(...)` lets Media Foundation open the nearest supported hardware rate, while `vision_worker.rs` enforces the exact user-selected `target_fps` processing cadence.
   * When the user changes either `camera_index` or `target_fps` in the UI, drop `active_camera` (`active_camera = None`) so the next loop iteration cleanly re-opens the stream with the updated settings.
4. **Implement Windows Registry Auto-Yield (`get_other_active_camera_user`):**
   * Inspect both:
     * `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam` (UWP/Store apps)
     * `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged` (desktop `.exe` apps like Chrome, Discord, Zoom)
   * Skip your own executable name (`std::env::current_exe()`).
   * If any other app has `LastUsedTimeStart` $> 0$ and `LastUsedTimeStop` $= 0$, return `Some(app_name)`.
5. **Implement Clean Handle Release & Stale-Key Override:**
   * Hold the stream in `active_camera: Option<Camera>`.
   * When another app claims the webcam (and Auto-Yield is enabled), call `active_camera.take()` so `Camera::drop()` instantly releases Media Foundation, then sleep $500\text{ ms}$ per check until the call ends.
6. **Verify:** Run `npm run tauri dev`, switch between $15\text{ FPS}$ and $30\text{ FPS}$ in the UI, then open **Google Meet** in Chrome and confirm ScreenSight immediately yields the camera and resumes cleanly when the tab closes.

---

### Phase 4: Two-Stage Vision Pipeline, Weighted 2D Nearest-Anchor Matching & Dwell Logic (`vision_worker.rs`)

**Learning Focus:** Background worker threads (`std::thread`), lock-free atomics (`Arc<AtomicBool>`), tensor preprocessing (`ndarray`), two-stage ONNX inference (`ort`), and 2D angular classification for stacked displays.

#### Why Two Stages Matter
Standalone head-pose models like **FSANet** and **6DRepNet** expect a **tightly cropped face image**, not a full $640 \times 480$ room shot. Feeding an uncropped webcam frame directly into a head-pose network produces noisy yaw and pitch predictions.

#### Tasks

1. **Add ONNX inference crates in `src-tauri/Cargo.toml`:**
   ```toml
   ort = "2.0.0-rc.15"
   ndarray = "0.17"
   ```
2. **Bundle Lightweight ONNX Models:**
   * **Stage 1 (`src-tauri/models/face_detector.onnx`):** Fast CPU face detector such as **YuNet** ($\approx 230\text{ KB}$) or **UltraFace-RFB-320** ($\approx 1.2\text{ MB}$) to locate the primary face bounding box `(x, y, w, h)`.
   * **Stage 2 (`src-tauri/models/head_pose.onnx`):** Lightweight head-pose estimator such as **FSANet** ($\approx 1\text{–}5\text{ MB}$) or **6DRepNet** to regress horizontal **yaw** and vertical **pitch** angles in degrees.
   * Register `models/*` inside `src-tauri/tauri.conf.json` under `bundle.resources` so packaged builds locate them via Tauri's `path().resource_dir()`.
3. **Run the Dynamically Paced 2D $N$-Monitor Inference Loop:**
   * Compute target frame interval from the active config's `target_fps` (clamped safely to $[5, 60]$, default $15$):
     $$\Delta t_{\text{frame}} = \left\lfloor \frac{1000}{\text{target\_fps}} \right\rfloor \text{ ms}$$
     At the default $15\text{ FPS}$, $\Delta t_{\text{frame}} \approx 66\text{ ms}$; at $30\text{ FPS}$, $\Delta t_{\text{frame}} \approx 33\text{ ms}$. Measure elapsed loop time with `Instant::now()` and sleep only for the remaining budget.
   * **Per-Frame Pipeline:**
     1. **Detect Face:** Resize frame for Stage 1 and extract the largest face bounding box. If no face is detected (you stepped away), hold state and skip focus switching.
     2. **Crop & Estimate $(\text{yaw}, \text{pitch})$:** Add $\approx 20\%$ padding around the bounding box, resize to Stage 2's input tensor (`NCHW` normalized `Array4<f32>`), and extract raw `(yaw, pitch)` in degrees.
     3. **Apply Exponential Moving Average (EMA) Smoothing** to eliminate micro-jitter on both axes:
        $$\text{yaw}_{\text{smooth}} = \alpha \cdot \text{yaw}_{\text{raw}} + (1 - \alpha) \cdot \text{yaw}_{\text{smooth}}$$
        $$\text{pitch}_{\text{smooth}} = \alpha \cdot \text{pitch}_{\text{raw}} + (1 - \alpha) \cdot \text{pitch}_{\text{smooth}}$$
        *(Start with $\alpha = 0.35$; optionally scale $\alpha$ gently when changing FPS so responsiveness stays consistent between $15\text{ FPS}$ and $30\text{ FPS}$.)*
     4. **Detect Stacked 2D Geometry (`is_2d_layout`):**
        * Inspect the `deskPos` vertical spans of all enabled monitors. Whenever any two enabled monitors have non-overlapping vertical spans (one sits above another), set `is_2d_layout = true`.
     5. **Weighted 2D Nearest-Anchor Classification with Switch Margin (Hysteresis):**
        * Looking left/right ($\text{yaw}$) naturally spans $\pm 25^\circ$–$35^\circ$, whereas looking up/down ($\text{pitch}$) between stacked monitors spans a smaller range ($\pm 10^\circ$–$15^\circ$). Set pitch weight $w_p = 1.6$ when `is_2d_layout` is true (or $w_p = 0$ for horizontal-only rigs):
          $$d_i = \sqrt{(\text{yaw}_{\text{smooth}} - \text{yaw}_i)^2 + w_p \cdot (\text{pitch}_{\text{smooth}} - \text{pitch}_i)^2}$$
        * Let $c$ be the currently focused monitor and $k = \arg\min_i d_i$ be the nearest candidate monitor. Start a pending switch only if $k \neq c$ **and** the candidate beats the current monitor by at least `switch_margin_deg` ($m_{\text{hyst}}$, default $6^\circ$):
          $$d_k + m_{\text{hyst}} < d_c$$
        * **Webcam Mounting Note:** Because each monitor stores its own calibrated $(\text{yaw}_i, \text{pitch}_i)$ anchor, stacked tracking works accurately regardless of whether your webcam is mounted between rows, on top of the upper display, or on a desk tripod below.
        * **Zero-Calibration Fallback:** For any uncalibrated monitor, synthesize initial anchors from its normalized 2D `deskPos` center ($\text{yaw} \in [-24^\circ, +24^\circ]$, $\text{pitch} \in [-12^\circ, +12^\circ]$) while displaying an amber `"Uncalibrated"` dot in the UI.
     6. **Frame-Rate-Independent Dwell Timer & Cooldown:**
        * Track dwell time using **wall-clock `std::time::Instant`** rather than frame counts so a $300\text{ ms}$ dwell delay takes exactly $300\text{ ms}$ at $10\text{ FPS}$, $15\text{ FPS}$, or $30\text{ FPS}$.
        * Enforce a `cooldown_ms` lock (default $800\text{ ms}$) after every focus switch.
4. **Verify:** Log `measured_fps`, `smoothed_yaw`, `smoothed_pitch`, and per-monitor distances $d_i$ across both horizontal and $2 \times 2$ stacked setups to confirm zero boundary flicker on horizontal and vertical edges.

---

### Phase 5: Tauri 2 System Tray, Identify Overlays, Plugins & Shared State (`state.rs` + `lib.rs`)

**Learning Focus:** Tauri 2 plugin architecture, capability permissions (`capabilities/default.json`), shared state (`Arc<RwLock<AppConfig>>`), click-through overlay windows, and System Tray lifecycle management.

#### Tasks

1. **Install Official Tauri 2 Plugins:**
   ```bash
   npm run tauri add single-instance
   npm run tauri add store
   npm run tauri add global-shortcut
   npm run tauri add autostart
   ```
   * **Critical Rule:** Register `tauri_plugin_single_instance` **first** in `tauri::Builder::default()` so launching ScreenSight twice focuses the existing window instead of spawning a competing camera thread.
2. **Configure Permissions (`src-tauri/capabilities/default.json`):**
   Grant explicit permissions for `core:window:allow-minimize`, `core:window:allow-hide`, `core:window:allow-start-dragging` (for `TitleBar.tsx`), `store:default`, `global-shortcut:allow-register`, `global-shortcut:allow-unregister`, and `autostart:*`.
3. **Create Shared State (`src-tauri/src/state.rs`):**
   Define serializable structs for $N$-monitor 2D configuration and telemetry:
   * `DeskPoint`: `{ x: i32, y: i32 }`
   * `MonitorCalibration`: `{ enabled: bool, desk_pos: Option<DeskPoint>, anchor_yaw: Option<f32>, anchor_pitch: Option<f32> }`
   * `AppConfig`:
     * `camera_index: u32` (default: `0`)
     * `target_fps: u32` (default: `15`, presets: `10`, `15`, `24`, `30`)
     * `switch_margin_deg: f32` (default: `6.0`, range: $4^\circ$–$12^\circ$)
     * `dwell_ms: u64` (default: `300`)
     * `cooldown_ms: u64` (default: `800`)
     * `smoothing_alpha: f32` (default: `0.35`)
     * `auto_yield_camera: bool` (default: `true`)
     * `auto_pause_fullscreen: bool` (default: `true`)
     * `teleport_cursor: bool` (default: `false`)
     * `excluded_processes: Vec<String>`
     * `monitor_configs: HashMap<String, MonitorCalibration>` (keyed by Win32 `szDevice`, e.g., `\\.\DISPLAY1`)
   * `MonitorNode`: `{ id, index, os_rect, desk_pos, is_primary, is_focused, active_window_title, enabled, anchor }`
   * `TelemetryPayload`: `{ smoothed_yaw, smoothed_pitch, measured_fps, focused_monitor_id, is_2d_layout, monitors: Vec<MonitorNode> }`
   * `TrackerStatus`: `Active`, `ManuallyPaused`, `YieldedToApp(String)`, `PausedFullscreen`, `NoCamera`
4. **Build System Tray, IPC Commands & Close-to-Tray (`src-tauri/src/lib.rs`):**
   * Enable `"tray-icon"` on `tauri` in `Cargo.toml`.
   * Expose commands:
     * `get_monitors`, `list_cameras`, `update_config`, `set_tracking_enabled`
     * `calibrate_monitor(monitor_id)` — averages a $300\text{ ms}$ $(\text{yaw}, \text{pitch})$ sample and saves it as that monitor's anchor.
     * `set_monitor_enabled(monitor_id, enabled)` — includes/excludes a screen (e.g., TV or sensor panel).
     * `update_monitor_desk_layout(positions: HashMap<String, DeskPoint>)` — persists custom dragged/stacked `deskPos` coordinates and immediately recalculates `is_2d_layout`.
     * `reset_monitor_desk_layout()` — clears custom `deskPos` overrides to match Windows `osRect`.
     * `identify_monitors()` — spawns brief ($\approx 2.5\text{ s}$), transparent, always-on-top, click-through Tauri overlay badges displaying `1`, `2`, `3`, `4` at each monitor's `osRect` center.
   * Build a Tray Menu with: live status line, `Pause / Resume Tracking`, `Calibrate Displays...`, `Open Settings`, and `Quit ScreenSight`.
   * Bind the default global shortcut (`Ctrl + Alt + G`) to toggle `Pause / Resume` from anywhere.
   * Intercept `WindowEvent::CloseRequested` to hide the window (`window.hide()`) instead of terminating the background worker.
   * Emit high-frequency `screensight://telemetry` events only while the settings window is visible (`window.is_visible()`) so the hidden tray app spends zero IPC overhead on UI updates.

---

### Phase 6: Wiring the Interactive 2D shadcn/ui Dashboard (`src/App.tsx`)

**Learning Focus:** Connecting every shadcn/ui control from Section 4 to Rust via `invoke()` and `listen()`, driving Arrange Mode stacking and guided per-monitor calibration, and persisting settings with `tauri-plugin-store`.

#### IPC Wiring Map

* **`TitleBar.tsx`:**
  * Subscribes to `screensight://status` and `screensight://telemetry` to render the live status pill and actual capture rate (`15 FPS · Media Foundation`).
  * Master `Tracking` switch calls `invoke("set_tracking_enabled", { enabled })`.
  * Minimize (`getCurrentWindow().minimize()`) and Close (`getCurrentWindow().hide()`) buttons handle frameless window controls.
* **`ActiveDisplaysCard.tsx`:**
  * Subscribes to `screensight://monitors-changed` and `screensight://telemetry`, feeding `monitors` into `layoutMonitors()` from `src/lib/monitorLayout.ts`.
  * **Live View:** Clicking any monitor opens a `Popover` with **Calibrate This Display** (`invoke("calibrate_monitor", { monitorId })`) and an **Include in Tracking** `Switch` (`invoke("set_monitor_enabled", { monitorId, enabled })`).
  * **Arrange Mode:** Toggling **Arrange** lets users drag tiles above, below, or beside each other with magnetic edge snapping (`snapMonitorPosition`); releasing a tile calls `invoke("update_monitor_desk_layout", { positions })` and saves to `tauri-plugin-store`.
  * **Identify & Sync:** Toolbar buttons call `invoke("identify_monitors")` and `invoke("reset_monitor_desk_layout")`.
  * Renders dashed borders + amber dots for any newly detected display missing an anchor, and switches to compact numbered tiles with hover `Tooltip` when box width falls below $110\text{ px}$.
* **`TrackingSettingsCard.tsx`:**
  * **Camera `Select`:** Populated via `invoke("list_cameras")`; changing it updates `camera_index` and hot-swaps the stream.
  * **Camera FPS `Select` (Default: $15\text{ FPS}$):** Offers `10 FPS (Eco)`, `15 FPS (Default)`, `24 FPS (Smooth)`, and `30 FPS (Responsive)`. Calls `invoke("update_config", { config })` and persists to `tauri-plugin-store`.
  * **Switch Margin `Slider` ($4^\circ$–$12^\circ$) & Dwell Delay `Slider` ($150\text{ ms}$–$600\text{ ms}$):** Live-update `AppConfig` with instant feedback.
* **`HeadPoseCard.tsx`:**
  * Reads `is_2d_layout` from telemetry:
    * `false` (horizontal rig): renders the **1D Multi-Zone Yaw Bar** with dynamic zone boundaries at the midpoints between adjacent monitor anchors.
    * `true` (stacked rig): renders the **2D Gaze Pad** plotting every monitor's $(\text{yaw}_i, \text{pitch}_i)$ anchor dot alongside the live gaze reticle.
  * **"Calibrate All" `Button`:** Walks sequentially through every enabled display (*"Look at Monitor 1 -> Press Space..."*), calling `invoke("calibrate_monitor", { monitorId })` on each step.
* **`SmartSafeguardsCard.tsx` & `ExclusionsDialog.tsx`:**
  * Binds switches for `auto_yield_camera`, `auto_pause_fullscreen`, `teleport_cursor`, and `autostart`.
  * Opens `ExclusionsDialog` (`Dialog` + `Input` + `Badge`) to add or remove excluded `.exe` names.

---

### Phase 7: Packaging, Performance Profiling & Edge-Case QA

**Learning Focus:** Release-mode compiler optimizations (`--release`), installer bundling, and testing real Windows multi-monitor and security boundaries.

#### Tasks

1. **Build the Optimized Installer:**
   ```bash
   npm run tauri build
   ```
   *(Important: ONNX Runtime inference and `image` resizing are dramatically faster in `--release` builds than in `dev` mode—always benchmark CPU/RAM usage on the release binary at $15\text{ FPS}$ vs. $30\text{ FPS}$.)*
2. **Verification Checklist:**
   * **2D Stacked & Mixed Geometry ($2 \times 2$, $1$-over-$2$, Portrait):** Arrange monitors vertically in **Arrange Mode**, calibrate all displays, confirm `HeadPoseCard` switches automatically to the **2D Gaze Pad**, and verify smooth switching between top and bottom rows without losing `osRect` window accuracy.
   * **Identify & Sync Controls:** Click **Identify** to verify numbered overlays appear cleanly on each screen without stealing focus, then test **Sync** to restore Windows coordinates.
   * **Display Hot-Plug & Rotation:** Plug/unplug a display or change a monitor's orientation in Windows Display Settings while ScreenSight is running; verify the spatial canvas updates live and flags any new uncalibrated screen with an amber indicator.
   * **Dynamic FPS Switching:** Switch between $10\text{ FPS}$, $15\text{ FPS}$, and $30\text{ FPS}$ in **Tracking Settings**; confirm the header badge updates live, no camera lock occurs during stream reconfiguration, and the $300\text{ ms}$ dwell delay remains identical.
   * **Video Call Handoff:** Join a Google Meet call in Chrome -> confirm instant camera release & amber `Yielded to chrome.exe` badge -> leave call -> confirm ScreenSight resumes automatically within $\approx 1\text{ s}$.
   * **Fullscreen Safety:** Launch a fullscreen game or fullscreen video -> glance at another monitor -> confirm focus does **not** steal away.
   * **Single Instance:** Double-click the ScreenSight shortcut while it is already running in the tray -> confirm it restores the existing window instead of spawning a second process.
   * **Windows UAC / UIPI Note:** Windows security (User Interface Privilege Isolation) prevents a standard non-elevated app from calling `SetForegroundWindow` on windows running **as Administrator** (e.g., elevated PowerShell or Task Manager). Document this gracefully in the UI rather than requiring admin rights by default.

---

## 6. Quick Reference: Key Rust, Tauri & Win32 Concepts

| Concept | Module | Why ScreenSight Uses It |
| :--- | :--- | :--- |
| `HWND` & `HMONITOR` | `win32_focus.rs` | Windows' opaque handles for open application windows and physical display monitors. |
| `osRect` vs. `deskPos` | `state.rs` / `monitorLayout.ts` | Keeps Win32 window hit-testing locked to real Windows coordinates (`osRect`) while allowing custom stacked drag-and-drop arrangements (`deskPos`) in the UI. |
| `MONITORINFOEXW` & `WM_DISPLAYCHANGE` | `win32_focus.rs` | Reads stable Win32 device IDs (`szDevice`) + virtual desktop coordinates and detects hot-plug or orientation changes live. |
| `extern "system"` | `win32_focus.rs` | Compiles our `EnumWindows` and `EnumDisplayMonitors` callbacks using Windows' C calling convention (ABI). |
| `DWMWA_CLOAKED` | `win32_focus.rs` | Filters out invisible background UWP windows and windows on other Virtual Desktops. |
| `AttachThreadInput` | `win32_focus.rs` | Safely works around Windows' Foreground Lock so a background tray app can switch focus reliably. |
| `SHQueryUserNotificationState` | `win32_focus.rs` | Detects exclusive fullscreen D3D games and media apps to auto-pause focus switching. |
| UTF-16 (`[u16]`) | `win32_focus.rs` | Modern `*W` Win32 APIs return UTF-16 buffers that Rust converts via `String::from_utf16_lossy`. |
| `Option<Camera>` + `.take()` | `camera_guard.rs` | Idiomatic Rust RAII: dropping `Camera` immediately releases the Media Foundation webcam stream for auto-yield or FPS reconfiguration. |
| Dynamic FPS & `Instant` Dwell | `vision_worker.rs` | Paces inference to $\lfloor 1000 / \text{target\_fps} \rfloor\text{ ms}$ (default $15\text{ FPS}$) while using wall-clock `Instant` so dwell timing stays identical at any framerate. |
| Weighted 2D Nearest-Anchor + Hysteresis | `vision_worker.rs` | Scales head-pose switching cleanly across horizontal and stacked $N$-monitor rigs using $w_p = 1.6$ on pitch and requiring $d_k + m_{\text{hyst}} < d_c$ before starting the dwell timer. |
| Two-Stage ONNX + EMA | `vision_worker.rs` | Crops the face before estimating $(\text{yaw}, \text{pitch})$, then smooths jitter on both axes so focus never flickers. |
| `Arc<AtomicBool>` / `RwLock` | `state.rs` | Shares live pause flags, `target_fps`, `desk_pos`, and per-monitor anchors safely across the camera thread and Tauri UI. |
| `capabilities/default.json` | `src-tauri/` | Tauri 2 security manifest granting the React UI explicit access to frameless window controls, overlay labels, and plugins (`store`, `autostart`, `global-shortcut`). |