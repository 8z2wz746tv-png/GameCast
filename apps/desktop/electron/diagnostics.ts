import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateRawSync } from "node:zlib";
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
    const entries: Array<{ name: string; data: Buffer }> = [];
    for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
      const rotatedPath = `${this.logPath}.${index}`;
      if (existsSync(rotatedPath)) {
        entries.push({
          name: `logs/gamecast.log.${index}`,
          data: readFileSync(rotatedPath),
        });
      }
    }
    if (existsSync(this.logPath)) {
      entries.push({ name: "logs/gamecast.log", data: readFileSync(this.logPath) });
    }
    const nativeMediaPath = join(this.userDataPath, "native-media.log");
    if (existsSync(nativeMediaPath)) {
      entries.push({ name: "logs/native-media.log", data: readFileSync(nativeMediaPath) });
    }
    entries.push({
      name: "diagnostics.json",
      data: Buffer.from(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            metadata: sanitizeDiagnosticValue(this.metadata),
          },
          null,
          2,
        ),
        "utf8",
      ),
    });

    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
    const outputPath = join(this.desktopPath, `GameCast-diagnostics-${timestamp}.zip`);
    writeFileSync(outputPath, createZip(entries));
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

export function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = toDosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

export function diagnosticFileName(path: string): string {
  return basename(path);
}
