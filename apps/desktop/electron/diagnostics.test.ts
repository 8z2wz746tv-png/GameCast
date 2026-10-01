import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticExport, sanitizeDiagnosticValue } from "./diagnostics.js";

test("diagnostic sanitization removes secrets and raw SDP", () => {
  const sanitized = sanitizeDiagnosticValue({
    sessionToken: "room-token",
    password: "password",
    nested: {
      apiSecret: "secret",
      sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102",
      message: "Bearer abc.def and https://host/path?token=value&mode=p2p",
    },
  });
  assert.deepEqual(sanitized, {
    sessionToken: "[REDACTED]",
    password: "[REDACTED]",
    nested: {
      apiSecret: "[REDACTED]",
      sdp: "[REDACTED]",
      message: "Bearer [REDACTED] and https://host/path?token=[REDACTED]&mode=p2p",
    },
  });
});

test("diagnostic export combines metadata and all logs into one JSONL file", () => {
  const content = Buffer.from(
    '{"timestamp":"2026-09-01T00:00:01.000Z","scope":"viewer","event":"connected"}\n',
    "utf8",
  );
  const output = createDiagnosticExport({
    exportedAt: "2026-09-01T00:00:02.000Z",
    metadata: {
      appVersion: "0.3.7",
      platform: "win32",
      release: "10.0",
      arch: "x64",
      electronVersion: "43",
      chromeVersion: "150",
      nodeVersion: "24",
    },
    logFiles: [content],
    legacyNativeLog: Buffer.from(
      "2026-09-01T00:00:00.000Z publisher fps=60 sentPackets=1\n",
      "utf8",
    ),
  });
  const records = output.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.equal(records[0].event, "export.metadata");
  assert.equal(records[0].data.metadata.appVersion, "0.3.7");
  assert.equal(records[1].event, "connected");
  assert.equal(records[2].scope, "native-media-legacy");
  assert.equal(records[2].data.message, "publisher fps=60 sentPackets=1");
});
