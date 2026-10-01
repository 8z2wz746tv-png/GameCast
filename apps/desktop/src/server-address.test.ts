import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPrivateControlServerUrl } from "./server-address";

describe("control server address classification", () => {
  it("rejects addresses that cannot be reached from the public internet", () => {
    for (const address of [
      "http://192.168.1.27:8787",
      "http://10.0.0.4:8787",
      "http://172.20.0.4:8787",
      "http://100.100.10.4:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ]) assert.equal(isPrivateControlServerUrl(address), true, address);
  });

  it("allows public IPs and hostnames", () => {
    assert.equal(isPrivateControlServerUrl("https://203.0.113.10"), false);
    assert.equal(isPrivateControlServerUrl("https://control.gamecast.example"), false);
  });
});
