import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AsyncLineWriter } from "./async-line-writer.js";

test("AsyncLineWriter batches lines without losing order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamecast-log-"));
  try {
    const path = join(directory, "gamecast.log");
    const writer = new AsyncLineWriter(path, 1_024, 3, 5);
    writer.write("first\n");
    writer.write("second\n");
    await writer.flush();
    assert.equal(await readFile(path, "utf8"), "first\nsecond\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
