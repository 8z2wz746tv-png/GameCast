import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RtpContinuityRewriter } from "./rtp-continuity.js";

describe("native RTP continuity", () => {
  it("keeps sequence numbers and timestamps continuous after an encoder restart", () => {
    const rewriter = new RtpContinuityRewriter();
    const first = rewriter.rewrite(rtpPacket(50_000, 4_000_000), 60);
    const second = rewriter.rewrite(rtpPacket(50_001, 4_000_000), 60);
    assert.equal(first.readUInt16BE(2), 50_000);
    assert.equal(second.readUInt16BE(2), 50_001);

    rewriter.markDiscontinuity();
    const restarted = rewriter.rewrite(rtpPacket(120, 90_000), 60);
    const next = rewriter.rewrite(rtpPacket(121, 90_000), 60);
    assert.equal(restarted.readUInt16BE(2), 50_002);
    assert.equal(next.readUInt16BE(2), 50_003);
    assert.equal(restarted.readUInt32BE(4), 4_001_500);
    assert.equal(next.readUInt32BE(4), 4_001_500);
  });

  it("wraps sequence numbers without creating a gap", () => {
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(rtpPacket(65_535, 100), 60);
    rewriter.markDiscontinuity();
    const restarted = rewriter.rewrite(rtpPacket(900, 200), 60);
    assert.equal(restarted.readUInt16BE(2), 0);
    assert.equal(restarted.readUInt32BE(4), 1_600);
  });
});

function rtpPacket(sequence: number, timestamp: number): Buffer {
  const packet = Buffer.alloc(12);
  packet[0] = 0x80;
  packet[1] = 102;
  packet.writeUInt16BE(sequence, 2);
  packet.writeUInt32BE(timestamp, 4);
  return packet;
}
