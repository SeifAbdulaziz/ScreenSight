import React, { useState, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Monitor,
  Move,
  RefreshCw,
  Hash,
  CheckCircle2,
  AlertCircle,
  Loader2,
  MousePointerClick,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MonitorInfo,
  layoutMonitors,
  snapMonitorPosition,
  DeskPosition,
} from "@/lib/monitorLayout";
import { buildDeskLayoutPayload } from "@/lib/gazeGeometry";
import { cn } from "@/lib/utils";
import type { HeadPose } from "@/types/screensight";

// Browser-only mock rigs used exclusively when running Vite outside the Tauri host.
export const MOCK_TOPOLOGIES: Record<
  string,
  { label: string; monitors: MonitorInfo[] }
> = {
  dual_horizontal: {
    label: "2 Displays (Side-by-Side)",
    monitors: [
      {
        id: "MONITOR\\DEL418B\\{1}",
        name: "Dell U2720Q (Primary)",
        displayIndex: 1,
        isPrimary: true,
        enabled: true,
        calibrated: true,
        currentFocus: false,
        activeWindowTitle: "Discord",
        anchor: { yaw: -16, pitch: 0, roll: 0 },
        osRect: { left: 0, top: 0, right: 2560, bottom: 1440 },
        deskPos: { x: 0, y: 0, width: 2560, height: 1440 },
      },
      {
        id: "MONITOR\\GSM5B07\\{2}",
        name: "LG 27GL850",
        displayIndex: 2,
        isPrimary: false,
        enabled: true,
        calibrated: true,
        currentFocus: true,
        activeWindowTitle: "Google Chrome",
        anchor: { yaw: 16, pitch: 0, roll: 0 },
        osRect: { left: 2560, top: 0, right: 5120, bottom: 1440 },
        deskPos: { x: 2560, y: 0, width: 2560, height: 1440 },
      },
    ],
  },
  three_stacked_1_over_2: {
    label: "3 Displays (1-Over-2 Stacked)",
    monitors: [
      {
        id: "MONITOR\\DEL418B\\{1}",
        name: "Dell U2720Q (Left)",
        displayIndex: 1,
        isPrimary: true,
        enabled: true,
        calibrated: true,
        currentFocus: true,
        activeWindowTitle: "Visual Studio Code",
        anchor: { yaw: -15, pitch: -8, roll: 0 },
        osRect: { left: 0, top: 1440, right: 2560, bottom: 2880 },
        deskPos: { x: 0, y: 1440, width: 2560, height: 1440 },
      },
      {
        id: "MONITOR\\GSM5B07\\{2}",
        name: "LG 27GL850 (Right)",
        displayIndex: 2,
        isPrimary: false,
        enabled: true,
        calibrated: true,
        currentFocus: false,
        activeWindowTitle: "Windows Terminal",
        anchor: { yaw: 15, pitch: -8, roll: 0 },
        osRect: { left: 2560, top: 1440, right: 5120, bottom: 2880 },
        deskPos: { x: 2560, y: 1440, width: 2560, height: 1440 },
      },
      {
        id: "MONITOR\\SAM0F34\\{3}",
        name: 'Samsung 34" Ultrawide (Top)',
        displayIndex: 3,
        isPrimary: false,
        enabled: true,
        calibrated: false,
        currentFocus: false,
        activeWindowTitle: "Spotify",
        anchor: null,
        osRect: { left: 860, top: 0, right: 4300, bottom: 1440 },
        deskPos: { x: 860, y: 0, width: 3440, height: 1440 },
      },
    ],
  },
  four_stacked_2x2: {
    label: "4 Displays (2x2 Grid)",
    monitors: [
      {
        id: "MONITOR\\MON1\\{1}",
        name: "Monitor 1 (Top-Left)",
        displayIndex: 1,
        isPrimary: false,
        enabled: true,
        calibrated: true,
        currentFocus: false,
        activeWindowTitle: "Discord",
        anchor: { yaw: -16, pitch: 11, roll: 0 },
        osRect: { left: 0, top: 0, right: 1920, bottom: 1080 },
        deskPos: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      {
        id: "MONITOR\\MON2\\{2}",
        name: "Monitor 2 (Top-Right)",
        displayIndex: 2,
        isPrimary: false,
        enabled: true,
        calibrated: true,
        currentFocus: true,
        activeWindowTitle: "Chrome",
        anchor: { yaw: 16, pitch: 11, roll: 0 },
        osRect: { left: 1920, top: 0, right: 3840, bottom: 1080 },
        deskPos: { x: 1920, y: 0, width: 1920, height: 1080 },
      },
      {
        id: "MONITOR\\MON3\\{3}",
        name: "Monitor 3 (Bottom-Left)",
        displayIndex: 3,
        isPrimary: true,
        enabled: true,
        calibrated: true,
        currentFocus: false,
        activeWindowTitle: "VS Code",
        anchor: { yaw: -16, pitch: -10, roll: 0 },
        osRect: { left: 0, top: 1080, right: 1920, bottom: 2160 },
        deskPos: { x: 0, y: 1080, width: 1920, height: 1080 },
      },
      {
        id: "MONITOR\\MON4\\{4}",
        name: "Monitor 4 (Bottom-Right)",
        displayIndex: 4,
        isPrimary: false,
        enabled: true,
        calibrated: false,
        currentFocus: false,
        activeWindowTitle: "Terminal",
        anchor: null,
        osRect: { left: 1920, top: 1080, right: 3840, bottom: 2160 },
        deskPos: { x: 1920, y: 1080, width: 1920, height: 1080 },
      },
    ],
  },
};

interface DragState {
  monitorId: string;
  startX: number;
  startY: number;
  originDeskPos: DeskPosition;
  currentDeskPos: DeskPosition;
}

interface ActiveDisplaysCardProps {
  monitors: MonitorInfo[];
  isTauriRuntime: boolean;
  highlightedMonitorId?: string | null;
  cursorTeleport?: boolean;
  excludedProcesses?: string[];
  onLocalMonitorsChange?: (monitors: MonitorInfo[]) => void;
  onSelectMockPreset?: (key: string) => void;
  onRefreshMonitors: () => Promise<void>;
}

export function ActiveDisplaysCard({
  monitors,
  isTauriRuntime,
  highlightedMonitorId = null,
  cursorTeleport = false,
  excludedProcesses = [],
  onLocalMonitorsChange,
  onSelectMockPreset,
  onRefreshMonitors,
}: ActiveDisplaysCardProps) {
  const [selectedPreset, setSelectedPreset] = useState("three_stacked_1_over_2");
  const [isArrangeMode, setIsArrangeMode] = useState(false);
  const [showIdentityBadges, setShowIdentityBadges] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [calibratingId, setCalibratingId] = useState<string | null>(null);
  const [popoverError, setPopoverError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasDimensions, setCanvasDimensions] = useState({
    width: 400,
    height: 156,
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasDimensions({ width, height });
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const flashBanner = (msg: string, ms = 2800) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage((cur) => (cur === msg ? null : cur)), ms);
  };

  // Keep live drag geometry local until release so 150ms telemetry does not overwrite pointer motion.
  const displayedMonitors = useMemo(() => {
    if (!dragState) return monitors;
    return monitors.map((m) =>
      m.id === dragState.monitorId ? { ...m, deskPos: dragState.currentDeskPos } : m
    );
  }, [monitors, dragState]);

  const layout = useMemo(() => {
    return layoutMonitors(
      displayedMonitors,
      canvasDimensions.width,
      canvasDimensions.height,
      14
    );
  }, [displayedMonitors, canvasDimensions]);

  const handleToggleMonitor = async (id: string, enabled: boolean) => {
    if (!isTauriRuntime) {
      onLocalMonitorsChange?.(
        monitors.map((m) => (m.id === id ? { ...m, enabled } : m))
      );
      return;
    }

    try {
      await invoke("set_monitor_enabled", { monitorId: id, enabled });
      await onRefreshMonitors();
    } catch (err: unknown) {
      setPopoverError(
        typeof err === "string" ? err : "Failed to update monitor state."
      );
    }
  };

  const handleCalibrateSingle = async (id: string, displayIndex: number) => {
    setCalibratingId(id);
    setPopoverError(null);

    if (!isTauriRuntime) {
      onLocalMonitorsChange?.(
        monitors.map((m) =>
          m.id === id
            ? {
                ...m,
                calibrated: true,
                anchor: m.anchor ?? { yaw: (displayIndex - 2) * 14, pitch: 0, roll: 0 },
              }
            : m
        )
      );
      setCalibratingId(null);
      flashBanner(`Monitor ${displayIndex} anchor saved (preview).`);
      return;
    }

    try {
      const pose = await invoke<HeadPose>("calibrate_monitor", { monitorId: id });
      await onRefreshMonitors();
      flashBanner(
        `Monitor ${displayIndex} calibrated (${pose.yaw.toFixed(1)}°, ${pose.pitch.toFixed(1)}°).`
      );
    } catch (err: unknown) {
      setPopoverError(
        typeof err === "string" ? err : "Calibration failed. Keep face visible."
      );
    } finally {
      setCalibratingId(null);
    }
  };

  const handleTestFocus = async (id: string, displayIndex: number) => {
    if (!isTauriRuntime) {
      onLocalMonitorsChange?.(
        monitors.map((m) => ({ ...m, currentFocus: m.id === id }))
      );
      flashBanner(`Preview focused Monitor ${displayIndex}.`);
      return;
    }

    try {
      const res = await invoke<{ title: string } | null>("debug_focus_monitor", {
        monitorId: id,
        teleportCursor: cursorTeleport,
        excludedProcesses,
      });
      await onRefreshMonitors();
      flashBanner(
        res?.title
          ? `Focused Monitor ${displayIndex} ("${res.title}")`
          : `Focused Monitor ${displayIndex}`
      );
    } catch (err: unknown) {
      setPopoverError(typeof err === "string" ? err : "Focus switch failed.");
    }
  };

  const handleIdentify = () => {
    setShowIdentityBadges(true);
    if (isTauriRuntime) {
      invoke("identify_monitors").catch(() => {});
    }
    setTimeout(() => setShowIdentityBadges(false), 2500);
  };

  const handleSyncWithOS = async () => {
    if (!isTauriRuntime) {
      onLocalMonitorsChange?.(
        monitors.map((m) => ({
          ...m,
          deskPos: {
            x: m.osRect.left,
            y: m.osRect.top,
            width: m.osRect.right - m.osRect.left,
            height: m.osRect.bottom - m.osRect.top,
          },
        }))
      );
      flashBanner("Desk layout synchronized with OS coordinates.");
      return;
    }

    try {
      await invoke("reset_monitor_desk_layout");
      await onRefreshMonitors();
      flashBanner("Desk layout synchronized with Windows Display Settings.");
    } catch {
      flashBanner("Failed to reset desk layout.");
    }
  };

  // Pointer drag handling for Arrange Mode
  const handlePointerDown = (e: React.PointerEvent, m: MonitorInfo) => {
    if (!isArrangeMode) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    setDragState({
      monitorId: m.id,
      startX: e.clientX,
      startY: e.clientY,
      originDeskPos: { ...m.deskPos },
      currentDeskPos: { ...m.deskPos },
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragState || !isArrangeMode) return;
    const scale = layout.scale || 1;
    const dx = (e.clientX - dragState.startX) / scale;
    const dy = (e.clientY - dragState.startY) / scale;

    const candidate: DeskPosition = {
      ...dragState.originDeskPos,
      x: Math.round(dragState.originDeskPos.x + dx),
      y: Math.round(dragState.originDeskPos.y + dy),
    };

    setDragState((prev) => (prev ? { ...prev, currentDeskPos: candidate } : null));
  };

  const handlePointerUp = async () => {
    if (!dragState || !isArrangeMode) return;

    const currentDrag = dragState;
    setDragState(null);

    const result = snapMonitorPosition(
      currentDrag.monitorId,
      currentDrag.currentDeskPos,
      currentDrag.originDeskPos,
      monitors
    );

    if (result.rejected) {
      flashBanner("Drop reverted: displays cannot overlap.", 2000);
      return;
    }

    const nextMonitors = monitors.map((m) =>
      m.id === currentDrag.monitorId ? { ...m, deskPos: result.snappedPos } : m
    );
    onLocalMonitorsChange?.(nextMonitors);

    if (isTauriRuntime) {
      try {
        await invoke("update_monitor_desk_layout", {
          positions: buildDeskLayoutPayload(nextMonitors),
        });
        await onRefreshMonitors();
      } catch {
        flashBanner("Failed to save arranged monitor positions.");
      }
    }
  };

  const focusedMonitor = monitors.find((m) => m.currentFocus);
  const uncalibratedCount = monitors.filter((m) => m.enabled && !m.calibrated).length;

  return (
    <Card className="flex flex-col h-full min-h-0 bg-zinc-900/60 border-zinc-800/80 shadow-md">
      <CardHeader className="py-2 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="size-4 text-emerald-400 shrink-0" />
          <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider truncate">
            Active Displays
          </CardTitle>
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-zinc-400 shrink-0"
          >
            {monitors.length}
          </Badge>
          {uncalibratedCount > 0 && (
            <Badge
              variant="warning"
              className="text-[10px] px-1.5 py-0 shrink-0"
              title="One or more enabled displays need calibration"
            >
              {uncalibratedCount} Uncal
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {!isTauriRuntime && onSelectMockPreset && (
            <select
              value={selectedPreset}
              onChange={(e) => {
                setSelectedPreset(e.target.value);
                onSelectMockPreset(e.target.value);
              }}
              className="h-6 text-[10px] bg-zinc-950/80 border border-zinc-800 rounded px-1.5 text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
              title="Browser preview rig presets"
            >
              {Object.entries(MOCK_TOPOLOGIES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          )}

          <Button
            variant={isArrangeMode ? "default" : "outline"}
            size="sm"
            onClick={() => setIsArrangeMode((prev) => !prev)}
            className="h-6 px-2 text-[11px] gap-1"
            title="Drag and snap displays into your physical desk layout"
          >
            <Move className="size-3" />
            <span>{isArrangeMode ? "Done" : "Arrange"}</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleIdentify}
            className="h-6 px-2 text-[11px] gap-1"
            title="Flash monitor number overlays on physical screens"
          >
            <Hash className="size-3" />
            <span>Identify</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncWithOS}
            className="h-6 px-2 text-[11px] gap-1"
            title="Reset desk layout to Windows Display Settings"
          >
            <RefreshCw className="size-3" />
            <span>Sync</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-2.5 flex-1 min-h-0 flex flex-col justify-between gap-2">
        {(isArrangeMode || statusMessage) && (
          <div
            className={cn(
              "py-1 px-2 rounded border text-[10px] flex items-center justify-between gap-2 shrink-0",
              isArrangeMode
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-zinc-800/80 border-zinc-700 text-zinc-200"
            )}
          >
            <span className="truncate">
              {isArrangeMode
                ? "Arrange Mode: drag monitors to match your desk. Edges snap automatically."
                : statusMessage}
            </span>
          </div>
        )}

        {/* 2D Interactive Spatial Canvas */}
        <div
          ref={containerRef}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={cn(
            "relative w-full flex-1 min-h-[126px] rounded-lg border border-zinc-800/80 bg-zinc-950/70 overflow-hidden select-none transition-colors",
            isArrangeMode && "border-emerald-500/40"
          )}
        >
          <div
            className="absolute inset-0 opacity-[0.04] pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(circle at 1px 1px, #10b981 1px, transparent 0)",
              backgroundSize: "18px 18px",
            }}
          />

          <TooltipProvider delayDuration={150}>
            {layout.projected.map(
              ({
                monitor: m,
                canvasX,
                canvasY,
                canvasWidth,
                canvasHeight,
                isCompact,
              }) => {
                const isDraggingThis = dragState?.monitorId === m.id;
                const isHighlighted = highlightedMonitorId === m.id;
                const gapInset = 1.5;
                const tileW = Math.max(26, canvasWidth - gapInset * 2);
                const tileH = Math.max(26, canvasHeight - gapInset * 2);

                const tileBody = (
                  <button
                    type="button"
                    onPointerDown={(e) => handlePointerDown(e, m)}
                    style={{
                      transform: `translate(${canvasX + gapInset}px, ${canvasY + gapInset}px)`,
                      width: `${tileW}px`,
                      height: `${tileH}px`,
                      zIndex: isDraggingThis
                        ? 30
                        : isHighlighted || m.currentFocus
                        ? 20
                        : 10,
                    }}
                    className={cn(
                      "absolute top-0 left-0 rounded-md flex flex-col justify-between text-left transition-shadow select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                      isCompact ? "p-1.5 items-center" : "p-2",
                      isHighlighted
                        ? "bg-amber-500/15 border-2 border-amber-400 shadow-[0_0_16px_rgba(251,191,36,0.3)]"
                        : m.currentFocus
                        ? "bg-emerald-950/25 border-2 border-emerald-500 shadow-[0_0_14px_rgba(16,185,129,0.22)]"
                        : "bg-zinc-900/75 border border-zinc-800 hover:border-zinc-600",
                      !m.calibrated &&
                        m.enabled &&
                        !isHighlighted &&
                        "border-dashed border-amber-500/75",
                      !m.enabled && "opacity-40 grayscale",
                      isDraggingThis && "opacity-90 ring-2 ring-emerald-400 shadow-2xl",
                      isArrangeMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                    )}
                  >
                    {/* Header Row */}
                    <div
                      className={cn(
                        "flex items-center w-full pointer-events-none",
                        isCompact ? "justify-center gap-1" : "justify-between"
                      )}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold font-mono",
                            m.currentFocus
                              ? "bg-emerald-500 text-zinc-950 font-black"
                              : "bg-zinc-800 text-zinc-300 border border-zinc-700"
                          )}
                        >
                          {m.displayIndex}
                        </span>
                        {!isCompact && (
                          <span className="text-[11px] font-semibold text-zinc-200 truncate leading-none">
                            {m.isPrimary ? `Primary` : `Monitor ${m.displayIndex}`}
                          </span>
                        )}
                      </div>

                      {!isCompact && (
                        <div className="flex items-center gap-1 shrink-0">
                          {m.isPrimary && (
                            <span className="text-[9px] uppercase px-1 rounded bg-zinc-800 text-zinc-400 font-mono">
                              PRI
                            </span>
                          )}
                          {!m.calibrated && m.enabled && (
                            <span
                              className="size-2 rounded-full bg-amber-400"
                              title="Needs calibration"
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {/* Center Label */}
                    {isCompact ? (
                      <div className="flex items-center justify-center pointer-events-none">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            !m.calibrated && m.enabled
                              ? "bg-amber-400"
                              : m.currentFocus
                              ? "bg-emerald-400"
                              : "bg-zinc-500"
                          )}
                        />
                      </div>
                    ) : (
                      <div className="flex-1 flex flex-col justify-center items-center w-full min-w-0 pointer-events-none gap-0.5">
                        <span className="text-[10px] font-medium text-zinc-300 truncate max-w-full">
                          {m.activeWindowTitle || `${m.deskPos.width}×${m.deskPos.height}`}
                        </span>
                        <span className="text-[9px] font-mono text-zinc-400">
                          {m.deskPos.width}×{m.deskPos.height}
                        </span>
                      </div>
                    )}

                    {/* Bottom Status Indicator */}
                    {!isCompact && (
                      <div className="flex items-center justify-between w-full text-[9px] font-mono text-zinc-400 pointer-events-none">
                        <span>
                          {m.anchor
                            ? `${m.anchor.yaw.toFixed(0)}°, ${m.anchor.pitch.toFixed(0)}°`
                            : "Uncalibrated"}
                        </span>
                        {m.currentFocus && (
                          <span className="text-emerald-400 font-semibold uppercase">
                            Focused
                          </span>
                        )}
                      </div>
                    )}

                    {showIdentityBadges && (
                      <div className="absolute inset-0 bg-emerald-500/90 rounded-md flex items-center justify-center pointer-events-none">
                        <span className="text-3xl font-black font-mono text-zinc-950">
                          {m.displayIndex}
                        </span>
                      </div>
                    )}
                  </button>
                );

                if (isArrangeMode) {
                  return <React.Fragment key={m.id}>{tileBody}</React.Fragment>;
                }

                return (
                  <Popover
                    key={m.id}
                    onOpenChange={(open) => {
                      if (open) setPopoverError(null);
                    }}
                  >
                    {isCompact ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PopoverTrigger asChild>{tileBody}</PopoverTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <div className="flex flex-col gap-0.5 text-[11px]">
                            <span className="font-semibold text-zinc-100">
                              Monitor {m.displayIndex} {m.isPrimary ? "(Primary)" : ""}
                            </span>
                            <span className="text-zinc-400 font-mono">
                              {m.deskPos.width}×{m.deskPos.height} ·{" "}
                              {m.activeWindowTitle || "No active app"}
                            </span>
                            <span className={m.calibrated ? "text-emerald-400" : "text-amber-400"}>
                              {m.calibrated
                                ? `Anchor (${m.anchor!.yaw.toFixed(1)}°, ${m.anchor!.pitch.toFixed(1)}°)`
                                : "Click to calibrate display"}
                            </span>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <PopoverTrigger asChild>{tileBody}</PopoverTrigger>
                    )}

                    <PopoverContent
                      className="w-64 p-3 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs flex flex-col gap-2.5"
                      align="center"
                    >
                      <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5 gap-2">
                        <span className="font-semibold text-zinc-100 truncate">
                          Monitor {m.displayIndex}
                          {m.isPrimary ? " · Primary" : ""}
                        </span>
                        <Badge
                          variant={m.calibrated ? "default" : "warning"}
                          className="text-[9px] py-0 px-1.5 shrink-0"
                        >
                          {m.calibrated ? "Calibrated" : "Uncalibrated"}
                        </Badge>
                      </div>

                      <div className="flex flex-col gap-1 font-mono text-[10px] text-zinc-400">
                        <div className="truncate">ID: {m.id}</div>
                        <div>
                          OS Rect: ({m.osRect.left}, {m.osRect.top}) to (
                          {m.osRect.right}, {m.osRect.bottom})
                        </div>
                        <div>
                          Anchor:{" "}
                          {m.anchor
                            ? `Yaw ${m.anchor.yaw.toFixed(1)}°, Pitch ${m.anchor.pitch.toFixed(1)}°`
                            : "Not calibrated"}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-0.5">
                        <Label htmlFor={`mon-enabled-${m.id}`} className="text-[11px]">
                          Include in Tracking
                        </Label>
                        <Switch
                          id={`mon-enabled-${m.id}`}
                          checked={m.enabled}
                          onCheckedChange={(checked) =>
                            handleToggleMonitor(m.id, checked)
                          }
                        />
                      </div>

                      {popoverError && (
                        <div className="flex items-center gap-1.5 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                          <AlertCircle className="size-3 shrink-0" />
                          <span>{popoverError}</span>
                        </div>
                      )}

                      <div className="flex flex-col gap-1.5 pt-0.5">
                        <Button
                          size="sm"
                          disabled={calibratingId === m.id || !m.enabled}
                          onClick={() => handleCalibrateSingle(m.id, m.displayIndex)}
                          className="w-full text-xs h-7"
                        >
                          {calibratingId === m.id ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <CheckCircle2 data-icon="inline-start" />
                          )}
                          {calibratingId === m.id
                            ? "Sampling (300ms)..."
                            : "Calibrate This Display"}
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleTestFocus(m.id, m.displayIndex)}
                          className="w-full text-xs h-7"
                        >
                          <MousePointerClick data-icon="inline-start" />
                          Test Focus Switch
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                );
              }
            )}
          </TooltipProvider>
        </div>

        {/* Focused Summary Footer */}
        <div className="pt-1 border-t border-zinc-800/60 flex items-center justify-between text-[11px] text-zinc-400 shrink-0 gap-2">
          <div className="flex items-center gap-1.5 truncate min-w-0">
            <span className="text-zinc-400 shrink-0">Focused:</span>
            {focusedMonitor ? (
              <span className="text-zinc-200 font-medium flex items-center gap-1 truncate">
                <span className="size-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="truncate">
                  Monitor {focusedMonitor.displayIndex}
                  {focusedMonitor.activeWindowTitle
                    ? ` · ${focusedMonitor.activeWindowTitle}`
                    : ` (${focusedMonitor.deskPos.width}×${focusedMonitor.deskPos.height})`}
                </span>
              </span>
            ) : (
              <span className="text-zinc-400 italic">None</span>
            )}
          </div>

          <span className="font-mono text-[10px] text-zinc-400 shrink-0">
            Scale: {layout.scale.toFixed(3)}x
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
