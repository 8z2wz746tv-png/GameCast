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
  DEPLOYMENT_MODE: z.enum(["embedded", "internet"]).default("internet"),
  STUN_URLS: z.string().default("stun:stun.cloudflare.com:3478"),
  SFU_ENABLED: z.enum(["true", "false"]).default("true"),
  SFU_VIEWER_THRESHOLD: z.coerce.number().int().min(2).max(7).default(2),
  LIVEKIT_API_KEY: z.string().min(1).default("devkey"),
  LIVEKIT_API_SECRET: z.string().min(16).default("devsecret-change-before-production"),
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

export const appConfig: ControlServerRuntimeConfig = {
  host: env.CONTROL_SERVER_HOST,
  port: env.CONTROL_SERVER_PORT,
  clientOrigins: env.CLIENT_ORIGIN.split(",").map((value) => value.trim()),
  logger: true,
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
