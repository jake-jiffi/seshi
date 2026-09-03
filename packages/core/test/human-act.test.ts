import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTS, openEnvelope, sealEnvelope } from "../src/envelope.ts";
import { fingerprint, generateIdentity } from "../src/identity.ts";

test("HUMAN is a valid act and survives the wire with the sender proven", () => {
  assert.ok((ACTS as readonly string[]).includes("HUMAN"));
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope(
    { v: 1, convo: "c1", seq: 1, prev: null, from: "", act: "HUMAN", headline: "h", body: "the human speaks" },
    a,
    b.seal.pub,
  );
  const e = openEnvelope(wire, b, a.sign.pub, a.seal.pub);
  assert.equal(e.act, "HUMAN");
  assert.equal(e.body, "the human speaks");
  assert.equal(e.from, fingerprint(a.sign.pub, a.seal.pub), "stamped by the receiver, as ever");
});
