import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ServerSignalMessage, ShareDescriptor, VideoPreset } from "@gamecast/contracts";
import { P2PMediaManager, type P2PMediaCallbacks } from "./p2p-media-manager";
import type { SignalingClient } from "./signaling-client";
import type { SfuFallback } from "./sfu-fallback";

/*
 * Harness for the viewer half of the P2P state machine.
 *
 * `P2PMediaManager` had no test coverage at all because it needs a WebRTC environment. The fakes
 * below are deliberately small: they implement only what the manager actually touches, so the tests
 * drive the real offer/answer/first-frame/release flow instead of private helpers.
 */

const PRESET: VideoPreset = {
  name: "1080p",
  label: "1080p",
  width: 1920,
  height: 1080,
  frameRate: 60,
};

type FakeStats = {
  forEach(callback: (report: Record<string, unknown>) => void): void;
  get(id: string): Record<string, unknown> | undefined;
};

function statsFrom(reports: Record<string, unknown>[] = []): FakeStats {
  const byId = new Map<string, Record<string, unknown>>();
  for (const report of reports) {
    if (typeof report.id === "string") byId.set(report.id, report);
  }
  return {
    forEach: (callback) => {
      for (const report of reports) callback(report);
    },
    get: (id) => byId.get(id),
  };
}

class FakeMediaStreamTrack {
  readonly id = `track-${crypto.randomUUID()}`;
  readonly label = "fake-track";
  muted = false;
  readyState = "live";
  contentHint = "";
  constructor(readonly kind: "video" | "audio") {}
  getSettings(): Record<string, unknown> {
    return { width: 1920, height: 1080, frameRate: 60 };
  }
  appliedConstraints: unknown[] = [];
  async applyConstraints(constraints?: unknown): Promise<void> {
    this.appliedConstraints.push(constraints);
  }
  private readonly listeners = new Map<string, Set<unknown>>();
  addEventListener(type: string, listener?: unknown): void {
    const listeners = this.listeners.get(type) ?? new Set<unknown>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener?: unknown): void {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(): number {
    let total = 0;
    for (const listeners of this.listeners.values()) total += listeners.size;
    return total;
  }
  stop(): void {
    this.readyState = "ended";
  }
}

class FakeMediaStream {
  private tracks: FakeMediaStreamTrack[];
  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }
  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  addTrack(track: FakeMediaStreamTrack): void {
    this.tracks.push(track);
  }
  removeTrack(track: FakeMediaStreamTrack): void {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  static latest(): FakeRTCPeerConnection {
    const instance = FakeRTCPeerConnection.instances.at(-1);
    if (!instance) throw new Error("no fake RTCPeerConnection was created");
    return instance;
  }
  static reset(): void {
    FakeRTCPeerConnection.instances = [];
  }

  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  iceGatheringState = "complete";
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  closed = false;
  getStatsCalls = 0;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  private stats: () => Promise<FakeStats> = async () => statsFrom();

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  setStats(stats: () => Promise<FakeStats>): void {
    this.stats = stats;
  }

  async getStats(): Promise<FakeStats> {
    this.getStatsCalls += 1;
    return this.stats();
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "v=0" };
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: "answer", sdp: "v=0" };
  }
  async setLocalDescription(description: unknown): Promise<void> {
    this.localDescription = description;
  }
  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
  }
  async addIceCandidate(): Promise<void> {}
  addTrack(): unknown {
    return {};
  }
  getTransceivers(): unknown[] {
    return [];
  }
  getReceivers(): unknown[] {
    return [];
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

class FakeSignaling {
  readonly sent: { type: string; connectionId?: string }[] = [];
  send(message: { type: string; connectionId?: string }): void {
    this.sent.push(message);
  }
  committed(connectionId: string): boolean {
    return this.sent.some(
      (message) => message.type === "watch.commit" && message.connectionId === connectionId,
    );
  }
}

const fakeSfu = {
  available: false,
  publish: async () => {},
  unpublish: async () => {},
  subscribe: async () => {},
  unsubscribe: () => {},
  disconnect: async () => {},
};

type ManagerInternals = {
  activeConnectionId?: string;
  pendingConnectionId?: string;
  displayedConnectionId?: string;
  localStream?: unknown;
  incoming: Map<string, unknown>;
  monitorActiveConnection(): Promise<void>;
};

function asInternals(manager: P2PMediaManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

type Harness = {
  manager: P2PMediaManager;
  signaling: FakeSignaling;
  events: string[];
  internals: ManagerInternals;
};

function createHarness(connectionTimeoutSeconds = 30): Harness {
  const signaling = new FakeSignaling();
  const events: string[] = [];
  const callbacks: P2PMediaCallbacks = {
    onStream: (connectionId) => events.push(`stream:${connectionId}`),
    onStreamCleared: (connectionId) => events.push(`cleared:${connectionId}`),
    onLocalShareChanged: () => {},
    onConnectionCommitted: (participantId) => events.push(`committed:${participantId}`),
    onError: (message) => events.push(`error:${message}`),
    onStats: () => {},
    onPublisherStats: () => {},
    onConnectionStage: (stage) => events.push(`stage:${stage.phase}`),
  };
  const manager = new P2PMediaManager(
    "self",
    {
      iceServers: [],
      connectionTimeoutSeconds,
      candidatePolicy: "all",
    },
    signaling as unknown as SignalingClient,
    [],
    fakeSfu as unknown as SfuFallback,
    callbacks,
    PRESET,
  );
  return { manager, signaling, events, internals: asInternals(manager) };
}

const shareFor = (participantId: string): ShareDescriptor => ({
  participantId,
  displayName: participantId,
  preset: "1080p",
  hasSystemAudio: false,
  viewerCount: 1,
});

const offerFrom = (connectionId: string, participantId: string): ServerSignalMessage => ({
  type: "rtc.offer",
  connectionId,
  participantId,
  description: { type: "offer", sdp: "v=0" },
});

const frameDecodedStats = () =>
  statsFrom([
    { type: "inbound-rtp", kind: "video", framesDecoded: 12, frameWidth: 1920, frameHeight: 1080 },
  ]);

/** Lets `setTimeout(..., 0)` continuations and the awaited `check()` bodies run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function deliverVideoTrack(pc: FakeRTCPeerConnection): Promise<FakeMediaStreamTrack> {
  const track = new FakeMediaStreamTrack("video");
  pc.ontrack?.({ track, streams: [new FakeMediaStream([track])] });
  await settle();
  return track;
}

/** Drives select -> offer -> first decoded frame -> server commit, i.e. a live watched share. */
async function driveToCommittedViewer(
  harness: Harness,
  participantId: string,
): Promise<string> {
  const { manager, internals } = harness;
  manager.selectShare(shareFor(participantId));
  const connectionId = internals.pendingConnectionId;
  assert.ok(connectionId, "selectShare should have created a pending connection");

  await manager.handleSignal(offerFrom(connectionId, participantId));
  const pc = FakeRTCPeerConnection.latest();
  pc.setStats(async () => frameDecodedStats());
  await deliverVideoTrack(pc);
  assert.equal(
    internals.displayedConnectionId,
    connectionId,
    "the first decoded frame should have activated the connection",
  );

  await manager.handleSignal({
    type: "watch.committed",
    connectionId,
    targetParticipantId: participantId,
    transport: "p2p",
  });
  assert.equal(internals.activeConnectionId, connectionId);
  return connectionId;
}

/** `navigator` already exists in Node, so it has to be redefined rather than assigned. */
function installDisplayMedia(
  getDisplayMedia: () => Promise<FakeMediaStream>,
): FakeMediaStreamTrack[] {
  const tracks: FakeMediaStreamTrack[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => {
          const stream = await getDisplayMedia();
          tracks.push(...stream.getTracks());
          return stream;
        },
      },
    },
  });
  return tracks;
}

const harnesses: Harness[] = [];

function openHarness(connectionTimeoutSeconds = 30): Harness {
  const harness = createHarness(connectionTimeoutSeconds);
  harnesses.push(harness);
  return harness;
}

// The manager logs through `window.electronAPI`, so a bare `window` must exist in Node.
beforeEach(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window = {};
  scope.MediaStream = FakeMediaStream;
  scope.RTCPeerConnection = FakeRTCPeerConnection;
  FakeRTCPeerConnection.reset();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.manager.close();
});

describe("P2PMediaManager viewer state", () => {
  it("clears activeConnectionId when the watched connection is released", async () => {
    const harness = openHarness();
    const { manager, internals } = harness;
    const connectionId = await driveToCommittedViewer(harness, "viewer-a");

    await manager.handleSignal({
      type: "watch.released",
      connectionId,
      participantId: "viewer-a",
    });

    assert.equal(
      internals.activeConnectionId,
      undefined,
      "a released connection must not stay active, or the next watch is never monitored",
    );
  });

  it("keeps sampling the next watch after the previous one was released", async () => {
    const harness = openHarness();
    const { manager, internals } = harness;
    const released = await driveToCommittedViewer(harness, "viewer-a");

    await manager.handleSignal({ type: "watch.released", connectionId: released, participantId: "viewer-a" });

    // The viewer immediately picks a different share.
    manager.selectShare(shareFor("viewer-b"));
    const nextId = internals.pendingConnectionId;
    assert.ok(nextId);
    const nextPc = FakeRTCPeerConnection.latest();
    nextPc.connectionState = "connected";

    await internals.monitorActiveConnection();

    assert.ok(
      nextPc.getStatsCalls > 0,
      "the monitor sampled the stale connection id and skipped the pending one",
    );
  });

  it("ignores a connection released while its transport was being detected", async () => {
    const harness = openHarness();
    const { manager, signaling, events, internals } = harness;
    manager.selectShare(shareFor("viewer-a"));
    const connectionId = internals.pendingConnectionId;
    assert.ok(connectionId);
    await manager.handleSignal(offerFrom(connectionId, "viewer-a"));

    const pc = FakeRTCPeerConnection.latest();
    const gate = deferred();
    let calls = 0;
    pc.setStats(async () => {
      calls += 1;
      // First call answers the first-frame poll; the second one is `detectTransport`, held open
      // so the release lands in the middle of `activateIncoming`.
      if (calls === 1) return frameDecodedStats();
      await gate.promise;
      return statsFrom();
    });

    await deliverVideoTrack(pc);
    await manager.handleSignal({ type: "watch.released", connectionId, participantId: "viewer-a" });
    gate.resolve();
    await settle();

    assert.equal(
      events.includes(`stream:${connectionId}`),
      false,
      "a released connection must never be handed to the UI",
    );
    assert.equal(
      signaling.committed(connectionId),
      false,
      "a released watch must not be committed to the server",
    );
  });

  it("closes an unexpected connection that never delivers a first frame", async () => {
    // `handleOffer` creates a record for any unknown connectionId, with no timeout and a 250ms
    // first-frame poller: without a deadline that record and its pc leak for the session.
    const harness = openHarness(1);
    const { manager, internals } = harness;

    await manager.handleSignal(offerFrom("unexpected-connection", "viewer-z"));
    assert.ok(internals.incoming.has("unexpected-connection"));

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    assert.equal(
      internals.incoming.has("unexpected-connection"),
      false,
      "an unknown connection that never produces video should be closed",
    );
  });

  it("detaches remote track listeners when the connection closes", async () => {
    const harness = openHarness();
    const { manager, internals } = harness;
    manager.selectShare(shareFor("viewer-a"));
    const connectionId = internals.pendingConnectionId;
    assert.ok(connectionId);
    await manager.handleSignal(offerFrom(connectionId, "viewer-a"));

    const pc = FakeRTCPeerConnection.latest();
    pc.setStats(async () => frameDecodedStats());
    const track = await deliverVideoTrack(pc);
    assert.ok(track.listenerCount() > 0, "listeners should be attached while watching");

    await manager.handleSignal({ type: "watch.released", connectionId, participantId: "viewer-a" });

    assert.equal(
      track.listenerCount(),
      0,
      "listeners on a remote track must not outlive the connection that created them",
    );
  });

  it("clears the local preview when sharing stops", async () => {
    const harness = openHarness();
    const { manager, events, internals } = harness;
    installDisplayMedia(async () => new FakeMediaStream([new FakeMediaStreamTrack("video")]));
    await manager.startSharing("screen:0:0", PRESET);

    manager.selectShare(shareFor("self"));
    assert.equal(internals.displayedConnectionId, "local-self");

    await manager.stopSharing();

    assert.equal(
      internals.displayedConnectionId,
      undefined,
      "the stage would otherwise keep a frozen frame of a stopped capture",
    );
    assert.ok(events.includes("cleared:local-self"), "the UI must be told the preview is gone");
  });

  it("abandons a capture that finishes starting after sharing was stopped", async () => {
    const harness = openHarness();
    const { manager, signaling, internals } = harness;
    const gate = deferred();
    const track = new FakeMediaStreamTrack("video");
    installDisplayMedia(async () => {
      await gate.promise;
      return new FakeMediaStream([track]);
    });

    const starting = manager.startSharing("screen:0:0", PRESET);
    await settle();
    // The user hits stop while the OS source picker is still open.
    await manager.stopSharing();
    gate.resolve();
    await starting;

    assert.equal(track.readyState, "ended", "the abandoned capture must not keep running");
    assert.equal(
      internals.localStream,
      undefined,
      "a capture that started after the stop must not be published",
    );
    assert.equal(
      signaling.sent.some((message) => message.type === "share.start"),
      false,
      "the room must never be told about an abandoned capture",
    );
  });
});
