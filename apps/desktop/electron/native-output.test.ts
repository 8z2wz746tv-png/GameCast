import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchNativeOutputPreviews,
  resolveNativeOutputIndex,
  type NativePreviewFrame,
} from "./native-output.js";

describe("native screen output mapping", () => {
  it("keeps the desktopCapturer mapping when the source id contains another number", () => {
    assert.equal(resolveNativeOutputIndex("screen:4:0", 0), 0);
  });

  it("only falls back to the source id when no mapping is available", () => {
    assert.equal(resolveNativeOutputIndex("screen:4:0"), 4);
    assert.equal(resolveNativeOutputIndex("window:4:0"), undefined);
  });
});

describe("native screen preview calibration", () => {
  it("matches Electron screens to DXGI outputs even when their order differs", () => {
    const blue = preview([220, 40, 20]);
    const green = preview([20, 210, 60]);
    const result = matchNativeOutputPreviews(
      [
        { sourceId: "screen:4:0", ...blue },
        { sourceId: "screen:1:0", ...green },
      ],
      [
        { outputIndex: 0, ...green },
        { outputIndex: 1, ...blue },
      ],
    );

    assert.equal(result.reliable, true);
    assert.deepEqual(
      result.matches.map(({ sourceId, outputIndex }) => ({ sourceId, outputIndex })),
      [
        { sourceId: "screen:4:0", outputIndex: 1 },
        { sourceId: "screen:1:0", outputIndex: 0 },
      ],
    );
  });

  it("rejects an ambiguous mapping instead of selecting an arbitrary screen", () => {
    const same = preview([30, 30, 30]);
    const result = matchNativeOutputPreviews(
      [
        { sourceId: "screen:1:0", ...same },
        { sourceId: "screen:2:0", ...same },
      ],
      [
        { outputIndex: 0, ...same },
        { outputIndex: 1, ...same },
      ],
    );

    assert.equal(result.reliable, false);
  });

  it("rejects incomplete preview data", () => {
    const result = matchNativeOutputPreviews(
      [{ sourceId: "screen:1:0", ...preview([0, 0, 0]) }],
      [],
    );
    assert.equal(result.reliable, false);
    assert.deepEqual(result.matches, []);
  });

  it("calibrates the outputs FFmpeg can access and leaves other screens unmapped", () => {
    const blue = preview([220, 40, 20]);
    const green = preview([20, 210, 60]);
    const result = matchNativeOutputPreviews(
      [
        { sourceId: "screen:external:0", ...blue },
        { sourceId: "screen:laptop:0", ...green },
      ],
      [{ outputIndex: 0, ...green }],
    );

    assert.equal(result.reliable, true);
    assert.deepEqual(result.matches.map(({ sourceId, outputIndex }) => ({ sourceId, outputIndex })), [
      { sourceId: "screen:laptop:0", outputIndex: 0 },
    ]);
  });
});

function preview([blue, green, red]: [number, number, number]): NativePreviewFrame {
  const width = 16;
  const height = 9;
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = blue;
    pixels[offset + 1] = green;
    pixels[offset + 2] = red;
    pixels[offset + 3] = 255;
  }
  return { width, height, pixels };
}
