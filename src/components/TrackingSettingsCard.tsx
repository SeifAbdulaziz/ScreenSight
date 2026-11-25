import { useState, useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { AppConfig, CameraDeviceInfo } from "@/types/screensight";

interface TrackingSettingsCardProps {
  config: AppConfig;
  cameras: CameraDeviceInfo[];
  onPatchConfig: (patch: Partial<AppConfig>) => void;
}

const FPS_OPTIONS = [
  { value: "10", label: "10 FPS (Eco)" },
  { value: "15", label: "15 FPS (Default)" },
  { value: "24", label: "24 FPS (Smooth)" },
  { value: "30", label: "30 FPS (Responsive)" },
] as const;

export function TrackingSettingsCard({
  config,
  cameras,
  onPatchConfig,
}: TrackingSettingsCardProps) {
  // Local slider mirrors keep drags silky without writing settings.json 20x per second.
  const [draftMargin, setDraftMargin] = useState(config.switch_margin_deg);
  const [draftDwell, setDraftDwell] = useState(config.dwell_ms);

  useEffect(() => {
    setDraftMargin(config.switch_margin_deg);
  }, [config.switch_margin_deg]);

  useEffect(() => {
    setDraftDwell(config.dwell_ms);
  }, [config.dwell_ms]);

  const cameraOptions =
    cameras.length > 0
      ? cameras
      : [
          {
            index: config.camera_index,
            name: `Default Webcam (Index ${config.camera_index})`,
            description: "Media Foundation",
          },
        ];

  const hasCurrentCam = cameraOptions.some((c) => c.index === config.camera_index);
  const resolvedCameras = hasCurrentCam
    ? cameraOptions
    : [
        {
          index: config.camera_index,
          name: `Webcam (Index ${config.camera_index})`,
          description: "Saved index",
        },
        ...cameraOptions,
      ];

  const fpsValue = FPS_OPTIONS.some((o) => Number(o.value) === config.target_fps)
    ? String(config.target_fps)
    : "15";

  return (
    <Card className="flex flex-col h-full min-h-0 bg-zinc-900/60 border-zinc-800/80 shadow-md">
      <CardHeader className="py-2 px-3 border-b border-zinc-800/60 flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="size-4 text-emerald-400 shrink-0" />
          <CardTitle className="text-xs font-semibold text-zinc-100 uppercase tracking-wider truncate">
            Tracking Settings
          </CardTitle>
        </div>
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800/40 text-emerald-400 shrink-0"
        >
          {config.target_fps} FPS
        </Badge>
      </CardHeader>

      <CardContent className="p-2.5 flex-1 min-h-0 flex flex-col justify-between gap-2 text-xs">
        {/* Camera Source Select */}
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="camera-select" className="text-zinc-300 shrink-0">
            Camera
          </Label>
          <Select
            value={String(config.camera_index)}
            onValueChange={(val) => onPatchConfig({ camera_index: Number(val) })}
          >
            <SelectTrigger id="camera-select" className="h-7 w-[220px] text-[11px]">
              <SelectValue placeholder="Select webcam" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {resolvedCameras.map((cam) => (
                  <SelectItem key={cam.index} value={String(cam.index)}>
                    {cam.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {/* Target FPS Select */}
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="fps-select" className="text-zinc-300 shrink-0">
            Camera FPS
          </Label>
          <Select
            value={fpsValue}
            onValueChange={(val) => onPatchConfig({ target_fps: Number(val) })}
          >
            <SelectTrigger id="fps-select" className="h-7 w-[220px] text-[11px]">
              <SelectValue placeholder="Select FPS" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {FPS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {/* Switch Margin Slider (4 deg - 12 deg) */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="margin-slider" className="text-zinc-300">
              Switch Margin
            </Label>
            <span className="font-mono text-emerald-400 font-semibold text-[11px]">
              {draftMargin}°
            </span>
          </div>
          <Slider
            id="margin-slider"
            value={[draftMargin]}
            min={4}
            max={12}
            step={1}
            onValueChange={(val) => setDraftMargin(val[0])}
            onValueCommit={(val) =>
              onPatchConfig({ switch_margin_deg: val[0] })
            }
          />
          <div className="flex justify-between text-[10px] text-zinc-400 font-mono">
            <span>4° Sensitive</span>
            <span>12° Resistant</span>
          </div>
        </div>

        {/* Dwell Delay Slider (150ms - 600ms) */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="dwell-slider" className="text-zinc-300">
              Dwell Delay
            </Label>
            <span className="font-mono text-emerald-400 font-semibold text-[11px]">
              {draftDwell} ms
            </span>
          </div>
          <Slider
            id="dwell-slider"
            value={[draftDwell]}
            min={150}
            max={600}
            step={25}
            onValueChange={(val) => setDraftDwell(val[0])}
            onValueCommit={(val) => onPatchConfig({ dwell_ms: val[0] })}
          />
          <div className="flex justify-between text-[10px] text-zinc-400 font-mono">
            <span>150 ms Rapid</span>
            <span>600 ms Deliberate</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
