import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDevServerUrl } from "./dev-server-url.js";

describe("dev server URL guard", () => {
  it("accepts a loopback dev server in an unpackaged build", () => {
    assert.equal(
      resolveDevServerUrl("http://127.0.0.1:5173", false),
      "http://127.0.0.1:5173/",
    );
    assert.equal(
      resolveDevServerUrl("http://localhost:5173/", false),
      "http://localhost:5173/",
    );
  });

  it("never honours the override in a packaged build", () => {
    // The window carries the preload bridge, so a packaged build must always load the bundled UI.
    assert.equal(resolveDevServerUrl("http://127.0.0.1:5173", true), undefined);
  });

  it("rejects remote, non-http and malformed origins", () => {
    for (const raw of [
      "http://evil.example.com/",
      "https://127.0.0.1:5173",
      "http://192.168.1.20:5173",
      "file:///tmp/index.html",
      "not a url",
      "",
      undefined,
    ]) {
      assert.equal(
        resolveDevServerUrl(raw, false),
        undefined,
        `expected ${String(raw)} to be rejected`,
      );
    }
  });
});
