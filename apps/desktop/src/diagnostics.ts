import type { DiagnosticLogEntry } from "./vite-env";

export function diagnosticLog(
  scope: string,
  event: string,
  data?: unknown,
  level: DiagnosticLogEntry["level"] = "info",
): void {
  window.electronAPI?.logDiagnostic({ scope, event, data, level });
}

export function errorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

export function summarizeIceCandidate(candidate: RTCIceCandidate | RTCIceCandidateInit | null) {
  if (!candidate) return { complete: true };
  const raw = candidate.candidate ?? "";
  const parts = raw.split(/\s+/);
  const typeIndex = parts.indexOf("typ");
  const tcpTypeIndex = parts.indexOf("tcptype");
  return {
    complete: false,
    protocol: "protocol" in candidate && candidate.protocol
      ? candidate.protocol
      : parts[2]?.toLowerCase(),
    address: "address" in candidate && candidate.address
      ? candidate.address
      : parts[4],
    port: "port" in candidate && candidate.port
      ? candidate.port
      : Number(parts[5]) || undefined,
    candidateType: "type" in candidate && candidate.type
      ? candidate.type
      : typeIndex >= 0
        ? parts[typeIndex + 1]
        : undefined,
    tcpType: "tcpType" in candidate && candidate.tcpType
      ? candidate.tcpType
      : tcpTypeIndex >= 0
        ? parts[tcpTypeIndex + 1]
        : undefined,
  };
}

export function summarizeSdp(description: { type: string; sdp?: string }) {
  const sdp = description.sdp ?? "";
  const lines = sdp.split(/\r?\n/);
  const payloads = new Map<string, string>();
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+)\s+([^/\s]+)/i.exec(line);
    if (match) payloads.set(match[1]!, match[2]!.toUpperCase());
  }
  return {
    type: description.type,
    length: sdp.length,
    media: lines.filter((line) => line.startsWith("m=")).map((line) => {
      const [kind, _port, _protocol, ...ids] = line.slice(2).split(/\s+/);
      return { kind, codecs: ids.map((id) => payloads.get(id)).filter(Boolean) };
    }),
    candidateCount: lines.filter((line) => line.startsWith("a=candidate:")).length,
    directions: lines
      .filter((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))
      .map((line) => line.slice(2)),
  };
}

export function summarizeSignalMessage(message: { type: string }) {
  const record = message as Record<string, unknown>;
  return {
    type: message.type,
    connectionId: record.connectionId,
    participantId: record.participantId,
    targetParticipantId: record.targetParticipantId,
    transport: record.transport,
    reason: record.reason,
  };
}

export function installGlobalDiagnostics(): void {
  diagnosticLog("renderer", "started", {
    userAgent: navigator.userAgent,
    language: navigator.language,
    devicePixelRatio: window.devicePixelRatio,
  });
  window.addEventListener("error", (event) => {
    diagnosticLog(
      "renderer",
      "uncaught-error",
      { message: event.message, filename: event.filename, line: event.lineno, column: event.colno },
      "error",
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    diagnosticLog("renderer", "unhandled-rejection", errorDetails(event.reason), "error");
  });
}
