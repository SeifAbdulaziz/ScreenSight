import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  CameraOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { TrackerStatus } from "@/types/screensight";

interface TitleBarProps {
  trackingEnabled: boolean;
  onToggleTracking: (enabled: boolean) => void;
  status: TrackerStatus;
  fps: number;
  measuredFps: number;
}

export function TitleBar({
  trackingEnabled,
  onToggleTracking,
  status,
  fps,
  measuredFps,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      invoke("minimize_window").catch(() => {});
    }
  };

  const handleToggleMaximize = async () => {
    try {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    } catch {
      invoke("toggle_maximize_window")
        .then(() => setIsMaximized((prev) => !prev))
        .catch(() => {});
    }
  };

  const handleHideToTray = async () => {
    try {
      await getCurrentWindow().hide();
    } catch {
      invoke("close_window").catch(() => {});
    }
  };

  const renderStatusBadge = () => {
    if (!trackingEnabled || status.kind === "ManuallyPaused") {
      return (
        <Badge variant="secondary" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
          <Pause className="text-zinc-400" />
          <span>Paused</span>
        </Badge>
      );
    }

    switch (status.kind) {
      case "YieldedToApp":
        return (
          <Badge
            variant="warning"
            className="gap-1.5 text-[11px] py-0 px-2 font-medium max-w-[180px]"
            title={`Webcam surrendered to ${status.detail}`}
          >
            <VideoOff className="text-amber-400 shrink-0" />
            <span className="truncate">Yielded to {status.detail}</span>
          </Badge>
        );
      case "PausedFullscreen":
        return (
          <Badge variant="info" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
            <Gamepad2 className="text-blue-400" />
            <span>Fullscreen Paused</span>
          </Badge>
        );
      case "NoCamera":
        return (
          <Badge variant="warning" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
            <CameraOff className="text-amber-400" />
            <span>No Camera</span>
          </Badge>
        );
      case "Active":
      default:
        return (
          <Badge variant="default" className="gap-1.5 text-[11px] py-0 px-2 font-medium">
            <Activity className="text-emerald-400 animate-pulse" />
            <span>Tracking Active</span>
          </Badge>
        );
    }
  };

  const rateText =
    measuredFps > 0.5 ? `${Math.round(measuredFps)} / ${fps}` : `${fps}`;

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 w-full shrink-0 select-none items-center justify-between border-b border-zinc-800/80 bg-zinc-950/90 px-3 backdrop-blur-md"
    >
      {/* Left: Branding & Status Telemetry */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex items-center gap-1.5 text-zinc-100 font-semibold tracking-tight text-xs shrink-0">
          <div className="flex size-5 items-center justify-center rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <Eye className="size-3.5" />
          </div>
          <span className="font-bold tracking-tight text-zinc-100">ScreenSight</span>
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        {renderStatusBadge()}

        <Badge
          variant="outline"
          className="gap-1 text-[11px] py-0 px-2 text-zinc-400 border-zinc-800 bg-zinc-900/40 shrink-0"
        >
          <Cpu className="size-3 text-zinc-400" />
          <span>{rateText} FPS · Media Foundation</span>
        </Badge>

        <Badge
          variant="outline"
          className="hidden md:inline-flex gap-1 text-[11px] py-0 px-2 text-zinc-400 border-zinc-800/80 bg-zinc-900/30 shrink-0"
          title="100% Volatile RAM. Video frames never touch disk or network."
        >
          <ShieldCheck className="size-3 text-emerald-400" />
          <span>Local Only</span>
        </Badge>
      </div>

      {/* Right: Master Switch & Window Controls */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2 pr-1">
          <span className="text-[11px] font-medium text-zinc-400">Tracking</span>
          <Switch
            checked={trackingEnabled}
            onCheckedChange={onToggleTracking}
            aria-label="Toggle Head Pose Tracking"
          />
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleMinimize}
            className="size-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 rounded"
            title="Minimize"
            aria-label="Minimize window"
          >
            <Minus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleToggleMaximize}
            className="size-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 rounded"
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
          >
            <Square className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleHideToTray}
            className="size-7 text-zinc-400 hover:text-red-300 hover:bg-red-500/20 rounded"
            title="Hide to System Tray"
            aria-label="Hide window to system tray"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
