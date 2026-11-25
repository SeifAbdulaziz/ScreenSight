import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Monitor,
  Move,
  RefreshCw,
  Hash,
  CheckCircle2,
  AlertCircle,
  Sliders,
  Laptop,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";

// ==============================================================================
// Preset Test Topologies (Phase 1 Verification)
// ==============================================================================
export const MOCK_TOPOLOGIES: Record<string, { label: string; monitors: MonitorInfo[] }> = {
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
        osRect: { left: 2560, top: 1440, right: 5120, bottom: 2880 },
        deskPos: { x: 2560, y: 1440, width: 2560, height: 1440 },
      },
      {
        id: "MONITOR\\SAM0F34\\{3}",
        name: "Samsung 34\" Ultrawide (Top)",
        displayIndex: 3,
        isPrimary: false,
        enabled: true,
        calibrated: false,
        currentFocus: false,
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
        osRect: { left: 1920, top: 0, right: 3840, bottom: 1080 },
        deskPos: { x: 1920, y: 0, width: 1920, height: 1080 },
      },
      {
        id: "MONITOR\\MON3\\{3}",
        name: "Monitor 3 (Bottom-Left Primary)",
        displayIndex: 3,
        isPrimary: true,
        enabled: true,
        calibrated: true,
        currentFocus: false,
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
        osRect: { left: 1920, top: 1080, right: 3840, bottom: 2160 },
        deskPos: { x: 1920, y: 1080, width: 1920, height: 1080 },
      },
    ],
  },
  portrait_mixed: {
    label: "Portrait + Landscape Rig",
    monitors: [
      {
        id: "MONITOR\\PORT1\\{1}",
        name: "Dell 24\" Portrait (Code)",
        displayIndex: 1,
        isPrimary: false,
        enabled: true,
        calibrated: true,
        currentFocus: false,
        osRect: { left: 0, top: 0, right: 1080, bottom: 1920 },
        deskPos: { x: 0, y: 0, width: 1080, height: 1920 },
      },
      {
        id: "MONITOR\\LAND2\\{2}",
        name: "ASUS 27\" Main (Center)",
        displayIndex: 2,
        isPrimary: true,
        enabled: true,
        calibrated: true,
        currentFocus: true,
        osRect: { left: 1080, top: 240, right: 3640, bottom: 1680 },
        deskPos: { x: 1080, y: 240, width: 2560, height: 1440 },
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

interface RawSystemMonitor {
  id: string;
  display_index: number;
  is_primary: boolean;
  os_rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

interface TopWindowResult {
  title: string;
  hwnd: number;
}

interface ActiveDisplaysCardProps {
  cursorTeleport?: boolean;
  focusedMonitorId?: string | null;
  onMonitorsChange?: (monitors: MonitorInfo[]) => void;
}

export function ActiveDisplaysCard({
  cursorTeleport = false,
  focusedMonitorId = null,
  onMonitorsChange,
}: ActiveDisplaysCardProps) {
  const [selectedTopologyKey, setSelectedTopologyKey] = useState<string>("live_system");
  const [monitors, setMonitors] = useState<MonitorInfo[]>(MOCK_TOPOLOGIES["three_stacked_1_over_2"].monitors);
  const [isArrangeMode, setIsArrangeMode] = useState(false);
  const [showIdentityBadges, setShowIdentityBadges] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [topAppTitle, setTopAppTitle] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 440, height: 210 });

  // Update canvas dimensions dynamically with ResizeObserver
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

  // Fetch real system monitors from Rust Win32 backend
  const fetchLiveSystemMonitors = useCallback(async () => {
    try {
      const raw = await invoke<RawSystemMonitor[]>("get_system_monitors");
      if (raw && raw.length > 0) {
        const mapped: MonitorInfo[] = raw.map((m, idx) => ({
          id: m.id,
          name: `${m.is_primary ? "Primary Display" : `Display ${m.display_index}`} (${m.id})`,
          displayIndex: m.display_index,
          isPrimary: m.is_primary,
          enabled: true,
          calibrated: true,
          currentFocus: idx === 0,
          osRect: m.os_rect,
          deskPos: {
            x: m.os_rect.left,
            y: m.os_rect.top,
            width: m.os_rect.right - m.os_rect.left,
            height: m.os_rect.bottom - m.os_rect.top,
          },
        }));
        setMonitors(mapped);
        setSelectedTopologyKey("live_system");
        setStatusMessage(`Loaded ${raw.length} active Windows display(s).`);
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch {
      // Fallback to mock preset when outside Tauri runtime
      setSelectedTopologyKey("three_stacked_1_over_2");
      setMonitors(MOCK_TOPOLOGIES["three_stacked_1_over_2"].monitors);
    }
  }, []);

  // Automatically load live system displays on startup
  useEffect(() => {
    fetchLiveSystemMonitors();
  }, [fetchLiveSystemMonitors]);

  // Reflect live vision-worker focus switches on the monitor canvas
  useEffect(() => {
    if (!focusedMonitorId) return;
    setMonitors((prev) =>
      prev.some((m) => m.id === focusedMonitorId && !m.currentFocus)
        ? prev.map((m) => ({ ...m, currentFocus: m.id === focusedMonitorId }))
        : prev
    );
  }, [focusedMonitorId]);

  // Notify parent when topology/deskPos/enabled changes (skip intermediate drag frames)
  useEffect(() => {
    if (!dragState) {
      onMonitorsChange?.(monitors);
    }
  }, [monitors, dragState, onMonitorsChange]);

  // When topology selector changes, update monitor list
  const handleSelectTopology = (key: string) => {
    setSelectedTopologyKey(key);
    if (key === "live_system") {
      fetchLiveSystemMonitors();
    } else {
      setMonitors(MOCK_TOPOLOGIES[key].monitors);
    }
    setDragState(null);
  };

  // Reset deskPos back to physical osRect (Sync action)
  const handleSyncWithOS = () => {
    setMonitors((prev) =>
      prev.map((m) => ({
        ...m,
        deskPos: {
          x: m.osRect.left,
          y: m.osRect.top,
          width: m.osRect.right - m.osRect.left,
          height: m.osRect.bottom - m.osRect.top,
        },
      }))
    );
    setStatusMessage("Desk layout synchronized with Windows coordinates.");
    setTimeout(() => setStatusMessage(null), 2500);
  };

  // Toggle monitor tracking inclusion
  const handleToggleMonitor = (id: string, enabled: boolean) => {
    setMonitors((prev) =>
      prev.map((m) => (m.id === id ? { ...m, enabled } : m))
    );
  };

  // Focus monitor: Invokes Rust Win32 focus command in Phase 2
  const handleFocusMonitor = async (id: string) => {
    if (isArrangeMode) return;

    setMonitors((prev) =>
      prev.map((m) => ({ ...m, currentFocus: m.id === id }))
    );

    try {
      const res = await invoke<TopWindowResult | null>("debug_focus_monitor", {
        monitorId: id,
        teleportCursor: cursorTeleport,
        excludedProcesses: [],
      });

      if (res && res.title) {
        setTopAppTitle(res.title);
        setStatusMessage(`Focus switched to: "${res.title}"`);
      } else {
        setTopAppTitle("Desktop");
        setStatusMessage("Focus switched to target screen (Desktop).");
      }
    } catch (err: unknown) {
      const msg = typeof err === "string" ? err : "Focus shift failed";
      setStatusMessage(msg);
    }

    setTimeout(() => setStatusMessage(null), 3500);
  };

  // Flash identity badges
  const handleIdentify = () => {
    setShowIdentityBadges(true);
    setTimeout(() => setShowIdentityBadges(false), 3000);
  };

  // Active projection layout
  const layout = useMemo(() => {
    return layoutMonitors(monitors, canvasDimensions.width, canvasDimensions.height, 20);
  }, [monitors, canvasDimensions]);

  // Pointer drag handling for Arrange Mode
  const handlePointerDown = (e: React.PointerEvent, m: MonitorInfo) => {
    if (!isArrangeMode) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

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
    const dx = (e.clientX - dragState.startX) / (layout.scale || 1);
    const dy = (e.clientY - dragState.startY) / (layout.scale || 1);

    const newPos: DeskPosition = {
      ...dragState.originDeskPos,
      x: Math.round(dragState.originDeskPos.x + dx),
      y: Math.round(dragState.originDeskPos.y + dy),
    };

    setDragState((prev) => (prev ? { ...prev, currentDeskPos: newPos } : null));

    setMonitors((prev) =>
      prev.map((m) => (m.id === dragState.monitorId ? { ...m, deskPos: newPos } : m))
    );
  };

  const handlePointerUp = () => {
    if (!dragState || !isArrangeMode) return;

    const result = snapMonitorPosition(
      dragState.monitorId,
      dragState.currentDeskPos,
      dragState.originDeskPos,
      monitors
    );

    setMonitors((prev) =>
      prev.map((m) =>
        m.id === dragState.monitorId ? { ...m, deskPos: result.snappedPos } : m
      )
    );

    setDragState(null);
  };

  const focusedMonitor = monitors.find((m) => m.currentFocus);

  return (
    <Card className="flex flex-col h-full bg-zinc-900/60 border-zinc-800/80 shadow-md">
      <CardHeader className="py-2.5 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-emerald-400" />
          <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
            Active Displays
          </CardTitle>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-zinc-400">
            {monitors.length} Displays
          </Badge>
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center gap-1.5">
          {/* Quick Rig Presets / Live System selector */}
          <select
            value={selectedTopologyKey}
            onChange={(e) => handleSelectTopology(e.target.value)}
            className="h-7 text-[11px] bg-zinc-950/80 border border-zinc-800 rounded px-2 text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
            title="Switch multi-monitor setup"
          >
            <option value="live_system">🖥️ Live Windows Displays</option>
            {Object.entries(MOCK_TOPOLOGIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>

          {/* Arrange Mode Toggle */}
          <Button
            variant={isArrangeMode ? "default" : "outline"}
            size="sm"
            onClick={() => setIsArrangeMode(!isArrangeMode)}
            className={cn(
              "h-7 px-2 text-[11px] gap-1 rounded",
              isArrangeMode
                ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
            )}
            title="Toggle Arrange Mode to drag and stack monitors"
          >
            <Move className="h-3 w-3" />
            <span>{isArrangeMode ? "Done" : "Arrange"}</span>
          </Button>

          {/* Identify Displays */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleIdentify}
            className="h-7 px-2 text-[11px] gap-1 rounded border-zinc-800 text-zinc-400 hover:text-zinc-200"
            title="Identify monitor numbers"
          >
            <Hash className="h-3 w-3" />
            <span className="hidden sm:inline">Identify</span>
          </Button>

          {/* Sync / Reset to OS layout */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncWithOS}
            className="h-7 px-2 text-[11px] gap-1 rounded border-zinc-800 text-zinc-400 hover:text-zinc-200"
            title="Reset desk layout to match Windows Display Settings"
          >
            <RefreshCw className="h-3 w-3" />
            <span className="hidden sm:inline">Sync</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-3 flex-1 flex flex-col justify-between">
        {/* Arrange Mode Hint Banner */}
        {isArrangeMode && (
          <div className="mb-2 py-1 px-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-300 flex items-center justify-between animate-in fade-in duration-200">
            <span className="flex items-center gap-1.5">
              <Move className="h-3 w-3 shrink-0" />
              Drag tiles to rearrange your desk layout. Releases snap magnetically to edges.
            </span>
            <span className="font-mono text-[10px] text-emerald-400/80">Threshold: 120px</span>
          </div>
        )}

        {/* Live Feedback Toast/Banner */}
        {statusMessage && !isArrangeMode && (
          <div className="mb-2 py-1 px-2.5 rounded bg-zinc-800/90 border border-emerald-500/30 text-[11px] text-emerald-300 flex items-center gap-1.5 animate-in fade-in duration-150">
            <Laptop className="h-3 w-3 text-emerald-400 shrink-0" />
            <span className="truncate">{statusMessage}</span>
          </div>
        )}

        {/* 2D Interactive Projection Canvas */}
        <div
          ref={containerRef}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className={cn(
            "relative w-full h-[180px] sm:h-[200px] rounded-lg border border-zinc-800/80 bg-zinc-950/70 overflow-hidden select-none transition-colors",
            isArrangeMode ? "cursor-grab active:cursor-grabbing border-emerald-500/40" : "cursor-default"
          )}
        >
          {/* Grid background */}
          <div
            className="absolute inset-0 opacity-[0.04] pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(circle at 1px 1px, #10b981 1px, transparent 0)",
              backgroundSize: "20px 20px",
            }}
          />

          <TooltipProvider delayDuration={150}>
            {layout.projected.map(({ monitor: m, canvasX, canvasY, canvasWidth, canvasHeight, isCompact }) => {
              const isDraggingThis = dragState?.monitorId === m.id;

              return (
                <div
                  key={m.id}
                  onPointerDown={(e) => handlePointerDown(e, m)}
                  onClick={() => handleFocusMonitor(m.id)}
                  style={{
                    transform: `translate(${canvasX}px, ${canvasY}px)`,
                    width: `${canvasWidth}px`,
                    height: `${canvasHeight}px`,
                    zIndex: isDraggingThis ? 30 : m.currentFocus ? 20 : 10,
                  }}
                  className={cn(
                    "absolute top-0 left-0 rounded-md transition-shadow flex flex-col justify-between p-2 select-none",
                    m.currentFocus
                      ? "bg-zinc-900/90 border-2 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.25)]"
                      : "bg-zinc-900/70 border border-zinc-800/90 hover:border-zinc-700",
                    !m.calibrated && "border-dashed border-amber-500/60",
                    !m.enabled && "opacity-40 grayscale",
                    isDraggingThis && "opacity-90 ring-2 ring-emerald-400 shadow-2xl scale-[1.02] cursor-grabbing",
                    isArrangeMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                  )}
                >
                  {/* Top Bar inside Monitor Tile */}
                  <div className="flex items-center justify-between w-full pointer-events-none">
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold font-mono",
                          m.currentFocus
                            ? "bg-emerald-500 text-zinc-950 font-black"
                            : "bg-zinc-800 text-zinc-300 border border-zinc-700"
                        )}
                      >
                        {m.displayIndex}
                      </span>

                      {!isCompact && (
                        <span className="text-[11px] font-semibold text-zinc-200 truncate leading-none">
                          {m.name.split("(")[0].trim()}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      {m.isPrimary && (
                        <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-zinc-800 text-zinc-400 font-mono">
                          PRI
                        </span>
                      )}
                      {!m.calibrated && (
                        <span title="Uncalibrated anchor">
                          <AlertCircle className="h-3 w-3 text-amber-400 shrink-0" />
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Center Content / Badge if Compact */}
                  {isCompact ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex-1 flex items-center justify-center pointer-events-auto">
                          <span className="text-xs font-mono font-bold text-zinc-400">
                            {m.deskPos.width}×{m.deskPos.height}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <div className="space-y-1 text-[11px]">
                          <p className="font-semibold text-zinc-200">{m.name}</p>
                          <p className="font-mono text-zinc-400">
                            Desk: ({m.deskPos.x}, {m.deskPos.y}) | Res: {m.deskPos.width}×{m.deskPos.height}
                          </p>
                          <p className="text-emerald-400">
                            {m.currentFocus ? "Active Focus" : "Click to switch OS focus"}
                          </p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <div className="flex-1 flex flex-col justify-center items-center pointer-events-none">
                      <span className="text-[10px] font-mono text-zinc-400/90">
                        {m.deskPos.width} × {m.deskPos.height}
                      </span>
                      {m.currentFocus && (
                        <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                          Focused
                        </span>
                      )}
                    </div>
                  )}

                  {/* Bottom Bar: Action Popover */}
                  <div className="flex items-center justify-between w-full pt-1 pointer-events-auto">
                    <span className="text-[9px] font-mono text-zinc-400">
                      ({m.deskPos.x}, {m.deskPos.y})
                    </span>

                    {!isArrangeMode && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 p-0 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded"
                            title="Configure monitor"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Sliders className="h-3 w-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-64 p-3 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs space-y-2.5 z-50"
                          align="end"
                        >
                          <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5">
                            <span className="font-semibold text-zinc-100 truncate">{m.name}</span>
                            <Badge variant={m.calibrated ? "default" : "warning"} className="text-[9px] py-0 px-1.5">
                              {m.calibrated ? "Calibrated" : "Needs Cal"}
                            </Badge>
                          </div>

                          <div className="space-y-1 font-mono text-[11px] text-zinc-400">
                            <div>Resolution: {m.deskPos.width} × {m.deskPos.height}</div>
                            <div>OS Rect: ({m.osRect.left}, {m.osRect.top}) - ({m.osRect.right}, {m.osRect.bottom})</div>
                            <div className="truncate text-zinc-400">ID: {m.id}</div>
                          </div>

                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[11px] text-zinc-300">Include in Tracking</span>
                            <Switch
                              checked={m.enabled}
                              onCheckedChange={(checked) => handleToggleMonitor(m.id, checked)}
                            />
                          </div>

                          <Button
                            variant="secondary"
                            size="sm"
                            className="w-full text-xs h-7 gap-1.5 text-zinc-200 bg-zinc-800 hover:bg-zinc-700"
                            onClick={() => {
                              setMonitors((prev) =>
                                prev.map((item) =>
                                  item.id === m.id ? { ...item, calibrated: true } : item
                                )
                              );
                            }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                            Calibrate Anchor
                          </Button>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>

                  {/* Big Number Overlay during Identify mode */}
                  {showIdentityBadges && (
                    <div className="absolute inset-0 bg-emerald-500/90 rounded-md flex items-center justify-center z-40 animate-in fade-in zoom-in-95 duration-150">
                      <span className="text-4xl font-black font-mono text-zinc-950 drop-shadow-md">
                        {m.displayIndex}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </TooltipProvider>
        </div>

        {/* Footer telemetry bar for Focused Monitor */}
        <div className="mt-2.5 pt-2 border-t border-zinc-800/60 flex items-center justify-between text-[11px] text-zinc-400">
          <div className="flex items-center gap-1.5 truncate max-w-[65%]">
            <span className="text-zinc-400">Focused:</span>
            {focusedMonitor ? (
              <span className="text-zinc-200 font-medium flex items-center gap-1 truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                Monitor {focusedMonitor.displayIndex}
                {topAppTitle ? ` · "${topAppTitle}"` : ` (${focusedMonitor.name.split("(")[0].trim()})`}
              </span>
            ) : (
              <span className="text-zinc-400 italic">None</span>
            )}
          </div>

          <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-400 shrink-0">
            <span>Scale: {layout.scale.toFixed(4)}x</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
