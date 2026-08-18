import type {
  ClientSignalMessage,
  RoomSnapshot,
  ServerSignalMessage,
} from "@gamecast/contracts";
import {
  diagnosticLog,
  summarizeIceCandidate,
  summarizeSdp,
  summarizeSignalMessage,
} from "../diagnostics";

export type SignalConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export class SignalingClient {
  private socket: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private manualClose = false;
  private reconnectDeadline = 0;
  private reconnectAttempt = 0;
  private reconnectCycleActive = false;
  private initialResolve: ((snapshot: RoomSnapshot) => void) | undefined;
  private initialReject: ((error: Error) => void) | undefined;

  onMessage?: (message: ServerSignalMessage) => void;
  onStateChange?: (state: SignalConnectionState) => void;

  constructor(
    private readonly url: string,
    private readonly sessionToken: string,
    private readonly reconnectGraceSeconds: number,
  ) {}

  connect(): Promise<RoomSnapshot> {
    const signalUrl = new URL(this.url);
    diagnosticLog("signaling", "connect.requested", {
      url: signalUrl.origin + signalUrl.pathname,
      reconnectGraceSeconds: this.reconnectGraceSeconds,
    });
    this.manualClose = false;
    this.beginReconnectCycle();
    const promise = new Promise<RoomSnapshot>((resolve, reject) => {
      this.initialResolve = resolve;
      this.initialReject = reject;
    });
    this.open(false);
    return promise;
  }

  reconnect(): void {
    diagnosticLog("signaling", "reconnect.requested");
    this.manualClose = false;
    this.beginReconnectCycle();
    if (this.socket) this.socket.close();
    else this.open(true);
  }

  send(message: ClientSignalMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      diagnosticLog("signaling", "send.rejected", summarizeSignalMessage(message), "warn");
      throw new Error("房间信令尚未连接");
    }
    if (message.type !== "heartbeat") {
      const data: Record<string, unknown> = summarizeSignalMessage(message);
      if (message.type === "rtc.ice") data.candidate = summarizeIceCandidate(message.candidate);
      if (message.type === "rtc.offer" || message.type === "rtc.answer") {
        data.description = summarizeSdp(message.description);
      }
      diagnosticLog("signaling", "message.sent", data);
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    diagnosticLog("signaling", "close.requested");
    this.manualClose = true;
    this.reconnectCycleActive = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, "Client leaving");
    this.socket = undefined;
  }

  private open(isReconnect: boolean): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    this.onStateChange?.(isReconnect ? "reconnecting" : "connecting");
    diagnosticLog("signaling", "socket.opening", { reconnect: isReconnect });
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      diagnosticLog("signaling", "socket.opened", { reconnect: isReconnect });
      socket.send(JSON.stringify({ type: "auth", sessionToken: this.sessionToken }));
    });
    socket.addEventListener("message", (event) => {
      let message: ServerSignalMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerSignalMessage;
      } catch {
        diagnosticLog("signaling", "message.invalid-json", undefined, "warn");
        return;
      }
      if (message.type !== "auth.ok") {
        const data: Record<string, unknown> = summarizeSignalMessage(message);
        if (message.type === "rtc.ice") data.candidate = summarizeIceCandidate(message.candidate);
        if (message.type === "rtc.offer" || message.type === "rtc.answer") {
          data.description = summarizeSdp(message.description);
        }
        diagnosticLog("signaling", "message.received", data);
      }
      if (message.type === "auth.ok") {
        this.reconnectCycleActive = false;
        this.reconnectAttempt = 0;
        this.reconnectDeadline = 0;
        diagnosticLog("signaling", "authenticated", {
          participantCount: message.snapshot.participants.length,
          shareCount: message.snapshot.shares.length,
        });
        this.onStateChange?.("connected");
        this.startHeartbeat();
        this.initialResolve?.(message.snapshot);
        this.initialResolve = undefined;
        this.initialReject = undefined;
      }
      this.onMessage?.(message);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.socket = undefined;
      this.stopHeartbeat();
      diagnosticLog(
        "signaling",
        "socket.closed",
        {
          code: event.code,
          reason: event.reason,
          clean: event.wasClean,
          manual: this.manualClose,
        },
        this.manualClose ? "info" : "warn",
      );
      if (this.manualClose) {
        this.onStateChange?.("disconnected");
        return;
      }
      if (!this.reconnectCycleActive) this.beginReconnectCycle();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      diagnosticLog("signaling", "socket.error", { reconnect: isReconnect }, "error");
      // The close event drives retry. Rejecting here would leave the UI in a
      // failed state while the socket is still reconnecting in the background.
    });
  }

  private scheduleReconnect(): void {
    if (Date.now() >= this.reconnectDeadline) {
      diagnosticLog("signaling", "reconnect.expired", undefined, "error");
      this.reconnectCycleActive = false;
      this.initialReject?.(new Error("无法连接房主信令服务"));
      this.initialResolve = undefined;
      this.initialReject = undefined;
      this.onStateChange?.("disconnected");
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.onStateChange?.("reconnecting");
    const delay = Math.min(2_000, 400 * 2 ** this.reconnectAttempt);
    diagnosticLog(
      "signaling",
      "reconnect.scheduled",
      { attempt: this.reconnectAttempt + 1, delay },
      "warn",
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open(true);
    }, delay);
  }

  private beginReconnectCycle(): void {
    this.reconnectCycleActive = true;
    this.reconnectAttempt = 0;
    this.reconnectDeadline = Date.now() + Math.max(1, this.reconnectGraceSeconds) * 1000;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: "heartbeat", sentAt: Date.now() }));
    }, 5_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

export function createSignalUrl(apiBase: string, path: string): string {
  const url = new URL(path.replace(/^\/+/, ""), `${apiBase.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
