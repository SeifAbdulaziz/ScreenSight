/**
 * ScreenSight 2D Multi-Monitor Spatial Engine
 *
 * Handles uniform 2D bounding-box projection and magnetic edge snapping
 * for horizontal, portrait, ultrawide, and stacked (e.g. 2x2, 1-over-2) monitor rigs.
 *
 * CRITICAL ARCHITECTURAL DISTINCTION:
 * - osRect: Read-only Windows desktop coordinates (from EnumDisplayMonitors).
 * - deskPos: User-customizable 2D virtual coordinates in physical desktop space.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DeskPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorInfo {
  id: string; // Hardware PNP Device ID / EDID
  name: string; // e.g. "Dell U2720Q" or "Built-in Display"
  displayIndex: number; // 1-based display number for badges
  isPrimary: boolean;
  enabled: boolean;
  calibrated: boolean;
  currentFocus: boolean;
  osRect: Rect;
  deskPos: DeskPosition;
}

export interface ProjectedMonitor {
  monitor: MonitorInfo;
  // Canvas coordinate projection (CSS pixels)
  canvasX: number;
  canvasY: number;
  canvasWidth: number;
  canvasHeight: number;
  isCompact: boolean; // True if rendered width < 110px
}

export interface CanvasLayout {
  projected: ProjectedMonitor[];
  scale: number;
  canvasWidth: number;
  canvasHeight: number;
}

const DEFAULT_SNAP_THRESHOLD = 120; // Virtual desk coordinate units

/**
 * Calculates uniform 2D scale and positions to project any N-monitor setup
 * into a fixed canvas size while preserving physical aspect ratios.
 */
export function layoutMonitors(
  monitors: MonitorInfo[],
  canvasWidth: number,
  canvasHeight: number,
  padding: number = 24
): CanvasLayout {
  if (monitors.length === 0) {
    return {
      projected: [],
      scale: 1,
      canvasWidth,
      canvasHeight,
    };
  }

  // 1. Calculate bounding box across all deskPos coordinates
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const m of monitors) {
    const { x, y, width, height } = m.deskPos;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }

  const totalWidth = Math.max(maxX - minX, 100);
  const totalHeight = Math.max(maxY - minY, 100);

  const availableWidth = Math.max(canvasWidth - 2 * padding, 50);
  const availableHeight = Math.max(canvasHeight - 2 * padding, 50);

  // 2. Uniform scaling factor:
  // scale = min((W_canvas - 2p) / W_total, (H_canvas - 2p) / H_total)
  const scale = Math.min(
    availableWidth / totalWidth,
    availableHeight / totalHeight
  );

  // 3. Center the layout inside the available canvas region
  const renderedTotalWidth = totalWidth * scale;
  const renderedTotalHeight = totalHeight * scale;
  const offsetX = padding + (availableWidth - renderedTotalWidth) / 2;
  const offsetY = padding + (availableHeight - renderedTotalHeight) / 2;

  // 4. Project each monitor
  const projected: ProjectedMonitor[] = monitors.map((m) => {
    const canvasX = offsetX + (m.deskPos.x - minX) * scale;
    const canvasY = offsetY + (m.deskPos.y - minY) * scale;
    const canvasW = m.deskPos.width * scale;
    const canvasH = m.deskPos.height * scale;

    return {
      monitor: m,
      canvasX,
      canvasY,
      canvasWidth: canvasW,
      canvasHeight: canvasH,
      // Compact trigger: when rendered box width drops below 110px
      isCompact: canvasW < 110,
    };
  });

  return {
    projected,
    scale,
    canvasWidth,
    canvasHeight,
  };
}

/**
 * Checks whether two AABB rectangles overlap in 2D space.
 * Uses a small tolerance epsilon (2px) to allow perfect edge abutment without triggering overlap.
 */
export function checkAABBOverlap(
  a: DeskPosition,
  b: DeskPosition,
  epsilon: number = 2
): boolean {
  return (
    a.x < b.x + b.width - epsilon &&
    a.x + a.width > b.x + epsilon &&
    a.y < b.y + b.height - epsilon &&
    a.y + a.height > b.y + epsilon
  );
}

/**
 * Snaps a dragged monitor to adjacent monitor edges within a magnetic threshold.
 * If the resulting drop overlaps with any existing display, returns the original
 * un-dragged position to reject the collision.
 */
export function snapMonitorPosition(
  draggedId: string,
  newDeskPos: DeskPosition,
  originalDeskPos: DeskPosition,
  allMonitors: MonitorInfo[],
  threshold: number = DEFAULT_SNAP_THRESHOLD
): { snappedPos: DeskPosition; snapped: boolean; rejected: boolean } {
  const others = allMonitors.filter((m) => m.id !== draggedId);
  if (others.length === 0) {
    return { snappedPos: newDeskPos, snapped: false, rejected: false };
  }

  let snappedX = newDeskPos.x;
  let snappedY = newDeskPos.y;
  let didSnap = false;

  let minDiffX = threshold;
  let minDiffY = threshold;

  for (const other of others) {
    const o = other.deskPos;

    // Check horizontal edge alignments:
    // 1. Dragged Left edge snaps to Other Right edge
    const distLeftToRight = Math.abs(snappedX - (o.x + o.width));
    if (distLeftToRight < minDiffX) {
      minDiffX = distLeftToRight;
      snappedX = o.x + o.width;
      didSnap = true;
    }

    // 2. Dragged Right edge snaps to Other Left edge
    const distRightToLeft = Math.abs(snappedX + newDeskPos.width - o.x);
    if (distRightToLeft < minDiffX) {
      minDiffX = distRightToLeft;
      snappedX = o.x - newDeskPos.width;
      didSnap = true;
    }

    // Check vertical edge alignments:
    // 3. Dragged Top edge snaps to Other Bottom edge
    const distTopToBottom = Math.abs(snappedY - (o.y + o.height));
    if (distTopToBottom < minDiffY) {
      minDiffY = distTopToBottom;
      snappedY = o.y + o.height;
      didSnap = true;
    }

    // 4. Dragged Bottom edge snaps to Other Top edge
    const distBottomToTop = Math.abs(snappedY + newDeskPos.height - o.y);
    if (distBottomToTop < minDiffY) {
      minDiffY = distBottomToTop;
      snappedY = o.y - newDeskPos.height;
      didSnap = true;
    }

    // Co-linear alignment snaps (e.g. aligning top borders or left borders)
    const distAlignTop = Math.abs(snappedY - o.y);
    if (distAlignTop < minDiffY) {
      minDiffY = distAlignTop;
      snappedY = o.y;
      didSnap = true;
    }

    const distAlignLeft = Math.abs(snappedX - o.x);
    if (distAlignLeft < minDiffX) {
      minDiffX = distAlignLeft;
      snappedX = o.x;
      didSnap = true;
    }
  }

  const candidatePos: DeskPosition = {
    x: snappedX,
    y: snappedY,
    width: newDeskPos.width,
    height: newDeskPos.height,
  };

  // Reject overlapping drops
  const hasOverlap = others.some((other) =>
    checkAABBOverlap(candidatePos, other.deskPos)
  );

  if (hasOverlap) {
    return {
      snappedPos: originalDeskPos,
      snapped: false,
      rejected: true,
    };
  }

  return {
    snappedPos: candidatePos,
    snapped: didSnap,
    rejected: false,
  };
}
