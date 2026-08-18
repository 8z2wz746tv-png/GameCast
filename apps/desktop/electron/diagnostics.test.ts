import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { createZip, sanitizeDiagnosticValue } from "./diagnostics.js";

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

test("diagnostic ZIP contains a readable deflated entry", () => {
  const content = Buffer.from("viewer connected but decoded zero frames\n", "utf8");
  const archive = createZip([{ name: "logs/gamecast.log", data: content }]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const nameLength = archive.readUInt16LE(26);
  const compressedLength = archive.readUInt32LE(18);
  const dataOffset = 30 + nameLength;
  const compressed = archive.subarray(dataOffset, dataOffset + compressedLength);
  assert.deepEqual(inflateRawSync(compressed), content);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});
