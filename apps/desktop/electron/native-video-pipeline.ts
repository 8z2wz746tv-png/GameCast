import type { VideoPreset } from "@gamecast/contracts";

export type NativeCaptureBackend = "gfxcapture" | "ddagrab";
export type NativeMediaPipeline = "gpu" | "compatibility";
export type EncoderName = "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf";

export type EncoderDefinition = {
  name: EncoderName;
  label: string;
};

export type NativeMediaCapabilities = {
  captureBackend: NativeCaptureBackend;
  encoders: EncoderDefinition[];
};

export type EncoderAttempt = {
  encoder: EncoderDefinition;
  pipeline: NativeMediaPipeline;
};

type NativeVideoRequest = {
  preset: VideoPreset;
  maxBitrate: number;
};

const H264_PAYLOAD_TYPE = 102;

const ENCODERS: EncoderDefinition[] = [
  { name: "h264_nvenc", label: "NVIDIA NVENC" },
  { name: "h264_qsv", label: "Intel Quick Sync" },
  { name: "h264_amf", label: "AMD AMF" },
  { name: "h264_mf", label: "Windows Media Foundation" },
];

export function detectNativeMediaCapabilities(
  filters: string,
  encoders: string,
): NativeMediaCapabilities {
  const hasDdagrab = /\bddagrab\b/i.test(filters);
  const hasGfxcapture = /\bgfxcapture\b/i.test(filters);
  if (!hasDdagrab && !hasGfxcapture) {
    throw new Error("当前 FFmpeg 运行库不支持 Windows 屏幕采集");
  }
  return {
    captureBackend: hasGfxcapture ? "gfxcapture" : "ddagrab",
    encoders: ENCODERS.filter((encoder) =>
      new RegExp(`\\b${encoder.name}\\b`).test(encoders)
    ),
  };
}

export function buildEncoderAttempts(
  capabilities: NativeMediaCapabilities,
): EncoderAttempt[] {
  if (capabilities.captureBackend === "ddagrab") {
    const qsv = capabilities.encoders
      .filter((encoder) => encoder.name === "h264_qsv")
      .map((encoder) => ({ encoder, pipeline: "gpu" as const }));
    const compatibility = capabilities.encoders
      .map((encoder) => ({ encoder, pipeline: "compatibility" as const }));
    // On hybrid laptops the display output commonly belongs to Intel while
    // the discrete NVIDIA adapter is only an encode device. Try QSV's VPP
    // path first to avoid a full-frame cross-adapter copy; NVENC remains the
    // next fallback for NVIDIA-only systems.
    return [...qsv, ...compatibility];
  }
  const gpu = capabilities.encoders
    .filter((encoder) => encoder.name !== "h264_mf")
    .map((encoder) => ({ encoder, pipeline: "gpu" as const }));
  const compatibility = capabilities.encoders
    .map((encoder) => ({ encoder, pipeline: "compatibility" as const }));
  return [...gpu, ...compatibility];
}

export function buildFfmpegArgs(
  request: NativeVideoRequest,
  outputIndex: number,
  encoder: EncoderDefinition,
  port: number,
  captureBackend: NativeCaptureBackend = "ddagrab",
  pipeline: NativeMediaPipeline = "compatibility",
): string[] {
  const bitrate = Math.max(1_000_000, request.maxBitrate);
  const bitrateText = `${Math.round(bitrate / 1000)}k`;
  const bufferText = `${Math.round(bitrate / 2000)}k`;
  const captureSource = captureBackend === "gfxcapture"
    ? [
        `monitor_idx=${outputIndex}`,
        `max_framerate=${request.preset.frameRate}`,
        `width=${request.preset.width}`,
        `height=${request.preset.height}`,
        "resize_mode=scale_aspect",
        "scale_mode=bilinear",
        "capture_cursor=1",
        "output_fmt=8bit",
      ].join(":")
    : [
        `output_idx=${outputIndex}`,
        `framerate=${request.preset.frameRate}`,
        "draw_mouse=1",
      ].join(":");
  const filter = (() => {
    if (captureBackend === "ddagrab") {
      if (pipeline === "gpu" && encoder.name === "h264_qsv") {
        return [
          "hwdownload",
          "format=bgra",
          "hwupload=extra_hw_frames=64",
          `scale_qsv=w=${request.preset.width}:h=${request.preset.height}:format=nv12`,
        ];
      }
      return [
        "hwdownload",
        "format=bgra",
        `scale=${request.preset.width}:${request.preset.height}:flags=fast_bilinear`,
      ];
    }
    if (pipeline === "compatibility") {
      return [`fps=${request.preset.frameRate}`, "hwdownload", "format=bgra"];
    }
    if (encoder.name === "h264_qsv") {
      return [`fps=${request.preset.frameRate}`, "hwmap=derive_device=qsv"];
    }
    return [`fps=${request.preset.frameRate}`];
  })();
  const deviceArgs = captureBackend === "ddagrab" &&
      pipeline === "gpu" &&
      encoder.name === "h264_qsv"
    ? ["-init_hw_device", "qsv=qsv:hw", "-filter_hw_device", "qsv"]
    : [];
  const common = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-stats_period",
    "1",
    "-progress",
    "pipe:2",
    ...deviceArgs,
    "-f",
    "lavfi",
    "-i",
    `${captureBackend}=${captureSource}`,
    "-vf",
    filter.join(","),
    "-an",
    "-c:v",
    encoder.name,
  ];
  const encoderArgs = (() => {
    switch (encoder.name) {
      case "h264_nvenc":
        return [
          "-preset", "p1", "-tune", "ull", "-rc", "cbr", "-profile:v", "baseline",
          "-level", "5.1", "-bf", "0", "-zerolatency", "1", "-forced-idr", "1",
        ];
      case "h264_qsv":
        return [
          "-preset", "veryfast", "-low_power", "1", "-look_ahead", "0", "-async_depth", "2",
          "-profile:v", "baseline", "-level", "5.1", "-bf", "0",
        ];
      case "h264_amf":
        return ["-usage", "ultralowlatency", "-quality", "speed", "-rc", "cbr", "-bf", "0"];
      case "h264_mf":
        return ["-rate_control", "cbr", "-scenario", "video_conference"];
    }
  })();
  return [
    ...common,
    ...encoderArgs,
    "-b:v", bitrateText,
    "-maxrate", bitrateText,
    "-bufsize", bufferText,
    // A two-second GOP is the normal WebRTC live-video trade-off. It avoids
    // spending a full encode refresh every second while still letting a new
    // viewer lock on quickly; the fanout sends an existing keyframe stream.
    "-g", String(Math.max(1, Math.round(request.preset.frameRate * 2))),
    "-keyint_min", String(Math.max(1, Math.round(request.preset.frameRate * 2))),
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-bsf:v", "dump_extra=freq=keyframe",
    "-f", "rtp",
    "-payload_type", String(H264_PAYLOAD_TYPE),
    `rtp://127.0.0.1:${port}?pkt_size=1200`,
  ];
}
