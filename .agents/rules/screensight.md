
# ScreenSight Workspace Guardrails

## Project Identity & Roadmap Discipline
- Follow `GLANCE_SWITCH_ROADMAP.md` strictly one phase at a time. Never scaffold or implement future phases unless explicitly asked.
- Because the author is actively learning Rust and Win32 line-by-line, add concise, step-by-step inline comments explaining *why* non-obvious Rust ownership, `unsafe` Win32 calls, and tensor transforms work.

## Working with Ponytail
- Keep code minimal and avoid unnecessary crates or wrapper abstractions, **but never strip required ScreenSight safeguards**:
  1. `DWMWA_CLOAKED` filtering and `AttachThreadInput` focus reliability.
  2. ConsentStore webcam Auto-Yield and Fullscreen Auto-Pause.
  3. Separate `osRect` (read-only Windows coordinates) vs. `deskPos` (editable 2D stacked UI layout).
  4. Configurable `target_fps` (default `15 FPS`) with `Instant`-based dwell timers.

## Frontend Rules
- Stack: React + TypeScript + Tailwind CSS v4 (`@tailwindcss/vite`) + `shadcn/ui` dark-mode dashboard.
- Never hardcode a 2-monitor grid; `ActiveDisplaysCard` must support $N$ monitors in horizontal, portrait, and 2D stacked (e.g., 2x2) layouts.
- Register `tauri-plugin-single-instance` first in `src-tauri/src/lib.rs`, and keep all Tauri 2 permissions declared in `src-tauri/capabilities/default.json`.
