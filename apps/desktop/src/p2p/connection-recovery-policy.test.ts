import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getConnectionRecoveryAction,
  getPendingConnectionFailureAction,
} from "./connection-recovery-policy";

describe("connection recovery policy", () => {
  it("falls back when a pending P2P connection fails", () => {
    assert.equal(getConnectionRecoveryAction({
      failedConnectionId: "pending",
      targetParticipantId: "sharer",
      pendingConnectionId: "pending",
      cooldownUntil: 0,
      now: 1,
    }), "request-fallback");
  });

  it("replaces a committed connection without clearing the old picture first", () => {
    assert.equal(getConnectionRecoveryAction({
      failedConnectionId: "active",
      targetParticipantId: "sharer",
      activeConnectionId: "active",
      displayedConnectionId: "active",
      desiredTargetId: "sharer",
      cooldownUntil: 0,
      now: 1,
    }), "replace-active");
  });

  it("does not start overlapping recoveries", () => {
    assert.equal(getConnectionRecoveryAction({
      failedConnectionId: "active",
      targetParticipantId: "sharer",
      pendingConnectionId: "replacement",
      activeConnectionId: "active",
      displayedConnectionId: "active",
      desiredTargetId: "sharer",
      cooldownUntil: 0,
      now: 1,
    }), "none");
  });
});

describe("initial P2P retry policy", () => {
  it("retries the first failed attempt with a fresh watching relation", () => {
    assert.equal(getPendingConnectionFailureAction({
      attempt: 1,
      maxAttempts: 2,
      connectionId: "first",
      pendingConnectionId: "first",
      targetParticipantId: "sharer",
      desiredTargetId: "sharer",
    }), "retry-p2p");
  });

  it("requests configured fallback only after the retry also fails", () => {
    assert.equal(getPendingConnectionFailureAction({
      attempt: 2,
      maxAttempts: 2,
      connectionId: "second",
      pendingConnectionId: "second",
      targetParticipantId: "sharer",
      desiredTargetId: "sharer",
    }), "request-fallback");
  });

  it("cancels recovery when the user has selected another sharer", () => {
    assert.equal(getPendingConnectionFailureAction({
      attempt: 1,
      maxAttempts: 2,
      connectionId: "first",
      pendingConnectionId: "first",
      targetParticipantId: "old-sharer",
      desiredTargetId: "new-sharer",
    }), "none");
  });
});
