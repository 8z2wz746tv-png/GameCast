import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEasyTierArgs,
  detectNetworkKind,
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
});
