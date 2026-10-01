import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type {
  ClientSignalMessage,
  RoomSession,
  ServerSignalMessage,
} from "@gamecast/contracts";
import WebSocket from "ws";
import { type ControlServerHandle, startControlServer } from "./app.js";

class TestSignalClient {
  private readonly messages: ServerSignalMessage[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerSignalMessage);
      for (const waiter of this.waiters) waiter();
    });
  }

  send(message: ClientSignalMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends ServerSignalMessage["type"]>(
    type: T,
    timeoutMs = 2_000,
  ): Promise<Extract<ServerSignalMessage, { type: T }>> {
    const find = () => {
      const index = this.messages.findIndex((message) => message.type === type);
      if (index < 0) return undefined;
      return this.messages.splice(index, 1)[0] as Extract<ServerSignalMessage, { type: T }>;
    };
    const existing = find();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      const check = () => {
        const message = find();
        if (!message) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(message);
      };
      this.waiters.add(check);
    });
  }
}

describe("P2P signaling integration", () => {
  let handle: ControlServerHandle | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await handle?.close();
    handle = undefined;
  });

  it("reports internet node capabilities and enables all ICE candidates", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      deploymentMode: "internet",
      stunUrls: ["stun:stun.example.com:3478"],
      sfuViewerThreshold: 2,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
    });

    const healthResponse = await fetch(`${handle.url}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as {
      deploymentMode: string;
      stunAvailable: boolean;
      turnAvailable: boolean;
      sfuAvailable: boolean;
      sfuViewerThreshold: number;
    };
    assert.deepEqual(health, {
      deploymentMode: "internet",
      stunAvailable: true,
      turnAvailable: false,
      sfuAvailable: false,
      sfuViewerThreshold: 2,
      status: "ok",
      p2p: true,
    });

    const uploadResponse = await fetch(`${handle.url}/api/network/upload-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(32 * 1024) }),
    });
    assert.equal(uploadResponse.status, 200);
    assert.deepEqual(await uploadResponse.json(), { receivedBytes: 32 * 1024 });

    const session = await createRoom(handle.url);
    assert.equal(session.p2p.candidatePolicy, "all");
    assert.deepEqual(session.p2p.iceServers, [{ urls: ["stun:stun.example.com:3478"] }]);
  });

  it("keeps background clients alive with protocol-level ping and pong", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
      heartbeatTimeoutMs: 400,
    });
    const session = await createRoom(handle.url);
    const client = await connectSignal(handle.url, session, sockets);

    await delay(1_200);

    assert.equal(client.socket.readyState, WebSocket.OPEN);
  });

  it("authenticates, announces a share, and rejects the fourth viewer", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
    });
    const hostSession = await createRoom(handle.url);
    const host = await connectSignal(handle.url, hostSession, sockets);
    const viewers: Array<{ session: RoomSession; signal: TestSignalClient }> = [];
    for (let index = 0; index < 4; index += 1) {
      const session = await joinRoom(handle.url, hostSession.room.code, `Viewer ${index + 1}`);
      viewers.push({ session, signal: await connectSignal(handle.url, session, sockets) });
    }

    host.send({ type: "share.start", preset: "1080p", hasSystemAudio: true });
    await viewers[0]!.signal.waitFor("share.updated");

    for (const viewer of viewers.slice(0, 3)) {
      const connectionId = randomUUID();
      viewer.signal.send({
        type: "watch.request",
        connectionId,
        targetParticipantId: hostSession.participant.id,
      });
      const pending = await viewer.signal.waitFor("watch.pending");
      assert.equal(pending.connectionId, connectionId);
      assert.equal(pending.transport, "p2p");
      const requested = await host.waitFor("watch.requested");
      assert.equal(requested.connectionId, connectionId);
    }

    const rejectedConnection = randomUUID();
    viewers[3]!.signal.send({
      type: "watch.request",
      connectionId: rejectedConnection,
      targetParticipantId: hostSession.participant.id,
    });
    const rejected = await viewers[3]!.signal.waitFor("watch.rejected");
    assert.equal(rejected.connectionId, rejectedConnection);
    assert.match(rejected.reason, /观看人数已满/);
  });

  it("ignores late signaling after a watch has been released", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
    });
    const hostSession = await createRoom(handle.url);
    const host = await connectSignal(handle.url, hostSession, sockets);
    const viewerSession = await joinRoom(handle.url, hostSession.room.code, "Viewer");
    const viewer = await connectSignal(handle.url, viewerSession, sockets);
    host.send({ type: "share.start", preset: "1080p", hasSystemAudio: true });
    await viewer.waitFor("share.updated");

    const connectionId = randomUUID();
    viewer.send({
      type: "watch.request",
      connectionId,
      targetParticipantId: hostSession.participant.id,
    });
    await viewer.waitFor("watch.pending");
    await host.waitFor("watch.requested");
    viewer.send({ type: "watch.release", connectionId });
    await viewer.waitFor("watch.released");
    await host.waitFor("watch.released");

    viewer.send({ type: "watch.release", connectionId });
    host.send({
      type: "rtc.ice",
      connectionId,
      targetParticipantId: viewerSession.participant.id,
      candidate: null,
    });
    await assert.rejects(viewer.waitFor("error", 200), /Timed out waiting for error/);
    await assert.rejects(host.waitFor("error", 200), /Timed out waiting for error/);
  });

  it("returns an actionable error when P2P has no fallback", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
    });
    const hostSession = await createRoom(handle.url);
    const host = await connectSignal(handle.url, hostSession, sockets);
    const viewerSession = await joinRoom(handle.url, hostSession.room.code, "Viewer");
    const viewer = await connectSignal(handle.url, viewerSession, sockets);
    host.send({ type: "share.start", preset: "1080p", hasSystemAudio: true });
    await viewer.waitFor("share.updated");

    const connectionId = randomUUID();
    viewer.send({
      type: "watch.request",
      connectionId,
      targetParticipantId: hostSession.participant.id,
    });
    await viewer.waitFor("watch.pending");
    await host.waitFor("watch.requested");
    viewer.send({
      type: "p2p.failed",
      connectionId,
      targetParticipantId: hostSession.participant.id,
    });

    const failure = await viewer.waitFor("error");
    assert.equal(failure.code, "P2P_CONNECTION_FAILED");
    assert.match(failure.message, /TURN\/SFU/);
  });

  it("uses P2P for the first viewer and SFU for the next viewer when LiveKit is available", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      livekit: {
        serverUrl: "ws://127.0.0.1:7880",
        apiKey: "test-key",
        apiSecret: "test-secret-with-at-least-16-chars",
        assumeAvailable: true,
      },
      sfuViewerThreshold: 2,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
    });
    const hostSession = await createRoom(handle.url);
    const host = await connectSignal(handle.url, hostSession, sockets);
    const firstSession = await joinRoom(handle.url, hostSession.room.code, "First viewer");
    const first = await connectSignal(handle.url, firstSession, sockets);
    const secondSession = await joinRoom(handle.url, hostSession.room.code, "Second viewer");
    const second = await connectSignal(handle.url, secondSession, sockets);

    host.send({ type: "share.start", preset: "1080p", hasSystemAudio: true });
    await first.waitFor("share.updated");

    const firstConnectionId = randomUUID();
    first.send({
      type: "watch.request",
      connectionId: firstConnectionId,
      targetParticipantId: hostSession.participant.id,
    });
    const firstPending = await first.waitFor("watch.pending");
    assert.equal(firstPending.transport, "p2p");
    assert.equal((await host.waitFor("watch.requested")).connectionId, firstConnectionId);
    first.send({ type: "watch.commit", connectionId: firstConnectionId, transport: "p2p" });
    assert.equal((await first.waitFor("watch.committed")).transport, "p2p");
    assert.equal((await host.waitFor("watch.committed")).transport, "p2p");

    const secondConnectionId = randomUUID();
    second.send({
      type: "watch.request",
      connectionId: secondConnectionId,
      targetParticipantId: hostSession.participant.id,
    });
    const secondPending = await second.waitFor("watch.pending");
    assert.equal(secondPending.transport, "sfu");
    assert.equal((await host.waitFor("sfu.publish-requested")).connectionId, secondConnectionId);
    await assert.rejects(second.waitFor("watch.requested", 150), /Timed out waiting for watch.requested/);

    second.send({ type: "watch.commit", connectionId: secondConnectionId, transport: "p2p" });
    const rejected = await second.waitFor("error");
    assert.equal(rejected.code, "INVALID_TRANSPORT");
  });

  it("rate limits repeated room mutations from one client", async () => {
    handle = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      clientOrigins: ["*"],
      logger: false,
      reconnectGraceSeconds: 1,
      connectionTimeoutSeconds: 2,
    });
    for (let index = 0; index < 20; index += 1) {
      const response: Response = await fetch(`${handle.url}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Room ${index}`,
          displayName: "Host",
          mediaMode: "hybrid",
          limits: { maxParticipants: 8, maxSharers: 4, maxViewersPerShare: 3 },
        }),
      });
      assert.equal(response.status, 201);
    }
    const rejected: Response = await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Limited",
        displayName: "Host",
        mediaMode: "hybrid",
        limits: { maxParticipants: 8, maxSharers: 4, maxViewersPerShare: 3 },
      }),
    });
    assert.equal(rejected.status, 429);
    assert.ok(rejected.headers.get("retry-after"));
  });
});

async function createRoom(baseUrl: string): Promise<RoomSession> {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Signal Test",
      displayName: "Host",
      mediaMode: "hybrid",
      limits: { maxParticipants: 8, maxSharers: 4, maxViewersPerShare: 3 },
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as RoomSession;
}

async function joinRoom(baseUrl: string, code: string, displayName: string): Promise<RoomSession> {
  const response = await fetch(`${baseUrl}/api/rooms/${code}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as RoomSession;
}

async function connectSignal(
  baseUrl: string,
  session: RoomSession,
  sockets: WebSocket[],
): Promise<TestSignalClient> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${session.signaling.path}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const client = new TestSignalClient(socket);
  client.send({ type: "auth", sessionToken: session.sessionToken });
  await client.waitFor("auth.ok");
  return client;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
