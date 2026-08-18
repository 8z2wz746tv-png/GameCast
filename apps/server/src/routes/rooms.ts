import type {
  CreateRoomRequest,
  JoinRoomRequest,
  RoomSession,
} from "@gamecast/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { MediaSessionService } from "../services/media-token-service.js";
import type {
  RoomService,
  ParticipantRemoval,
  RoomAccess,
} from "../services/room-service.js";

const limitsSchema = z
  .object({
    maxParticipants: z.number().int().min(2).max(8),
    maxSharers: z.number().int().min(1).max(4),
    maxViewersPerShare: z.number().int().min(1).max(7),
  })
  .superRefine((limits, context) => {
    if (limits.maxSharers > limits.maxParticipants) {
      context.addIssue({
        code: "custom",
        path: ["maxSharers"],
        message: "共享人数不能超过房间总人数",
      });
    }
    if (limits.maxViewersPerShare >= limits.maxParticipants) {
      context.addIssue({
        code: "custom",
        path: ["maxViewersPerShare"],
        message: "单路观看人数必须小于房间总人数",
      });
    }
  });

const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(32),
  password: z.string().max(128).optional(),
  mediaMode: z.literal("hybrid"),
  limits: limitsSchema,
});

const joinRoomSchema = z.object({
  displayName: z.string().trim().min(1).max(32),
  password: z.string().max(128).optional(),
});

const roomCodeSchema = z.string().trim().length(6).toUpperCase();

export type RoomRouteEvents = {
  onSessionCreated(access: RoomAccess): void;
  onParticipantRemoved(removal: ParticipantRemoval): void;
};

export async function registerRoomRoutes(
  app: FastifyInstance,
  rooms: RoomService,
  mediaSessions: MediaSessionService,
  events: RoomRouteEvents,
  reconnectGraceSeconds: number,
): Promise<void> {
  app.post("/api/rooms", async (request, reply) => {
    const input = createRoomSchema.parse(request.body) as CreateRoomRequest;
    const access = await rooms.create(input, await mediaSessions.isSfuAvailable());
    events.onSessionCreated(access);
    return reply
      .status(201)
      .send(await createResponse(access, rooms, mediaSessions, reconnectGraceSeconds));
  });

  app.get("/api/rooms/:code", async (request) => {
    const params = z.object({ code: roomCodeSchema }).parse(request.params);
    return { room: rooms.findSummary(params.code) };
  });

  app.post("/api/rooms/:code/join", async (request) => {
    const params = z.object({ code: roomCodeSchema }).parse(request.params);
    const input = joinRoomSchema.parse(request.body) as JoinRoomRequest;
    const access = await rooms.join(params.code, input);
    events.onSessionCreated(access);
    return createResponse(access, rooms, mediaSessions, reconnectGraceSeconds);
  });

  app.post("/api/session/media-token", async (request) => {
    const access = rooms.authenticate(readBearerToken(request));
    rooms.setSfuAvailability(access.room.id, await mediaSessions.isSfuAvailable());
    return { sfu: await mediaSessions.issueSfuSession(access.room, access.participant) };
  });

  app.delete("/api/session", async (request, reply) => {
    const removal = rooms.removeBySession(readBearerToken(request));
    events.onParticipantRemoved(removal);
    return reply.status(204).send();
  });
}

async function createResponse(
  access: RoomAccess,
  rooms: RoomService,
  mediaSessions: MediaSessionService,
  reconnectGraceSeconds: number,
): Promise<RoomSession> {
  rooms.setSfuAvailability(access.room.id, await mediaSessions.isSfuAvailable());
  return {
    room: rooms.toSummary(access.room),
    participant: rooms.toParticipantSummary(access.participant),
    sessionToken: access.session.token,
    signaling: { path: "/api/signal", reconnectGraceSeconds },
    p2p: mediaSessions.createP2PSession(access.participant.id),
    sfu: await mediaSessions.issueSfuSession(access.room, access.participant),
  };
}

function readBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new DomainError("MISSING_SESSION", "缺少房间会话凭证", 401);
  }
  return authorization.slice("Bearer ".length);
}
