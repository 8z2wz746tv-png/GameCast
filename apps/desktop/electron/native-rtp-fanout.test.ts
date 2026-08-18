import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeRtpFanout, isNativeRtpStalled } from "./native-rtp-fanout.js";

describe("native RTP direct fanout", () => {
  it("forwards a sustained 1080p60-style packet stream without a timer queue", () => {
    const fanout = new NativeRtpFanout();
    let firstPackets = 0;
    let secondPackets = 0;
    fanout.add("first", () => { firstPackets += 1; });
    fanout.add("second", () => { secondPackets += 1; });

    const packet = Buffer.alloc(1_200);
    const packetCount = 60 * 120 * 16;
    for (let index = 0; index < packetCount; index += 1) fanout.write(packet);

    assert.equal(firstPackets, packetCount);
    assert.equal(secondPackets, packetCount);
    assert.deepEqual(fanout.stats("first"), {
      forwardedPackets: packetCount,
      forwardedBytes: packetCount * packet.byteLength,
      failedPackets: 0,
    });
  });

  it("isolates a failed viewer without interrupting the other viewers", () => {
    const errors: string[] = [];
    const fanout = new NativeRtpFanout((id) => errors.push(id));
    let delivered = 0;
    fanout.add("failed", () => { throw new Error("closed"); });
    fanout.add("healthy", () => { delivered += 1; });

    fanout.write(Buffer.alloc(1_200));

    assert.equal(delivered, 1);
    assert.deepEqual(errors, ["failed"]);
    assert.equal(fanout.stats("failed")?.failedPackets, 1);
  });

  it("only declares a source stall while a viewer is present", () => {
    assert.equal(isNativeRtpStalled({
      now: 5_500,
      lastRtpAt: 1_000,
      peerCount: 1,
      thresholdMs: 4_000,
    }), true);
    assert.equal(isNativeRtpStalled({
      now: 5_500,
      lastRtpAt: 1_000,
      peerCount: 0,
      thresholdMs: 4_000,
    }), false);
    assert.equal(isNativeRtpStalled({
      now: 4_999,
      lastRtpAt: 1_000,
      peerCount: 1,
      thresholdMs: 4_000,
    }), false);
  });
});
