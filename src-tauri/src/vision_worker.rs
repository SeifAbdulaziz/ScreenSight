//! ScreenSight Two-Stage Vision Worker & 2D Nearest-Anchor Gaze Engine
//!
//! Runs 100% locally in volatile RAM on the CPU Execution Provider:
//! - Stage 1 (YuNet): Detects the primary face bounding box on a fixed NCHW BGR tensor
//! - Stage 2 (`HeadPoseEstimator` / FSANet): Crops face (+25% square padding) -> 64x64 -> (yaw, pitch, roll)
//! - Signal Smoothing: Exponential Moving Average (EMA) eliminates micro-jitter
//! - Matching & Hysteresis: Weighted 2D distance (w_p = 1.6 for stacked rigs) + switch_margin_deg
//! - Dwell & Cooldown: Wall-clock `std::time::Instant` timers (independent of target_fps)

use crate::camera_guard::CameraActorHandle;
use crate::win32_focus;
use image::imageops::{crop_imm, resize, FilterType};
use image::RgbImage;
use ndarray::Array4;
use nokhwa::pixel_format::RgbFormat;
use ort::environment::Environment;
use ort::ep;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::{TensorRef, ValueType};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

// ==============================================================================
// 1. Public Data Types & Stage 2 Trait Boundary
// ==============================================================================

/// Detected face bounding box in source camera frame pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub confidence: f32,
}

/// Estimated 3-DOF head orientation in degrees.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct HeadPose {
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
}

/// Stage 2 abstraction so head-pose ONNX models (FSANet, 6DRepNet, etc.) can be
/// swapped cleanly without touching the worker loop or gaze engine.
pub trait HeadPoseEstimator: Send {
    fn estimate(&mut self, face_crop: &RgbImage) -> Result<HeadPose, String>;
}

/// Editable 2D physical desk coordinates (kept strictly separate from Windows `osRect`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Per-monitor tracking configuration used by the 2D nearest-anchor classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorTrackingTarget {
    pub id: String,
    pub display_index: u32,
    pub enabled: bool,
    pub desk_pos: DeskRect,
    pub anchor_yaw: Option<f32>,
    pub anchor_pitch: Option<f32>,
}

/// Live tunable parameters for the vision loop and switching state machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionConfig {
    pub target_fps: u32,
    pub switch_margin_deg: f32,
    pub dwell_ms: u64,
    pub cooldown_ms: u64,
    pub smoothing_alpha: f32,
    pub auto_pause_fullscreen: bool,
    pub teleport_cursor: bool,
    pub excluded_processes: Vec<String>,
    pub monitors: Vec<MonitorTrackingTarget>,
}

impl Default for VisionConfig {
    fn default() -> Self {
        Self {
            target_fps: 15,
            switch_margin_deg: 6.0,
            dwell_ms: 300,
            cooldown_ms: 800,
            smoothing_alpha: 0.35,
            auto_pause_fullscreen: true,
            teleport_cursor: false,
            excluded_processes: Vec::new(),
            monitors: Vec::new(),
        }
    }
}

/// Real-time telemetry published for the dashboard UI (`HeadPoseCard` & `TitleBar`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VisionTelemetry {
    pub running: bool,
    pub face_detected: bool,
    pub face_confidence: f32,
    pub raw_yaw: f32,
    pub raw_pitch: f32,
    pub smoothed_yaw: f32,
    pub smoothed_pitch: f32,
    pub smoothed_roll: f32,
    pub measured_fps: f32,
    pub is_2d_layout: bool,
    pub focused_monitor_id: Option<String>,
    pub pending_monitor_id: Option<String>,
    pub pending_progress: f32,
    pub monitor_distances: Vec<(String, f32)>,
    pub last_error: Option<String>,
}

// ==============================================================================
// 2. ONNX Runtime Environment & Model Path Resolution
// ==============================================================================

static ORT_ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

/// Initializes the process-global ONNX Runtime environment exactly once on CPU.
///
/// RUST LEARN NOTE:
/// `ort` permits only one `Environment` per process (`CURRENT_ENV`). Wrapping initialization
/// in `OnceLock` makes repeated calls from tests or restarts safe and idempotent.
/// We explicitly disable ORT telemetry and select the CPU Execution Provider so gaming
/// laptops never wake their discrete GPU for lightweight head-pose inference.
fn get_ort_env() -> Result<&'static Environment, String> {
    ORT_ENV
        .get_or_init(|| {
            ort::init()
                .with_name("ScreenSight")
                .with_telemetry(false)
                .with_execution_providers([ep::CPU::default().with_arena_allocator(true).build()])
                .build()
                .map_err(|e| format!("Failed to initialize ONNX Runtime: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Locates a bundled `.onnx` file in Tauri's `resource_dir`, falling back to `src-tauri/models`
/// during `cargo test` and `tauri dev`.
pub fn resolve_model_path(file_name: &str, resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(dir) = resource_dir {
        let candidate = dir.join("models").join(file_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("models")
        .join(file_name);
    if manifest_candidate.exists() {
        return Ok(manifest_candidate);
    }

    let local_candidate = PathBuf::from("models").join(file_name);
    if local_candidate.exists() {
        return Ok(local_candidate);
    }

    Err(format!("ONNX model '{file_name}' not found in resource_dir or src-tauri/models/"))
}

// ==============================================================================
// 3. Tensor Preprocessing & Face Crop Helpers
// ==============================================================================

/// Resizes `src` to `(target_w, target_h)` and writes BGR `[0.0, 255.0]` float32 pixels
/// into a pre-allocated NCHW tensor (`[1, 3, H, W]`).
///
/// RUST LEARN NOTE (Tensor Layout & Memory Reuse):
/// Both OpenCV YuNet and FSANet expect planar NCHW order in **BGR** channel sequence
/// (OpenCV's native color order) with unnormalized `[0.0, 255.0]` pixel values.
/// Mutating a pre-allocated `Array4<f32>` avoids ~5 MB/frame of heap allocations at 15-30 FPS.
fn fill_bgr_nchw_tensor(src: &RgbImage, dst: &mut Array4<f32>, target_w: u32, target_h: u32) {
    let resized = if src.width() == target_w && src.height() == target_h {
        std::borrow::Cow::Borrowed(src)
    } else {
        std::borrow::Cow::Owned(resize(src, target_w, target_h, FilterType::Triangle))
    };

    for (x, y, pixel) in resized.enumerate_pixels() {
        let [r, g, b] = pixel.0;
        let yi = y as usize;
        let xi = x as usize;
        // Channel 0 = Blue, Channel 1 = Green, Channel 2 = Red (BGR planar)
        dst[[0, 0, yi, xi]] = f32::from(b);
        dst[[0, 1, yi, xi]] = f32::from(g);
        dst[[0, 2, yi, xi]] = f32::from(r);
    }
}

/// Expands YuNet's face box by `pad_ratio` (e.g. `0.25` = 25% per edge) into a square crop
/// clamped to image bounds so forehead and chin landmarks stay intact for vertical pitch.
pub fn crop_face_with_padding(frame: &RgbImage, face: &FaceBox, pad_ratio: f32) -> RgbImage {
    let fw = frame.width() as f32;
    let fh = frame.height() as f32;

    let cx = face.x + face.width * 0.5;
    let cy = face.y + face.height * 0.5;
    let side = face.width.max(face.height) * (1.0 + 2.0 * pad_ratio);
    let half = side * 0.5;

    let x1 = (cx - half).floor().clamp(0.0, (fw - 1.0).max(0.0)) as u32;
    let y1 = (cy - half).floor().clamp(0.0, (fh - 1.0).max(0.0)) as u32;
    let x2 = (cx + half).ceil().clamp((x1 + 1) as f32, fw) as u32;
    let y2 = (cy + half).ceil().clamp((y1 + 1) as f32, fh) as u32;

    let crop_w = (x2.saturating_sub(x1)).max(1);
    let crop_h = (y2.saturating_sub(y1)).max(1);

    crop_imm(frame, x1, y1, crop_w, crop_h).to_image()
}

// ==============================================================================
// 4. Stage 1: YuNet Face Detector (`face_detector.onnx`)
// ==============================================================================

pub struct YuNetDetector {
    session: Session,
    input_name: String,
    input_w: usize,
    input_h: usize,
    input_tensor: Array4<f32>,
    conf_threshold: f32,
}

impl YuNetDetector {
    pub fn load(model_path: &Path, conf_threshold: f32) -> Result<Self, String> {
        let env = get_ort_env()?;
        let session = Session::builder(env)
            .map_err(|e| format!("YuNet Session::builder failed: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("YuNet opt level failed: {e}"))?
            .with_intra_threads(2)
            .map_err(|e| format!("YuNet intra threads failed: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("Failed to load YuNet ONNX from {}: {e}", model_path.display()))?;

        // Read the model's exact declared input dimensions (ort enforces fixed shapes).
        let input_outlet = session
            .inputs()
            .first()
            .ok_or_else(|| "YuNet model has no declared input".to_string())?;
        let input_name = input_outlet.name().to_string();
        let (input_h, input_w) = match input_outlet.dtype() {
            ValueType::Tensor { shape, .. } if shape.len() == 4 => {
                let h = if shape[2] > 0 { shape[2] as usize } else { 320 };
                let w = if shape[3] > 0 { shape[3] as usize } else { 320 };
                (h, w)
            }
            _ => (640, 640),
        };

        let input_tensor = Array4::<f32>::zeros((1, 3, input_h, input_w));

        Ok(Self {
            session,
            input_name,
            input_w,
            input_h,
            input_tensor,
            conf_threshold,
        })
    }

    pub fn input_dimensions(&self) -> (usize, usize) {
        (self.input_w, self.input_h)
    }

    /// Detects the highest-confidence primary face in `frame`, returning `None` if no
    /// face passes `conf_threshold` (e.g. user stepped away from desk).
    pub fn detect_primary_face(&mut self, frame: &RgbImage) -> Result<Option<FaceBox>, String> {
        fill_bgr_nchw_tensor(
            frame,
            &mut self.input_tensor,
            self.input_w as u32,
            self.input_h as u32,
        );

        let input_ref = TensorRef::from_array_view(self.input_tensor.view())
            .map_err(|e| format!("YuNet TensorRef failed: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => input_ref])
            .map_err(|e| format!("YuNet inference failed: {e}"))?;

        let scale_x = frame.width() as f32 / self.input_w as f32;
        let scale_y = frame.height() as f32 / self.input_h as f32;

        let mut best_face: Option<(f32, FaceBox)> = None;

        // Decode anchor-free predictions across strides [8, 16, 32] matching OpenCV FaceDetectorYNImpl.
        for stride in [8_usize, 16, 32] {
            let cols = self.input_w / stride;
            let rows = self.input_h / stride;

            let cls_name = format!("cls_{stride}");
            let obj_name = format!("obj_{stride}");
            let bbox_name = format!("bbox_{stride}");

            let cls_arr = outputs[cls_name.as_str()]
                .try_extract_array::<f32>()
                .map_err(|e| format!("Missing/invalid YuNet output {cls_name}: {e}"))?;
            let obj_arr = outputs[obj_name.as_str()]
                .try_extract_array::<f32>()
                .map_err(|e| format!("Missing/invalid YuNet output {obj_name}: {e}"))?;
            let bbox_arr = outputs[bbox_name.as_str()]
                .try_extract_array::<f32>()
                .map_err(|e| format!("Missing/invalid YuNet output {bbox_name}: {e}"))?;

            let cls_slice = cls_arr.as_slice().ok_or("YuNet cls tensor not contiguous")?;
            let obj_slice = obj_arr.as_slice().ok_or("YuNet obj tensor not contiguous")?;
            let bbox_slice = bbox_arr.as_slice().ok_or("YuNet bbox tensor not contiguous")?;

            let stride_f = stride as f32;
            let expected_cells = rows * cols;
            let cell_count = expected_cells.min(cls_slice.len()).min(obj_slice.len());

            for idx in 0..cell_count {
                // YuNet 2023mar outputs already-sigmoided probabilities in [0, 1].
                let cls_score = cls_slice[idx].clamp(0.0, 1.0);
                let obj_score = obj_slice[idx].clamp(0.0, 1.0);
                let score = (cls_score * obj_score).sqrt();

                if score < self.conf_threshold {
                    continue;
                }

                let r = (idx / cols) as f32;
                let c = (idx % cols) as f32;
                let base = idx * 4;
                if base + 3 >= bbox_slice.len() {
                    continue;
                }

                let cx = (c + bbox_slice[base]) * stride_f;
                let cy = (r + bbox_slice[base + 1]) * stride_f;
                let w = bbox_slice[base + 2].exp() * stride_f;
                let h = bbox_slice[base + 3].exp() * stride_f;

                let face = FaceBox {
                    x: ((cx - w * 0.5) * scale_x).max(0.0),
                    y: ((cy - h * 0.5) * scale_y).max(0.0),
                    width: (w * scale_x).max(1.0),
                    height: (h * scale_y).max(1.0),
                    confidence: score,
                };

                // Rank by confidence * sqrt(area) so the primary foreground user beats small background faces.
                let rank_score = score * (face.width * face.height).sqrt();
                if best_face.is_none_or(|(best_rank, _)| rank_score > best_rank) {
                    best_face = Some((rank_score, face));
                }
            }
        }

        Ok(best_face.map(|(_, f)| f))
    }
}

// ==============================================================================
// 5. Stage 2: FSANet Head Pose Estimator (`head_pose.onnx`)
// ==============================================================================

pub struct FSANetEstimator {
    session: Session,
    input_name: String,
    output_name: String,
    input_w: usize,
    input_h: usize,
    input_tensor: Array4<f32>,
}

impl FSANetEstimator {
    pub fn load(model_path: &Path) -> Result<Self, String> {
        let env = get_ort_env()?;
        let session = Session::builder(env)
            .map_err(|e| format!("FSANet Session::builder failed: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("FSANet opt level failed: {e}"))?
            .with_intra_threads(2)
            .map_err(|e| format!("FSANet intra threads failed: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("Failed to load FSANet ONNX from {}: {e}", model_path.display()))?;

        let input_outlet = session
            .inputs()
            .first()
            .ok_or_else(|| "FSANet model has no declared input".to_string())?;
        let input_name = input_outlet.name().to_string();
        let (input_h, input_w) = match input_outlet.dtype() {
            ValueType::Tensor { shape, .. } if shape.len() == 4 => {
                let h = if shape[2] > 0 { shape[2] as usize } else { 64 };
                let w = if shape[3] > 0 { shape[3] as usize } else { 64 };
                (h, w)
            }
            _ => (64, 64),
        };

        let output_name = session
            .outputs()
            .first()
            .ok_or_else(|| "FSANet model has no declared output".to_string())?
            .name()
            .to_string();

        let input_tensor = Array4::<f32>::zeros((1, 3, input_h, input_w));

        Ok(Self {
            session,
            input_name,
            output_name,
            input_w,
            input_h,
            input_tensor,
        })
    }

    pub fn input_dimensions(&self) -> (usize, usize) {
        (self.input_w, self.input_h)
    }
}

impl HeadPoseEstimator for FSANetEstimator {
    fn estimate(&mut self, face_crop: &RgbImage) -> Result<HeadPose, String> {
        fill_bgr_nchw_tensor(
            face_crop,
            &mut self.input_tensor,
            self.input_w as u32,
            self.input_h as u32,
        );

        let input_ref = TensorRef::from_array_view(self.input_tensor.view())
            .map_err(|e| format!("FSANet TensorRef failed: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => input_ref])
            .map_err(|e| format!("FSANet inference failed: {e}"))?;

        let out_arr = outputs[self.output_name.as_str()]
            .try_extract_array::<f32>()
            .map_err(|e| format!("Failed to extract FSANet output '{}': {e}", self.output_name))?;
        let out_slice = out_arr
            .as_slice()
            .ok_or_else(|| "FSANet output tensor is not contiguous".to_string())?;

        if out_slice.len() < 3 {
            return Err(format!(
                "Expected 3 Euler angles from FSANet, got {} elements",
                out_slice.len()
            ));
        }

        // Per GHLab/fsanet-onnx-demo `cam_demo.py`: output order is [pitch, yaw, roll].
        Ok(HeadPose {
            pitch: out_slice[0],
            yaw: out_slice[1],
            roll: out_slice[2],
        })
    }
}

// ==============================================================================
// 6. EMA Smoothing, 2D Topology Classification, Hysteresis & Instant Dwell
// ==============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GazeDecision {
    Hold,
    SwitchFocus(String),
}

pub struct GazeEngine {
    pub ema_yaw: Option<f32>,
    pub ema_pitch: Option<f32>,
    pub ema_roll: Option<f32>,
    pub focused_monitor_id: Option<String>,
    pub pending_monitor_id: Option<String>,
    pub pending_since: Option<Instant>,
    pub last_switch_at: Option<Instant>,
    pub last_face_seen_at: Option<Instant>,
}

impl Default for GazeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GazeEngine {
    pub fn new() -> Self {
        Self {
            ema_yaw: None,
            ema_pitch: None,
            ema_roll: None,
            focused_monitor_id: None,
            pending_monitor_id: None,
            pending_since: None,
            last_switch_at: None,
            last_face_seen_at: None,
        }
    }

    /// Detects whether enabled monitors form a stacked 2D layout (e.g. 1-over-2, 2x2).
    /// True whenever any two enabled displays have non-overlapping vertical Y spans in `desk_pos`.
    pub fn detect_is_2d_layout(monitors: &[MonitorTrackingTarget]) -> bool {
        let enabled: Vec<&MonitorTrackingTarget> = monitors.iter().filter(|m| m.enabled).collect();
        for i in 0..enabled.len() {
            let a = enabled[i].desk_pos;
            for b_item in enabled.iter().skip(i + 1) {
                let b = b_item.desk_pos;
                if a.y + a.height <= b.y || b.y + b.height <= a.y {
                    return true;
                }
            }
        }
        false
    }

    /// Returns calibrated `(yaw, pitch)` anchor for a monitor, or synthesizes an intuitive
    /// zero-calibration fallback from its normalized 2D `desk_pos` center (`yaw` in [-24, +24],
    /// `pitch` in [-12, +12]).
    pub fn effective_anchor(
        monitor: &MonitorTrackingTarget,
        bounds: (i32, i32, i32, i32),
    ) -> (f32, f32) {
        if let (Some(y), Some(p)) = (monitor.anchor_yaw, monitor.anchor_pitch) {
            return (y, p);
        }

        let (min_x, min_y, max_x, max_y) = bounds;
        let span_x = (max_x - min_x).max(1) as f32;
        let span_y = (max_y - min_y).max(1) as f32;

        let cx = monitor.desk_pos.x as f32 + monitor.desk_pos.width as f32 * 0.5;
        let cy = monitor.desk_pos.y as f32 + monitor.desk_pos.height as f32 * 0.5;

        // Map bounding-box center to [-1.0, +1.0], then scale to natural yaw/pitch ranges.
        let norm_x = ((cx - min_x as f32) / span_x) * 2.0 - 1.0;
        let norm_y = ((cy - min_y as f32) / span_y) * 2.0 - 1.0;

        let synth_yaw = norm_x * 24.0;
        // Screen Y increases downward, whereas positive head pitch means looking upward.
        let synth_pitch = -norm_y * 12.0;

        (synth_yaw, synth_pitch)
    }

    /// Computes angular distance between smoothed gaze and a monitor anchor.
    /// Uses `w_p = 1.6` on pitch for stacked 2D rigs because vertical pitch has a tighter
    /// natural range than horizontal yaw.
    pub fn compute_distance(yaw: f32, pitch: f32, anchor: (f32, f32), is_2d: bool) -> f32 {
        let dy = yaw - anchor.0;
        if !is_2d {
            dy.abs()
        } else {
            let dp = pitch - anchor.1;
            (dy * dy + 1.6 * dp * dp).sqrt()
        }
    }

    /// Clears pending dwell candidate when no face is visible; preserves current focus and EMA.
    pub fn process_no_face(&mut self) {
        self.pending_monitor_id = None;
        self.pending_since = None;
    }

    /// Evaluates one head-pose sample through EMA smoothing, 2D nearest-anchor matching,
    /// hysteresis margin, cooldown lock, and wall-clock `Instant` dwell timing.
    pub fn process_pose(
        &mut self,
        raw: HeadPose,
        config: &VisionConfig,
        now: Instant,
    ) -> (GazeDecision, bool, Vec<(String, f32)>, f32) {
        let alpha = config.smoothing_alpha.clamp(0.05, 1.0);
        let smooth_yaw = match self.ema_yaw {
            Some(prev) => alpha * raw.yaw + (1.0 - alpha) * prev,
            None => raw.yaw,
        };
        let smooth_pitch = match self.ema_pitch {
            Some(prev) => alpha * raw.pitch + (1.0 - alpha) * prev,
            None => raw.pitch,
        };
        let smooth_roll = match self.ema_roll {
            Some(prev) => alpha * raw.roll + (1.0 - alpha) * prev,
            None => raw.roll,
        };

        self.ema_yaw = Some(smooth_yaw);
        self.ema_pitch = Some(smooth_pitch);
        self.ema_roll = Some(smooth_roll);
        self.last_face_seen_at = Some(now);

        let enabled: Vec<&MonitorTrackingTarget> =
            config.monitors.iter().filter(|m| m.enabled).collect();
        if enabled.is_empty() {
            self.pending_monitor_id = None;
            self.pending_since = None;
            return (GazeDecision::Hold, false, Vec::new(), 0.0);
        }

        let is_2d = Self::detect_is_2d_layout(&config.monitors);

        // Compute bounding box of enabled monitors for zero-calibration fallback anchors.
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for m in &enabled {
            min_x = min_x.min(m.desk_pos.x);
            min_y = min_y.min(m.desk_pos.y);
            max_x = max_x.max(m.desk_pos.x + m.desk_pos.width);
            max_y = max_y.max(m.desk_pos.y + m.desk_pos.height);
        }
        let bounds = (min_x, min_y, max_x, max_y);

        let mut distances: Vec<(String, f32)> = Vec::with_capacity(enabled.len());
        let mut nearest: Option<(&str, f32)> = None;

        for m in &enabled {
            let anchor = Self::effective_anchor(m, bounds);
            let dist = Self::compute_distance(smooth_yaw, smooth_pitch, anchor, is_2d);
            distances.push((m.id.clone(), dist));
            if nearest.is_none_or(|(_, best_d)| dist < best_d) {
                nearest = Some((m.id.as_str(), dist));
            }
        }

        let Some((cand_id, cand_dist)) = nearest else {
            return (GazeDecision::Hold, is_2d, distances, 0.0);
        };

        // Ensure current focus points to an enabled monitor; otherwise adopt nearest immediately.
        let current_dist = self.focused_monitor_id.as_ref().and_then(|cur_id| {
            distances
                .iter()
                .find(|(id, _)| id == cur_id)
                .map(|(_, d)| (cur_id.as_str(), *d))
        });

        let Some((cur_id, cur_dist)) = current_dist else {
            self.focused_monitor_id = Some(cand_id.to_string());
            self.pending_monitor_id = None;
            self.pending_since = None;
            return (GazeDecision::Hold, is_2d, distances, 0.0);
        };

        // Cooldown guard prevents rapid focus bouncing right after a switch.
        if let Some(last) = self.last_switch_at {
            if now.duration_since(last) < Duration::from_millis(config.cooldown_ms) {
                self.pending_monitor_id = None;
                self.pending_since = None;
                return (GazeDecision::Hold, is_2d, distances, 0.0);
            }
        }

        // Hysteresis check: candidate k must beat current monitor c by at least switch_margin_deg.
        if cand_id != cur_id && (cand_dist + config.switch_margin_deg) < cur_dist {
            let dwell_duration = Duration::from_millis(config.dwell_ms);
            if self.pending_monitor_id.as_deref() == Some(cand_id) {
                if let Some(since) = self.pending_since {
                    let elapsed = now.duration_since(since);
                    if elapsed >= dwell_duration {
                        let target = cand_id.to_string();
                        self.focused_monitor_id = Some(target.clone());
                        self.last_switch_at = Some(now);
                        self.pending_monitor_id = None;
                        self.pending_since = None;
                        return (GazeDecision::SwitchFocus(target), is_2d, distances, 1.0);
                    }
                    let progress = if dwell_duration.as_secs_f32() > 0.0 {
                        (elapsed.as_secs_f32() / dwell_duration.as_secs_f32()).clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    return (GazeDecision::Hold, is_2d, distances, progress);
                }
            }

            // Start fresh wall-clock dwell timer for new candidate.
            self.pending_monitor_id = Some(cand_id.to_string());
            self.pending_since = Some(now);
            return (GazeDecision::Hold, is_2d, distances, 0.0);
        }

        self.pending_monitor_id = None;
        self.pending_since = None;
        (GazeDecision::Hold, is_2d, distances, 0.0)
    }
}

// ==============================================================================
// 7. Paced Background Worker Thread & Thread-Safe Handle
// ==============================================================================

#[derive(Clone)]
pub struct VisionWorkerHandle {
    tracking_enabled: Arc<AtomicBool>,
    config: Arc<RwLock<VisionConfig>>,
    telemetry: Arc<Mutex<VisionTelemetry>>,
    camera: CameraActorHandle,
}

impl VisionWorkerHandle {
    pub fn start(
        camera: CameraActorHandle,
        resource_dir: Option<PathBuf>,
    ) -> Self {
        // Initialize monitor topology immediately from real Windows displays.
        let initial_monitors: Vec<MonitorTrackingTarget> = win32_focus::get_system_monitors()
            .into_iter()
            .map(|m| MonitorTrackingTarget {
                id: m.id,
                display_index: m.display_index,
                enabled: true,
                desk_pos: DeskRect {
                    x: m.os_rect.left,
                    y: m.os_rect.top,
                    width: m.os_rect.width(),
                    height: m.os_rect.height(),
                },
                anchor_yaw: None,
                anchor_pitch: None,
            })
            .collect();

        let initial_config = VisionConfig {
            monitors: initial_monitors,
            ..VisionConfig::default()
        };

        let tracking_enabled = Arc::new(AtomicBool::new(true));
        let config = Arc::new(RwLock::new(initial_config));
        let telemetry = Arc::new(Mutex::new(VisionTelemetry {
            running: true,
            ..VisionTelemetry::default()
        }));

        let t_enabled = Arc::clone(&tracking_enabled);
        let t_config = Arc::clone(&config);
        let t_telemetry = Arc::clone(&telemetry);
        let t_camera = camera.clone();

        thread::Builder::new()
            .name("screensight-vision-worker".to_string())
            .spawn(move || {
                run_vision_loop(t_enabled, t_config, t_telemetry, t_camera, resource_dir);
            })
            .expect("Failed to spawn vision worker thread");

        Self {
            tracking_enabled,
            config,
            telemetry,
            camera,
        }
    }

    pub fn set_tracking_enabled(&self, enabled: bool) {
        self.tracking_enabled.store(enabled, Ordering::Relaxed);
        self.camera.set_tracking_enabled(enabled);
    }

    pub fn update_config(&self, new_config: VisionConfig) {
        if let Ok(mut cfg) = self.config.write() {
            *cfg = new_config;
        }
    }

    pub fn update_target_fps(&self, target_fps: u32) {
        if let Ok(mut cfg) = self.config.write() {
            cfg.target_fps = target_fps.clamp(5, 60);
        }
    }

    pub fn get_config(&self) -> VisionConfig {
        self.config.read().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn get_telemetry(&self) -> VisionTelemetry {
        self.telemetry.lock().map(|t| t.clone()).unwrap_or_default()
    }
}

pub struct SharedVisionState(pub VisionWorkerHandle);

fn run_vision_loop(
    tracking_enabled: Arc<AtomicBool>,
    config: Arc<RwLock<VisionConfig>>,
    telemetry: Arc<Mutex<VisionTelemetry>>,
    camera: CameraActorHandle,
    resource_dir: Option<PathBuf>,
) {
    let mut detector = match resolve_model_path("face_detector.onnx", resource_dir.as_deref())
        .and_then(|p| YuNetDetector::load(&p, 0.6))
    {
        Ok(d) => Some(d),
        Err(err) => {
            if let Ok(mut tel) = telemetry.lock() {
                tel.last_error = Some(err);
                tel.running = false;
            }
            None
        }
    };

    let mut pose_estimator: Option<Box<dyn HeadPoseEstimator>> =
        match resolve_model_path("head_pose.onnx", resource_dir.as_deref())
            .and_then(|p| FSANetEstimator::load(&p))
        {
            Ok(est) => Some(Box::new(est)),
            Err(err) => {
                if let Ok(mut tel) = telemetry.lock() {
                    tel.last_error = Some(err);
                    tel.running = false;
                }
                None
            }
        };

    let mut engine = GazeEngine::new();
    let mut last_frame_at = Instant::now();
    let mut smoothed_fps = 0.0_f32;

    loop {
        let loop_start = Instant::now();
        let cfg = config.read().map(|c| c.clone()).unwrap_or_default();
        let target_fps = cfg.target_fps.clamp(5, 60);
        let frame_budget = Duration::from_millis(1000 / u64::from(target_fps));

        let is_enabled = tracking_enabled.load(Ordering::Relaxed);
        let cam_status = camera.get_status();

        // Pause inference when manually disabled, yielded to a call, or fullscreen game is active.
        let fullscreen_blocked =
            cfg.auto_pause_fullscreen && win32_focus::is_fullscreen_game_active();

        if !is_enabled || cam_status.is_yielded || fullscreen_blocked {
            engine.process_no_face();
            if let Ok(mut tel) = telemetry.lock() {
                tel.running = false;
                tel.measured_fps = 0.0;
                tel.pending_monitor_id = None;
                tel.pending_progress = 0.0;
            }
            thread::sleep(Duration::from_millis(100));
            continue;
        }

        let (Some(det), Some(pose_est)) = (detector.as_mut(), pose_estimator.as_mut()) else {
            thread::sleep(Duration::from_millis(500));
            continue;
        };

        // Wait up to frame_budget for the freshest undecoded camera buffer.
        if let Some(buffer) = camera.wait_for_frame(frame_budget) {
            if let Ok(rgb_frame) = buffer.decode_image::<RgbFormat>() {
                let frame_dt = last_frame_at.elapsed().as_secs_f32();
                last_frame_at = Instant::now();
                if frame_dt > 0.001 {
                    let inst_fps = 1.0 / frame_dt;
                    smoothed_fps = if smoothed_fps == 0.0 {
                        inst_fps
                    } else {
                        0.2 * inst_fps + 0.8 * smoothed_fps
                    };
                }

                match det.detect_primary_face(&rgb_frame) {
                    Ok(Some(face)) => {
                        let crop = crop_face_with_padding(&rgb_frame, &face, 0.25);
                        match pose_est.estimate(&crop) {
                            Ok(raw_pose) => {
                                let now = Instant::now();
                                let (decision, is_2d, distances, progress) =
                                    engine.process_pose(raw_pose, &cfg, now);

                                if let GazeDecision::SwitchFocus(target_id) = decision {
                                    let _ = win32_focus::switch_focus_to_monitor(
                                        &target_id,
                                        cfg.teleport_cursor,
                                        &cfg.excluded_processes,
                                    );
                                }

                                if let Ok(mut tel) = telemetry.lock() {
                                    tel.running = true;
                                    tel.face_detected = true;
                                    tel.face_confidence = face.confidence;
                                    tel.raw_yaw = raw_pose.yaw;
                                    tel.raw_pitch = raw_pose.pitch;
                                    tel.smoothed_yaw = engine.ema_yaw.unwrap_or(raw_pose.yaw);
                                    tel.smoothed_pitch = engine.ema_pitch.unwrap_or(raw_pose.pitch);
                                    tel.smoothed_roll = engine.ema_roll.unwrap_or(raw_pose.roll);
                                    tel.measured_fps = smoothed_fps;
                                    tel.is_2d_layout = is_2d;
                                    tel.focused_monitor_id = engine.focused_monitor_id.clone();
                                    tel.pending_monitor_id = engine.pending_monitor_id.clone();
                                    tel.pending_progress = progress;
                                    tel.monitor_distances = distances;
                                    tel.last_error = None;
                                }
                            }
                            Err(err) => {
                                if let Ok(mut tel) = telemetry.lock() {
                                    tel.last_error = Some(err);
                                }
                            }
                        }
                    }
                    Ok(None) => {
                        engine.process_no_face();
                        if let Ok(mut tel) = telemetry.lock() {
                            tel.running = true;
                            tel.face_detected = false;
                            tel.face_confidence = 0.0;
                            tel.measured_fps = smoothed_fps;
                            tel.pending_monitor_id = None;
                            tel.pending_progress = 0.0;
                            tel.last_error = None;
                        }
                    }
                    Err(err) => {
                        if let Ok(mut tel) = telemetry.lock() {
                            tel.last_error = Some(err);
                        }
                    }
                }
            }
        }

        // Sleep only for the remainder of the frame budget to maintain steady target_fps.
        let elapsed = loop_start.elapsed();
        if elapsed < frame_budget {
            thread::sleep(frame_budget - elapsed);
        }
    }
}

// ==============================================================================
// 8. Unit & ONNX Integration Tests (Ponytail verification rule)
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_monitor(id: &str, x: i32, y: i32, w: i32, h: i32, yaw: Option<f32>, pitch: Option<f32>) -> MonitorTrackingTarget {
        MonitorTrackingTarget {
            id: id.to_string(),
            display_index: 1,
            enabled: true,
            desk_pos: DeskRect { x, y, width: w, height: h },
            anchor_yaw: yaw,
            anchor_pitch: pitch,
        }
    }

    #[test]
    fn test_onnx_models_load_and_infer_without_error() {
        let yunet_path = resolve_model_path("face_detector.onnx", None)
            .expect("face_detector.onnx should exist in src-tauri/models");
        let fsanet_path = resolve_model_path("head_pose.onnx", None)
            .expect("head_pose.onnx should exist in src-tauri/models");

        let mut detector = YuNetDetector::load(&yunet_path, 0.6).expect("YuNet should load");
        let mut estimator = FSANetEstimator::load(&fsanet_path).expect("FSANet should load");

        let (yw, yh) = detector.input_dimensions();
        let (fw, fh) = estimator.input_dimensions();
        assert!(yw >= 320 && yh >= 320, "Unexpected YuNet dimensions: {yw}x{yh}");
        assert_eq!((fw, fh), (64, 64), "FSANet must expect 64x64 input");

        // Blank synthetic frame -> YuNet runs end-to-end and detects 0 faces
        let blank_frame = RgbImage::new(640, 480);
        let face = detector.detect_primary_face(&blank_frame).expect("YuNet infer succeeded");
        assert!(face.is_none());

        // Synthetic 64x64 face crop -> FSANet returns finite yaw, pitch, roll
        let blank_crop = RgbImage::new(64, 64);
        let pose = estimator.estimate(&blank_crop).expect("FSANet infer succeeded");
        assert!(pose.yaw.is_finite() && pose.pitch.is_finite() && pose.roll.is_finite());
    }

    #[test]
    fn test_2d_layout_detection_horizontal_vs_stacked() {
        let horizontal = vec![
            make_monitor("M1", 0, 0, 1920, 1080, None, None),
            make_monitor("M2", 1920, 0, 1920, 1080, None, None),
        ];
        assert!(!GazeEngine::detect_is_2d_layout(&horizontal));

        let stacked_1_over_2 = vec![
            make_monitor("M1", 0, 1080, 1920, 1080, None, None),
            make_monitor("M2", 1920, 1080, 1920, 1080, None, None),
            make_monitor("M3", 960, 0, 1920, 1080, None, None),
        ];
        assert!(GazeEngine::detect_is_2d_layout(&stacked_1_over_2));
    }

    #[test]
    fn test_hysteresis_instant_dwell_and_cooldown() {
        let cfg = VisionConfig {
            target_fps: 15,
            switch_margin_deg: 6.0,
            dwell_ms: 300,
            cooldown_ms: 800,
            smoothing_alpha: 1.0, // Raw step for deterministic test
            monitors: vec![
                make_monitor("LEFT", 0, 0, 1920, 1080, Some(-20.0), Some(0.0)),
                make_monitor("RIGHT", 1920, 0, 1920, 1080, Some(20.0), Some(0.0)),
            ],
            ..VisionConfig::default()
        };

        let mut engine = GazeEngine::new();
        let t0 = Instant::now();

        // 1. Initial glance locks onto LEFT immediately
        let (dec, is_2d, _, _) = engine.process_pose(HeadPose { yaw: -20.0, pitch: 0.0, roll: 0.0 }, &cfg, t0);
        assert_eq!(dec, GazeDecision::Hold);
        assert!(!is_2d);
        assert_eq!(engine.focused_monitor_id.as_deref(), Some("LEFT"));

        // 2. Look at boundary yaw=+2.0 -> d_RIGHT=18, d_LEFT=22 -> margin is 4 deg < 6 deg -> MUST NOT switch!
        let t1 = t0 + Duration::from_millis(500);
        let (dec, _, _, _) = engine.process_pose(HeadPose { yaw: 2.0, pitch: 0.0, roll: 0.0 }, &cfg, t1);
        assert_eq!(dec, GazeDecision::Hold);
        assert!(engine.pending_monitor_id.is_none());

        // 3. Look decisively right yaw=+18.0 -> d_RIGHT=2, d_LEFT=38 -> starts dwell timer
        let t2 = t1 + Duration::from_millis(100);
        let (dec, _, _, prog) = engine.process_pose(HeadPose { yaw: 18.0, pitch: 0.0, roll: 0.0 }, &cfg, t2);
        assert_eq!(dec, GazeDecision::Hold);
        assert_eq!(prog, 0.0);
        assert_eq!(engine.pending_monitor_id.as_deref(), Some("RIGHT"));

        // 4. 200ms later (< 300ms dwell) -> still pending, progress ~0.66
        let t3 = t2 + Duration::from_millis(200);
        let (dec, _, _, prog) = engine.process_pose(HeadPose { yaw: 18.0, pitch: 0.0, roll: 0.0 }, &cfg, t3);
        assert_eq!(dec, GazeDecision::Hold);
        assert!(prog > 0.6 && prog < 0.7);

        // 5. 310ms elapsed (>= 300ms dwell) -> switches to RIGHT!
        let t4 = t2 + Duration::from_millis(310);
        let (dec, _, _, _) = engine.process_pose(HeadPose { yaw: 18.0, pitch: 0.0, roll: 0.0 }, &cfg, t4);
        assert_eq!(dec, GazeDecision::SwitchFocus("RIGHT".to_string()));
        assert_eq!(engine.focused_monitor_id.as_deref(), Some("RIGHT"));

        // 6. Immediate look back left inside 800ms cooldown -> blocked by cooldown
        let t5 = t4 + Duration::from_millis(400);
        let (dec, _, _, _) = engine.process_pose(HeadPose { yaw: -20.0, pitch: 0.0, roll: 0.0 }, &cfg, t5);
        assert_eq!(dec, GazeDecision::Hold);
        assert!(engine.pending_monitor_id.is_none());
    }

    #[test]
    fn test_weighted_2d_pitch_matching_for_stacked_monitors() {
        let cfg = VisionConfig {
            smoothing_alpha: 1.0,
            switch_margin_deg: 4.0,
            dwell_ms: 0,
            cooldown_ms: 0,
            monitors: vec![
                make_monitor("TOP", 0, 0, 1920, 1080, Some(0.0), Some(12.0)),
                make_monitor("BOTTOM", 0, 1080, 1920, 1080, Some(0.0), Some(-10.0)),
            ],
            ..VisionConfig::default()
        };

        let mut engine = GazeEngine::new();
        let t0 = Instant::now();

        // Start on BOTTOM
        engine.process_pose(HeadPose { yaw: 0.0, pitch: -10.0, roll: 0.0 }, &cfg, t0);
        assert_eq!(engine.focused_monitor_id.as_deref(), Some("BOTTOM"));

        // Look upward (+12 deg pitch) -> 1st sample starts pending, 2nd triggers with dwell_ms=0
        let t1 = t0 + Duration::from_millis(50);
        engine.process_pose(HeadPose { yaw: 0.0, pitch: 12.0, roll: 0.0 }, &cfg, t1);
        let (dec, is_2d, _, _) = engine.process_pose(HeadPose { yaw: 0.0, pitch: 12.0, roll: 0.0 }, &cfg, t1 + Duration::from_millis(1));
        assert!(is_2d);
        assert_eq!(dec, GazeDecision::SwitchFocus("TOP".to_string()));
    }
}
