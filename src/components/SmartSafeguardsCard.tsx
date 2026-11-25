import { useState } from "react";
import {
  ShieldAlert,
  Video,
  Gamepad2,
  CornerDownRight,
  Power,
  Ban,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ExclusionsDialog } from "@/components/ExclusionsDialog";
import type { AppConfig } from "@/types/screensight";

interface SmartSafeguardsCardProps {
  config: AppConfig;
  autostartEnabled: boolean;
  onPatchConfig: (patch: Partial<AppConfig>) => void;
  onToggleAutostart: (enabled: boolean) => void;
}

export function SmartSafeguardsCard({
  config,
  autostartEnabled,
  onPatchConfig,
  onToggleAutostart,
}: SmartSafeguardsCardProps) {
  const [exclusionsOpen, setExclusionsOpen] = useState(false);

  return (
    <Card className="flex flex-col h-full min-h-0 bg-zinc-900/60 border-zinc-800/80 shadow-md">
      <CardHeader className="py-2 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert className="size-4 text-emerald-400 shrink-0" />
          <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider truncate">
            Smart Safeguards
          </CardTitle>
        </div>
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-zinc-400 shrink-0"
          title="Standard non-elevated Windows permissions cannot switch focus onto Administrator-elevated windows (UIPI)."
        >
          Win32 Safe
        </Badge>
      </CardHeader>

      <CardContent className="p-2.5 flex-1 min-h-0 flex flex-col justify-between gap-2 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Video className="size-3.5 text-zinc-400 shrink-0" />
              <div className="flex flex-col min-w-0">
                <Label htmlFor="auto-yield-switch" className="text-zinc-200 truncate">
                  Auto-Yield for Video Calls
                </Label>
                <span className="text-[10px] text-zinc-400 truncate">
                  Release webcam when Zoom, Meet, or Teams opens
                </span>
              </div>
            </div>
            <Switch
              id="auto-yield-switch"
              checked={config.auto_yield_camera}
              onCheckedChange={(checked) =>
                onPatchConfig({ auto_yield_camera: checked })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Gamepad2 className="size-3.5 text-zinc-400 shrink-0" />
              <div className="flex flex-col min-w-0">
                <Label htmlFor="fullscreen-switch" className="text-zinc-200 truncate">
                  Fullscreen & Gaming Auto-Pause
                </Label>
                <span className="text-[10px] text-zinc-400 truncate">
                  Suppress focus shifts during fullscreen apps
                </span>
              </div>
            </div>
            <Switch
              id="fullscreen-switch"
              checked={config.auto_pause_fullscreen}
              onCheckedChange={(checked) =>
                onPatchConfig({ auto_pause_fullscreen: checked })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <CornerDownRight className="size-3.5 text-zinc-400 shrink-0" />
              <div className="flex flex-col min-w-0">
                <Label htmlFor="teleport-switch" className="text-zinc-200 truncate">
                  Cursor Teleport
                </Label>
                <span className="text-[10px] text-zinc-400 truncate">
                  Move mouse cursor to focused display center
                </span>
              </div>
            </div>
            <Switch
              id="teleport-switch"
              checked={config.teleport_cursor}
              onCheckedChange={(checked) =>
                onPatchConfig({ teleport_cursor: checked })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Power className="size-3.5 text-zinc-400 shrink-0" />
              <div className="flex flex-col min-w-0">
                <Label htmlFor="autostart-switch" className="text-zinc-200 truncate">
                  Launch on Startup
                </Label>
                <span className="text-[10px] text-zinc-400 truncate">
                  Start silently in Windows System Tray
                </span>
              </div>
            </div>
            <Switch
              id="autostart-switch"
              checked={autostartEnabled}
              onCheckedChange={onToggleAutostart}
            />
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setExclusionsOpen(true)}
          className="w-full h-7 justify-between text-[11px]"
        >
          <span className="flex items-center gap-1.5">
            <Ban className="size-3.5 text-zinc-400" />
            Manage Excluded Apps...
          </span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {config.excluded_processes.length}
          </Badge>
        </Button>

        <ExclusionsDialog
          open={exclusionsOpen}
          onOpenChange={setExclusionsOpen}
          excludedProcesses={config.excluded_processes}
          onSaveExclusions={(next) =>
            onPatchConfig({ excluded_processes: next })
          }
        />
      </CardContent>
    </Card>
  );
}
