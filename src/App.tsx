import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { TitleBar } from "@/components/TitleBar";
import {
  ActiveDisplaysCard,
  MOCK_TOPOLOGIES,
} from "@/components/ActiveDisplaysCard";
import { TrackingSettingsCard } from "@/components/TrackingSettingsCard";
import { HeadPoseCard } from "@/components/HeadPoseCard";
import { SmartSafeguardsCard } from "@/components/SmartSafeguardsCard";
import { StatusFooter } from "@/components/StatusFooter";
import type { MonitorInfo } from "@/lib/monitorLayout";
import {
  DEFAULT_APP_CONFIG,
  monitorNodeToInfo,
  type AppConfig,
  type CameraDeviceInfo,
  type HeadPose,
  type MonitorNode,
  type TelemetryPayload,
  type TrackerStatus,
} from "@/types/screensight";

const INITIAL_TELEMETRY: TelemetryPayload = {
  status: { kind: "Active" },
  face_detected: false,
  face_confidence: 0,
  smoothed_yaw: 0,
  smoothed_pitch: 0,
  smoothed_roll: 0,
  measured_fps: 0,
  focused_monitor_id: null,
  pending_monitor_id: null,
  pending_progress: 0,
  is_2d_layout: false,
  monitors: [],
};

function hasVerticalStack(monitors: MonitorInfo[]): boolean {
  if (monitors.length < 2) return false;
  const ys = monitors.map((m) => m.deskPos.y + m.deskPos.height / 2);
  return Math.max(...ys) - Math.min(...ys) > 300;
}

export default function App() {
  const [isTauriRuntime, setIsTauriRuntime] = useState(true);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const configRef = useRef<AppConfig>(DEFAULT_APP_CONFIG);

  const [cameras, setCameras] = useState<CameraDeviceInfo[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryPayload>(INITIAL_TELEMETRY);
  const [trackingEnabled, setTrackingEnabled] = useState(true);
  const [autostartEnabled, setAutostartEnabled] = useState(false);

  const [highlightedMonitorId, setHighlightedMonitorId] = useState<string | null>(
    null
  );
  const [openCalibrationTrigger, setOpenCalibrationTrigger] = useState(0);

  const refreshMonitorsAndConfig = useCallback(async () => {
    try {
      const [cfg, nodes] = await Promise.all([
        invoke<AppConfig>("get_config"),
        invoke<MonitorNode[]>("get_monitors"),
      ]);
      configRef.current = cfg;
      setConfig(cfg);
      setMonitors(nodes.map(monitorNodeToInfo));
      setTelemetry((prev) => ({
        ...prev,
        is_2d_layout: prev.is_2d_layout || hasVerticalStack(nodes.map(monitorNodeToInfo)),
      }));
    } catch {
      // Handled by initial offline fallback
    }
  }, []);

  // Hydrate initial persisted AppConfig, MonitorNode[], Webcams, and Autostart on startup
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [cfg, nodes] = await Promise.all([
          invoke<AppConfig>("get_config"),
          invoke<MonitorNode[]>("get_monitors"),
        ]);
        if (cancelled) return;

        setIsTauriRuntime(true);
        configRef.current = cfg;
        setConfig(cfg);
        const mappedMonitors = nodes.map(monitorNodeToInfo);
        setMonitors(mappedMonitors);
        setTelemetry((prev) => ({
          ...prev,
          is_2d_layout: hasVerticalStack(mappedMonitors),
        }));

        invoke<CameraDeviceInfo[]>("list_cameras")
          .then((list) => {
            if (!cancelled && Array.isArray(list)) setCameras(list);
          })
          .catch(() => {});

        isAutostartEnabled()
          .then((enabled) => {
            if (!cancelled) setAutostartEnabled(enabled);
          })
          .catch(() => {});
      } catch {
        if (cancelled) return;
        // Browser dev preview fallback when Vite runs without the Tauri host
        setIsTauriRuntime(false);
        const preview = MOCK_TOPOLOGIES.three_stacked_1_over_2.monitors;
        setMonitors(preview);
        setCameras([
          {
            index: 0,
            name: "Preview Webcam (Browser Mode)",
            description: "Mock camera",
          },
        ]);
        setTelemetry((prev) => ({
          ...prev,
          is_2d_layout: hasVerticalStack(preview),
          focused_monitor_id: preview.find((m) => m.currentFocus)?.id ?? null,
        }));
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to visibility-gated telemetry, tray status changes, hot-plugs, and tray calibration trigger
  useEffect(() => {
    const unlistenPromises = [
      listen<TelemetryPayload>("screensight://telemetry", (event) => {
        const payload = event.payload;
        setTelemetry(payload);
        setMonitors(payload.monitors.map(monitorNodeToInfo));
        setTrackingEnabled(payload.status.kind !== "ManuallyPaused");
      }),
      listen<TrackerStatus>("screensight://status", (event) => {
        const nextStatus = event.payload;
        setTelemetry((prev) => ({ ...prev, status: nextStatus }));
        setTrackingEnabled(nextStatus.kind !== "ManuallyPaused");
      }),
      listen<void>("screensight://monitors-changed", () => {
        refreshMonitorsAndConfig();
      }),
      listen<void>("screensight://open-calibration", () => {
        setOpenCalibrationTrigger((c) => c + 1);
      }),
    ];

    return () => {
      for (const p of unlistenPromises) {
        p.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, [refreshMonitorsAndConfig]);

  const handlePatchConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      const next: AppConfig = { ...configRef.current, ...patch };
      configRef.current = next;
      setConfig(next);

      if (!isTauriRuntime) return;

      try {
        const saved = await invoke<AppConfig>("update_config", { config: next });
        configRef.current = saved;
        setConfig(saved);
      } catch {
        // Keep optimistic state if window closes concurrently
      }
    },
    [isTauriRuntime]
  );

  const handleToggleTracking = useCallback(
    async (enabled: boolean) => {
      setTrackingEnabled(enabled);
      setTelemetry((prev) => ({
        ...prev,
        status: enabled ? { kind: "Active" } : { kind: "ManuallyPaused" },
      }));

      if (!isTauriRuntime) return;
      try {
        await invoke("set_tracking_enabled", { enabled });
      } catch {
        // Event listener will reconcile actual backend state
      }
    },
    [isTauriRuntime]
  );

  const handleToggleAutostart = useCallback(
    async (enabled: boolean) => {
      setAutostartEnabled(enabled);
      if (!isTauriRuntime) return;

      try {
        if (enabled) {
          await enableAutostart();
        } else {
          await disableAutostart();
        }
      } catch {
        setAutostartEnabled(!enabled);
      }
    },
    [isTauriRuntime]
  );

  const handleCalibrateMonitor = useCallback(
    async (monitorId: string): Promise<HeadPose> => {
      if (!isTauriRuntime) {
        const target = monitors.find((m) => m.id === monitorId);
        const pose: HeadPose = {
          yaw: ((target?.displayIndex ?? 1) - 2) * 14,
          pitch: target && target.deskPos.y < 1000 ? 8 : -8,
          roll: 0,
        };
        setMonitors((prev) =>
          prev.map((m) =>
            m.id === monitorId ? { ...m, calibrated: true, anchor: pose } : m
          )
        );
        return pose;
      }

      const pose = await invoke<HeadPose>("calibrate_monitor", { monitorId });
      await refreshMonitorsAndConfig();
      return pose;
    },
    [isTauriRuntime, monitors, refreshMonitorsAndConfig]
  );

  const handleSelectMockPreset = useCallback((key: string) => {
    const preset = MOCK_TOPOLOGIES[key];
    if (!preset) return;
    setMonitors(preset.monitors);
    setTelemetry((prev) => ({
      ...prev,
      is_2d_layout: hasVerticalStack(preset.monitors),
      focused_monitor_id: preset.monitors.find((m) => m.currentFocus)?.id ?? null,
    }));
  }, []);

  const handleLocalMonitorsChange = useCallback((next: MonitorInfo[]) => {
    setMonitors(next);
    setTelemetry((prev) => ({
      ...prev,
      is_2d_layout: hasVerticalStack(next),
    }));
  }, []);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-zinc-950 text-zinc-100 flex flex-col font-sans select-none">
      <TitleBar
        trackingEnabled={trackingEnabled}
        onToggleTracking={handleToggleTracking}
        status={telemetry.status}
        fps={config.target_fps}
        measuredFps={telemetry.measured_fps}
      />

      {/* 2x2 Dark-Mode Dashboard Bento Grid */}
      <main className="flex-1 min-h-0 p-2.5 grid grid-cols-1 md:grid-cols-2 md:grid-rows-2 gap-2.5 overflow-y-auto md:overflow-hidden">
        <ActiveDisplaysCard
          monitors={monitors}
          isTauriRuntime={isTauriRuntime}
          highlightedMonitorId={highlightedMonitorId}
          cursorTeleport={config.teleport_cursor}
          excludedProcesses={config.excluded_processes}
          onLocalMonitorsChange={handleLocalMonitorsChange}
          onSelectMockPreset={handleSelectMockPreset}
          onRefreshMonitors={refreshMonitorsAndConfig}
        />

        <TrackingSettingsCard
          config={config}
          cameras={cameras}
          onPatchConfig={handlePatchConfig}
        />

        <HeadPoseCard
          telemetry={telemetry}
          monitors={monitors}
          trackingEnabled={trackingEnabled}
          openCalibrationTrigger={openCalibrationTrigger}
          onCalibrateMonitor={handleCalibrateMonitor}
          onEnableTrackingForCalibration={() => handleToggleTracking(true)}
          onHighlightMonitor={setHighlightedMonitorId}
        />

        <SmartSafeguardsCard
          config={config}
          autostartEnabled={autostartEnabled}
          onPatchConfig={handlePatchConfig}
          onToggleAutostart={handleToggleAutostart}
        />
      </main>

      <StatusFooter
        status={telemetry.status}
        globalShortcut={config.global_shortcut}
      />
    </div>
  );
}
