import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRoomInvitation, parseRoomInvitation } from "./room-invitation";

describe("room invitation", () => {
  it("round-trips the current multiline template", () => {
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

  it("does not reinterpret a plain server URL as an invitation", () => {
    assert.equal(parseRoomInvitation("http://100.64.0.10:8787"), undefined);
  });
});
