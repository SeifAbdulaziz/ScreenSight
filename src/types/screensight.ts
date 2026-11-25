import type { MonitorInfo } from "@/lib/monitorLayout";

export type TrackerStatus =
  | { kind: "Active" }
  | { kind: "ManuallyPaused" }
  | { kind: "YieldedToApp"; detail: string }
  | { kind: "PausedFullscreen" }
  | { kind: "NoCamera" };

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface DeskPoint {
  x: number;
  y: number;
}

export interface MonitorCalibration {
  enabled: boolean;
  desk_pos: DeskPoint | null;
  anchor_yaw: number | null;
  anchor_pitch: number | null;
}

export interface AppConfig {
  schema_version: number;
  camera_index: number;
  target_fps: number;
  switch_margin_deg: number;
  dwell_ms: number;
  cooldown_ms: number;
  smoothing_alpha: number;
  auto_yield_camera: boolean;
  auto_pause_fullscreen: boolean;
  teleport_cursor: boolean;
  global_shortcut: string;
  excluded_processes: string[];
  monitor_configs: Record<string, MonitorCalibration>;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  schema_version: 1,
  camera_index: 0,
  target_fps: 15,
  switch_margin_deg: 6,
  dwell_ms: 300,
  cooldown_ms: 800,
  smoothing_alpha: 0.35,
  auto_yield_camera: true,
  auto_pause_fullscreen: true,
  teleport_cursor: false,
  global_shortcut: "Ctrl+Alt+G",
  excluded_processes: [],
  monitor_configs: {},
};

export interface MonitorNode {
  id: string;
  index: number;
  os_rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  desk_pos: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  is_primary: boolean;
  is_focused: boolean;
  active_window_title: string | null;
  enabled: boolean;
  anchor: HeadPose | null;
}

export interface TelemetryPayload {
  status: TrackerStatus;
  face_detected: boolean;
  face_confidence: number;
  smoothed_yaw: number;
  smoothed_pitch: number;
  smoothed_roll: number;
  measured_fps: number;
  focused_monitor_id: string | null;
  pending_monitor_id: string | null;
  pending_progress: number;
  is_2d_layout: boolean;
  monitors: MonitorNode[];
}

export interface CameraDeviceInfo {
  index: number;
  name: string;
  description: string;
}

export function monitorNodeToInfo(node: MonitorNode): MonitorInfo {
  return {
    id: node.id,
    name: `${node.is_primary ? "Primary Display" : `Display ${node.index}`} (${node.id})`,
    displayIndex: node.index,
    isPrimary: node.is_primary,
    enabled: node.enabled,
    calibrated: node.anchor !== null,
    currentFocus: node.is_focused,
    activeWindowTitle: node.active_window_title,
    anchor: node.anchor,
    osRect: node.os_rect,
    deskPos: node.desk_pos,
  };
}
