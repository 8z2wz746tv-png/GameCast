import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoPreset } from "@gamecast/contracts";
import {
  describeDisplayCaptureFailure,
  isSystemAudioCaptureFailure,
  shouldUseNativeScreenCapture,
} from "./display-capture-error";

const preset: VideoPreset = {
  name: "1080p",
  label: "1080p",
  width: 1920,
  height: 1080,
  frameRate: 60,
};

describe("display capture errors", () => {
  it("routes only Electron whole-screen sources through native capture", () => {
    assert.equal(shouldUseNativeScreenCapture("screen:4:0", true), true);
    assert.equal(shouldUseNativeScreenCapture("window:1441976:0", true), false);
    assert.equal(shouldUseNativeScreenCapture("screen:4:0", false), false);
  });

  it("recognizes Electron loopback audio startup failures", () => {
    assert.equal(isSystemAudioCaptureFailure(new Error("Could not start audio source")), true);
    assert.equal(isSystemAudioCaptureFailure(new Error("Could not start video source")), false);
  });

  it("does not report permission errors as unsupported quality", () => {
    const error = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    assert.equal(
      describeDisplayCaptureFailure(error, "screen", preset),
      "已取消屏幕共享，或系统没有授予捕获权限",
    );
  });

  it("reserves the quality message for constraint failures", () => {
    const error = Object.assign(new Error("Constraints could not be satisfied"), {
      name: "OverconstrainedError",
    });
    assert.equal(
      describeDisplayCaptureFailure(error, "window", preset),
      "1080p 60fps 在所选窗口上不可用",
    );
  });
});
