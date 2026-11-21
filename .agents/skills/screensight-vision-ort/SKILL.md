---
name: screensight-vision-ort
description: Use when building or debugging ScreenSight's webcam capture, Media Foundation format negotiation, configurable FPS loop, YuNet face detection, FSANet head-pose ONNX inference (`ort`), EMA smoothing, or 2D nearest-anchor monitor matching. Do not use for Win32 window focus or shadcn UI layout.
---

# ScreenSight Vision Pipeline (`nokhwa` + `ort`)

## Camera Capture & Yielding
- Use `nokhwa` with the `input-native` feature so Windows routes through `ApiBackend::MediaFoundation` (compatible with Windows 11 Multi-App Camera Frame Server).
- Populate selectable cameras via `nokhwa::query(ApiBackend::MediaFoundation)`; never hardcode index `0` as the only option (virtual cameras often occupy index `0`).
- Default capture rate is **15 FPS** (`config.target_fps`), configurable to `10`, `15`, `24`, or `30` FPS at `640x480` (`MJPEG` / closest match).
- Dropping `Option<Camera>` (`active_camera = None`) must happen immediately on Auto-Yield or manual pause so Chrome/Meet/Discord can open the device without contention.

## Two-Stage ONNX Pipeline (`ort` 2.0)
- **Stage 1 (Face Detection):** `face_detection_yunet_2023mar.onnx`. Resize frame to the model's exact declared input dimensions (check via Netron; `ort` enforces fixed input shapes). Pick the highest-confidence/largest face bounding box.
- **Stage 2 (Head Pose):** Pre-exported FSANet ONNX (`64x64`). Expand YuNet's bounding box by **20%–30%** into a square crop (clamped to frame bounds) before resizing to `64x64`, so forehead/chin context is preserved for stable pitch on stacked monitors.
- Keep Stage 2 behind a `HeadPoseEstimator` trait returning `(yaw, pitch, roll)` in degrees so models can be swapped later without touching `vision_worker.rs`.

## Smoothing, Dwell & Stacked Monitor Matching
- Apply Exponential Moving Average (EMA) smoothing to `(yaw, pitch)` before matching.
- Use wall-clock `std::time::Instant` for Dwell Delay (default `300 ms`) and cooldown—never count raw frames, because `target_fps` is user-configurable.
- **Nearest-Anchor Distance:**
  - Horizontal-only rig: `d = |yaw - anchor.yaw|`
  - Stacked 2D rig (non-overlapping Y monitor spans in `deskPos`):
    `d = sqrt((yaw - anchor.yaw)^2 + 1.6 * (pitch - anchor.pitch)^2)`
- Apply hysteresis (`switch_margin_deg`): only switch focus when a candidate monitor's distance beats the currently focused monitor by at least `switch_margin_deg` continuously for `dwell_delay_ms`.