import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateRoomRequest } from "@gamecast/contracts";
import { DomainError } from "../domain/errors.js";
import { RoomService } from "./room-service.js";

const request: CreateRoomRequest = {
  title: "P2P Test",
  displayName: "Host",
  mediaMode: "hybrid",
  limits: { maxParticipants: 8, maxSharers: 4, maxViewersPerShare: 3 },
};

describe("RoomService P2P room rules", () => {
  it("enforces the eight participant room limit", async () => {
    const rooms = new RoomService();
    const host = await rooms.create(request, false);
    for (let index = 1; index < 8; index += 1) {
      await rooms.join(host.room.code, { displayName: `Member ${index}` });
    }
    await assert.rejects(
      () => rooms.join(host.room.code, { displayName: "Too many" }),
      (error) => error instanceof DomainError && error.code === "ROOM_FULL",
    );
  });

  it("enforces sharer and per-share viewer limits", async () => {
    const rooms = new RoomService();
    const host = await rooms.create(request, false);
    const members = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        rooms.join(host.room.code, { displayName: `Member ${index + 1}` }),
      ),
    );
    rooms.startShare(host.room.id, host.participant.id, "1080p", true);
    for (const member of members.slice(0, 3)) {
      rooms.requestWatch(
        host.room.id,
        member.participant.id,
        host.participant.id,
        crypto.randomUUID(),
      );
    }
    assert.throws(
      () =>
        rooms.requestWatch(
          host.room.id,
          members[3]!.participant.id,
          host.participant.id,
          crypto.randomUUID(),
        ),
      (error) => error instanceof DomainError && error.code === "VIEWER_LIMIT",
    );

    for (const member of members.slice(0, 3)) {
      rooms.startShare(host.room.id, member.participant.id, "720p", true);
    }
    assert.throws(
      () => rooms.startShare(host.room.id, members[3]!.participant.id, "720p", true),
      (error) => error instanceof DomainError && error.code === "SHARER_LIMIT",
    );
  });

  it("keeps one active watch while a switch is pending", async () => {
    const rooms = new RoomService();
    const host = await rooms.create(request, false);
    const viewer = await rooms.join(host.room.code, { displayName: "Viewer" });
    const other = await rooms.join(host.room.code, { displayName: "Other" });
    rooms.startShare(host.room.id, host.participant.id, "1080p", true);
    rooms.startShare(host.room.id, other.participant.id, "720p", false);

    const first = rooms.requestWatch(
      host.room.id,
      viewer.participant.id,
      host.participant.id,
      crypto.randomUUID(),
    ).relation;
    rooms.commitWatch(host.room.id, viewer.participant.id, first.connectionId, "p2p");
    assert.equal(rooms.getShareDescriptor(host.room, host.participant.id)?.viewerCount, 1);
    const pending = rooms.requestWatch(
      host.room.id,
      viewer.participant.id,
      other.participant.id,
      crypto.randomUUID(),
    ).relation;

    assert.equal(host.room.watches.size, 2);
    assert.equal(rooms.getShareDescriptor(host.room, host.participant.id)?.viewerCount, 1);
    assert.equal(rooms.getShareDescriptor(host.room, other.participant.id)?.viewerCount, 0);
    const committed = rooms.commitWatch(
      host.room.id,
      viewer.participant.id,
      pending.connectionId,
      "turn",
    );
    assert.equal(committed.releasedActive?.connectionId, first.connectionId);
    assert.equal(committed.relation.transport, "turn");
    assert.equal(host.room.watches.size, 1);
    assert.equal(rooms.getShareDescriptor(host.room, host.participant.id)?.viewerCount, 0);
    assert.equal(rooms.getShareDescriptor(host.room, other.participant.id)?.viewerCount, 1);
  });

  it("keeps an initial watch alive for the full client connection window", async () => {
    const rooms = new RoomService();
    const host = await rooms.create(request, false);
    const viewer = await rooms.join(host.room.code, { displayName: "Viewer" });
    rooms.startShare(host.room.id, host.participant.id, "1080p", true);
    const relation = rooms.requestWatch(
      host.room.id,
      viewer.participant.id,
      host.participant.id,
      crypto.randomUUID(),
    ).relation;

    assert.ok(relation.expiresAt);
    assert.ok(relation.expiresAt.getTime() - relation.createdAt.getTime() >= 20_000);
  });

  it("allows an active viewer to preconnect a replacement when the share is full", async () => {
    const rooms = new RoomService();
    const host = await rooms.create(request, false);
    const viewers = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        rooms.join(host.room.code, { displayName: `Viewer ${index + 1}` }),
      ),
    );
    rooms.startShare(host.room.id, host.participant.id, "1080p", true);

    const activeRelations = viewers.map((viewer) => {
      const relation = rooms.requestWatch(
        host.room.id,
        viewer.participant.id,
        host.participant.id,
        crypto.randomUUID(),
      ).relation;
      rooms.commitWatch(host.room.id, viewer.participant.id, relation.connectionId, "p2p");
      return relation;
    });

    const replacement = rooms.requestWatch(
      host.room.id,
      viewers[0]!.participant.id,
      host.participant.id,
      crypto.randomUUID(),
    ).relation;
    assert.equal(replacement.state, "pending");
    assert.equal(host.room.watches.size, 4);

    const committed = rooms.commitWatch(
      host.room.id,
      viewers[0]!.participant.id,
      replacement.connectionId,
      "p2p",
    );
    assert.equal(committed.releasedActive?.connectionId, activeRelations[0]!.connectionId);
    assert.equal(rooms.getShareDescriptor(host.room, host.participant.id)?.viewerCount, 3);
  });

  it("expires sessions and closes the room when the host leaves", async () => {
    const expiringRooms = new RoomService(0);
    const expired = await expiringRooms.create(request, false);
    assert.throws(
      () => expiringRooms.authenticate(expired.session.token),
      (error) => error instanceof DomainError && error.code === "INVALID_SESSION",
    );

    const rooms = new RoomService();
    const host = await rooms.create(request, false);
    await rooms.join(host.room.code, { displayName: "Viewer" });
    const removal = rooms.removeBySession(host.session.token);
    assert.equal(removal.roomClosed, true);
    assert.throws(() => rooms.findSummary(host.room.code));
  });

  it("verifies passwords asynchronously and renews active sessions", async () => {
    const rooms = new RoomService(10);
    const createdAt = Date.now();
    const host = await rooms.create({ ...request, password: "secret-room" }, false);
    await assert.rejects(
      () => rooms.join(host.room.code, { displayName: "Wrong", password: "wrong" }),
      (error) => error instanceof DomainError && error.code === "INVALID_PASSWORD",
    );
    const viewer = await rooms.join(
      host.room.code,
      { displayName: "Viewer", password: "secret-room" },
    );
    rooms.touchSession(host.session.token, createdAt + 5_000);
    rooms.touchSession(viewer.session.token, createdAt + 5_000);
    assert.equal(rooms.sweepExpiredSessions(createdAt + 11_000).length, 0);
    const removals = rooms.sweepExpiredSessions(createdAt + 16_000);
    assert.equal(removals.some((removal) => removal.participant.id === host.participant.id), true);
    assert.throws(() => rooms.findSummary(host.room.code));
  });
});
