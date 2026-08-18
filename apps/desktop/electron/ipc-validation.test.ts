import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseConnectionId,
  parseIpv4Address,
  parseNativeStart,
} from "./ipc-validation.js";

describe("Electron IPC validation", () => {
  it("accepts a bounded native media request", () => {
    const parsed = parseNativeStart({
      sourceId: "screen:0:0",
      preset: {
        name: "1080p",
        label: "1080p",
        width: 1920,
        height: 1080,
        frameRate: 60,
      },
      maxBitrate: 12_000_000,
      iceServers: [],
      allowedHostAddresses: ["100.64.0.1"],
    });
    assert.equal(parsed.preset.name, "1080p");
  });

  it("rejects malformed addresses and connection identifiers", () => {
    assert.throws(() => parseIpv4Address("not-an-ip"));
    assert.throws(() => parseConnectionId("not-a-uuid"));
  });
});
