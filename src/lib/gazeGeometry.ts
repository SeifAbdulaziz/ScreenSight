import type { MonitorInfo } from "@/lib/monitorLayout";
import type { DeskPoint } from "@/types/screensight";

export interface YawAnchorPoint {
  monitorId: string;
  displayIndex: number;
  yaw: number;
  leftPct: number;
  isFocused: boolean;
  isPending: boolean;
}

export interface YawZoneDivider {
  midpointYaw: number;
  leftPct: number;
}

export interface YawZoneLayout {
  anchors: YawAnchorPoint[];
  dividers: YawZoneDivider[];
  rangeDeg: number;
}

function clampPct(pct: number, min = 4, max = 96): number {
  return Math.min(max, Math.max(min, pct));
}

export function yawToPct(yaw: number, rangeDeg = 40): number {
  return clampPct(50 + (yaw / rangeDeg) * 46, 3, 97);
}

/**
 * Projects yaw (X) and pitch (Y) into clamped 2D Gaze Pad percentages.
 */
export function projectGazePoint(
  yaw: number,
  pitch: number,
  maxYawDeg = 35,
  maxPitchDeg = 20
): { leftPct: number; topPct: number } {
  return {
    leftPct: clampPct(50 + (yaw / maxYawDeg) * 44, 5, 95),
    // Invert Y so positive pitch (looking up) moves toward the top edge.
    topPct: clampPct(50 - (pitch / maxPitchDeg) * 40, 8, 92),
  };
}

/**
 * Sorts calibrated monitors left-to-right by yaw and places dynamic zone dividers
 * halfway between each adjacent pair of anchors.
 */
export function computeYawZones(
  monitors: MonitorInfo[],
  focusedMonitorId: string | null,
  pendingMonitorId: string | null,
  rangeDeg = 40
): YawZoneLayout {
  const calibrated = monitors
    .filter((m) => m.enabled && m.anchor !== undefined && m.anchor !== null)
    .sort((a, b) => a.anchor!.yaw - b.anchor!.yaw);

  const maxAbsYaw = calibrated.reduce(
    (acc, m) => Math.max(acc, Math.abs(m.anchor!.yaw)),
    rangeDeg - 8
  );
  const effectiveRange = Math.max(rangeDeg, Math.ceil((maxAbsYaw + 8) / 5) * 5);

  const anchors: YawAnchorPoint[] = calibrated.map((m) => ({
    monitorId: m.id,
    displayIndex: m.displayIndex,
    yaw: m.anchor!.yaw,
    leftPct: yawToPct(m.anchor!.yaw, effectiveRange),
    isFocused: m.id === focusedMonitorId || m.currentFocus,
    isPending: m.id === pendingMonitorId,
  }));

  const dividers: YawZoneDivider[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const midpointYaw = (anchors[i].yaw + anchors[i + 1].yaw) / 2;
    dividers.push({
      midpointYaw,
      leftPct: yawToPct(midpointYaw, effectiveRange),
    });
  }

  return { anchors, dividers, rangeDeg: effectiveRange };
}

/**
 * Serializes current desk origins for `update_monitor_desk_layout`.
 */
export function buildDeskLayoutPayload(
  monitors: MonitorInfo[]
): Record<string, DeskPoint> {
  const positions: Record<string, DeskPoint> = {};
  for (const m of monitors) {
    positions[m.id] = {
      x: Math.round(m.deskPos.x),
      y: Math.round(m.deskPos.y),
    };
  }
  return positions;
}

/**
 * Normalizes a process exclusion string so casing/spacing differences do not duplicate entries.
 */
export function normalizeProcessName(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
}
