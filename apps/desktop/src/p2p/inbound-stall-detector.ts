export type InboundMediaSample = {
  bytesReceived: number;
  framesDecoded: number;
  sampledAt: number;
};

export type InboundMediaHealth = {
  stalled: boolean;
  stalledForMs: number;
};

export class InboundMediaStallDetector {
  private lastBytesReceived: number | undefined;
  private lastFramesDecoded: number | undefined;
  private lastProgressAt: number | undefined;

  constructor(private readonly stallThresholdMs = 10_000) {}

  observe(sample: InboundMediaSample): InboundMediaHealth {
    const firstSample = this.lastProgressAt === undefined;
    const countersReset =
      (this.lastBytesReceived !== undefined && sample.bytesReceived < this.lastBytesReceived) ||
      (this.lastFramesDecoded !== undefined && sample.framesDecoded < this.lastFramesDecoded);
    const progressed =
      (this.lastBytesReceived !== undefined && sample.bytesReceived > this.lastBytesReceived) ||
      (this.lastFramesDecoded !== undefined && sample.framesDecoded > this.lastFramesDecoded);

    if (firstSample || countersReset || progressed) this.lastProgressAt = sample.sampledAt;
    this.lastBytesReceived = sample.bytesReceived;
    this.lastFramesDecoded = sample.framesDecoded;

    const stalledForMs = Math.max(0, sample.sampledAt - (this.lastProgressAt ?? sample.sampledAt));
    return {
      stalled: stalledForMs >= this.stallThresholdMs,
      stalledForMs,
    };
  }
}
