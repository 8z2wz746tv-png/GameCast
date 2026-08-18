export type NativeRtpFanoutStats = {
  forwardedPackets: number;
  forwardedBytes: number;
  failedPackets: number;
};

type NativeRtpSink = (packet: Buffer) => void;

type SinkRecord = {
  write: NativeRtpSink;
  forwardedPackets: number;
  forwardedBytes: number;
  failedPackets: number;
};

export class NativeRtpFanout {
  private readonly sinks = new Map<string, SinkRecord>();

  constructor(
    private readonly onError?: (id: string, error: unknown) => void,
  ) {}

  add(id: string, write: NativeRtpSink): void {
    this.sinks.set(id, {
      write,
      forwardedPackets: 0,
      forwardedBytes: 0,
      failedPackets: 0,
    });
  }

  remove(id: string): void {
    this.sinks.delete(id);
  }

  clear(): void {
    this.sinks.clear();
  }

  write(packet: Buffer): void {
    for (const [id, sink] of this.sinks) {
      try {
        // FFmpeg's real-time capture already provides media pacing. Werift's
        // track API hands the RTP packet directly to its WebRTC sender.
        sink.write(packet);
        sink.forwardedPackets += 1;
        sink.forwardedBytes += packet.byteLength;
      } catch (error) {
        sink.failedPackets += 1;
        this.onError?.(id, error);
      }
    }
  }

  stats(id: string): NativeRtpFanoutStats | undefined {
    const sink = this.sinks.get(id);
    return sink
      ? {
          forwardedPackets: sink.forwardedPackets,
          forwardedBytes: sink.forwardedBytes,
          failedPackets: sink.failedPackets,
        }
      : undefined;
  }

  snapshot(): NativeRtpFanoutStats[] {
    return [...this.sinks.keys()]
      .map((id) => this.stats(id))
      .filter((stats): stats is NativeRtpFanoutStats => Boolean(stats));
  }
}

export function isNativeRtpStalled(input: {
  now: number;
  lastRtpAt: number;
  peerCount: number;
  thresholdMs: number;
}): boolean {
  return input.peerCount > 0
    && input.lastRtpAt > 0
    && input.now - input.lastRtpAt >= input.thresholdMs;
}
