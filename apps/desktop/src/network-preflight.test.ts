import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCandidateType } from "./p2p/ice-candidate-type";

describe("network preflight candidate parsing", () => {
  it("recognizes relay candidates", () => {
    assert.equal(
      extractCandidateType("candidate:1 1 udp 16777215 203.0.113.10 49160 typ relay raddr 0.0.0.0 rport 0"),
      "relay",
    );
  });

  it("recognizes server-reflexive candidates", () => {
    assert.equal(
      extractCandidateType("candidate:2 1 udp 2122260223 10.0.0.2 5000 typ srflx raddr 192.168.1.2 rport 5000"),
      "srflx",
    );
  });
});
