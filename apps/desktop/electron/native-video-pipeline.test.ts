import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoPreset } from "@gamecast/contracts";
import {
  buildEncoderAttempts,
  buildFfmpegArgs,
  detectNativeMediaCapabilities,
  type EncoderDefinition,
} from "./native-video-pipeline.js";

const preset: VideoPreset = {
  name: "1080p",
  label: "1080p",
  width: 1920,
  height: 1080,
  frameRate: 60,
};
const nvenc: EncoderDefinition = { name: "h264_nvenc", label: "NVIDIA NVENC" };
const qsv: EncoderDefinition = { name: "h264_qsv", label: "Intel Quick Sync" };

describe("native video pipeline", () => {
  it("prefers Windows Graphics Capture and GPU attempts when available", () => {
    const capabilities = detectNativeMediaCapabilities(
      "ddagrab gfxcapture",
      "h264_nvenc h264_qsv h264_mf",
    );
    assert.equal(capabilities.captureBackend, "gfxcapture");
    assert.deepEqual(
      buildEncoderAttempts(capabilities).map(({ encoder, pipeline }) =>
        `${encoder.name}:${pipeline}`
      ),
      [
        "h264_nvenc:gpu",
        "h264_qsv:gpu",
        "h264_nvenc:compatibility",
        "h264_qsv:compatibility",
        "h264_mf:compatibility",
      ],
    );
  });

  it("keeps D3D11 frames on the GPU for NVENC", () => {
    const args = buildFfmpegArgs(
      { preset, maxBitrate: 12_000_000 },
      1,
      nvenc,
      5004,
      "gfxcapture",
      "gpu",
    );
    const text = args.join(" ");
    assert.match(text, /gfxcapture=monitor_idx=1/);
    assert.match(text, /width=1920:height=1080:resize_mode=scale_aspect/);
    assert.doesNotMatch(text, /hwdownload|scale=1920:1080/);
  });

  it("maps fixed D3D11 frames to Quick Sync before encoding", () => {
    const text = buildFfmpegArgs(
      { preset, maxBitrate: 12_000_000 },
      0,
      qsv,
      5004,
      "gfxcapture",
      "gpu",
    ).join(" ");
    assert.match(text, /hwmap=derive_device=qsv/);
    assert.doesNotMatch(text, /hwdownload/);
  });

  it("retains a bounded compatibility path for older FFmpeg builds", () => {
    const text = buildFfmpegArgs(
      { preset, maxBitrate: 12_000_000 },
      0,
      nvenc,
      5004,
      "ddagrab",
      "compatibility",
    ).join(" ");
    assert.match(text, /ddagrab=output_idx=0/);
    assert.match(text, /hwdownload,format=bgra,scale=1920:1080/);
    assert.match(text, /-g 120 -keyint_min 120 -force_key_frames expr:gte\(t,n_forced\*2\)/);
  });

  it("accepts a WGC-only FFmpeg build", () => {
    const capabilities = detectNativeMediaCapabilities(
      "gfxcapture",
      "h264_nvenc",
    );
    assert.equal(capabilities.captureBackend, "gfxcapture");
  });

  it("uses Intel VPP before cross-GPU compatibility encoding on older builds", () => {
    const capabilities = detectNativeMediaCapabilities(
      "ddagrab",
      "h264_nvenc h264_qsv h264_mf",
    );
    assert.equal(buildEncoderAttempts(capabilities)[0]?.encoder.name, "h264_qsv");
    assert.equal(buildEncoderAttempts(capabilities)[0]?.pipeline, "gpu");
    assert.equal(buildEncoderAttempts(capabilities)[1]?.encoder.name, "h264_nvenc");
    assert.equal(buildEncoderAttempts(capabilities)[1]?.pipeline, "compatibility");
    const text = buildFfmpegArgs(
      { preset, maxBitrate: 12_000_000 },
      0,
      qsv,
      5004,
      "ddagrab",
      "gpu",
    ).join(" ");
    assert.match(text, /-init_hw_device qsv=qsv:hw -filter_hw_device qsv/);
    assert.match(text, /hwupload=extra_hw_frames=64,scale_qsv=w=1920:h=1080:format=nv12/);
  });
});
