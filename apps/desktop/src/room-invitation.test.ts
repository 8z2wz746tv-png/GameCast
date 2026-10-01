import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRoomInvitation, parseRoomInvitation } from "./room-invitation";

describe("room invitation", () => {
  it("round-trips the current one-line deep-link invitation", () => {
    const text = formatRoomInvitation({
      serverUrl: "http://100.64.0.10:8787",
      code: "abc123",
      title: "周末开黑",
    });
    assert.deepEqual(parseRoomInvitation(text), {
      serverUrl: "http://100.64.0.10:8787",
      code: "ABC123",
      title: "周末开黑",
    });
  });

  it("parses a bare gamecast deep link", () => {
    assert.deepEqual(
      parseRoomInvitation("gamecast://join?server=https%3A%2F%2Fcast.example.com&code=ab12cd&title=%E5%91%A8%E6%9C%AB"),
      {
        serverUrl: "https://cast.example.com",
        code: "AB12CD",
        title: "周末",
      },
    );
  });

  it("keeps compatibility with the old dot-separated invitation", () => {
    assert.deepEqual(
      parseRoomInvitation("http://100.64.0.10:8787 · XY12Z9 · 今晚一起玩"),
      {
        serverUrl: "http://100.64.0.10:8787",
        code: "XY12Z9",
        title: "今晚一起玩",
      },
    );
  });

  it("round-trips optional EasyTier network details", () => {
    const text = formatRoomInvitation({
      serverUrl: "http://10.0.0.2:8787",
      code: "ABC234",
      network: {
        mode: "easytier",
        name: "friends",
        secret: "local-only-secret",
        peers: ["tcp://1.2.3.4:11010"],
      },
    });
    assert.deepEqual(parseRoomInvitation(text), {
      serverUrl: "http://10.0.0.2:8787",
      code: "ABC234",
      network: {
        mode: "easytier",
        name: "friends",
        secret: "local-only-secret",
        peers: ["tcp://1.2.3.4:11010"],
      },
    });
  });

  it("does not reinterpret a plain server URL as an invitation", () => {
    assert.equal(parseRoomInvitation("http://100.64.0.10:8787"), undefined);
  });
});
