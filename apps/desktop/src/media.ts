import type { VideoPreset } from "@gamecast/contracts";

export const VIDEO_PRESETS: VideoPreset[] = [
  { name: "480p", label: "480p", width: 854, height: 480, frameRate: 60 },
  { name: "720p", label: "720p", width: 1280, height: 720, frameRate: 60 },
  { name: "1080p", label: "1080p", width: 1920, height: 1080, frameRate: 60 },
  { name: "1440p", label: "2K", width: 2560, height: 1440, frameRate: 60 },
];
