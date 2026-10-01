import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import cors from "@fastify/cors";
import type { ApiError } from "@gamecast/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";
import type { ControlServerRuntimeConfig } from "./config.js";
import { DomainError } from "./domain/errors.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { MediaSessionService } from "./services/media-token-service.js";
import { RequestRateLimiter } from "./services/request-rate-limiter.js";
import { RoomService } from "./services/room-service.js";
import { SignalHub } from "./services/signal-hub.js";

export type ControlServerHandle = {
  app: FastifyInstance;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

export async function createControlServer(
  config: ControlServerRuntimeConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.logger });
  const deploymentMode = config.deploymentMode ?? "embedded";
  const sfuViewerThreshold = config.sfuViewerThreshold ?? 2;
  const rooms = new RoomService(undefined, sfuViewerThreshold);
  const mediaSessions = new MediaSessionService(
    config.livekit,
    config.turn,
    config.connectionTimeoutSeconds,
    config.stunUrls,
    deploymentMode === "internet" ? "all" : "selected",
  );
  const signalHub = new SignalHub(
    rooms,
    config.reconnectGraceSeconds,
    config.heartbeatTimeoutMs,
  );
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const requestLimiter = new RequestRateLimiter();
  const upgradeLimiter = new RequestRateLimiter();

  await app.register(cors, {
    origin: config.clientOrigins,
    methods: ["GET", "POST", "DELETE"],
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const general = requestLimiter.consume(`api:${request.ip}`, 120, 60_000);
    const isCreate = request.method === "POST" && request.url === "/api/rooms";
    const isJoin = request.method === "POST" && /^\/api\/rooms\/[^/]+\/join(?:\?|$)/.test(request.url);
    const sensitive = isCreate || isJoin
      ? requestLimiter.consume(`room-write:${request.ip}`, 20, 60_000)
      : { allowed: true, retryAfterSeconds: 0 };
    if (general.allowed && sensitive.allowed) return;
    const retryAfter = Math.max(general.retryAfterSeconds, sensitive.retryAfterSeconds);
    reply.header("Retry-After", String(retryAfter));
    throw new DomainError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
  });

  app.server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/api/signal") {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const allowedOrigin = !origin ||
      config.clientOrigins.includes("*") ||
      config.clientOrigins.includes(origin) ||
      ((origin === "file://" || origin === "null") && config.clientOrigins.includes("null"));
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    const rate = upgradeLimiter.consume(`upgrade:${remoteAddress}`, 30, 60_000);
    if (!allowedOrigin || !rate.allowed || socketServer.clients.size >= 64) {
      socket.destroy();
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (webSocket) => {
      signalHub.attach(webSocket);
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    deploymentMode,
    p2p: true,
    stunAvailable: mediaSessions.stunAvailable,
    turnAvailable: mediaSessions.turnAvailable,
    sfuAvailable: await mediaSessions.isSfuAvailable(),
    sfuViewerThreshold,
  }));
  app.get("/api/network/preflight", async () => ({
    p2p: mediaSessions.createP2PSession(`preflight-${randomUUID()}`),
    sfuAvailable: await mediaSessions.isSfuAvailable(),
    issuedAt: new Date().toISOString(),
  }));
  app.post("/api/network/upload-probe", async (request) => {
    const body = request.body as { payload?: unknown } | undefined;
    if (typeof body?.payload !== "string" || body.payload.length > 768 * 1024) {
      throw new DomainError("INVALID_REQUEST", "上传检测数据无效", 400);
    }
    return { receivedBytes: Buffer.byteLength(body.payload, "utf8") };
  });
  await registerRoomRoutes(
    app,
    rooms,
    mediaSessions,
    signalHub,
    config.reconnectGraceSeconds,
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      const body: ApiError = { error: error.code, message: error.message };
      return reply.status(error.statusCode).send(body);
    }
    if (error instanceof ZodError) {
      const body: ApiError = {
        error: "INVALID_REQUEST",
        message: error.issues[0]?.message ?? "请求参数不正确",
      };
      return reply.status(400).send(body);
    }
    app.log.error(error);
    const body: ApiError = { error: "INTERNAL_ERROR", message: "服务暂时不可用" };
    return reply.status(500).send(body);
  });

  app.addHook("onClose", async () => {
    signalHub.close();
    for (const client of socketServer.clients) client.close(1001, "Server stopping");
    socketServer.close();
  });

  return app;
}

export async function startControlServer(
  config: ControlServerRuntimeConfig,
): Promise<ControlServerHandle> {
  const app = await createControlServer(config);
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address() as AddressInfo;
  const displayHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    app,
    host: address.address,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    close: () => app.close(),
  };
}
