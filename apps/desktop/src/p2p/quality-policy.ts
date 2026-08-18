import type { VideoPreset, VideoPresetName } from "@gamecast/contracts";
import { VIDEO_PRESETS } from "../media";

const BITRATE_BY_PRESET: Record<VideoPresetName, number> = {
  "480p": 2_500_000,
  "720p": 7_000_000,
  "1080p": 12_000_000,
  "1440p": 20_000_000,
};

export type EffectiveQualityPolicy = {
  preset: VideoPreset;
  maxBitrate: number;
};

export type CaptureSettingsLike = {
  width?: number;
  height?: number;
  frameRate?: number;
};

export function isCaptureTargetMet(
  settings: CaptureSettingsLike,
  preset: VideoPreset,
): boolean {
  return (
    (settings.width ?? 0) >= preset.width &&
    (settings.height ?? 0) >= preset.height &&
    (settings.frameRate ?? 0) + 0.5 >= preset.frameRate
  );
}

export function getEffectiveQualityPolicy(
  requested: VideoPreset,
  viewerCount: number,
): EffectiveQualityPolicy {
  const capName: VideoPresetName = viewerCount >= 4 ? "720p" : requested.name;
  const capPreset = VIDEO_PRESETS.find((preset) => preset.name === capName) ?? requested;
  const requestedPixels = requested.width * requested.height;
  const capPixels = capPreset.width * capPreset.height;
  const preset = requestedPixels <= capPixels ? requested : capPreset;
  const audienceBitrate =
    viewerCount >= 6
      ? 2_500_000
      : viewerCount >= 4
        ? 3_500_000
        : viewerCount >= 3
          ? 6_000_000
          : viewerCount >= 2
            ? 8_000_000
            : Infinity;
  return {
    preset,
    maxBitrate: Math.min(BITRATE_BY_PRESET[preset.name], audienceBitrate),
  };
}

export function isIceCandidateAllowed(
  candidate: RTCIceCandidate,
  allowedHostAddresses: string[],
): boolean {
  if (candidate.type !== "host") return true;
  if (allowedHostAddresses.length === 0) return true;
  const address = candidate.address || extractCandidateAddress(candidate.candidate);
  return allowedHostAddresses.includes(address);
}

function extractCandidateAddress(candidate: string): string {
  return candidate.trim().split(/\s+/)[4] ?? "";
}
