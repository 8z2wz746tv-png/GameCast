import { createHmac } from "node:crypto";
import type {
  IceServerConfig,
  P2PSession,
  SfuSession,
} from "@gamecast/contracts";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import type {
  LiveKitRuntimeConfig,
  TurnRuntimeConfig,
} from "../config.js";
import type { Participant, Room } from "../domain/room.js";

const TOKEN_TTL_SECONDS = 6 * 60 * 60;
/**
 * ICE credentials handed out by the unauthenticated `/api/network/preflight` probe. The probe only
 * needs to complete one gathering round (the client gives up after 6s), so a short lifetime keeps
 * that endpoint from being used to stockpile long-lived TURN relays.
 */
export const PREFLIGHT_ICE_TTL_SECONDS = 10 * 60;
const AVAILABILITY_CACHE_MS = 30_000;

export class MediaSessionService {
  private lastAvailabilityCheck = 0;
  private lastAvailabilityResult = false;

  constructor(
    private readonly livekit: LiveKitRuntimeConfig | undefined,
    private readonly turn: TurnRuntimeConfig | undefined,
    private readonly connectionTimeoutSeconds: number,
    private readonly stunUrls: string[] = [],
    private readonly candidatePolicy: P2PSession["candidatePolicy"] = "selected",
  ) {}

  createP2PSession(participantId: string, ttlSeconds: number = TOKEN_TTL_SECONDS): P2PSession {
    return {
      iceServers: this.createIceServers(participantId, ttlSeconds),
      connectionTimeoutSeconds: this.connectionTimeoutSeconds,
      candidatePolicy: this.candidatePolicy,
    };
  }

  get stunAvailable(): boolean {
    return this.stunUrls.length > 0 || Boolean(this.turn?.urls.some((url) => url.startsWith("stun:")));
  }

  get turnAvailable(): boolean {
    return Boolean(
      this.turn?.urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:")),
    );
  }

  async isSfuAvailable(): Promise<boolean> {
    if (!this.livekit) return false;
    if (this.livekit.assumeAvailable) return true;
    if (Date.now() - this.lastAvailabilityCheck < AVAILABILITY_CACHE_MS) {
      return this.lastAvailabilityResult;
    }
    this.lastAvailabilityCheck = Date.now();
    const client = this.roomServiceClient();
    if (!client) return false;
    try {
      await Promise.race([
        client.listRooms(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("LiveKit availability timeout")), 2_000),
        ),
      ]);
      this.lastAvailabilityResult = true;
    } catch {
      this.lastAvailabilityResult = false;
    }
    return this.lastAvailabilityResult;
  }

  private roomServiceClient(): RoomServiceClient | undefined {
    if (!this.livekit) return undefined;
    const serviceUrl = (this.livekit.serviceUrl ?? this.livekit.serverUrl)
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:");
    return new RoomServiceClient(serviceUrl, this.livekit.apiKey, this.livekit.apiSecret);
  }

  /**
   * A LiveKit token stays valid for its entire TTL, so a participant who leaves the room would keep
   * publish and subscribe access to the SFU room until it expires. Removing them from the SFU is what
   * actually ends that access.
   *
   * Best effort on purpose: the participant may never have joined the SFU, and a revocation failure
   * must not break the leave path.
   */
  async revokeSfuAccess(roomId: string, participantId: string): Promise<void> {
    const client = this.roomServiceClient();
    if (!client) return;
    try {
      await Promise.race([
        client.removeParticipant(roomId, participantId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("LiveKit revoke timeout")), 2_000),
        ),
      ]);
    } catch {
      // The token still expires on its own; revocation is an additional guarantee, not the only one.
    }
  }

  async issueSfuSession(
    room: Room,
    participant: Participant,
  ): Promise<SfuSession | undefined> {
    if (!this.livekit || !room.sfuAvailable) return undefined;
    const token = new AccessToken(this.livekit.apiKey, this.livekit.apiSecret, {
      identity: participant.id,
      name: participant.displayName,
      ttl: TOKEN_TTL_SECONDS,
      metadata: JSON.stringify({ role: participant.role }),
    });
    token.addGrant({
      roomJoin: true,
      room: room.id,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    return { serverUrl: this.livekit.serverUrl, token: await token.toJwt() };
  }

  private createIceServers(participantId: string, ttlSeconds: number): IceServerConfig[] {
    const turn = this.turn;
    const stunUrls = [...new Set([
      ...this.stunUrls,
      ...(turn?.urls.filter((url) => url.startsWith("stun:")) ?? []),
    ])];
    const turnUrls = turn?.urls.filter(
      (url) => url.startsWith("turn:") || url.startsWith("turns:"),
    ) ?? [];
    const servers: IceServerConfig[] = [];
    if (stunUrls.length > 0) servers.push({ urls: stunUrls });
    if (turnUrls.length === 0) return servers;

    if (turn?.sharedSecret) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiresAt}:${participantId}`;
      const credential = createHmac("sha1", turn.sharedSecret)
        .update(username)
        .digest("base64");
      servers.push({ urls: turnUrls, username, credential });
    } else if (turn?.username && turn.credential) {
      servers.push({
        urls: turnUrls,
        username: turn.username,
        credential: turn.credential,
      });
    }
    return servers;
  }
}
