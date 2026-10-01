import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseConnectionId,
  parseEasyTierStart,
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

  it("allows the main process to resolve a stored EasyTier secret", () => {
    const parsed = parseEasyTierStart({ networkName: "friends" });
    assert.equal(parsed.networkName, "friends");
    assert.equal(parsed.networkSecret, "");
  });

  it("accepts a relocated easytier-core.exe", () => {
    const parsed = parseEasyTierStart({
      networkName: "friends",
      executablePath: "D:\\tools\\easytier\\easytier-core.exe",
    });
    assert.equal(parsed.executablePath, "D:\\tools\\easytier\\easytier-core.exe");
  });

  it("refuses to launch anything that is not easytier-core.exe", () => {
    // `network:start` ends in `spawn(executablePath, ...)`, so this field must never name an
    // arbitrary binary: doing so turns a renderer compromise into host code execution.
    for (const executablePath of [
      "C:\\Windows\\System32\\calc.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "D:\\tools\\easytier-core.exe.bak",
      "/usr/bin/curl",
    ]) {
      assert.throws(
        () => parseEasyTierStart({ networkName: "friends", executablePath }),
        /easytier-core\.exe/,
        `expected ${executablePath} to be rejected`,
      );
    }
  });
});
