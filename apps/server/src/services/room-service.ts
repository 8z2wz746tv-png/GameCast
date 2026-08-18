import {
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import type {
  CreateRoomRequest,
  JoinRoomRequest,
  MediaTransport,
  ParticipantSummary,
  RoomSnapshot,
  RoomSummary,
  ShareDescriptor,
  VideoPresetName,
} from "@gamecast/contracts";
import { DomainError } from "../domain/errors.js";
import type {
  Participant,
  Room,
  Session,
  ShareState,
  WatchRelation,
} from "../domain/room.js";
import { hashPassword, verifyPassword } from "./password-service.js";
import { selectInitialMediaRoute } from "./media-routing-policy.js";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_SESSION_TTL_SECONDS = 6 * 60 * 60;
const SWITCH_PENDING_TTL_MS = 8_000;
const INITIAL_PENDING_TTL_MS = 25_000;
const SFU_PENDING_TTL_MS = 10_000;

export type RoomAccess = {
  room: Room;
  participant: Participant;
  session: Session;
};

export type WatchRequestResult = {
  relation: WatchRelation;
  replacedPending?: WatchRelation;
};

export type WatchCommitResult = {
  relation: WatchRelation;
  releasedActive?: WatchRelation;
};

export type ParticipantRemoval = {
  room: Room;
  participant: Participant;
  releasedWatches: WatchRelation[];
  wasSharing: boolean;
  roomClosed: boolean;
};

export class RoomService {
  private readonly roomsByCode = new Map<string, Room>();
  private readonly roomsById = new Map<string, Room>();
  private readonly sessions = new Map<string, Session>();
  private readonly sessionTokensByParticipant = new Map<string, string>();

  constructor(
    private readonly sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
    private readonly sfuViewerThreshold = 2,
  ) {}

  async create(input: CreateRoomRequest, sfuAvailable: boolean): Promise<RoomAccess> {
    const room: Room = {
      id: randomUUID(),
      code: this.createUniqueCode(),
      title: input.title.trim(),
      createdAt: new Date(),
      mediaMode: input.mediaMode,
      limits: input.limits,
      sfuAvailable,
      passwordDigest: input.password ? await hashPassword(input.password) : undefined,
      participants: new Map(),
      shares: new Map(),
      watches: new Map(),
    };

    const participant = this.addParticipant(room, input.displayName, "host");
    const session = this.createSession(room, participant);
    this.roomsByCode.set(room.code, room);
    this.roomsById.set(room.id, room);
    return { room, participant, session };
  }

  async join(code: string, input: JoinRoomRequest): Promise<RoomAccess> {
    const room = this.getRoom(code);
    if (room.participants.size >= room.limits.maxParticipants) {
      throw new DomainError("ROOM_FULL", "房间人数已满", 409);
    }
    if (room.passwordDigest) {
      if (!input.password || !(await verifyPassword(input.password, room.passwordDigest))) {
        throw new DomainError("INVALID_PASSWORD", "房间密码不正确", 403);
      }
    }

    const participant = this.addParticipant(room, input.displayName, "member");
    const session = this.createSession(room, participant);
    return { room, participant, session };
  }

  touchSession(token: string, now = Date.now()): RoomAccess {
    const access = this.authenticate(token);
    access.session.expiresAt = new Date(now + this.sessionTtlSeconds * 1000);
    return access;
  }

  sweepExpiredSessions(now = Date.now()): ParticipantRemoval[] {
    const expiredParticipants = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.expiresAt.getTime() <= now) {
        expiredParticipants.add(this.participantKey(session.roomId, session.participantId));
      }
    }
    const removals: ParticipantRemoval[] = [];
    for (const key of expiredParticipants) {
      const separator = key.indexOf(":");
      const roomId = key.slice(0, separator);
      const participantId = key.slice(separator + 1);
      try {
        removals.push(this.removeParticipant(roomId, participantId));
      } catch {
        // A host expiration can remove the remaining members in the same room.
      }
    }
    return removals;
  }

  findSummary(code: string): RoomSummary {
    return this.toSummary(this.getRoom(code));
  }

  setSfuAvailability(roomId: string, available: boolean): void {
    const room = this.roomsById.get(roomId);
    if (room) room.sfuAvailable = available;
  }

  authenticate(token: string): RoomAccess {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      if (session) this.deleteSession(token, session);
      throw new DomainError("INVALID_SESSION", "会话已失效，请重新加入房间", 401);
    }
    const room = this.roomsById.get(session.roomId);
    const participant = room?.participants.get(session.participantId);
    if (!room || !participant) {
      this.deleteSession(token, session);
      throw new DomainError("INVALID_SESSION", "会话已失效，请重新加入房间", 401);
    }
    return { room, participant, session };
  }

  removeBySession(token: string): ParticipantRemoval {
    const access = this.authenticate(token);
    return this.removeParticipant(access.room.id, access.participant.id);
  }

  removeParticipant(roomId: string, participantId: string): ParticipantRemoval {
    const room = this.roomsById.get(roomId);
    const participant = room?.participants.get(participantId);
    if (!room || !participant) {
      throw new DomainError("PARTICIPANT_NOT_FOUND", "参与者已离开房间", 404);
    }

    const releasedWatches = [...room.watches.values()].filter(
      (watch) => watch.viewerId === participantId || watch.targetParticipantId === participantId,
    );
    for (const watch of releasedWatches) room.watches.delete(watch.connectionId);
    const wasSharing = room.shares.delete(participantId);
    room.participants.delete(participantId);
    const participantKey = this.participantKey(roomId, participantId);
    const participantToken = this.sessionTokensByParticipant.get(participantKey);
    if (participantToken) this.deleteSession(participantToken);

    const roomClosed = participant.role === "host" || room.participants.size === 0;
    if (roomClosed) {
      this.roomsByCode.delete(room.code);
      this.roomsById.delete(room.id);
      for (const [token, session] of this.sessions) {
        if (session.roomId === room.id) this.deleteSession(token, session);
      }
    }
    return { room, participant, releasedWatches, wasSharing, roomClosed };
  }

  startShare(
    roomId: string,
    participantId: string,
    preset: VideoPresetName,
    hasSystemAudio: boolean,
  ): ShareState {
    const room = this.requireRoomAndParticipant(roomId, participantId).room;
    if (!room.shares.has(participantId) && room.shares.size >= room.limits.maxSharers) {
      throw new DomainError("SHARER_LIMIT", "房间共享人数已达到上限", 409);
    }
    const share: ShareState = {
      participantId,
      preset,
      hasSystemAudio,
      startedAt: new Date(),
    };
    room.shares.set(participantId, share);
    return share;
  }

  stopShare(roomId: string, participantId: string): WatchRelation[] {
    const room = this.requireRoomAndParticipant(roomId, participantId).room;
    room.shares.delete(participantId);
    const released = [...room.watches.values()].filter(
      (watch) => watch.targetParticipantId === participantId,
    );
    for (const watch of released) room.watches.delete(watch.connectionId);
    return released;
  }

  requestWatch(
    roomId: string,
    viewerId: string,
    targetParticipantId: string,
    connectionId: string,
  ): WatchRequestResult {
    const { room } = this.requireRoomAndParticipant(roomId, viewerId);
    if (viewerId === targetParticipantId) {
      throw new DomainError("SELF_WATCH", "不能通过远程连接观看自己的共享", 400);
    }
    if (!room.participants.has(targetParticipantId) || !room.shares.has(targetParticipantId)) {
      throw new DomainError("SHARE_NOT_FOUND", "该共享已经结束", 404);
    }
    if (room.watches.has(connectionId)) {
      throw new DomainError("DUPLICATE_CONNECTION", "连接标识已经存在", 409);
    }
    const otherViewersForTarget = new Set(
      [...room.watches.values()]
        .filter(
          (watch) =>
            watch.targetParticipantId === targetParticipantId &&
            watch.viewerId !== viewerId,
        )
        .map((watch) => watch.viewerId),
    ).size;
    if (otherViewersForTarget >= room.limits.maxViewersPerShare) {
      throw new DomainError("VIEWER_LIMIT", "该共享的观看人数已满", 409);
    }

    const replacedPending = [...room.watches.values()].find(
      (watch) => watch.viewerId === viewerId && watch.state === "pending",
    );
    if (replacedPending) room.watches.delete(replacedPending.connectionId);

    const hasActiveWatch = [...room.watches.values()].some(
      (watch) => watch.viewerId === viewerId && watch.state === "active",
    );
    const transport = selectInitialMediaRoute({
      sfuAvailable: room.sfuAvailable,
      existingViewerCount: otherViewersForTarget,
      sfuViewerThreshold: this.sfuViewerThreshold,
    });
    const now = new Date();
    const relation: WatchRelation = {
      connectionId,
      viewerId,
      targetParticipantId,
      state: "pending",
      transport,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + (
          transport === "sfu"
            ? SFU_PENDING_TTL_MS
            : hasActiveWatch
              ? SWITCH_PENDING_TTL_MS
              : INITIAL_PENDING_TTL_MS
        ),
      ),
    };
    room.watches.set(connectionId, relation);
    return { relation, replacedPending };
  }

  setWatchTransport(
    roomId: string,
    participantId: string,
    connectionId: string,
    transport: MediaTransport,
  ): WatchRelation {
    const relation = this.requireWatch(roomId, connectionId);
    if (relation.viewerId !== participantId && relation.targetParticipantId !== participantId) {
      throw new DomainError("INVALID_SIGNAL_TARGET", "无权修改这个观看连接", 403);
    }
    relation.transport = transport;
    if (transport === "sfu" && relation.state === "pending") {
      relation.expiresAt = new Date(Date.now() + 10_000);
    }
    return relation;
  }

  commitWatch(
    roomId: string,
    viewerId: string,
    connectionId: string,
    transport: MediaTransport,
  ): WatchCommitResult {
    const room = this.requireRoomAndParticipant(roomId, viewerId).room;
    const relation = this.requireWatch(roomId, connectionId);
    if (relation.viewerId !== viewerId || relation.state !== "pending") {
      throw new DomainError("INVALID_WATCH", "观看连接状态无效", 409);
    }
    if (relation.transport === "sfu" && transport !== "sfu") {
      throw new DomainError("INVALID_TRANSPORT", "该观看连接必须使用 SFU", 409);
    }
    const releasedActive = [...room.watches.values()].find(
      (watch) => watch.viewerId === viewerId && watch.state === "active",
    );
    if (releasedActive) room.watches.delete(releasedActive.connectionId);
    relation.state = "active";
    relation.transport = transport;
    relation.expiresAt = undefined;
    return { relation, releasedActive };
  }

  releaseWatch(roomId: string, participantId: string, connectionId: string): WatchRelation {
    const relation = this.requireWatch(roomId, connectionId);
    if (relation.viewerId !== participantId && relation.targetParticipantId !== participantId) {
      throw new DomainError("INVALID_WATCH", "无权释放这个观看连接", 403);
    }
    this.roomsById.get(roomId)?.watches.delete(connectionId);
    return relation;
  }

  expireWatch(roomId: string, connectionId: string): WatchRelation | undefined {
    const room = this.roomsById.get(roomId);
    const relation = room?.watches.get(connectionId);
    if (!room || !relation || relation.state !== "pending") return undefined;
    if ((relation.expiresAt?.getTime() ?? 0) > Date.now()) return undefined;
    room.watches.delete(connectionId);
    return relation;
  }

  validateRtcRoute(
    roomId: string,
    senderId: string,
    targetParticipantId: string,
    connectionId: string,
  ): WatchRelation {
    const relation = this.requireWatch(roomId, connectionId);
    const valid =
      (relation.viewerId === senderId && relation.targetParticipantId === targetParticipantId) ||
      (relation.targetParticipantId === senderId && relation.viewerId === targetParticipantId);
    if (!valid) {
      throw new DomainError("INVALID_SIGNAL_TARGET", "无权向目标转发连接信息", 403);
    }
    return relation;
  }

  findRoomById(roomId: string): Room | undefined {
    return this.roomsById.get(roomId);
  }

  getParticipant(roomId: string, participantId: string): Participant | undefined {
    return this.roomsById.get(roomId)?.participants.get(participantId);
  }

  getShareDescriptor(room: Room, participantId: string): ShareDescriptor | undefined {
    const share = room.shares.get(participantId);
    const participant = room.participants.get(participantId);
    if (!share || !participant) return undefined;
    return {
      participantId,
      displayName: participant.displayName,
      preset: share.preset,
      hasSystemAudio: share.hasSystemAudio,
      viewerCount: [...room.watches.values()].filter(
        (watch) =>
          watch.targetParticipantId === participantId && watch.state === "active",
      ).length,
    };
  }

  getSfuViewerCount(roomId: string, participantId: string): number {
    const room = this.roomsById.get(roomId);
    if (!room) return 0;
    return [...room.watches.values()].filter(
      (watch) => watch.targetParticipantId === participantId && watch.transport === "sfu",
    ).length;
  }

  toSnapshot(room: Room, viewerId: string): RoomSnapshot {
    const activeWatch = [...room.watches.values()].find(
      (watch) => watch.viewerId === viewerId && watch.state === "active",
    );
    return {
      room: this.toSummary(room),
      participants: [...room.participants.values()].map((participant) =>
        this.toParticipantSummary(participant),
      ),
      shares: [...room.shares.keys()]
        .map((participantId) => this.getShareDescriptor(room, participantId))
        .filter((share): share is ShareDescriptor => Boolean(share)),
      activeWatch: activeWatch
        ? {
            connectionId: activeWatch.connectionId,
            targetParticipantId: activeWatch.targetParticipantId,
            transport: activeWatch.transport,
          }
        : undefined,
    };
  }

  toSummary(room: Room): RoomSummary {
    return {
      id: room.id,
      code: room.code,
      title: room.title,
      createdAt: room.createdAt.toISOString(),
      mediaMode: room.mediaMode,
      limits: room.limits,
      participantCount: room.participants.size,
      activeSharerCount: room.shares.size,
      sfuAvailable: room.sfuAvailable,
    };
  }

  toParticipantSummary(participant: Participant): ParticipantSummary {
    return {
      id: participant.id,
      displayName: participant.displayName,
      role: participant.role,
    };
  }

  private requireRoomAndParticipant(roomId: string, participantId: string): RoomAccess {
    const room = this.roomsById.get(roomId);
    const participant = room?.participants.get(participantId);
    if (!room || !participant) {
      throw new DomainError("PARTICIPANT_NOT_FOUND", "参与者已离开房间", 404);
    }
    const token = this.sessionTokensByParticipant.get(this.participantKey(roomId, participantId));
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      throw new DomainError("INVALID_SESSION", "会话已失效，请重新加入房间", 401);
    }
    return { room, participant, session };
  }

  private requireWatch(roomId: string, connectionId: string): WatchRelation {
    const relation = this.roomsById.get(roomId)?.watches.get(connectionId);
    if (!relation) throw new DomainError("WATCH_NOT_FOUND", "观看连接不存在", 404);
    return relation;
  }

  private getRoom(code: string): Room {
    const room = this.roomsByCode.get(code.trim().toUpperCase());
    if (!room) throw new DomainError("ROOM_NOT_FOUND", "没有找到这个房间", 404);
    return room;
  }

  private addParticipant(
    room: Room,
    displayName: string,
    role: Participant["role"],
  ): Participant {
    const participant: Participant = {
      id: randomUUID(),
      displayName: displayName.trim(),
      role,
      joinedAt: new Date(),
    };
    room.participants.set(participant.id, participant);
    return participant;
  }

  private createSession(room: Room, participant: Participant): Session {
    const createdAt = new Date();
    const session: Session = {
      token: randomBytes(32).toString("base64url"),
      roomId: room.id,
      participantId: participant.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.sessionTtlSeconds * 1000),
    };
    this.sessions.set(session.token, session);
    this.sessionTokensByParticipant.set(
      this.participantKey(room.id, participant.id),
      session.token,
    );
    return session;
  }

  private createUniqueCode(): string {
    for (;;) {
      let code = "";
      for (let index = 0; index < 6; index += 1) {
        code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      }
      if (!this.roomsByCode.has(code)) return code;
    }
  }

  private deleteSession(token: string, knownSession?: Session): void {
    const session = knownSession ?? this.sessions.get(token);
    this.sessions.delete(token);
    if (!session) return;
    const key = this.participantKey(session.roomId, session.participantId);
    if (this.sessionTokensByParticipant.get(key) === token) {
      this.sessionTokensByParticipant.delete(key);
    }
  }

  private participantKey(roomId: string, participantId: string): string {
    return `${roomId}:${participantId}`;
  }
}
