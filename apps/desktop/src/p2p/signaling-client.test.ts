import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RoomSnapshot } from "@gamecast/contracts";
import { createSignalUrl, SignalingClient } from "./signaling-client";

type Listener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  private emit(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, "WebSocket", { value: originalWebSocket, configurable: true });
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

describe("SignalingClient reconnection", () => {
  it("keeps a public control-node path when constructing the WebSocket URL", () => {
    assert.equal(
      createSignalUrl("https://example.com/gamecast", "/api/signal"),
      "wss://example.com/gamecast/api/signal",
    );
    assert.equal(
      createSignalUrl("http://127.0.0.1:8787", "/api/signal"),
      "ws://127.0.0.1:8787/api/signal",
    );
  });

  it("starts a fresh grace window when a long-running connection drops", async () => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeWebSocket,
      configurable: true,
    });
    const client = new SignalingClient("ws://127.0.0.1/signal", "token", 1);
    const connected = client.connect();
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    first.receive({ type: "auth.ok", snapshot: snapshot() });
    await connected;

    await delay(1_050);
    first.close(1006, "network changed");
    await delay(450);
    assert.equal(FakeWebSocket.instances.length, 2);
    client.close();
  });

  it("settles a connect() that is still pending when the client closes", async () => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeWebSocket,
      configurable: true,
    });
    const client = new SignalingClient("ws://127.0.0.1/signal", "token", 30);
    const connected = client.connect();
    // The handshake never completes; the viewer leaves the room instead.
    client.close();

    // Raced against a deadline so a regression fails fast instead of hanging the runner.
    const outcome = await Promise.race([
      connected.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      delay(500).then(() => "timed-out"),
    ]);
    assert.equal(outcome, "信令连接已关闭");
  });
});

function snapshot(): RoomSnapshot {
  return {
    room: {
      id: "room",
      code: "ABC123",
      title: "test",
      createdAt: new Date(0).toISOString(),
      mediaMode: "hybrid",
      limits: { maxParticipants: 8, maxSharers: 4, maxViewersPerShare: 3 },
      participantCount: 1,
      activeSharerCount: 0,
      sfuAvailable: false,
    },
    participants: [],
    shares: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
