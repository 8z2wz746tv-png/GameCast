import type {
  ControlServerHealth,
  CreateRoomRequest,
  JoinRoomRequest,
  RoomSession,
  RoomSummary,
} from "@gamecast/contracts";
import { diagnosticLog, errorDetails } from "./diagnostics";

const PUBLIC_API_BASE = (import.meta.env.VITE_PUBLIC_CONTROL_SERVER_URL as string | undefined)?.trim();
const DEFAULT_API_BASE = PUBLIC_API_BASE || (import.meta.env.VITE_CONTROL_SERVER_URL as string | undefined) || "http://localhost:8787";
let apiBase = normalizeBaseUrl(DEFAULT_API_BASE);

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("服务器地址必须使用 http 或 https");
  }
  return url.toString().replace(/\/$/, "");
}

export function getApiBaseUrl(): string {
  return apiBase;
}

export function getPublicControlServerUrl(): string | undefined {
  return PUBLIC_API_BASE ? normalizeBaseUrl(PUBLIC_API_BASE) : undefined;
}

export function configureApiBaseUrl(value: string): void {
  apiBase = normalizeBaseUrl(value);
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 12_000): Promise<T> {
  const method = init?.method ?? "GET";
  diagnosticLog("control-api", "request.started", { method, path, serverUrl: apiBase });
  let response: Response;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      diagnosticLog("control-api", "request.timeout", { method, path, serverUrl: apiBase }, "error");
      throw new Error("服务器响应超时，请检查网络连接或服务器状态后重试");
    }
    diagnosticLog("control-api", "request.failed", { method, path, serverUrl: apiBase, ...errorDetails(error) }, "error");
    throw new Error(`无法连接服务器：${apiBase}`);
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    diagnosticLog("control-api", "request.rejected", { method, path, status: response.status, message: body?.message }, "warn");
    throw new Error(body?.message ?? "服务暂时不可用");
  }

  diagnosticLog("control-api", "request.completed", { method, path, status: response.status });
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health(): Promise<ControlServerHealth> {
    return request<ControlServerHealth>("/health", undefined, 6_000);
  },

  createRoom(input: CreateRoomRequest): Promise<RoomSession> {
    return request<RoomSession>("/api/rooms", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getRoom(code: string): Promise<{ room: RoomSummary }> {
    return request<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(code)}`);
  },

  joinRoom(code: string, input: JoinRoomRequest): Promise<RoomSession> {
    return request<RoomSession>(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  leaveRoom(sessionToken: string): Promise<void> {
    return request<void>("/api/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
  },
};
