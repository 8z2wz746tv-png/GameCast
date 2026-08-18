import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InboundMediaStallDetector } from "./inbound-stall-detector";

describe("InboundMediaStallDetector", () => {
  it("reports a stream that stops making RTP and decode progress", () => {
    const detector = new InboundMediaStallDetector(10_000);
    assert.equal(detector.observe({ bytesReceived: 1_000, framesDecoded: 10, sampledAt: 0 }).stalled, false);
    assert.equal(detector.observe({ bytesReceived: 2_000, framesDecoded: 20, sampledAt: 4_000 }).stalled, false);
    assert.equal(detector.observe({ bytesReceived: 2_000, framesDecoded: 20, sampledAt: 13_999 }).stalled, false);
    const result = detector.observe({ bytesReceived: 2_000, framesDecoded: 20, sampledAt: 14_000 });
    assert.equal(result.stalled, true);
    assert.equal(result.stalledForMs, 10_000);
  });

  it("resets the timer when either packets or decoded frames advance", () => {
    const detector = new InboundMediaStallDetector(10_000);
    detector.observe({ bytesReceived: 1_000, framesDecoded: 10, sampledAt: 0 });
    detector.observe({ bytesReceived: 1_000, framesDecoded: 11, sampledAt: 9_000 });
    assert.equal(detector.observe({ bytesReceived: 1_000, framesDecoded: 11, sampledAt: 18_999 }).stalled, false);
  });

  it("treats reset counters as a new media source", () => {
    const detector = new InboundMediaStallDetector(10_000);
    detector.observe({ bytesReceived: 10_000, framesDecoded: 100, sampledAt: 0 });
    detector.observe({ bytesReceived: 10_000, framesDecoded: 100, sampledAt: 10_000 });
    const result = detector.observe({ bytesReceived: 100, framesDecoded: 1, sampledAt: 12_000 });
    assert.equal(result.stalled, false);
    assert.equal(result.stalledForMs, 0);
  });
});
