const UINT16_RANGE = 0x1_0000;
const UINT32_RANGE = 0x1_0000_0000;

export class RtpContinuityRewriter {
  private sequenceOffset = 0;
  private timestampOffset = 0;
  private lastSequence: number | undefined;
  private lastTimestamp: number | undefined;
  private discontinuityPending = false;

  markDiscontinuity(): void {
    if (this.lastSequence !== undefined) this.discontinuityPending = true;
  }

  rewrite(packet: Buffer, frameRate: number): Buffer {
    if (packet.length < 12 || packet[0]! >> 6 !== 2) return packet;

    const sourceSequence = packet.readUInt16BE(2);
    const sourceTimestamp = packet.readUInt32BE(4);
    if (
      this.discontinuityPending &&
      this.lastSequence !== undefined &&
      this.lastTimestamp !== undefined
    ) {
      const timestampStep = Math.max(1, Math.round(90_000 / Math.max(1, frameRate)));
      this.sequenceOffset = wrap(this.lastSequence + 1 - sourceSequence, UINT16_RANGE);
      this.timestampOffset = wrap(
        this.lastTimestamp + timestampStep - sourceTimestamp,
        UINT32_RANGE,
      );
      this.discontinuityPending = false;
    }

    const sequence = wrap(sourceSequence + this.sequenceOffset, UINT16_RANGE);
    const timestamp = wrap(sourceTimestamp + this.timestampOffset, UINT32_RANGE);
    packet.writeUInt16BE(sequence, 2);
    packet.writeUInt32BE(timestamp, 4);
    this.lastSequence = sequence;
    this.lastTimestamp = timestamp;
    return packet;
  }

  reset(): void {
    this.sequenceOffset = 0;
    this.timestampOffset = 0;
    this.lastSequence = undefined;
    this.lastTimestamp = undefined;
    this.discontinuityPending = false;
  }
}

function wrap(value: number, range: number): number {
  return ((value % range) + range) % range;
}
