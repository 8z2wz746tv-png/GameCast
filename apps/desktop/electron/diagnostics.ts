import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AsyncLineWriter } from "./async-line-writer.js";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticLogEntry = {
  level?: DiagnosticLevel;
  scope: string;
  event: string;
  data?: unknown;
};

export type DiagnosticMetadata = {
  appVersion: string;
  platform: string;
  release: string;
  arch: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
};

const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const MAX_STRING_LENGTH = 8_000;

export class DiagnosticsService {
  private readonly logDirectory: string;
  private readonly logPath: string;
  private readonly writer: AsyncLineWriter;

  constructor(
    private readonly userDataPath: string,
    private readonly desktopPath: string,
    private readonly metadata: DiagnosticMetadata,
  ) {
    this.logDirectory = join(userDataPath, "logs");
    this.logPath = join(this.logDirectory, "gamecast.log");
    mkdirSync(this.logDirectory, { recursive: true });
    this.writer = new AsyncLineWriter(this.logPath, MAX_LOG_SIZE, MAX_LOG_FILES);
  }

  log(entry: DiagnosticLogEntry): void {
    try {
      const record = {
        timestamp: new Date().toISOString(),
        level: entry.level ?? "info",
        scope: entry.scope.slice(0, 80),
        event: entry.event.slice(0, 120),
        ...(entry.data === undefined ? {} : { data: sanitizeDiagnosticValue(entry.data) }),
      };
      const line = `${JSON.stringify(record)}\n`;
      this.writer.write(line);
    } catch {
      // Diagnostics must never interrupt the application.
    }
  }

  async exportBundle(): Promise<string> {
    await this.writer.flush();
    mkdirSync(this.desktopPath, { recursive: true });
    const logFiles: Buffer[] = [];
    for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
      const rotatedPath = `${this.logPath}.${index}`;
      if (existsSync(rotatedPath)) {
        logFiles.push(readFileSync(rotatedPath));
      }
    }
    if (existsSync(this.logPath)) {
      logFiles.push(readFileSync(this.logPath));
    }
    const nativeMediaPath = join(this.userDataPath, "native-media.log");
    const legacyNativeLog = existsSync(nativeMediaPath)
      ? readFileSync(nativeMediaPath)
      : undefined;

    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
    const outputPath = join(this.desktopPath, `GameCast-diagnostics-${timestamp}.jsonl`);
    writeFileSync(outputPath, createDiagnosticExport({
      exportedAt: new Date().toISOString(),
      metadata: this.metadata,
      logFiles,
      legacyNativeLog,
    }));
    return outputPath;
  }

  close(): Promise<void> {
    return this.writer.flush();
  }
}

export function sanitizeDiagnosticValue(
  value: unknown,
  key = "",
  depth = 0,
): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeDiagnosticValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      result[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized === "authorization" ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential") ||
    normalized === "sdp" ||
    normalized === "offer" ||
    normalized === "answer"
  );
}

function sanitizeString(value: string): string {
  if (/^v=0(?:\r?\n|$)/.test(value)) return "[REDACTED_SDP]";
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|password|secret|credential)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, MAX_STRING_LENGTH);
}

export function createDiagnosticExport(input: {
  exportedAt: string;
  metadata: DiagnosticMetadata;
  logFiles: Buffer[];
  legacyNativeLog?: Buffer;
}): Buffer {
  const header = Buffer.from(`${JSON.stringify({
    timestamp: input.exportedAt,
    level: "info",
    scope: "diagnostics",
    event: "export.metadata",
    data: {
      schemaVersion: 1,
      exportedAt: input.exportedAt,
      metadata: sanitizeDiagnosticValue(input.metadata),
    },
  })}\n`, "utf8");
  const parts = [header];
  for (const logFile of input.logFiles) appendLineBuffer(parts, logFile);
  if (input.legacyNativeLog) {
    for (const line of input.legacyNativeLog.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      const match = /^(\S+)\s+(.*)$/.exec(line);
      const timestamp = match?.[1] && !Number.isNaN(Date.parse(match[1]))
        ? match[1]
        : input.exportedAt;
      parts.push(Buffer.from(`${JSON.stringify({
        timestamp,
        level: "info",
        scope: "native-media-legacy",
        event: "message",
        data: { message: sanitizeString(match?.[2] ?? line) },
      })}\n`, "utf8"));
    }
  }
  return Buffer.concat(parts);
}

function appendLineBuffer(target: Buffer[], source: Buffer): void {
  if (source.length === 0) return;
  target.push(source);
  if (source[source.length - 1] !== 0x0a) target.push(Buffer.from("\n"));
}

export function diagnosticFileName(path: string): string {
  return basename(path);
}
