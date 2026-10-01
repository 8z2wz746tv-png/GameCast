import type { ClientSignalMessage } from "@gamecast/contracts";
import type { RawData } from "ws";
import { z } from "zod";

/**
 * The signaling socket caps a whole frame at 64 KiB (`maxPayload` in app.ts). The previous 256 000
 * allowance could never be reached — an oversized SDP was killed by the socket instead of being
 * rejected by this schema. 32 KiB leaves ample room for the JSON envelope, and a real screen-share
 * SDP is a few kilobytes.
 */
const MAX_SDP_CHARS = 32_768;

const descriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().max(MAX_SDP_CHARS),
});

const candidateSchema = z.object({
  candidate: z.string().max(8_192),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
}).nullable();

/**
 * `satisfies` makes the shared contract the authority: if a message shape here and
 * `ClientSignalMessage` in @gamecast/contracts ever diverge, the build fails instead of the two
 * silently describing different protocols.
 */
const signalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), sessionToken: z.string().min(20).max(256) }),
  z.object({ type: z.literal("heartbeat"), sentAt: z.number() }),
  z.object({
    type: z.literal("share.start"),
    preset: z.enum(["480p", "720p", "1080p", "1440p"]),
    hasSystemAudio: z.boolean(),
  }),
  z.object({ type: z.literal("share.stop") }),
  z.object({
    type: z.literal("watch.request"),
    connectionId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("watch.commit"),
    connectionId: z.string().uuid(),
    transport: z.enum(["p2p", "turn", "sfu"]),
  }),
  z.object({ type: z.literal("watch.release"), connectionId: z.string().uuid() }),
  z.object({
    type: z.literal("rtc.offer"),
    connectionId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
    description: descriptionSchema,
  }),
  z.object({
    type: z.literal("rtc.answer"),
    connectionId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
    description: descriptionSchema,
  }),
  z.object({
    type: z.literal("rtc.ice"),
    connectionId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
    candidate: candidateSchema,
  }),
  z.object({
    type: z.literal("p2p.failed"),
    connectionId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("sfu.publisher-ready"),
    connectionId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
  }),
]) satisfies z.ZodType<ClientSignalMessage>;

export function parseSignalMessage(raw: RawData): ClientSignalMessage {
  return signalSchema.parse(JSON.parse(raw.toString()) as unknown);
}
