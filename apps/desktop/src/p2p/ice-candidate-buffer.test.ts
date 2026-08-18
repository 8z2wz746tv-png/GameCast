import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IceCandidateBuffer } from "./ice-candidate-buffer";

describe("IceCandidateBuffer", () => {
  it("bounds candidates per connection and consumes them once", () => {
    const buffer = new IceCandidateBuffer<number>(4, 2, 1_000);
    buffer.push("a", 1, 0);
    buffer.push("a", 2, 0);
    buffer.push("a", 3, 0);
    assert.deepEqual(buffer.take("a", 10), [1, 2]);
    assert.deepEqual(buffer.take("a", 10), []);
  });

  it("drops expired and oldest unknown connections", () => {
    const buffer = new IceCandidateBuffer<number>(2, 4, 100);
    buffer.push("a", 1, 0);
    buffer.push("b", 2, 0);
    buffer.push("c", 3, 10);
    assert.deepEqual(buffer.take("a", 10), []);
    assert.deepEqual(buffer.take("b", 10), [2]);
    buffer.push("d", 4, 20);
    assert.deepEqual(buffer.take("d", 121), []);
  });
});
