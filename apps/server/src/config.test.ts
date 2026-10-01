import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insecureDefaultSecrets } from "./config.js";

describe("insecure default secrets", () => {
  it("flags LiveKit keys that still match the shipped examples", () => {
    assert.deepEqual(
      insecureDefaultSecrets({
        livekitApiKey: "devkey",
        livekitApiSecret: "devsecret-change-before-production",
        allowInsecureDefaults: false,
      }),
      ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
    );
    assert.deepEqual(
      insecureDefaultSecrets({
        livekitApiKey: "devkey",
        livekitApiSecret: "a-real-rotated-secret",
        allowInsecureDefaults: false,
      }),
      ["LIVEKIT_API_KEY"],
    );
  });

  it("accepts rotated secrets and an explicitly disabled SFU", () => {
    assert.deepEqual(
      insecureDefaultSecrets({
        livekitApiKey: "prod-key",
        livekitApiSecret: "a-real-rotated-secret",
        allowInsecureDefaults: false,
      }),
      [],
    );
    // No livekit config means SFU is off, so there are no keys to judge.
    assert.deepEqual(
      insecureDefaultSecrets({ allowInsecureDefaults: false }),
      [],
    );
  });

  it("honours the explicit local-development escape hatch", () => {
    assert.deepEqual(
      insecureDefaultSecrets({
        livekitApiKey: "devkey",
        livekitApiSecret: "devsecret-change-before-production",
        allowInsecureDefaults: true,
      }),
      [],
    );
  });
});
