import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TitleBar, SystemStatus } from "@/components/TitleBar";
import { ActiveDisplaysCard } from "@/components/ActiveDisplaysCard";
import { MonitorInfo } from "@/lib/monitorLayout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Camera,
  Compass,
  ShieldAlert,
  BatteryCharging,
  Gamepad2,
  Video,
  CornerDownRight,
  AlertTriangle,
} from "lucide-react";

interface CameraDeviceInfo {
  index: number;
  name: string;
  description: string;
}

interface CameraStatus {
  is_streaming: boolean;
  camera_index: number;
  camera_name: string;
  target_fps: number;
  auto_yield: boolean;
  is_yielded: boolean;
  yielded_to_app: string | null;
}

interface VisionTelemetry {
  running: boolean;
  face_detected: boolean;
  face_confidence: number;
  raw_yaw: number;
  raw_pitch: number;
  smoothed_yaw: number;
  smoothed_pitch: number;
  smoothed_roll: number;
  measured_fps: number;
  is_2d_layout: boolean;
  focused_monitor_id: string | null;
  pending_monitor_id: string | null;
  pending_progress: number;
  monitor_distances: [string, number][];
  last_error: string | null;
}

export default function App() {
  const [trackingEnabled, setTrackingEnabled] = useState(true);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>("active");
  const [yieldedAppName, setYieldedAppName] = useState<string | null>(null);

  // Camera & Tracking Configuration
  const [cameras, setCameras] = useState<CameraDeviceInfo[]>([]);
  const [selectedCameraIndex, setSelectedCameraIndex] = useState<number>(0);
  const [fps, setFps] = useState<number>(15);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);

  // Settings & Safeguards
  const [switchMargin, setSwitchMargin] = useState(6);
  const [dwellDelay, setDwellDelay] = useState(300);
  const [autoYield, setAutoYield] = useState(true);
  const [gamingPause, setGamingPause] = useState(true);
  const [batteryEco, setBatteryEco] = useState(true);
  const [cursorTeleport, setCursorTeleport] = useState(false);

  // Live Vision Telemetry (Phase 4)
  const [telemetry, setTelemetry] = useState<VisionTelemetry>({
    running: false,
    face_detected: false,
    face_confidence: 0,
    raw_yaw: 0,
    raw_pitch: 0,
    smoothed_yaw: 0,
    smoothed_pitch: 0,
    smoothed_roll: 0,
    measured_fps: 0,
    is_2d_layout: false,
    focused_monitor_id: null,
    pending_monitor_id: null,
    pending_progress: 0,
    monitor_distances: [],
    last_error: null,
  });

  // 1. Enumerate physical webcams on mount
  useEffect(() => {
    async function loadCameras() {
      try {
        const list = await invoke<CameraDeviceInfo[]>("list_cameras");
        if (list && list.length > 0) {
          setCameras(list);
          setSelectedCameraIndex(list[0].index);
        }
      } catch {
        setCameras([
          {
            index: 0,
            name: "Integrated Webcam (1080p)",
            description: "Default Media Foundation device",
          },
        ]);
      }
    }
    loadCameras();
  }, []);

  // 2. Synchronize camera configuration with Rust Camera Actor + Vision Worker
  const syncCameraConfig = useCallback(
    async (newCamIdx: number, newFps: number, newYield: boolean) => {
      try {
        const status = await invoke<CameraStatus>("set_camera_config", {
          cameraIndex: newCamIdx,
          targetFps: newFps,
          autoYield: newYield,
        });

        if (status.is_yielded) {
          setSystemStatus("yielded");
          setYieldedAppName(status.yielded_to_app);
        } else if (!trackingEnabled) {
          setSystemStatus("paused");
        } else {
          setSystemStatus("active");
          setYieldedAppName(null);
        }
      } catch {
        // Dev fallback
      }
    },
    [trackingEnabled]
  );

  const handleToggleTracking = async (enabled: boolean) => {
    setTrackingEnabled(enabled);
    try {
      await invoke("set_tracking_enabled", { enabled });
    } catch {
      // Dev fallback
    }
  };

  const handleCameraChange = (newIndex: number) => {
    setSelectedCameraIndex(newIndex);
    syncCameraConfig(newIndex, fps, autoYield);
  };

  const handleFpsChange = (newFps: number) => {
    setFps(newFps);
    syncCameraConfig(selectedCameraIndex, newFps, autoYield);
  };

  const handleAutoYieldToggle = (enabled: boolean) => {
    setAutoYield(enabled);
    syncCameraConfig(selectedCameraIndex, fps, enabled);
  };

  // 3. Push vision tuning & 2D monitor layout changes to vision_worker.rs
  useEffect(() => {
    if (monitors.length === 0) return;

    invoke("update_vision_config", {
      config: {
        target_fps: fps,
        switch_margin_deg: switchMargin,
        dwell_ms: dwellDelay,
        cooldown_ms: 800,
        smoothing_alpha: 0.35,
        auto_pause_fullscreen: gamingPause,
        teleport_cursor: cursorTeleport,
        excluded_processes: [],
        monitors: monitors.map((m) => ({
          id: m.id,
          display_index: m.displayIndex,
          enabled: m.enabled,
          desk_pos: {
            x: Math.round(m.deskPos.x),
            y: Math.round(m.deskPos.y),
            width: Math.round(m.deskPos.width),
            height: Math.round(m.deskPos.height),
          },
          anchor_yaw: null,
          anchor_pitch: null,
        })),
      },
    }).catch(() => {});
  }, [fps, switchMargin, dwellDelay, gamingPause, cursorTeleport, monitors]);

  // 4. Periodic polling loop for Auto-Yield & Fullscreen gaming status
  useEffect(() => {
    const timer = setInterval(async () => {
      if (!trackingEnabled) {
        setSystemStatus("paused");
        return;
      }

      try {
        if (gamingPause) {
          const isGaming = await invoke<boolean>("check_fullscreen_state");
          if (isGaming) {
            setSystemStatus("gaming_paused");
            return;
          }
        }

        const camStatus = await invoke<CameraStatus>("get_camera_status");
        if (camStatus.is_yielded) {
          setSystemStatus("yielded");
          setYieldedAppName(camStatus.yielded_to_app);
        } else {
          setSystemStatus("active");
          setYieldedAppName(null);
        }
      } catch {
        // Dev mode fallback
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [trackingEnabled, gamingPause]);

  // 5. High-frequency telemetry & tray status event subscription
  useEffect(() => {
    const unlistenPromise = listen<{ kind: string; detail?: string }>(
      "screensight://status",
      (event) => {
        const s = event.payload;
        if (s.kind === "ManuallyPaused") {
          setTrackingEnabled(false);
          setSystemStatus("paused");
        } else if (s.kind === "Active") {
          setTrackingEnabled(true);
          setSystemStatus("active");
          setYieldedAppName(null);
        } else if (s.kind === "PausedFullscreen") {
          setSystemStatus("gaming_paused");
        } else if (s.kind === "YieldedToApp") {
          setSystemStatus("yielded");
          setYieldedAppName(s.detail ?? null);
        }
      }
    );

    const timer = setInterval(async () => {
      try {
        const tel = await invoke<VisionTelemetry>("get_vision_telemetry");
        setTelemetry(tel);
      } catch {
        // Dev browser fallback
      }
    }, 150);

    return () => {
      clearInterval(timer);
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Map smoothed yaw (-35..+35 deg) & pitch (-20..+20 deg) to Gaze Pad % coordinates
  const reticleLeftPct = Math.min(95, Math.max(5, 50 + (telemetry.smoothed_yaw / 35) * 45));
  const reticleTopPct = Math.min(92, Math.max(8, 50 - (telemetry.smoothed_pitch / 20) * 42));

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-zinc-950 text-zinc-100 flex flex-col font-sans select-none">
      {/* 1. Frameless Header Bar */}
      <TitleBar
        trackingEnabled={trackingEnabled}
        onToggleTracking={handleToggleTracking}
        status={systemStatus}
        yieldedAppName={yieldedAppName}
        fps={fps}
        measuredFps={telemetry.measured_fps}
      />

      {/* 2. Bento Grid Dashboard Canvas */}
      <main className="flex-1 p-3 grid grid-cols-1 md:grid-cols-2 gap-3 overflow-hidden">
        {/* Top-Left: Active Displays (Phase 1, 2 & 4 live focus sync) */}
        <div className="h-full">
          <ActiveDisplaysCard
            cursorTeleport={cursorTeleport}
            focusedMonitorId={telemetry.focused_monitor_id}
            onMonitorsChange={setMonitors}
          />
        </div>

        {/* Top-Right: Tracking Settings */}
        <Card className="flex flex-col bg-zinc-900/60 border-zinc-800/80 shadow-md">
          <CardHeader className="py-2.5 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-emerald-400" />
              <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                Tracking Settings
              </CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-emerald-400">
              Media Foundation
            </Badge>
          </CardHeader>

          <CardContent className="p-3 space-y-3.5 flex-1 flex flex-col justify-between text-xs">
            {/* Live Camera Selector */}
            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Camera Source</span>
                <p className="text-[10px] text-zinc-400">Physical webcams (nokhwa MSMF)</p>
              </div>
              <select
                value={selectedCameraIndex}
                onChange={(e) => handleCameraChange(Number(e.target.value))}
                className="h-7 text-[11px] bg-zinc-950/80 border border-zinc-800 rounded px-2 text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer max-w-[220px] truncate"
              >
                {cameras.length > 0 ? (
                  cameras.map((c) => (
                    <option key={c.index} value={c.index}>
                      {c.name}
                    </option>
                  ))
                ) : (
                  <option value={0}>Default Webcam (Index 0)</option>
                )}
              </select>
            </div>

            {/* Framerate Selection */}
            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Target FPS</span>
                <p className="text-[10px] text-zinc-400">Closest hardware rate + paced interval</p>
              </div>
              <div className="flex items-center gap-1 font-mono text-xs">
                {[10, 15, 24, 30].map((rate) => (
                  <button
                    key={rate}
                    onClick={() => handleFpsChange(rate)}
                    className={`px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                      fps === rate
                        ? "bg-emerald-500 text-zinc-950 font-bold"
                        : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {rate}
                  </button>
                ))}
              </div>
            </div>

            {/* Switch Margin Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-zinc-300">
                <span>Switch Margin (Hysteresis)</span>
                <span className="font-mono text-emerald-400 font-semibold">{switchMargin}°</span>
              </div>
              <Slider
                value={[switchMargin]}
                min={4}
                max={12}
                step={1}
                onValueChange={(val) => setSwitchMargin(val[0])}
              />
              <div className="flex justify-between text-[10px] text-zinc-400 font-mono">
                <span>4° (Sensitive)</span>
                <span>12° (Resistant)</span>
              </div>
            </div>

            {/* Dwell Delay Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-zinc-300">
                <span>Dwell Delay</span>
                <span className="font-mono text-emerald-400 font-semibold">{dwellDelay} ms</span>
              </div>
              <Slider
                value={[dwellDelay]}
                min={150}
                max={600}
                step={25}
                onValueChange={(val) => setDwellDelay(val[0])}
              />
              <div className="flex justify-between text-[10px] text-zinc-400 font-mono">
                <span>150 ms (Rapid)</span>
                <span>600 ms (Deliberate)</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Bottom-Left: Live Head Pose & Adaptive 1D/2D Gaze Pad */}
        <Card className="flex flex-col bg-zinc-900/60 border-zinc-800/80 shadow-md">
          <CardHeader className="py-2.5 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Compass className="h-4 w-4 text-emerald-400" />
              <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                Head Pose ({telemetry.is_2d_layout ? "2D Gaze Pad" : "1D Yaw Zone"})
              </CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-emerald-400">
              YuNet + FSANet CPU
            </Badge>
          </CardHeader>

          <CardContent className="p-3 flex-1 flex flex-col justify-between">
            <div className="relative w-full h-[120px] rounded-lg border border-zinc-800 bg-zinc-950/70 overflow-hidden">
              <div className="absolute inset-x-0 top-1/2 h-[1px] bg-zinc-800" />
              <div className="absolute inset-y-0 left-1/2 w-[1px] bg-zinc-800" />

              <span className="absolute top-1 left-2 font-mono text-[9px] text-zinc-400">+20° Pitch</span>
              <span className="absolute bottom-1 left-2 font-mono text-[9px] text-zinc-400">-20° Pitch</span>
              <span className="absolute right-2 top-1 font-mono text-[9px] text-zinc-400">+35° Yaw</span>

              {/* Live Smoothed Reticle */}
              <div
                style={{ left: `${reticleLeftPct}%`, top: `${reticleTopPct}%` }}
                className="absolute -translate-x-1/2 -translate-y-1/2 z-10 transition-all duration-100"
              >
                <div
                  className={`h-4 w-4 rounded-full border flex items-center justify-center ${
                    telemetry.face_detected
                      ? "border-emerald-400 bg-emerald-500/25 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                      : "border-zinc-600 bg-zinc-800/40"
                  }`}
                >
                  <div
                    className={`h-1.5 w-1.5 rounded-full ${
                      telemetry.face_detected ? "bg-emerald-400" : "bg-zinc-500"
                    }`}
                  />
                </div>
              </div>

              {/* Dwell progress bar when switching monitors */}
              {telemetry.pending_monitor_id && (
                <div className="absolute bottom-0 inset-x-0 h-1 bg-zinc-800">
                  <div
                    className="h-full bg-emerald-400 transition-all duration-75"
                    style={{ width: `${Math.round(telemetry.pending_progress * 100)}%` }}
                  />
                </div>
              )}
            </div>

            <div className="pt-2 flex items-center justify-between text-[11px] text-zinc-400 font-mono">
              <span>
                Yaw: {telemetry.smoothed_yaw >= 0 ? "+" : ""}
                {telemetry.smoothed_yaw.toFixed(1)}° · Pitch:{" "}
                {telemetry.smoothed_pitch >= 0 ? "+" : ""}
                {telemetry.smoothed_pitch.toFixed(1)}°
              </span>
              <span className={telemetry.face_detected ? "text-emerald-400" : "text-zinc-500"}>
                {telemetry.last_error
                  ? "Model/Cam Wait"
                  : telemetry.face_detected
                  ? `YuNet Conf: ${telemetry.face_confidence.toFixed(2)}`
                  : "No Face"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Bottom-Right: Smart Safeguards */}
        <Card className="flex flex-col bg-zinc-900/60 border-zinc-800/80 shadow-md">
          <CardHeader className="py-2.5 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-emerald-400" />
              <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                Smart Safeguards
              </CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-zinc-400">
              Win32 Hooks
            </Badge>
          </CardHeader>

          <CardContent className="p-3 space-y-2 flex-1 flex flex-col justify-between text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Video className="h-3.5 w-3.5 text-zinc-400" />
                <div>
                  <span className="text-zinc-200">Auto-Yield for Calls</span>
                  <p className="text-[10px] text-zinc-400">Surrender camera to Zoom, Meet, Teams</p>
                </div>
              </div>
              <Switch checked={autoYield} onCheckedChange={handleAutoYieldToggle} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Gamepad2 className="h-3.5 w-3.5 text-zinc-400" />
                <div>
                  <span className="text-zinc-200">Gaming & Fullscreen Pause</span>
                  <p className="text-[10px] text-zinc-400">SHQueryUserNotificationState lock</p>
                </div>
              </div>
              <Switch checked={gamingPause} onCheckedChange={setGamingPause} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BatteryCharging className="h-3.5 w-3.5 text-zinc-400" />
                <div>
                  <span className="text-zinc-200">Battery Eco Mode</span>
                  <p className="text-[10px] text-zinc-400">Throttles to 10 FPS on battery</p>
                </div>
              </div>
              <Switch checked={batteryEco} onCheckedChange={setBatteryEco} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CornerDownRight className="h-3.5 w-3.5 text-zinc-400" />
                <div>
                  <span className="text-zinc-200">Cursor Teleport</span>
                  <p className="text-[10px] text-zinc-400">Move mouse pointer to focused screen</p>
                </div>
              </div>
              <Switch checked={cursorTeleport} onCheckedChange={setCursorTeleport} />
            </div>
          </CardContent>
        </Card>
      </main>

      {/* 3. Status Footer */}
      <footer className="h-7 border-t border-zinc-800/80 bg-zinc-950 px-3 flex items-center justify-between text-[11px] text-zinc-400 select-none">
        <div className="flex items-center gap-2">
          {systemStatus === "yielded" ? (
            <span className="flex items-center gap-1.5 text-amber-400 font-medium">
              <AlertTriangle className="h-3 w-3" />
              <span>Camera yielded to {yieldedAppName || "another app"}</span>
            </span>
          ) : (
            <>
              <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span>System Tray Resident</span>
              <span className="text-zinc-400">·</span>
              <span className="font-mono text-zinc-400">Hotkey: Ctrl+Alt+G</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span>v1.0.0-phase5</span>
          <span className="text-zinc-400">·</span>
          <span className="text-emerald-400/90 font-medium">100% Volatile RAM</span>
        </div>
      </footer>
    </div>
  );
}
