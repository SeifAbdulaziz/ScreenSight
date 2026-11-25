import test from "node:test";
import assert from "node:assert/strict";
import {
  computeYawZones,
  projectGazePoint,
  buildDeskLayoutPayload,
  normalizeProcessName,
} from "../src/lib/gazeGeometry.ts";
import type { MonitorInfo } from "../src/lib/monitorLayout.ts";

function makeMonitor(
  id: string,
  idx: number,
  x: number,
  y: number,
  yaw: number | null,
  pitch: number | null,
  enabled = true
): MonitorInfo {
  return {
    id,
    name: `Display ${idx}`,
    displayIndex: idx,
    isPrimary: idx === 1,
    enabled,
    calibrated: yaw !== null && pitch !== null,
    currentFocus: false,
    anchor: yaw !== null && pitch !== null ? { yaw, pitch, roll: 0 } : null,
    osRect: { left: x, top: y, right: x + 1920, bottom: y + 1080 },
    deskPos: { x, y, width: 1920, height: 1080 },
  };
}

test("computeYawZones sorts anchors and calculates midpoint dividers for horizontal rigs", () => {
  const monitors = [
    makeMonitor("M3", 3, 3840, 0, 22, 0),
    makeMonitor("M1", 1, 0, 0, -20, 0),
    makeMonitor("M2", 2, 1920, 0, 2, 0),
    makeMonitor("M4", 4, 5760, 0, null, null), // uncalibrated -> excluded from zones
  ];

  const zones = computeYawZones(monitors, "M2", null);

  assert.equal(zones.anchors.length, 3);
  assert.deepEqual(
    zones.anchors.map((a) => a.monitorId),
    ["M1", "M2", "M3"]
  );
  assert.equal(zones.anchors[1].isFocused, true);

  assert.equal(zones.dividers.length, 2);
  assert.equal(zones.dividers[0].midpointYaw, -9); // (-20 + 2) / 2
  assert.equal(zones.dividers[1].midpointYaw, 12); // (2 + 22) / 2
});

test("projectGazePoint keeps reticle inside canvas bounds and maps +pitch upward", () => {
  const center = projectGazePoint(0, 0);
  assert.equal(center.leftPct, 50);
  assert.equal(center.topPct, 50);

  const upRight = projectGazePoint(35, 20);
  assert.ok(upRight.leftPct > 50 && upRight.leftPct <= 95);
  assert.ok(upRight.topPct < 50 && upRight.topPct >= 8);

  const clamped = projectGazePoint(-999, -999);
  assert.equal(clamped.leftPct, 5);
  assert.equal(clamped.topPct, 92);
});

test("buildDeskLayoutPayload and normalizeProcessName serialize clean IPC payloads", () => {
  const payload = buildDeskLayoutPayload([
    makeMonitor("M1", 1, 100.4, -200.6, 0, 0),
  ]);
  assert.deepEqual(payload, { M1: { x: 100, y: -201 } });

  assert.equal(normalizeProcessName('  "OBS64.EXE"  '), "obs64.exe");
  assert.equal(normalizeProcessName("   "), "");
});
