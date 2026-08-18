import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
} from "werift";
import { NativeRtpFanout } from "./native-rtp-fanout.js";

const PAYLOAD_TYPE = 102;

describe("native RTP WebRTC integration", () => {
  it("sustains direct track delivery without an application pacing queue", async () => {
    const sender = createPeer();
    const receiver = createPeer();
    const source = new MediaStreamTrack({ kind: "video" });
    const stream = new MediaStream({ id: "native-rtp-test" });
    stream.addTrack(source);
    sender.addTrack(source, stream);

    let received = 0;
    receiver.onTrack.subscribe((track) => {
      if (track.kind !== "video") return;
      track.onReceiveRtp.subscribe(() => { received += 1; });
    });
    sender.onIceCandidate.subscribe((candidate) => {
      void receiver.addIceCandidate(candidate ?? null);
    });
    receiver.onIceCandidate.subscribe((candidate) => {
      void sender.addIceCandidate(candidate ?? null);
    });

    try {
      const offer = await sender.createOffer();
      await sender.setLocalDescription(offer);
      await receiver.setRemoteDescription(offer);
      const answer = await receiver.createAnswer();
      await receiver.setLocalDescription(answer);
      await sender.setRemoteDescription(answer);
      await waitUntil(
        () => sender.connectionState === "connected" && receiver.connectionState === "connected",
        5_000,
      );

      const fanout = new NativeRtpFanout();
      fanout.add("receiver", (packet) => source.writeRtp(packet));
      let sequenceNumber = 0;
      let timestamp = 0;
      const frames = 180;
      const packetsPerFrame = 16;
      for (let frame = 0; frame < frames; frame += 1) {
        for (let packetIndex = 0; packetIndex < packetsPerFrame; packetIndex += 1) {
          fanout.write(createRtpPacket({
            sequenceNumber,
            timestamp,
            marker: packetIndex === packetsPerFrame - 1,
          }));
          sequenceNumber = (sequenceNumber + 1) & 0xffff;
        }
        timestamp = (timestamp + 1_500) >>> 0;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }

      const expectedPackets = frames * packetsPerFrame;
      await waitUntil(() => received >= expectedPackets * 0.95, 3_000);
      assert.ok(received >= expectedPackets * 0.95, `${received}/${expectedPackets} RTP packets received`);
    } finally {
      source.stop();
      await Promise.all([
        sender.close().catch(() => undefined),
        receiver.close().catch(() => undefined),
      ]);
    }
  });
});

function createPeer(): RTCPeerConnection {
  return new RTCPeerConnection({
    codecs: {
      video: [useH264({
        payloadType: PAYLOAD_TYPE,
        parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033",
      })],
      audio: [],
    },
    iceInterfaceAddresses: { udp4: "127.0.0.1" },
    iceAdditionalHostAddresses: ["127.0.0.1"],
    iceUseIpv4: true,
    iceUseIpv6: false,
  });
}

function createRtpPacket(input: {
  sequenceNumber: number;
  timestamp: number;
  marker: boolean;
}): Buffer {
  const packet = Buffer.alloc(12 + 1_100, 0x55);
  packet[0] = 0x80;
  packet[1] = (input.marker ? 0x80 : 0) | PAYLOAD_TYPE;
  packet.writeUInt16BE(input.sequenceNumber, 2);
  packet.writeUInt32BE(input.timestamp, 4);
  packet.writeUInt32BE(0x10203040, 8);
  packet[12] = 0x61;
  return packet;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for WebRTC media");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
