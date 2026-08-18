import type {
  ClientSignalMessage,
  ServerSignalMessage,
} from "@gamecast/contracts";
import WebSocket from "ws";
import { DomainError } from "../domain/errors.js";
import type { Room, WatchRelation } from "../domain/room.js";
import type { RoomAccess } from "./room-service.js";
import type { ParticipantRemoval, RoomService } from "./room-service.js";
import { parseSignalMessage } from "./signal-protocol.js";

const MAX_MESSAGES_PER_WINDOW = 200;
const RATE_WINDOW_MS = 10_000;
const AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000;

type ConnectionRecord = {
  socket: WebSocket;
  access: RoomAccess;
  lastHeartbeat: number;
  rateStartedAt: number;
  messageCount: number;
};

export class SignalHub {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly authExpectationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly announcedParticipants = new Set<string>();
  private readonly healthTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly rooms: RoomService,
    private readonly reconnectGraceSeconds: number,
    private readonly heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  ) {
    const healthIntervalMs = Math.min(5_000, Math.max(250, heartbeatTimeoutMs / 4));
    this.healthTimer = setInterval(() => this.checkHeartbeats(), healthIntervalMs);
    this.healthTimer.unref?.();
  }

  attach(socket: WebSocket): void {
    let record: ConnectionRecord | undefined;
    const authTimer = setTimeout(() => {
      if (!record) socket.close(4401, "Authentication timeout");
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw) => {
      let parsedMessage: ClientSignalMessage | undefined;
      try {
        const message = parseSignalMessage(raw);
        parsedMessage = message;
        if (!record) {
          if (message.type !== "auth") {
            socket.close(4401, "Authentication required");
            return;
          }
          record = this.authenticateSocket(socket, message.sessionToken);
          clearTimeout(authTimer);
          return;
        }
        this.checkRateLimit(record);
        this.handleMessage(record, message);
      } catch (error) {
        if (error instanceof DomainError) {
          const connectionId = parsedMessage && "connectionId" in parsedMessage
            ? parsedMessage.connectionId
            : undefined;
          this.send(record?.socket ?? socket, {
            type: "error",
            code: error.code,
            message: error.message,
            connectionId,
          });
          return;
        }
        this.send(record?.socket ?? socket, {
          type: "error",
          code: "INVALID_SIGNAL",
          message: "信令消息格式不正确",
        });
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (record) this.handleDisconnect(record);
    });
    socket.on("pong", () => {
      if (record) this.markAlive(record);
    });
    socket.on("error", () => undefined);
  }

  onSessionCreated(access: RoomAccess): void {
    const participantKey = this.key(access.room.id, access.participant.id);
    const existing = this.authExpectationTimers.get(participantKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.authExpectationTimers.delete(participantKey);
      if (this.connections.has(participantKey)) return;
      try {
        this.onParticipantRemoved(
          this.rooms.removeParticipant(access.room.id, access.participant.id),
        );
      } catch {
        // The participant may have explicitly left before opening signaling.
      }
    }, 30_000);
    timer.unref?.();
    this.authExpectationTimers.set(participantKey, timer);
  }

  onParticipantRemoved(removal: ParticipantRemoval): void {
    const roomId = removal.room.id;
    const removedKey = this.key(roomId, removal.participant.id);
    const removedConnection = this.connections.get(removedKey);
    this.connections.delete(removedKey);
    this.announcedParticipants.delete(removedKey);
    this.clearGraceTimer(removedKey);
    this.clearAuthExpectation(removedKey);
    removedConnection?.socket.close(1000, "Participant left");

    if (removal.roomClosed) {
      this.broadcastRoom(roomId, {
        type: "room.closed",
        reason: "房主已关闭房间",
      });
      for (const [key, connection] of this.connections) {
        if (connection.access.room.id !== roomId) continue;
        this.connections.delete(key);
        this.announcedParticipants.delete(key);
        this.clearGraceTimer(key);
        this.clearAuthExpectation(key);
        connection.socket.close(1000, "Room closed");
      }
      return;
    }

    if (removal.wasSharing) {
      this.broadcastRoom(roomId, {
        type: "share.stopped",
        participantId: removal.participant.id,
      });
    }
    for (const relation of removal.releasedWatches) this.notifyWatchReleased(removal.room, relation);
    this.broadcastRoom(roomId, {
      type: "participant.left",
      participantId: removal.participant.id,
      participantCount: removal.room.participants.size,
    });
  }

  close(): void {
    clearInterval(this.healthTimer);
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    for (const timer of this.authExpectationTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.authExpectationTimers.clear();
    for (const connection of this.connections.values()) {
      this.send(connection.socket, {
        type: "room.closed",
        reason: "房主服务已关闭",
      });
      connection.socket.close(1001, "Server stopping");
    }
    this.connections.clear();
  }

  private authenticateSocket(socket: WebSocket, sessionToken: string): ConnectionRecord {
    const access = this.rooms.authenticate(sessionToken);
    const participantKey = this.key(access.room.id, access.participant.id);
    const existing = this.connections.get(participantKey);
    if (existing && existing.socket !== socket) existing.socket.close(4000, "Replaced");
    this.clearGraceTimer(participantKey);
    this.clearAuthExpectation(participantKey);

    const record: ConnectionRecord = {
      socket,
      access,
      lastHeartbeat: Date.now(),
      rateStartedAt: Date.now(),
      messageCount: 0,
    };
    this.connections.set(participantKey, record);
    this.send(socket, {
      type: "auth.ok",
      snapshot: this.rooms.toSnapshot(access.room, access.participant.id),
    });

    if (!this.announcedParticipants.has(participantKey)) {
      this.announcedParticipants.add(participantKey);
      this.broadcastRoom(
        access.room.id,
        {
          type: "participant.joined",
          participant: this.rooms.toParticipantSummary(access.participant),
          participantCount: access.room.participants.size,
        },
        access.participant.id,
      );
    }
    return record;
  }

  private handleMessage(record: ConnectionRecord, message: ClientSignalMessage): void {
    const { room, participant } = record.access;
    switch (message.type) {
      case "auth":
        return;
      case "heartbeat":
        this.markAlive(record);
        this.send(record.socket, { type: "heartbeat.ack", sentAt: message.sentAt });
        return;
      case "share.start": {
        this.rooms.startShare(room.id, participant.id, message.preset, message.hasSystemAudio);
        this.broadcastShare(room.id, participant.id);
        return;
      }
      case "share.stop": {
        const released = this.rooms.stopShare(room.id, participant.id);
        for (const relation of released) this.notifyWatchReleased(room, relation);
        this.broadcastRoom(room.id, { type: "share.stopped", participantId: participant.id });
        return;
      }
      case "watch.request": {
        try {
          const result = this.rooms.requestWatch(
            room.id,
            participant.id,
            message.targetParticipantId,
            message.connectionId,
          );
          if (result.replacedPending) this.notifyWatchReleased(room, result.replacedPending);
          this.send(record.socket, {
          type: "watch.pending",
          connectionId: result.relation.connectionId,
          targetParticipantId: result.relation.targetParticipantId,
          transport: result.relation.transport === "sfu" ? "sfu" : "p2p",
          expiresAt: result.relation.expiresAt?.getTime() ?? Date.now(),
        });
          if (result.relation.transport === "sfu") {
            this.sendTo(room.id, result.relation.targetParticipantId, {
              type: "sfu.publish-requested",
              connectionId: result.relation.connectionId,
              viewer: this.rooms.toParticipantSummary(participant),
            });
          } else {
            this.sendTo(room.id, result.relation.targetParticipantId, {
              type: "watch.requested",
              connectionId: result.relation.connectionId,
              viewer: this.rooms.toParticipantSummary(participant),
            });
          }
          this.broadcastShare(room.id, result.relation.targetParticipantId);
          this.scheduleWatchExpiry(room.id, result.relation.connectionId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "无法观看这个共享";
          this.send(record.socket, {
            type: "watch.rejected",
            connectionId: message.connectionId,
            reason,
          });
        }
        return;
      }
      case "watch.commit": {
        const result = this.rooms.commitWatch(
          room.id,
          participant.id,
          message.connectionId,
          message.transport,
        );
        if (result.releasedActive) this.notifyWatchReleased(room, result.releasedActive);
        this.send(record.socket, {
          type: "watch.committed",
          connectionId: result.relation.connectionId,
          targetParticipantId: result.relation.targetParticipantId,
          transport: result.relation.transport,
        });
        this.sendTo(room.id, result.relation.targetParticipantId, {
          type: "watch.committed",
          connectionId: result.relation.connectionId,
          targetParticipantId: result.relation.targetParticipantId,
          transport: result.relation.transport,
        });
        this.broadcastShare(room.id, result.relation.targetParticipantId);
        return;
      }
      case "watch.release": {
        let relation: WatchRelation;
        try {
          relation = this.rooms.releaseWatch(room.id, participant.id, message.connectionId);
        } catch (error) {
          if (isWatchNotFound(error)) return;
          throw error;
        }
        this.notifyWatchReleased(room, relation);
        return;
      }
      case "rtc.offer":
      case "rtc.answer": {
        try {
          this.rooms.validateRtcRoute(
            room.id,
            participant.id,
            message.targetParticipantId,
            message.connectionId,
          );
        } catch (error) {
          if (isWatchNotFound(error)) return;
          throw error;
        }
        this.sendTo(room.id, message.targetParticipantId, {
          type: message.type,
          connectionId: message.connectionId,
          participantId: participant.id,
          description: message.description,
        });
        return;
      }
      case "rtc.ice": {
        try {
          this.rooms.validateRtcRoute(
            room.id,
            participant.id,
            message.targetParticipantId,
            message.connectionId,
          );
        } catch (error) {
          if (isWatchNotFound(error)) return;
          throw error;
        }
        this.sendTo(room.id, message.targetParticipantId, {
          type: "rtc.ice",
          connectionId: message.connectionId,
          participantId: participant.id,
          candidate: message.candidate,
        });
        return;
      }
      case "p2p.failed": {
        const relation = this.rooms.validateRtcRoute(
          room.id,
          participant.id,
          message.targetParticipantId,
          message.connectionId,
        );
        if (relation.viewerId !== participant.id) {
          throw new DomainError("INVALID_FALLBACK", "只有观看者可以请求回退", 403);
        }
        if (!room.sfuAvailable) {
          this.send(record.socket, {
            type: "error",
            code: "P2P_CONNECTION_FAILED",
            message: "P2P 连接失败，当前房间没有可用的 TURN/SFU，请检查双方网络后重试",
            connectionId: message.connectionId,
          });
          return;
        }
        this.rooms.setWatchTransport(room.id, participant.id, message.connectionId, "sfu");
        this.sendTo(room.id, relation.targetParticipantId, {
          type: "sfu.publish-requested",
          connectionId: relation.connectionId,
          viewer: this.rooms.toParticipantSummary(participant),
        });
        this.scheduleWatchExpiry(room.id, relation.connectionId);
        return;
      }
      case "sfu.publisher-ready": {
        const relation = this.rooms.validateRtcRoute(
          room.id,
          participant.id,
          message.targetParticipantId,
          message.connectionId,
        );
        if (
          relation.targetParticipantId !== participant.id ||
          relation.viewerId !== message.targetParticipantId
        ) {
          throw new DomainError("INVALID_FALLBACK", "SFU 发布确认无效", 403);
        }
        this.sendTo(room.id, relation.viewerId, {
          type: "sfu.ready",
          connectionId: relation.connectionId,
          targetParticipantId: participant.id,
        });
        return;
      }
    }
  }

  private handleDisconnect(record: ConnectionRecord): void {
    const { room, participant } = record.access;
    const participantKey = this.key(room.id, participant.id);
    if (this.connections.get(participantKey)?.socket !== record.socket) return;
    this.connections.delete(participantKey);
    this.clearGraceTimer(participantKey);
    const timer = setTimeout(() => {
      this.graceTimers.delete(participantKey);
      try {
        this.onParticipantRemoved(this.rooms.removeParticipant(room.id, participant.id));
      } catch {
        this.announcedParticipants.delete(participantKey);
      }
    }, this.reconnectGraceSeconds * 1000);
    this.graceTimers.set(participantKey, timer);
  }

  private notifyWatchReleased(room: Room, relation: WatchRelation): void {
    this.sendTo(room.id, relation.viewerId, {
      type: "watch.released",
      connectionId: relation.connectionId,
      participantId: relation.targetParticipantId,
    });
    this.sendTo(room.id, relation.targetParticipantId, {
      type: "watch.released",
      connectionId: relation.connectionId,
      participantId: relation.viewerId,
    });
    this.broadcastShare(room.id, relation.targetParticipantId);
    if (relation.transport === "sfu" && this.rooms.getSfuViewerCount(room.id, relation.targetParticipantId) === 0) {
      this.sendTo(room.id, relation.targetParticipantId, { type: "sfu.unpublish-requested" });
    }
  }

  private scheduleWatchExpiry(roomId: string, connectionId: string): void {
    const room = this.rooms.findRoomById(roomId);
    const relation = room?.watches.get(connectionId);
    if (!room || !relation?.expiresAt) return;
    const delay = Math.max(0, relation.expiresAt.getTime() - Date.now()) + 50;
    const timer = setTimeout(() => {
      const expired = this.rooms.expireWatch(roomId, connectionId);
      if (!expired) return;
      this.sendTo(roomId, expired.viewerId, {
        type: "watch.rejected",
        connectionId,
        reason: "建立观看连接超时",
      });
      this.notifyWatchReleased(room, expired);
    }, delay);
    timer.unref?.();
  }

  private broadcastShare(roomId: string, participantId: string): void {
    const room = this.rooms.findRoomById(roomId);
    if (!room) return;
    const share = this.rooms.getShareDescriptor(room, participantId);
    if (share) this.broadcastRoom(roomId, { type: "share.updated", share });
  }

  private checkRateLimit(record: ConnectionRecord): void {
    const now = Date.now();
    if (now - record.rateStartedAt > RATE_WINDOW_MS) {
      record.rateStartedAt = now;
      record.messageCount = 0;
    }
    record.messageCount += 1;
    if (record.messageCount > MAX_MESSAGES_PER_WINDOW) {
      record.socket.close(4429, "Signal rate limit exceeded");
      throw new DomainError("SIGNAL_RATE_LIMIT", "信令消息发送过于频繁", 429);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const connection of this.connections.values()) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      if (now - connection.lastHeartbeat > this.heartbeatTimeoutMs) {
        connection.socket.terminate();
        continue;
      }
      connection.socket.ping();
    }
    for (const removal of this.rooms.sweepExpiredSessions(now)) {
      this.onParticipantRemoved(removal);
    }
  }

  private markAlive(record: ConnectionRecord): void {
    record.lastHeartbeat = Date.now();
    this.rooms.touchSession(record.access.session.token, record.lastHeartbeat);
  }

  private sendTo(roomId: string, participantId: string, message: ServerSignalMessage): void {
    const connection = this.connections.get(this.key(roomId, participantId));
    if (connection) this.send(connection.socket, message);
  }

  private broadcastRoom(
    roomId: string,
    message: ServerSignalMessage,
    excludeParticipantId?: string,
  ): void {
    for (const connection of this.connections.values()) {
      if (connection.access.room.id !== roomId) continue;
      if (connection.access.participant.id === excludeParticipantId) continue;
      this.send(connection.socket, message);
    }
  }

  private send(socket: WebSocket, message: ServerSignalMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private clearGraceTimer(key: string): void {
    const timer = this.graceTimers.get(key);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(key);
  }

  private clearAuthExpectation(key: string): void {
    const timer = this.authExpectationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.authExpectationTimers.delete(key);
  }

  private key(roomId: string, participantId: string): string {
    return `${roomId}:${participantId}`;
  }
}

function isWatchNotFound(error: unknown): boolean {
  return error instanceof DomainError && error.code === "WATCH_NOT_FOUND";
}
