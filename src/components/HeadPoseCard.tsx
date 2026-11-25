import { useState, useEffect, useMemo, useCallback } from "react";
import { Compass, Crosshair, Loader2, Check, X, SkipForward } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MonitorInfo } from "@/lib/monitorLayout";
import { computeYawZones, projectGazePoint, yawToPct } from "@/lib/gazeGeometry";
import { cn } from "@/lib/utils";
import type { HeadPose, TelemetryPayload } from "@/types/screensight";

interface HeadPoseCardProps {
  telemetry: TelemetryPayload;
  monitors: MonitorInfo[];
  trackingEnabled: boolean;
  openCalibrationTrigger: number;
  onCalibrateMonitor: (monitorId: string) => Promise<HeadPose>;
  onEnableTrackingForCalibration: () => Promise<void>;
  onHighlightMonitor: (monitorId: string | null) => void;
}

export function HeadPoseCard({
  telemetry,
  monitors,
  trackingEnabled,
  openCalibrationTrigger,
  onCalibrateMonitor,
  onEnableTrackingForCalibration,
  onHighlightMonitor,
}: HeadPoseCardProps) {
  const [wizardTargets, setWizardTargets] = useState<MonitorInfo[]>([]);
  const [wizardIndex, setWizardIndex] = useState<number>(0);
  const [isSampling, setIsSampling] = useState(false);
  const [wizardMessage, setWizardMessage] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const isWizardActive = wizardTargets.length > 0 && wizardIndex < wizardTargets.length;
  const currentTarget = isWizardActive ? wizardTargets[wizardIndex] : null;

  const startCalibrateAll = useCallback(() => {
    const enabledTargets = [...monitors]
      .filter((m) => m.enabled)
      .sort((a, b) => a.displayIndex - b.displayIndex);

    if (enabledTargets.length === 0) {
      setWizardError("Enable at least one display in Active Displays first.");
      return;
    }

    setWizardError(null);
    setWizardMessage(null);
    setWizardTargets(enabledTargets);
    setWizardIndex(0);
  }, [monitors]);

  // Allow Tray menu "Calibrate Displays..." event to launch the wizard automatically.
  useEffect(() => {
    if (openCalibrationTrigger > 0) {
      startCalibrateAll();
    }
  }, [openCalibrationTrigger, startCalibrateAll]);

  // Highlight whichever monitor is actively waiting for the user's glance.
  useEffect(() => {
    onHighlightMonitor(currentTarget ? currentTarget.id : null);
    return () => onHighlightMonitor(null);
  }, [currentTarget, onHighlightMonitor]);

  const finishWizard = useCallback((summary?: string) => {
    setWizardTargets([]);
    setWizardIndex(0);
    setWizardError(null);
    if (summary) {
      setWizardMessage(summary);
      setTimeout(() => {
        setWizardMessage((cur) => (cur === summary ? null : cur));
      }, 3000);
    }
  }, []);

  const handleCaptureStep = useCallback(async () => {
    if (!currentTarget || isSampling) return;
    setIsSampling(true);
    setWizardError(null);

    try {
      await onCalibrateMonitor(currentTarget.id);
      const nextIdx = wizardIndex + 1;
      if (nextIdx >= wizardTargets.length) {
        finishWizard(`Calibrated ${wizardTargets.length} display(s).`);
      } else {
        setWizardIndex(nextIdx);
      }
    } catch (err: unknown) {
      setWizardError(
        typeof err === "string"
          ? err
          : "No face detected. Center your face and press Space to retry."
      );
    } finally {
      setIsSampling(false);
    }
  }, [
    currentTarget,
    isSampling,
    onCalibrateMonitor,
    wizardIndex,
    wizardTargets.length,
    finishWizard,
  ]);

  const handleSkipStep = useCallback(() => {
    const nextIdx = wizardIndex + 1;
    setWizardError(null);
    if (nextIdx >= wizardTargets.length) {
      finishWizard();
    } else {
      setWizardIndex(nextIdx);
    }
  }, [wizardIndex, wizardTargets.length, finishWizard]);

  // Press Space anywhere (outside inputs or secondary controls) to sample current monitor.
  useEffect(() => {
    if (!isWizardActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.closest('[data-cal-action="secondary"]')
      ) {
        return;
      }
      e.preventDefault();
      handleCaptureStep();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isWizardActive, handleCaptureStep]);

  const yawZoneLayout = useMemo(
    () =>
      computeYawZones(
        monitors,
        telemetry.focused_monitor_id,
        telemetry.pending_monitor_id
      ),
    [monitors, telemetry.focused_monitor_id, telemetry.pending_monitor_id]
  );

  const reticle2d = projectGazePoint(telemetry.smoothed_yaw, telemetry.smoothed_pitch);
  const reticle1dLeft = yawToPct(telemetry.smoothed_yaw, yawZoneLayout.rangeDeg);
  const calibrated2dMonitors = monitors.filter(
    (m) => m.enabled && m.anchor !== undefined && m.anchor !== null
  );

  return (
    <Card className="flex flex-col h-full min-h-0 bg-zinc-900/60 border-zinc-800/80 shadow-md">
      <CardHeader className="py-2 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2 min-w-0">
          <Compass className="size-4 text-emerald-400 shrink-0" />
          <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider truncate">
            Head Pose ({telemetry.is_2d_layout ? "2D Gaze Pad" : "1D Yaw Zone"})
          </CardTitle>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Badge
            variant="outline"
            className="hidden sm:inline-flex text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-zinc-400"
          >
            YuNet + FSANet
          </Badge>
          {!isWizardActive && (
            <Button
              size="sm"
              variant="outline"
              onClick={startCalibrateAll}
              className="h-6 px-2 text-[11px] gap-1"
            >
              <Crosshair className="size-3" />
              <span>Calibrate All</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-2.5 flex-1 min-h-0 flex flex-col justify-between gap-2">
        {/* Visualization Canvas: 1D Multi-Zone Yaw Bar vs 2D Gaze Pad */}
        {telemetry.is_2d_layout ? (
          <div className="relative w-full flex-1 min-h-[110px] rounded-lg border border-zinc-800 bg-zinc-950/75 overflow-hidden">
            <div className="absolute inset-x-0 top-1/2 h-[1px] bg-zinc-800/90" />
            <div className="absolute inset-y-0 left-1/2 w-[1px] bg-zinc-800/90" />

            <span className="absolute top-1 left-2 font-mono text-[9px] text-zinc-400">
              +20° Pitch
            </span>
            <span className="absolute bottom-1 left-2 font-mono text-[9px] text-zinc-400">
              -20° Pitch
            </span>
            <span className="absolute right-2 top-1 font-mono text-[9px] text-zinc-400">
              ±35° Yaw
            </span>

            {/* Calibrated Monitor Anchors */}
            {calibrated2dMonitors.map((m) => {
              const pt = projectGazePoint(m.anchor!.yaw, m.anchor!.pitch);
              const isFocused = m.id === telemetry.focused_monitor_id || m.currentFocus;
              const isPending = m.id === telemetry.pending_monitor_id;
              return (
                <div
                  key={m.id}
                  style={{ left: `${pt.leftPct}%`, top: `${pt.topPct}%` }}
                  className={cn(
                    "absolute -translate-x-1/2 -translate-y-1/2 size-5 rounded-full border flex items-center justify-center text-[9px] font-mono font-bold transition-colors",
                    isFocused
                      ? "bg-emerald-500/25 border-emerald-400 text-emerald-300"
                      : isPending
                      ? "bg-amber-500/20 border-amber-400 text-amber-300"
                      : "bg-zinc-900/90 border-zinc-700 text-zinc-400"
                  )}
                  title={`M${m.displayIndex} (${m.anchor!.yaw.toFixed(1)}°, ${m.anchor!.pitch.toFixed(1)}°)`}
                >
                  {m.displayIndex}
                </div>
              );
            })}

            {/* Live Smoothed Head-Pose Reticle */}
            <div
              style={{ left: `${reticle2d.leftPct}%`, top: `${reticle2d.topPct}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-100 pointer-events-none"
            >
              <div
                className={cn(
                  "size-4 rounded-full border flex items-center justify-center",
                  telemetry.face_detected
                    ? "border-emerald-400 bg-emerald-500/25 shadow-[0_0_10px_rgba(16,185,129,0.55)]"
                    : "border-zinc-600 bg-zinc-800/40"
                )}
              >
                <div
                  className={cn(
                    "size-1.5 rounded-full",
                    telemetry.face_detected ? "bg-emerald-400" : "bg-zinc-500"
                  )}
                />
              </div>
            </div>

            {telemetry.pending_monitor_id && (
              <div className="absolute bottom-0 inset-x-0 h-1 bg-zinc-800">
                <div
                  className="h-full bg-emerald-400 transition-all duration-75"
                  style={{ width: `${Math.round(telemetry.pending_progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        ) : (
          /* 1D Horizontal Multi-Zone Yaw Bar */
          <div className="relative w-full flex-1 min-h-[110px] rounded-lg border border-zinc-800 bg-zinc-950/75 overflow-hidden flex flex-col justify-center px-3">
            <span className="absolute top-1.5 left-2.5 font-mono text-[9px] text-zinc-400">
              -{yawZoneLayout.rangeDeg}° Left
            </span>
            <span className="absolute top-1.5 right-2.5 font-mono text-[9px] text-zinc-400">
              +{yawZoneLayout.rangeDeg}° Right
            </span>

            {/* Gauge Track */}
            <div className="relative w-full h-9 rounded-md border border-zinc-800/90 bg-zinc-900/60 overflow-hidden">
              {/* Midpoint Zone Dividers */}
              {yawZoneLayout.dividers.map((div, idx) => (
                <div
                  key={`${idx}-${div.midpointYaw}`}
                  style={{ left: `${div.leftPct}%` }}
                  className="absolute inset-y-0 border-l border-dashed border-zinc-600/80 pointer-events-none"
                >
                  <span className="absolute bottom-0.5 -translate-x-1/2 font-mono text-[8px] text-zinc-400 bg-zinc-950/80 px-0.5 rounded">
                    {div.midpointYaw.toFixed(0)}°
                  </span>
                </div>
              ))}

              {/* Monitor Yaw Anchors */}
              {yawZoneLayout.anchors.map((anchor) => (
                <div
                  key={anchor.monitorId}
                  style={{ left: `${anchor.leftPct}%` }}
                  className={cn(
                    "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 size-5 rounded border flex items-center justify-center text-[10px] font-mono font-bold",
                    anchor.isFocused
                      ? "bg-emerald-500 text-zinc-950 border-emerald-400"
                      : anchor.isPending
                      ? "bg-amber-500/20 text-amber-300 border-amber-400"
                      : "bg-zinc-900 text-zinc-300 border-zinc-700"
                  )}
                  title={`Monitor ${anchor.displayIndex} anchor: ${anchor.yaw.toFixed(1)}°`}
                >
                  M{anchor.displayIndex}
                </div>
              ))}

              {yawZoneLayout.anchors.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-400 pointer-events-none">
                  Calibrate displays to place yaw zone boundaries
                </div>
              )}

              {/* Live Smoothed Yaw Needle */}
              <div
                style={{ left: `${reticle1dLeft}%` }}
                className="absolute inset-y-0 -translate-x-1/2 transition-all duration-100 pointer-events-none flex flex-col items-center"
              >
                <div
                  className={cn(
                    "w-0.5 h-full",
                    telemetry.face_detected ? "bg-emerald-400" : "bg-zinc-500"
                  )}
                />
              </div>
            </div>

            {telemetry.pending_monitor_id && (
              <div className="absolute bottom-0 inset-x-0 h-1 bg-zinc-800">
                <div
                  className="h-full bg-emerald-400 transition-all duration-75"
                  style={{ width: `${Math.round(telemetry.pending_progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Guided Sequential "Calibrate All" Strip OR Telemetry Readout */}
        {isWizardActive && currentTarget ? (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 flex flex-col gap-1 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-emerald-200 truncate">
                Step {wizardIndex + 1}/{wizardTargets.length}: Look at Monitor{" "}
                {currentTarget.displayIndex} → Press Space
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  disabled={isSampling}
                  onClick={handleCaptureStep}
                  className="h-6 px-2 text-[10px]"
                >
                  {isSampling ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Check data-icon="inline-start" />
                  )}
                  {isSampling ? "Sampling" : "Capture"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-cal-action="secondary"
                  onClick={handleSkipStep}
                  className="h-6 px-1.5 text-[10px]"
                  title="Skip this monitor"
                >
                  <SkipForward className="size-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-cal-action="secondary"
                  onClick={() => finishWizard()}
                  className="h-6 px-1.5 text-[10px]"
                  title="Cancel calibration"
                >
                  <X className="size-3" />
                </Button>
              </div>
            </div>

            {(wizardError || !trackingEnabled) && (
              <div className="flex items-center justify-between gap-2 text-[10px] text-amber-300">
                <span className="truncate">
                  {!trackingEnabled
                    ? "Tracking is paused. Resume tracking to sample your face."
                    : wizardError}
                </span>
                {!trackingEnabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-cal-action="secondary"
                    onClick={onEnableTrackingForCalibration}
                    className="h-5 px-1.5 text-[10px] shrink-0"
                  >
                    Resume
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono shrink-0 gap-2">
            <span className="truncate">
              Yaw {telemetry.smoothed_yaw >= 0 ? "+" : ""}
              {telemetry.smoothed_yaw.toFixed(1)}° · Pitch{" "}
              {telemetry.smoothed_pitch >= 0 ? "+" : ""}
              {telemetry.smoothed_pitch.toFixed(1)}°
            </span>
            <span
              className={cn(
                "shrink-0",
                wizardError
                  ? "text-amber-400"
                  : wizardMessage || telemetry.face_detected
                  ? "text-emerald-400"
                  : "text-zinc-400"
              )}
            >
              {wizardError ||
                wizardMessage ||
                (telemetry.face_detected
                  ? `Conf ${telemetry.face_confidence.toFixed(2)}`
                  : "No Face")}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
