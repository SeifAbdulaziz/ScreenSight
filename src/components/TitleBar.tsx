import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Eye,
  ShieldCheck,
  Cpu,
  Minus,
  Square,
  X,
  Activity,
  Pause,
  Gamepad2,
  VideoOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export type SystemStatus = "active" | "yielded" | "gaming_paused" | "paused";

interface TitleBarProps {
  trackingEnabled: boolean;
  onToggleTracking: (enabled: boolean) => void;
  status?: SystemStatus;
  yieldedAppName?: string | null;
  fps?: number;
  measuredFps?: number;
}

export function TitleBar({
  trackingEnabled,
  onToggleTracking,
  status = "active",
  yieldedAppName = null,
  fps = 15,
  measuredFps = 0,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  const handleMinimize = async () => {
    try {
      await invoke("minimize_window");
    } catch {
      // Running in browser dev mode fallback
    }
  };

  const handleToggleMaximize = async () => {
    try {
      await invoke("toggle_maximize_window");
      setIsMaximized(!isMaximized);
    } catch {
      // Browser fallback
    }
  };

  const handleClose = async () => {
    try {
      await invoke("close_window");
    } catch {
      // Browser fallback
    }
  };

  // Dual indicator: color + explicit icon & text for a11y compliance
  const getStatusBadge = () => {
    if (!trackingEnabled) {
      return (
        <Badge variant="secondary" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
          <Pause className="h-3 w-3 text-zinc-400" />
          <span>Paused</span>
        </Badge>
      );
    }

    switch (status) {
      case "yielded":
        return (
          <Badge
            variant="warning"
            className="gap-1.5 text-[11px] py-0 px-2 font-medium"
            title={yieldedAppName ? `Webcam surrendered to ${yieldedAppName}` : "Webcam surrendered to video call"}
          >
            <VideoOff className="h-3 w-3 text-amber-400" />
            <span>Yielded{yieldedAppName ? `: ${yieldedAppName}` : " to Video Call"}</span>
          </Badge>
        );
      case "gaming_paused":
        return (
          <Badge variant="info" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
            <Gamepad2 className="h-3 w-3 text-blue-400" />
            <span>Gaming Paused</span>
          </Badge>
        );
      case "active":
      default:
        return (
          <Badge variant="default" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
            <Activity className="h-3 w-3 text-emerald-400 animate-pulse" />
            <span>Active</span>
          </Badge>
        );
    }
  };

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 w-full select-none items-center justify-between border-b border-zinc-800/80 bg-zinc-950/90 px-3 backdrop-blur-md"
    >
      {/* Left: Branding & Status Telemetry */}
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 text-zinc-100 font-semibold tracking-tight text-xs">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <Eye className="h-3.5 w-3.5" />
          </div>
          <span className="font-bold tracking-tight text-zinc-100">ScreenSight</span>
        </div>

        <div className="h-3.5 w-[1px] bg-zinc-800" />

        {/* Live Status Badge */}
        {getStatusBadge()}

        {/* FPS & Provider Telemetry */}
        <Badge
          variant="outline"
          className="gap-1 text-[11px] py-0 px-2 text-zinc-400 border-zinc-800 bg-zinc-900/40"
        >
          <Cpu className="h-3 w-3 text-zinc-500" />
          <span>
            {measuredFps > 0.5 ? `${Math.round(measuredFps)} / ${fps}` : fps} FPS · CPU
          </span>
        </Badge>

        {/* Local Privacy Guarantee */}
        <Badge
          variant="outline"
          className="hidden sm:inline-flex gap-1 text-[11px] py-0 px-2 text-zinc-400 border-zinc-800/80 bg-zinc-900/30"
          title="100% Volatile RAM. Zero disk writes, zero network transmissions."
        >
          <ShieldCheck className="h-3 w-3 text-emerald-400" />
          <span>Local Only</span>
        </Badge>
      </div>

      {/* Right: Master Switch & Window Controls */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 pr-1">
          <span className="text-[11px] font-medium text-zinc-400">Tracking</span>
          <Switch
            checked={trackingEnabled}
            onCheckedChange={onToggleTracking}
            aria-label="Toggle Head Pose & Eye Tracking"
          />
        </div>

        <div className="h-3.5 w-[1px] bg-zinc-800" />

        {/* Frameless Window Buttons */}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleMinimize}
            className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 rounded"
            title="Minimize"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleToggleMaximize}
            className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 rounded"
            title="Maximize"
          >
            <Square className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="h-7 w-7 text-zinc-400 hover:text-red-300 hover:bg-red-500/20 rounded"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
