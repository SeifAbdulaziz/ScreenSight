import React, { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { normalizeProcessName } from "@/lib/gazeGeometry";

interface ExclusionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludedProcesses: string[];
  onSaveExclusions: (next: string[]) => void;
}

export function ExclusionsDialog({
  open,
  onOpenChange,
  excludedProcesses,
  onSaveExclusions,
}: ExclusionsDialogProps) {
  const [draft, setDraft] = useState("");

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normalizeProcessName(draft);
    if (!cleaned) return;
    if (!excludedProcesses.some((item) => normalizeProcessName(item) === cleaned)) {
      onSaveExclusions([...excludedProcesses, cleaned]);
    }
    setDraft("");
  };

  const handleRemove = (target: string) => {
    onSaveExclusions(excludedProcesses.filter((item) => item !== target));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Excluded Applications</DialogTitle>
          <DialogDescription>
            Windows belonging to these processes will never receive automatic
            gaze focus switches (for example, games, screen recorders, or overlays).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleAdd} className="flex flex-col gap-2">
          <Label htmlFor="exclude-exe-input">Process executable name</Label>
          <div className="flex items-center gap-2">
            <Input
              id="exclude-exe-input"
              placeholder="e.g. obs64.exe or valorant.exe"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit" size="sm" className="shrink-0">
              <Plus data-icon="inline-start" />
              Add
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-medium text-zinc-400">
            Active Exclusions ({excludedProcesses.length})
          </span>
          <div className="min-h-[72px] max-h-[140px] overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/50 p-2.5 flex flex-wrap content-start gap-1.5">
            {excludedProcesses.length === 0 ? (
              <span className="text-xs text-zinc-400">
                No processes excluded yet.
              </span>
            ) : (
              excludedProcesses.map((proc) => (
                <Badge
                  key={proc}
                  variant="secondary"
                  className="font-mono text-[11px] pr-1 gap-1"
                >
                  <span>{proc}</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(proc)}
                    aria-label={`Remove ${proc}`}
                    className="rounded-full p-0.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 cursor-pointer"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-400 rounded-md border border-zinc-800/80 bg-zinc-900/40 px-2.5 py-2">
          Windows UAC / UIPI Note: Because ScreenSight runs with standard user
          permissions by default, Windows blocks switching focus onto windows
          running as Administrator (such as Task Manager or an elevated terminal).
        </p>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
