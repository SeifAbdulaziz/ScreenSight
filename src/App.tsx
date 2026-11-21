import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TitleBar, SystemStatus } from "@/components/TitleBar";
import { ActiveDisplaysCard } from "@/components/ActiveDisplaysCard";
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

export default function App() {
  const [trackingEnabled, setTrackingEnabled] = useState(true);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>("active");
  const [yieldedAppName, setYieldedAppName] = useState<string | null>(null);

  // Camera & Tracking Configuration
  const [cameras, setCameras] = useState<CameraDeviceInfo[]>([]);
  const [selectedCameraIndex, setSelectedCameraIndex] = useState<number>(0);
  const [fps, setFps] = useState<number>(15);

  // Settings mock & real state
  const [switchMargin, setSwitchMargin] = useState(6);
  const [dwellDelay, setDwellDelay] = useState(300);
  const [autoYield, setAutoYield] = useState(true);
  const [gamingPause, setGamingPause] = useState(true);
  const [batteryEco, setBatteryEco] = useState(true);
  const [cursorTeleport, setCursorTeleport] = useState(false);

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
        // Fallback for browser dev mode
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

  // 2. Synchronize configuration with Rust Camera Actor
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

  // 3. Periodic polling loop for Auto-Yield (Registry ConsentStore) & Fullscreen gaming
  useEffect(() => {
    const timer = setInterval(async () => {
      if (!trackingEnabled) {
        setSystemStatus("paused");
        return;
      }

      try {
        // Check gaming / fullscreen state
        if (gamingPause) {
          const isGaming = await invoke<boolean>("check_fullscreen_state");
          if (isGaming) {
            setSystemStatus("gaming_paused");
            return;
          }
        }

        // Check camera status & ConsentStore conflicts
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
    }, 1500);

    return () => clearInterval(timer);
  }, [trackingEnabled, gamingPause]);

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-zinc-950 text-zinc-100 flex flex-col font-sans select-none">
      {/* 1. Frameless Header Bar */}
      <TitleBar
        trackingEnabled={trackingEnabled}
        onToggleTracking={setTrackingEnabled}
        status={systemStatus}
        yieldedAppName={yieldedAppName}
        fps={fps}
      />

      {/* 2. Bento Grid Dashboard Canvas */}
      <main className="flex-1 p-3 grid grid-cols-1 md:grid-cols-2 gap-3 overflow-hidden">
        {/* Top-Left: Active Displays (Phase 1 & 2 Spatial + Win32 Focus) */}
        <div className="h-full">
          <ActiveDisplaysCard cursorTeleport={cursorTeleport} />
        </div>

        {/* Top-Right: Tracking Settings (Phase 3 Hardware Webcam & FPS Controls) */}
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

        {/* Bottom-Left: Head Pose & Calibration Preview */}
        <Card className="flex flex-col bg-zinc-900/60 border-zinc-800/80 shadow-md">
          <CardHeader className="py-2.5 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Compass className="h-4 w-4 text-emerald-400" />
              <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                Head Pose & Calibration (2D Gaze Pad)
              </CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-emerald-400">
              FSANet ONNX
            </Badge>
          </CardHeader>

          <CardContent className="p-3 flex-1 flex flex-col justify-between">
            <div className="relative w-full h-[120px] rounded-lg border border-zinc-800 bg-zinc-950/70 flex items-center justify-center overflow-hidden">
              <div className="absolute inset-x-0 h-[1px] bg-zinc-800" />
              <div className="absolute inset-y-0 w-[1px] bg-zinc-800" />

              <span className="absolute top-1 left-2 font-mono text-[9px] text-zinc-400">+15° Pitch</span>
              <span className="absolute bottom-1 left-2 font-mono text-[9px] text-zinc-400">-15° Pitch</span>
              <span className="absolute right-2 top-1 font-mono text-[9px] text-zinc-400">+25° Yaw</span>

              <div className="relative z-10 flex items-center justify-center">
                <div className="h-4 w-4 rounded-full border border-emerald-400 bg-emerald-500/20 flex items-center justify-center animate-pulse">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </div>
              </div>

              <div className="absolute left-[30%] top-[40%] flex items-center gap-1 opacity-70">
                <span className="h-2 w-2 rounded-full bg-blue-400" />
                <span className="font-mono text-[8px] text-blue-300">M1</span>
              </div>
              <div className="absolute right-[30%] top-[40%] flex items-center gap-1 opacity-70">
                <span className="h-2 w-2 rounded-full bg-blue-400" />
                <span className="font-mono text-[8px] text-blue-300">M2</span>
              </div>
              <div className="absolute left-[50%] top-[20%] flex items-center gap-1 opacity-70">
                <span className="h-2 w-2 rounded-full bg-amber-400" />
                <span className="font-mono text-[8px] text-amber-300">M3</span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between text-[11px] text-zinc-400 font-mono">
              <span>Yaw: +12.4° · Pitch: -2.1°</span>
              <span className="text-emerald-400">YuNet Conf: 0.94</span>
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
            {/* Auto-Yield Toggle (Phase 3 Core Safeguard) */}
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

            {/* Gaming & Fullscreen Auto-Pause */}
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

            {/* Battery Eco Mode */}
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

            {/* Cursor Teleport */}
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
          <span>v1.0.0-phase3</span>
          <span className="text-zinc-400">·</span>
          <span className="text-emerald-400/90 font-medium">100% Volatile RAM</span>
        </div>
      </footer>
    </div>
  );
}
