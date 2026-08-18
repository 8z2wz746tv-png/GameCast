import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
} from "werift";

const baseUrl = process.env.GAMECAST_PUBLIC_URL
  ?? "https://sunsetshimmer.mindtype.cn/gamecast";
const payloadType = 102;
const testSeconds = Number(process.env.GAMECAST_MEDIA_SMOKE_SECONDS ?? 12);
const packetsPerFrame = 8;
const appHeartbeatEnabled = process.env.GAMECAST_DISABLE_APP_HEARTBEAT !== "1";
const signalOrigin = process.env.GAMECAST_SIGNAL_ORIGIN ?? "null";

const resources = {
  sessions: [],
  signals: [],
  peers: [],
  tracks: [],
};

async function runSmokeTest() {
try {
  const hostSession = await createRoom();
  resources.sessions.push(hostSession);
  const viewerSession = await joinRoom(hostSession.room.code);
  resources.sessions.push(viewerSession);

  const hostSignal = await SignalClient.connect(hostSession);
  const viewerSignal = await SignalClient.connect(viewerSession);
  resources.signals.push(hostSignal, viewerSignal);

  hostSignal.send({ type: "share.start", preset: "1080p", hasSystemAudio: false });
  await viewerSignal.waitFor("share.updated");

  const connectionId = randomUUID();
  viewerSignal.send({
    type: "watch.request",
    connectionId,
    targetParticipantId: hostSession.participant.id,
  });
  const pending = await viewerSignal.waitFor("watch.pending");
  assert.equal(pending.transport, "p2p");
  assert.equal((await hostSignal.waitFor("watch.requested")).connectionId, connectionId);

  const sender = createPeer(hostSession.p2p.iceServers);
  // Werift waits for every TURN server before completing an answer, unlike
  // Chromium's trickle ICE implementation used by the real viewer.
  const receiver = createPeer(viewerSession.p2p.iceServers.filter((server) =>
    server.urls.every((url) => !url.startsWith("turn:") && !url.startsWith("turns:")),
  ));
  resources.peers.push(sender, receiver);
  const source = new MediaStreamTrack({ kind: "video" });
  resources.tracks.push(source);
  const stream = new MediaStream({ id: `gamecast-public-smoke-${connectionId}` });
  stream.addTrack(source);
  sender.addTrack(source, stream);

  let receivedPackets = 0;
  const senderCandidateTypes = new Set();
  const receiverCandidateTypes = new Set();
  sender.onIceCandidate.subscribe((candidate) => {
    recordCandidateType(senderCandidateTypes, candidate);
    hostSignal.send({
      type: "rtc.ice",
      connectionId,
      targetParticipantId: viewerSession.participant.id,
      candidate: candidate?.toJSON() ?? null,
    });
  });
  receiver.onIceCandidate.subscribe((candidate) => {
    recordCandidateType(receiverCandidateTypes, candidate);
    viewerSignal.send({
      type: "rtc.ice",
      connectionId,
      targetParticipantId: hostSession.participant.id,
      candidate: candidate?.toJSON() ?? null,
    });
  });
  hostSignal.on("rtc.ice", (message) => {
    void sender.addIceCandidate(message.candidate);
  });
  viewerSignal.on("rtc.ice", (message) => {
    void receiver.addIceCandidate(message.candidate);
  });
  receiver.onTrack.subscribe((track) => {
    if (track.kind !== "video") return;
    track.onReceiveRtp.subscribe(() => {
      receivedPackets += 1;
    });
  });

  const offer = await sender.createOffer();
  const senderLocalDescription = sender.setLocalDescription(offer);
  await waitForLocalDescription(sender, senderLocalDescription, 1_000);
  const senderDescription = sender.localDescription;
  assert.ok(senderDescription, "sender did not create a local description");
  hostSignal.send({
    type: "rtc.offer",
    connectionId,
    targetParticipantId: viewerSession.participant.id,
    description: { type: "offer", sdp: senderDescription.sdp },
  });

  const forwardedOffer = await viewerSignal.waitFor("rtc.offer", 10_000);
  await receiver.setRemoteDescription(forwardedOffer.description);
  const answer = await receiver.createAnswer();
  const receiverLocalDescription = receiver.setLocalDescription(answer);
  await waitForLocalDescription(receiver, receiverLocalDescription, 1_000);
  const receiverDescription = receiver.localDescription;
  assert.ok(receiverDescription, "receiver did not create a local description");
  viewerSignal.send({
    type: "rtc.answer",
    connectionId,
    targetParticipantId: hostSession.participant.id,
    description: { type: "answer", sdp: receiverDescription.sdp },
  });

  const forwardedAnswer = await hostSignal.waitFor("rtc.answer", 10_000);
  await sender.setRemoteDescription(forwardedAnswer.description);
  await waitUntil(
    () => sender.connectionState === "connected" && receiver.connectionState === "connected",
    15_000,
    "P2P connection",
  );

  let sequenceNumber = 0;
  let timestamp = 0;
  let sentPackets = 0;
  for (let packetIndex = 0; packetIndex < packetsPerFrame; packetIndex += 1) {
    source.writeRtp(createRtpPacket({
      sequenceNumber,
      timestamp,
      marker: packetIndex === packetsPerFrame - 1,
    }));
    sequenceNumber = (sequenceNumber + 1) & 0xffff;
    sentPackets += 1;
  }
  timestamp = (timestamp + 1_500) >>> 0;
  await waitUntil(() => receivedPackets >= sentPackets, 3_000, "first RTP frame");
  viewerSignal.send({ type: "watch.commit", connectionId, transport: "p2p" });
  const [viewerCommit, hostCommit] = await Promise.all([
    viewerSignal.waitFor("watch.committed"),
    hostSignal.waitFor("watch.committed"),
  ]);
  assert.equal(viewerCommit.connectionId, connectionId);
  assert.equal(hostCommit.connectionId, connectionId);

  const totalFrames = Math.round(testSeconds * 60);
  const startedAt = performance.now();
  for (let frame = 0; frame < totalFrames; frame += 1) {
    for (let packetIndex = 0; packetIndex < packetsPerFrame; packetIndex += 1) {
      source.writeRtp(createRtpPacket({
        sequenceNumber,
        timestamp,
        marker: packetIndex === packetsPerFrame - 1,
      }));
      sequenceNumber = (sequenceNumber + 1) & 0xffff;
      sentPackets += 1;
    }
    timestamp = (timestamp + 1_500) >>> 0;
    const nextFrameAt = startedAt + ((frame + 1) * 1_000) / 60;
    await delay(Math.max(0, nextFrameAt - performance.now()));
  }

  await waitUntil(
    () => receivedPackets >= sentPackets * 0.9,
    5_000,
    "sustained RTP delivery",
  );

  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  console.log(JSON.stringify({
    roomCreated: true,
    viewerJoined: true,
    websocketAuthenticated: true,
    appHeartbeatEnabled,
    signalOrigin,
    transport: viewerCommit.transport,
    senderCandidateTypes: [...senderCandidateTypes].sort(),
    receiverCandidateTypes: [...receiverCandidateTypes].sort(),
    sentPackets,
    receivedPackets,
    deliveryPercent: Math.round((receivedPackets / sentPackets) * 10_000) / 100,
    generatedFramesPerSecond: Math.round((totalFrames / elapsedSeconds) * 10) / 10,
    durationSeconds: Math.round(elapsedSeconds * 10) / 10,
  }));
} finally {
  for (const track of resources.tracks) track.stop();
  await Promise.all(resources.peers.map((peer) => peer.close().catch(() => undefined)));
  for (const signal of resources.signals) signal.close();
  await Promise.all(resources.sessions.map((session) => leaveRoom(session).catch(() => undefined)));
}
}

class SignalClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = new Set();
    this.listeners = new Map();
    this.heartbeat = appHeartbeatEnabled
      ? setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "heartbeat", sentAt: Date.now() }));
          }
        }, 5_000)
      : undefined;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      for (const listener of this.listeners.get(message.type) ?? []) listener(message);
      for (const waiter of this.waiters) waiter();
    });
  }

  static async connect(session) {
    const signalUrl = new URL(
      session.signaling.path.replace(/^\/+/, ""),
      `${baseUrl.replace(/\/+$/, "")}/`,
    );
    signalUrl.protocol = signalUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(signalUrl, { origin: signalOrigin });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connection timeout")), 8_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const client = new SignalClient(socket);
    client.send({ type: "auth", sessionToken: session.sessionToken });
    await client.waitFor("auth.ok", 8_000);
    return client;
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  waitFor(type, timeoutMs = 5_000) {
    const take = () => {
      const index = this.messages.findIndex((message) => message.type === type);
      return index >= 0 ? this.messages.splice(index, 1)[0] : undefined;
    };
    const queued = take();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const check = () => {
        const message = take();
        if (!message) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.add(check);
    });
  }

  close() {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
}

async function createRoom() {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Public media smoke test",
      displayName: "Smoke host",
      mediaMode: "hybrid",
      limits: { maxParticipants: 2, maxSharers: 1, maxViewersPerShare: 1 },
    }),
  });
  assert.equal(response.status, 201, `create room failed: ${response.status}`);
  return response.json();
}

async function joinRoom(code) {
  const response = await fetch(`${baseUrl}/api/rooms/${code}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Smoke viewer" }),
  });
  assert.equal(response.status, 200, `join room failed: ${response.status}`);
  return response.json();
}

async function leaveRoom(session) {
  await fetch(`${baseUrl}/api/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${session.sessionToken}` },
  });
}

function createPeer(iceServers) {
  return new RTCPeerConnection({
    codecs: {
      video: [useH264({
        payloadType,
        parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033",
      })],
      audio: [],
    },
    iceServers,
    iceUseIpv4: true,
    iceUseIpv6: false,
  });
}

function createRtpPacket(input) {
  const packet = Buffer.alloc(12 + 1_100, 0x55);
  packet[0] = 0x80;
  packet[1] = (input.marker ? 0x80 : 0) | payloadType;
  packet.writeUInt16BE(input.sequenceNumber, 2);
  packet.writeUInt32BE(input.timestamp, 4);
  packet.writeUInt32BE(0x10203040, 8);
  packet[12] = 0x61;
  return packet;
}

function recordCandidateType(types, candidate) {
  const type = candidate?.candidate.match(/\styp\s(\w+)/)?.[1];
  if (type) types.add(type);
}

async function waitForLocalDescription(peer, applying, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!peer.localDescription && Date.now() < deadline) await delay(10);
  if (!peer.localDescription) await applying;
  else void applying.catch(() => undefined);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await runSmokeTest();
process.exit(0);
