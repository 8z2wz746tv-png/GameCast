import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VIDEO_PRESETS } from "../media";
import {
  getEffectiveQualityPolicy,
  isCaptureTargetMet,
  isIceCandidateAllowed,
} from "./quality-policy";

const preset = (name: string) => VIDEO_PRESETS.find((candidate) => candidate.name === name)!;

describe("P2P quality policy", () => {
  it("raises the single-viewer ceiling and protects a three-viewer uplink", () => {
    const single = getEffectiveQualityPolicy(preset("1080p"), 1);
    assert.equal(single.preset.name, "1080p");
    assert.equal(single.maxBitrate, 12_000_000);
    const two = getEffectiveQualityPolicy(preset("1080p"), 2);
    assert.equal(two.maxBitrate, 8_000_000);
    const three = getEffectiveQualityPolicy(preset("1080p"), 3);
    assert.equal(three.preset.name, "1080p");
    assert.equal(three.maxBitrate, 6_000_000);
  });

  it("caps four viewers at 720p60 and six viewers at 2.5 Mbps", () => {
    const four = getEffectiveQualityPolicy(preset("1440p"), 4);
    assert.equal(four.preset.name, "720p");
    assert.equal(four.maxBitrate, 3_500_000);
    const six = getEffectiveQualityPolicy(preset("1080p"), 6);
    assert.equal(six.preset.name, "720p");
    assert.equal(six.maxBitrate, 2_500_000);
  });

  it("does not upscale a lower user-selected ceiling", () => {
    const policy = getEffectiveQualityPolicy(preset("480p"), 7);
    assert.equal(policy.preset.name, "480p");
    assert.equal(policy.maxBitrate, 2_500_000);
  });

  it("requires the selected capture resolution and frame rate", () => {
    assert.equal(
      isCaptureTargetMet({ width: 1920, height: 1080, frameRate: 59.94 }, preset("1080p")),
      true,
    );
    assert.equal(
      isCaptureTargetMet({ width: 1280, height: 720, frameRate: 60 }, preset("1080p")),
      false,
    );
    assert.equal(
      isCaptureTargetMet({ width: 1920, height: 1080, frameRate: 30 }, preset("1080p")),
      false,
    );
  });

  it("only exposes selected virtual host candidates", () => {
    const candidate = {
      type: "host",
      address: "100.64.0.5",
      candidate: "candidate:1 1 udp 1 100.64.0.5 50000 typ host",
    } as RTCIceCandidate;
    assert.equal(isIceCandidateAllowed(candidate, ["100.64.0.5"]), true);
    assert.equal(isIceCandidateAllowed(candidate, ["10.0.0.2"]), false);
    assert.equal(
      isIceCandidateAllowed({ ...candidate, type: "relay" } as RTCIceCandidate, ["10.0.0.2"]),
      true,
    );
  });
});
