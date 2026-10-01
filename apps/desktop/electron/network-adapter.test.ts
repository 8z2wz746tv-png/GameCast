import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildEasyTierArgs,
  detectNetworkKind,
  isEasyTierExecutablePath,
  resolveEasyTierExecutable,
} from "./network-adapter.js";

describe("embedded network adapter helpers", () => {
  it("recognizes supported virtual network adapters", () => {
    assert.equal(detectNetworkKind("EasyTier Virtual Adapter"), "easytier");
    assert.equal(detectNetworkKind("Tailscale Tunnel"), "tailscale");
    assert.equal(detectNetworkKind("Ethernet"), "other");
  });

  it("builds bounded EasyTier arguments without secrets in logs", () => {
    const args = buildEasyTierArgs({
      networkName: "friends",
      networkSecret: "secret",
      peers: ["tcp://1.2.3.4:11010"],
      configDir: "C:\\GameCast\\easytier",
    });
    assert.deepEqual(args, [
      "--network-name", "friends",
      "--network-secret", "secret",
      "--dhcp", "true",
      "--listeners", "11010",
      "--hostname", "GameCast",
      "--instance-name", "gamecast",
      "--config-dir", "C:\\GameCast\\easytier",
      "--rpc-portal", "127.0.0.1:0",
      "--default-protocol", "udp",
      "--peers", "tcp://1.2.3.4:11010",
    ]);
  });

  it("only resolves an executable that exists", () => {
    assert.equal(resolveEasyTierExecutable(undefined, "C:\\missing", "C:\\missing"), undefined);
  });

  it("classifies Windows paths regardless of host platform", () => {
    assert.equal(isEasyTierExecutablePath("C:\\tools\\EasyTier-Core.EXE"), true);
    assert.equal(isEasyTierExecutablePath("/opt/easytier/easytier-core.exe"), true);
    assert.equal(isEasyTierExecutablePath("C:\\Windows\\System32\\calc.exe"), false);
    assert.equal(isEasyTierExecutablePath("D:\\tools\\easytier-core.exe.bak"), false);
  });

  it("ignores a configured path that is not easytier-core.exe, even when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamecast-easytier-"));
    const missing = join(dir, "missing");
    try {
      // Existence alone must not be enough — that was the whole vulnerability.
      const decoy = join(dir, "calc.exe");
      writeFileSync(decoy, "");
      assert.equal(resolveEasyTierExecutable(decoy, missing, missing), undefined);

      const real = join(dir, "easytier-core.exe");
      writeFileSync(real, "");
      assert.equal(resolveEasyTierExecutable(real, missing, missing), real);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
