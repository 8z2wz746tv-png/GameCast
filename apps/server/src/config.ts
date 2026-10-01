import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

export type LiveKitRuntimeConfig = {
  apiKey: string;
  apiSecret: string;
  serverUrl: string;
  serviceUrl?: string;
  assumeAvailable?: boolean;
};

export type TurnRuntimeConfig = {
  urls: string[];
  sharedSecret?: string;
  username?: string;
  credential?: string;
};

export type ControlServerRuntimeConfig = {
  host: string;
  port: number;
  clientOrigins: string[];
  logger: boolean;
  /**
   * Reverse proxies whose `X-Forwarded-For` may be trusted, as addresses/CIDRs.
   * Left undefined when unset: rate limits then key on the socket peer, which is the correct
   * behaviour for a directly exposed server and never allows a client to spoof its own address.
   */
  trustProxy?: string[];
  /** Set ALLOW_INSECURE_DEFAULTS=true to let a server boot with the example LiveKit keys. */
  allowInsecureDefaults?: boolean;
  deploymentMode?: "embedded" | "internet";
  stunUrls?: string[];
  livekit?: LiveKitRuntimeConfig;
  turn?: TurnRuntimeConfig;
  reconnectGraceSeconds: number;
  connectionTimeoutSeconds: number;
  sfuViewerThreshold?: number;
  heartbeatTimeoutMs?: number;
};

loadEnv({ path: process.env.ENV_FILE ?? resolve(process.cwd(), "../../.env") });
loadEnv();

const envSchema = z.object({
  CONTROL_SERVER_HOST: z.string().default("0.0.0.0"),
  CONTROL_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173,http://127.0.0.1:5173,null"),
  TRUST_PROXY: z.string().default(""),
  DEPLOYMENT_MODE: z.enum(["embedded", "internet"]).default("internet"),
  STUN_URLS: z.string().default("stun:stun.cloudflare.com:3478"),
  SFU_ENABLED: z.enum(["true", "false"]).default("true"),
  SFU_VIEWER_THRESHOLD: z.coerce.number().int().min(2).max(7).default(2),
  LIVEKIT_API_KEY: z.string().min(1).default("devkey"),
  LIVEKIT_API_SECRET: z.string().min(16).default("devsecret-change-before-production"),
  /**
   * Explicit escape hatch for local work. Without it a server that kept the example LiveKit keys
   * refuses to start, because those keys are published in this repository.
   */
  ALLOW_INSECURE_DEFAULTS: z.enum(["true", "false"]).default("false"),
  LIVEKIT_WS_URL: z.string().url().default("ws://localhost:7880"),
  LIVEKIT_API_URL: z.string().url().optional(),
  TURN_SHARED_SECRET: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  TURN_URLS: z.string().default(""),
});

const env = envSchema.parse(process.env);
const stunUrls = env.STUN_URLS.split(",").map((value) => value.trim()).filter(Boolean);
const turnUrls = env.TURN_URLS.split(",").map((value) => value.trim()).filter(Boolean);
// Only the proxies named here may set the client address. An empty list disables the forwarded
// header entirely rather than trusting it, so a client can never choose its own rate-limit bucket.
const trustProxy = env.TRUST_PROXY.split(",").map((value) => value.trim()).filter(Boolean);

/**
 * These values ship in this repository (and in .env.example). A deployment that keeps them would
 * sign real LiveKit tokens with publicly known keys, and `livekit.yaml` enables `auto_create`, so
 * anyone could mint a token for any room.
 */
const INSECURE_DEFAULTS = {
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret-change-before-production",
} as const;

/**
 * Names the LiveKit settings still holding the example values above. Returned rather than thrown so
 * the process entry point owns the decision and this stays unit-testable.
 */
export function insecureDefaultSecrets(settings: {
  livekitApiKey?: string;
  livekitApiSecret?: string;
  allowInsecureDefaults: boolean;
}): string[] {
  if (settings.allowInsecureDefaults) return [];
  const reused: string[] = [];
  if (settings.livekitApiKey === INSECURE_DEFAULTS.LIVEKIT_API_KEY) {
    reused.push("LIVEKIT_API_KEY");
  }
  if (settings.livekitApiSecret === INSECURE_DEFAULTS.LIVEKIT_API_SECRET) {
    reused.push("LIVEKIT_API_SECRET");
  }
  return reused;
}

export const appConfig: ControlServerRuntimeConfig = {
  host: env.CONTROL_SERVER_HOST,
  port: env.CONTROL_SERVER_PORT,
  clientOrigins: env.CLIENT_ORIGIN.split(",").map((value) => value.trim()),
  logger: true,
  trustProxy: trustProxy.length > 0 ? trustProxy : undefined,
  allowInsecureDefaults: env.ALLOW_INSECURE_DEFAULTS === "true",
  deploymentMode: env.DEPLOYMENT_MODE,
  stunUrls,
  livekit:
    env.SFU_ENABLED === "true"
      ? {
          apiKey: env.LIVEKIT_API_KEY,
          apiSecret: env.LIVEKIT_API_SECRET,
          serverUrl: env.LIVEKIT_WS_URL,
          serviceUrl: env.LIVEKIT_API_URL,
        }
      : undefined,
  turn:
    turnUrls.length > 0
      ? {
          urls: turnUrls,
          sharedSecret: env.TURN_SHARED_SECRET,
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        }
      : undefined,
  reconnectGraceSeconds: 10,
  connectionTimeoutSeconds: 20,
  sfuViewerThreshold: env.SFU_VIEWER_THRESHOLD,
};
