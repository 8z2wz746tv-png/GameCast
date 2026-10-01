import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerSignalMessage } from "@gamecast/contracts";
import {
  type ActiveWatcher,
  describeWatchers,
  updateActiveWatchers,
} from "./watch-notice";

const watchRequested = (connectionId: string, id: string, displayName: string): ServerSignalMessage => ({
  type: "watch.requested",
  connectionId,
  viewer: { id, displayName, role: "member" },
});

const watchReleased = (connectionId: string, participantId: string): ServerSignalMessage => ({
  type: "watch.released",
  connectionId,
  participantId,
});

describe("active watchers", () => {
  it("tracks who is watching from watch.requested and watch.released", () => {
    let watchers: ActiveWatcher[] = [];
    watchers = updateActiveWatchers(watchers, watchRequested("c1", "u1", "小明"));
    watchers = updateActiveWatchers(watchers, watchRequested("c2", "u2", "小红"));
    assert.deepEqual(watchers.map((watcher) => watcher.displayName), ["小明", "小红"]);

    watchers = updateActiveWatchers(watchers, watchReleased("c1", "u1"));
    assert.deepEqual(watchers.map((watcher) => watcher.displayName), ["小红"]);
  });

  it("drops watchers who leave the room and clears on room close", () => {
    let watchers = updateActiveWatchers([], watchRequested("c1", "u1", "小明"));
    watchers = updateActiveWatchers(watchers, {
      type: "participant.left",
      participantId: "u1",
      participantCount: 0,
    });
    assert.deepEqual(watchers, []);

    watchers = updateActiveWatchers([], watchRequested("c2", "u2", "小红"));
    watchers = updateActiveWatchers(watchers, { type: "room.closed", reason: "房主已关闭房间" });
    assert.deepEqual(watchers, []);
  });

  it("replaces a repeated connection instead of double counting", () => {
    let watchers = updateActiveWatchers([], watchRequested("c1", "u1", "小明"));
    watchers = updateActiveWatchers(watchers, watchRequested("c1", "u1", "小明"));
    assert.equal(watchers.length, 1);
  });

  it("returns the same reference for unrelated messages so React can bail out", () => {
    const watchers = updateActiveWatchers([], watchRequested("c1", "u1", "小明"));
    assert.equal(updateActiveWatchers(watchers, { type: "heartbeat.ack", sentAt: 1 }), watchers);
  });

  it("describes the audience without alarming copy", () => {
    assert.equal(describeWatchers([]), "当前没有人在观看");
    assert.equal(
      describeWatchers([{ connectionId: "c1", id: "u1", displayName: "小明" }]),
      "小明 正在观看",
    );
    assert.equal(
      describeWatchers([
        { connectionId: "c1", id: "u1", displayName: "小明" },
        { connectionId: "c2", id: "u2", displayName: "小红" },
      ]),
      "小明、小红 正在观看",
    );
    assert.equal(
      describeWatchers([
        { connectionId: "c1", id: "u1", displayName: "小明" },
        { connectionId: "c2", id: "u2", displayName: "小红" },
        { connectionId: "c3", id: "u3", displayName: "小刚" },
      ]),
      "小明 等 3 人正在观看",
    );
  });
});
