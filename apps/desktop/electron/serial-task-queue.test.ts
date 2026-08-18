import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SerialTaskQueue } from "./serial-task-queue.js";

describe("native media operation queue", () => {
  it("never overlaps start, update, and stop operations", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const run = (name: string, delay: number) => queue.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`${name}:end`);
      active -= 1;
    });

    await Promise.all([run("start", 20), run("update", 5), run("stop", 1)]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(order, [
      "start:start", "start:end",
      "update:start", "update:end",
      "stop:start", "stop:end",
    ]);
  });

  it("continues after a failed operation", async () => {
    const queue = new SerialTaskQueue();
    await assert.rejects(queue.run(async () => { throw new Error("failed"); }));
    assert.equal(await queue.run(async () => "recovered"), "recovered");
  });
});
