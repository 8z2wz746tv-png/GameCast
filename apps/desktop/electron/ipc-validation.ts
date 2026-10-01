import type {
  IceCandidateData,
  SessionDescriptionData,
  VideoPreset,
} from "@gamecast/contracts";
import { z } from "zod";
import type { NativeMediaStartRequest } from "./native-media.js";
import {
  EASY_TIER_EXECUTABLE_NAME,
  type EasyTierStartRequest,
  isEasyTierExecutablePath,
} from "./network-adapter.js";

export type HostSettingsInput = {
  turnUrls: string;
  turnSharedSecret?: string;
  livekitServerUrl: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  clearTurnSecret?: boolean;
  clearLivekitCredentials?: boolean;
  easyTierPath?: string;
  easyTierNetworkName?: string;
  easyTierNetworkSecret?: string;
  easyTierPeers?: string;
  clearEasyTierSecret?: boolean;
};

const sourceIdSchema = z.string().min(1).max(512);
const connectionIdSchema = z.string().uuid();
const bitrateSchema = z.number().int().min(250_000).max(50_000_000);
// Each `satisfies` ties a schema to the type the main process acts on, so a schema that drifts away
// from its contract fails the build rather than silently accepting a different shape over IPC.
const presetSchema = z
  .object({
    name: z.enum(["480p", "720p", "1080p", "1440p"]),
    label: z.string().min(1).max(32),
    width: z.number().int().min(640).max(2560),
    height: z.number().int().min(480).max(1440),
    frameRate: z.union([z.literal(30), z.literal(60)]),
  }) satisfies z.ZodType<VideoPreset>;
const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().max(256_000),
}) satisfies z.ZodType<SessionDescriptionData>;
const iceCandidateSchema = z
  .object({
    candidate: z.string().max(8_192),
    sdpMid: z.string().max(128).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(128).nullable().optional(),
    usernameFragment: z.string().max(512).nullable().optional(),
  })
  .nullable() satisfies z.ZodType<IceCandidateData | null>;
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
}) satisfies z.ZodType<NativeMediaStartRequest>;
/**
 * A configured EasyTier path must name the EasyTier core binary and nothing else: this value is
 * reachable from the renderer and is what the main process ends up passing to `spawn`. An empty
 * string stays legal so clearing the optional field in the UI can still be saved.
 */
const easyTierPathSchema = z
  .string()
  .max(2_048)
  .refine((value) => value.trim() === "" || isEasyTierExecutablePath(value), {
    message: `EasyTier 可执行文件必须指向 ${EASY_TIER_EXECUTABLE_NAME}`,
  });

const hostSettingsSchema = z.object({
  turnUrls: z.string().max(8_192),
  turnSharedSecret: z.string().max(4_096).optional(),
  livekitServerUrl: z.string().max(2_048),
  livekitApiKey: z.string().max(1_024).optional(),
  livekitApiSecret: z.string().max(4_096).optional(),
  clearTurnSecret: z.boolean().optional(),
  clearLivekitCredentials: z.boolean().optional(),
  easyTierPath: easyTierPathSchema.optional(),
  easyTierNetworkName: z.string().max(128).optional(),
  easyTierNetworkSecret: z.string().max(4_096).optional(),
  easyTierPeers: z.string().max(8_192).optional(),
  clearEasyTierSecret: z.boolean().optional(),
}) satisfies z.ZodType<HostSettingsInput>;
const easyTierStartSchema = z.object({
  executablePath: easyTierPathSchema.optional(),
  networkName: z.string().trim().min(1).max(128),
  networkSecret: z.string().trim().min(1).max(4_096).optional(),
  peers: z.array(z.string().trim().min(1).max(2_048)).max(16).optional(),
  virtualIp: z.ipv4().optional(),
});

/**
 * IPC handlers let the thrown message reach the renderer verbatim, and a raw ZodError stringifies
 * to a JSON blob in the UI. Reduce it to one readable sentence, prefixed with the offending field.
 */
function parseValidated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  const message = issue?.message ?? "参数不正确";
  throw new Error(field ? `${field}: ${message}` : message);
}

export const parseSourceId = (value: unknown): string => parseValidated(sourceIdSchema, value);
export const parseConnectionId = (value: unknown): string =>
  parseValidated(connectionIdSchema, value);
export const parseBitrate = (value: unknown): number => parseValidated(bitrateSchema, value);
export const parseIpv4Address = (value: unknown): string => parseValidated(z.ipv4(), value);
export const parsePreset = (value: unknown): VideoPreset => parseValidated(presetSchema, value);
export const parseNativeStart = (value: unknown): NativeMediaStartRequest =>
  parseValidated(nativeStartSchema, value);
export const parseSessionDescription = (value: unknown): SessionDescriptionData =>
  parseValidated(sessionDescriptionSchema, value);
export const parseIceCandidate = (value: unknown): IceCandidateData | null =>
  parseValidated(iceCandidateSchema, value);
export const parseHostSettings = (value: unknown): HostSettingsInput =>
  parseValidated(hostSettingsSchema, value);
export const parseEasyTierStart = (value: unknown): EasyTierStartRequest => {
  // `networkSecret` is optional on the wire and defaulted here, so this one cast is a real
  // transformation rather than a contract check that could hide drift.
  const parsed = parseValidated(easyTierStartSchema, value);
  return { ...parsed, networkSecret: parsed.networkSecret ?? "" } as EasyTierStartRequest;
};
