import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutMonitors,
  snapMonitorPosition,
  checkAABBOverlap,
} from "../src/lib/monitorLayout.ts";
import type { MonitorInfo, DeskPosition } from "../src/lib/monitorLayout.ts";

test("layoutMonitors calculates proportional 2D projection and uniform scale", () => {
  const monitors: MonitorInfo[] = [
    {
      id: "M1",
      name: "Display 1",
      displayIndex: 1,
      isPrimary: true,
      enabled: true,
      calibrated: true,
      currentFocus: false,
      osRect: { left: 0, top: 0, right: 1920, bottom: 1080 },
      deskPos: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    {
      id: "M2",
      name: "Display 2",
      displayIndex: 2,
      isPrimary: false,
      enabled: true,
      calibrated: true,
      currentFocus: true,
      osRect: { left: 1920, top: 0, right: 3840, bottom: 1080 },
      deskPos: { x: 1920, y: 0, width: 1920, height: 1080 },
    },
  ];

  const canvasWidth = 800;
  const canvasHeight = 400;
  const padding = 20;

  const result = layoutMonitors(monitors, canvasWidth, canvasHeight, padding);

  assert.equal(result.projected.length, 2);

  // Total desk bounds: width = 3840, height = 1080
  const totalW = 3840;
  const totalH = 1080;
  const availW = canvasWidth - 2 * padding; // 760
  const availH = canvasHeight - 2 * padding; // 360

  const expectedScale = Math.min(availW / totalW, availH / totalH);
  assert.ok(Math.abs(result.scale - expectedScale) < 0.0001);

  // Both monitors should have same scaled width
  const m1 = result.projected[0];
  const m2 = result.projected[1];
  assert.ok(Math.abs(m1.canvasWidth - 1920 * expectedScale) < 0.01);
  assert.ok(Math.abs(m2.canvasWidth - 1920 * expectedScale) < 0.01);

  // Display 2 should be adjacent to Display 1 horizontally
  assert.ok(Math.abs(m2.canvasX - (m1.canvasX + m1.canvasWidth)) < 0.01);
});

test("checkAABBOverlap accurately detects overlapping rectangles", () => {
  const a: DeskPosition = { x: 0, y: 0, width: 100, height: 100 };
  const overlapping: DeskPosition = { x: 50, y: 50, width: 100, height: 100 };
  const adjacent: DeskPosition = { x: 100, y: 0, width: 100, height: 100 };
  const separated: DeskPosition = { x: 150, y: 150, width: 100, height: 100 };

  assert.equal(checkAABBOverlap(a, overlapping), true);
  assert.equal(checkAABBOverlap(a, adjacent), false); // Perfectly touching edges should not overlap
  assert.equal(checkAABBOverlap(a, separated), false);
});

test("snapMonitorPosition locks adjacent edges when within 120px threshold", () => {
  const allMonitors: MonitorInfo[] = [
    {
      id: "M1",
      name: "Display 1",
      displayIndex: 1,
      isPrimary: true,
      enabled: true,
      calibrated: true,
      currentFocus: false,
      osRect: { left: 0, top: 0, right: 1920, bottom: 1080 },
      deskPos: { x: 0, y: 0, width: 1920, height: 1080 },
    },
  ];

  const originPos: DeskPosition = { x: 2000, y: 0, width: 1920, height: 1080 };
  // Near M1 right edge (1920), dragged to 1980 (diff = 60px < 120px)
  const draggedNearRightEdge: DeskPosition = { x: 1980, y: 40, width: 1920, height: 1080 };

  const result = snapMonitorPosition(
    "M2",
    draggedNearRightEdge,
    originPos,
    allMonitors,
    120
  );

  assert.equal(result.snapped, true);
  assert.equal(result.rejected, false);
  // Should snap left edge to 1920
  assert.equal(result.snappedPos.x, 1920);
  // And top edge should snap to 0 since y=40 is within threshold of y=0
  assert.equal(result.snappedPos.y, 0);
});

test("snapMonitorPosition rejects collision when overlapping with existing monitor", () => {
  const allMonitors: MonitorInfo[] = [
    {
      id: "M1",
      name: "Display 1",
      displayIndex: 1,
      isPrimary: true,
      enabled: true,
      calibrated: true,
      currentFocus: false,
      osRect: { left: 0, top: 0, right: 1920, bottom: 1080 },
      deskPos: { x: 0, y: 0, width: 1920, height: 1080 },
    },
  ];

  const originPos: DeskPosition = { x: 2500, y: 0, width: 1920, height: 1080 };
  // Direct overlap on M1
  const directOverlapPos: DeskPosition = { x: 500, y: 200, width: 1920, height: 1080 };

  const result = snapMonitorPosition(
    "M2",
    directOverlapPos,
    originPos,
    allMonitors,
    120
  );

  assert.equal(result.rejected, true);
  assert.deepEqual(result.snappedPos, originPos);
});

test("layoutMonitors activates compact mode when tile width drops below 110px", () => {
  // 6 monitors in a row on a small 400px canvas
  const monitors: MonitorInfo[] = Array.from({ length: 6 }, (_, i) => ({
    id: `M${i}`,
    name: `Display ${i + 1}`,
    displayIndex: i + 1,
    isPrimary: i === 0,
    enabled: true,
    calibrated: true,
    currentFocus: i === 0,
    osRect: { left: i * 1920, top: 0, right: (i + 1) * 1920, bottom: 1080 },
    deskPos: { x: i * 1920, y: 0, width: 1920, height: 1080 },
  }));

  const result = layoutMonitors(monitors, 400, 200, 10);
  assert.ok(result.projected.every((p) => p.canvasWidth < 110));
  assert.ok(result.projected.every((p) => p.isCompact === true));
});
