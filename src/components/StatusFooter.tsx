import { AlertTriangle } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { TrackerStatus } from "@/types/screensight";

interface StatusFooterProps {
  status: TrackerStatus;
  globalShortcut: string;
}

export function StatusFooter({ status, globalShortcut }: StatusFooterProps) {
  return (
    <footer className="shrink-0 bg-zinc-950 select-none">
      <Separator />
      <div className="h-7 px-3 flex items-center justify-between text-[11px] text-zinc-400 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {status.kind === "YieldedToApp" ? (
            <span className="flex items-center gap-1.5 text-amber-400 font-medium truncate">
              <AlertTriangle className="size-3 shrink-0" />
              <span className="truncate">Camera yielded to {status.detail}</span>
            </span>
          ) : status.kind === "PausedFullscreen" ? (
            <span className="flex items-center gap-1.5 text-blue-400 font-medium truncate">
              <span className="size-1.5 rounded-full bg-blue-400 shrink-0" />
              <span>Fullscreen auto-pause active</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 truncate">
              <span
                className={
                  status.kind === "ManuallyPaused"
                    ? "size-1.5 rounded-full bg-zinc-500 shrink-0"
                    : "size-1.5 rounded-full bg-emerald-400 shrink-0"
                }
              />
              <span>Running in System Tray</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <span className="font-mono text-zinc-400">
            Pause Shortcut: {globalShortcut}
          </span>
          <Separator orientation="vertical" className="h-3" />
          <span className="text-emerald-400/90 font-medium">Volatile RAM</span>
        </div>
      </div>
    </footer>
  );
}
