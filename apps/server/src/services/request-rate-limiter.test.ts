import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestRateLimiter } from "./request-rate-limiter.js";

describe("RequestRateLimiter", () => {
  it("rejects requests above the window and resets afterwards", () => {
    const limiter = new RequestRateLimiter();
    assert.equal(limiter.consume("client", 2, 1_000, 0).allowed, true);
    assert.equal(limiter.consume("client", 2, 1_000, 10).allowed, true);
    const rejected = limiter.consume("client", 2, 1_000, 20);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfterSeconds, 1);
    assert.equal(limiter.consume("client", 2, 1_000, 1_000).allowed, true);
  });
});
