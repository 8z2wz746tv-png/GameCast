import type {
  IceCandidateData,
  SessionDescriptionData,
  VideoPreset,
} from "@gamecast/contracts";
import { z } from "zod";
import type { NativeMediaStartRequest } from "./native-media.js";

export type HostSettingsInput = {
  turnUrls: string;
  turnSharedSecret?: string;
  livekitServerUrl: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  clearTurnSecret?: boolean;
  clearLivekitCredentials?: boolean;
};

const sourceIdSchema = z.string().min(1).max(512);
const connectionIdSchema = z.string().uuid();
const bitrateSchema = z.number().int().min(250_000).max(50_000_000);
const presetSchema = z.object({
  name: z.enum(["480p", "720p", "1080p", "1440p"]),
  label: z.string().min(1).max(32),
  width: z.number().int().min(640).max(2560),
  height: z.number().int().min(480).max(1440),
  frameRate: z.union([z.literal(30), z.literal(60)]),
});
const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().max(256_000),
});
const iceCandidateSchema = z.object({
  candidate: z.string().max(8_192),
  sdpMid: z.string().max(128).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(128).nullable().optional(),
  usernameFragment: z.string().max(512).nullable().optional(),
}).nullable();
const nativeStartSchema = z.object({
  sourceId: sourceIdSchema,
  outputIndex: z.number().int().min(0).max(64).optional(),
  preset: presetSchema,
  maxBitrate: bitrateSchema,
  iceServers: z.array(z.object({
    urls: z.array(z.string().min(1).max(2048)).max(8),
    username: z.string().max(512).optional(),
    credential: z.string().max(1024).optional(),
  })).max(8),
  allowedHostAddresses: z.array(z.ipv4()).max(16),
  audioOffer: z.string().max(256_000).optional(),
});
const hostSettingsSchema = z.object({
  turnUrls: z.string().max(8_192),
  turnSharedSecret: z.string().max(4_096).optional(),
  livekitServerUrl: z.string().max(2_048),
  livekitApiKey: z.string().max(1_024).optional(),
  livekitApiSecret: z.string().max(4_096).optional(),
  clearTurnSecret: z.boolean().optional(),
  clearLivekitCredentials: z.boolean().optional(),
});

export const parseSourceId = (value: unknown): string => sourceIdSchema.parse(value);
export const parseConnectionId = (value: unknown): string => connectionIdSchema.parse(value);
export const parseBitrate = (value: unknown): number => bitrateSchema.parse(value);
export const parseIpv4Address = (value: unknown): string => z.ipv4().parse(value);
export const parsePreset = (value: unknown): VideoPreset => presetSchema.parse(value) as VideoPreset;
export const parseNativeStart = (value: unknown): NativeMediaStartRequest =>
  nativeStartSchema.parse(value) as NativeMediaStartRequest;
export const parseSessionDescription = (value: unknown): SessionDescriptionData =>
  sessionDescriptionSchema.parse(value) as SessionDescriptionData;
export const parseIceCandidate = (value: unknown): IceCandidateData | null =>
  iceCandidateSchema.parse(value) as IceCandidateData | null;
export const parseHostSettings = (value: unknown): HostSettingsInput =>
  hostSettingsSchema.parse(value) as HostSettingsInput;
