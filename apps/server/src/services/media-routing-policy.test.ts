import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectInitialMediaRoute } from "./media-routing-policy.js";

describe("initial media routing policy", () => {
  it("keeps the first viewer on P2P and routes later viewers through SFU", () => {
    assert.equal(selectInitialMediaRoute({
      sfuAvailable: true,
      existingViewerCount: 0,
      sfuViewerThreshold: 2,
    }), "p2p");
    assert.equal(selectInitialMediaRoute({
      sfuAvailable: true,
      existingViewerCount: 1,
      sfuViewerThreshold: 2,
    }), "sfu");
  });

  it("never selects SFU when the service is unavailable", () => {
    assert.equal(selectInitialMediaRoute({
      sfuAvailable: false,
      existingViewerCount: 5,
      sfuViewerThreshold: 2,
    }), "p2p");
  });
});
