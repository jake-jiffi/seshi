import { test } from "node:test";
import assert from "node:assert/strict";

import { generateIdentity } from "../src/identity.ts";
import { openEnvelope, sealEnvelope, type Envelope } from "../src/envelope.ts";
import { Chain, envelopeHash } from "../src/chain.ts";

const HASH = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    convo: "c1",
    seq: 1,
    prev: null,
    from: "",
    act: "PROPOSE",
    headline: "hi",
    body: "there",
    ...over,
  };
}

/** Turns 1..n by one author, each pointing at the hash of the one before it. */
function run(n: number): Envelope[] {
  const out: Envelope[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const e = env({ seq, prev, body: `turn ${seq}` });
    out.push(e);
    prev = envelopeHash(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the hash covers, and the one field it must not
// ---------------------------------------------------------------------------

test("the hash ignores `from`, which the receiver rewrites", () => {
  const sender = env({ from: "" });
  const receiver = { ...sender, from: "a1b2c3d4e5f60718" };

  assert.notEqual(sender.from, receiver.from);
  assert.equal(envelopeHash(sender), envelopeHash(receiver));
});

test("a sealed turn hashes the same on both machines", () => {
  const a = generateIdentity();
  const b = generateIdentity();

  const mine = env({ headline: "proposal", body: "swap the deadline" });
  const theirs = openEnvelope(sealEnvelope(mine, a, b.seal.pub), b, a.sign.pub);

  // The receiver stamped its own value over `from`, per spec 5.1.
  assert.match(theirs.from, FINGERPRINT);
  assert.notEqual(theirs.from, mine.from);
  assert.equal(envelopeHash(theirs), envelopeHash(mine));
});

test("a sealed turn carrying a ledger and an artefact also hashes the same on both machines", () => {
  const a = generateIdentity();
  const b = generateIdentity();

  const mine = env({
    seq: 4,
    prev: `sha256:${"ab".repeat(32)}`,
    act: "COUNTER",
    ledger: [
      { id: "i-07", state: "proposed" },
      { id: "i-08", state: "open" },
    ],
    artefact: { diff: "--- a\n+++ b\n", sha256: "cafe" },
  });
  const theirs = openEnvelope(sealEnvelope(mine, a, b.seal.pub), b, a.sign.pub);

  assert.notEqual(theirs.from, mine.from);
  assert.equal(envelopeHash(theirs), envelopeHash(mine));
});

test("key insertion order does not change the hash, at any depth", () => {
  const prev = `sha256:${"ab".repeat(32)}`;

  const inOrder: Envelope = {
    v: 1,
    convo: "c1",
    seq: 2,
    prev,
    from: "x",
    act: "COUNTER",
    headline: "h",
    body: "b",
    ledger: [{ id: "i-07", state: "proposed" }],
    artefact: { diff: "d", sha256: "s" },
  };

  const shuffled: Envelope = {
    artefact: { sha256: "s", diff: "d" },
    ledger: [{ state: "proposed", id: "i-07" }],
    body: "b",
    headline: "h",
    act: "COUNTER",
    from: "x",
    prev,
    seq: 2,
    convo: "c1",
    v: 1,
  };

  // If this were equal the test would prove nothing: plain JSON keeps insertion order.
  assert.notEqual(JSON.stringify(inOrder), JSON.stringify(shuffled));
  assert.equal(envelopeHash(inOrder), envelopeHash(shuffled));
});

test("an absent optional field and an explicit undefined hash alike", () => {
  assert.equal(envelopeHash(env()), envelopeHash(env({ ledger: undefined, artefact: undefined })));
});

test("a property the wire would never carry does not change the hash", () => {
  // capEnvelope and friends spread, so a stray key can ride along on the sender's
  // local copy. sealEnvelope drops it, so the hash has to drop it too.
  const stowaway = { ...env(), tier_asserted: 4 } as Envelope;
  assert.equal(envelopeHash(stowaway), envelopeHash(env()));
});

test("the hash is a `prev` the envelope schema accepts on the wire", () => {
  const a = generateIdentity();
  const b = generateIdentity();

  const h = envelopeHash(env());
  assert.match(h, HASH);

  const next = env({ seq: 2, prev: h });
  const got = openEnvelope(sealEnvelope(next, a, b.seal.pub), b, a.sign.pub);
  assert.equal(got.prev, h);
});

test("changing any covered field changes the hash", () => {
  const h = envelopeHash(env());
  const variants: Envelope[] = [
    env({ convo: "c2" }),
    env({ seq: 2 }),
    env({ prev: `sha256:${"00".repeat(32)}` }),
    env({ act: "ACCEPT" }),
    env({ headline: "other" }),
    env({ body: "other" }),
    env({ ledger: [{ id: "i-01", state: "open" }] }),
    env({ artefact: { diff: "d", sha256: "s" } }),
  ];
  for (const variant of variants) {
    assert.notEqual(envelopeHash(variant), h);
  }
});

// ---------------------------------------------------------------------------
// The chain itself
// ---------------------------------------------------------------------------

test("a fresh chain expects turn 1 with a null prev", () => {
  const c = new Chain();
  assert.deepEqual(c.expectedNext(), { seq: 1, prev: null });
  assert.deepEqual(c.entries(), []);
  assert.equal(c.verify(env({ seq: 1, prev: null })), "ok");
  assert.equal(c.verify(env({ seq: 1, prev: `sha256:${"11".repeat(32)}` })), "fork");
});

test("a correct chain verifies", () => {
  const turns = run(3);
  const c = new Chain();

  for (const e of turns) {
    assert.equal(c.verify(e), "ok");
    c.append(e);
  }

  assert.deepEqual(c.entries(), turns);
  assert.deepEqual(c.expectedNext(), { seq: 4, prev: envelopeHash(turns[2]!) });
});

test("a skipped sequence reports a gap", () => {
  const turns = run(3);
  const c = new Chain();
  c.append(turns[0]!);

  assert.equal(c.verify(turns[2]!), "gap");
  assert.throws(() => c.append(turns[2]!), /gap/);
  // The rejected turn left nothing behind.
  assert.deepEqual(c.expectedNext(), { seq: 2, prev: envelopeHash(turns[0]!) });
  assert.equal(c.verify(turns[1]!), "ok");
});

test("a rewritten history reports a fork", () => {
  const turns = run(3);
  const c = new Chain();
  c.append(turns[0]!);
  c.append(turns[1]!);

  // Right sequence number, but pointing back past turn 2 at turn 1.
  const rewritten = env({ seq: 3, prev: envelopeHash(turns[0]!), body: "turn 3" });
  assert.equal(c.verify(rewritten), "fork");
  assert.throws(() => c.append(rewritten), /fork/);

  // Same seq and prev, different content: the fork is in the successor's prev.
  const edited = env({ seq: 2, prev: envelopeHash(turns[0]!), body: "edited" });
  const after = env({ seq: 3, prev: envelopeHash(edited), body: "turn 3" });
  assert.equal(c.verify(after), "fork");
});

test("replaying an old envelope reports a fork", () => {
  const turns = run(3);
  const c = new Chain();
  for (const e of turns) c.append(e);

  assert.equal(c.verify(turns[1]!), "fork");
  assert.throws(() => c.append(turns[1]!), /fork/);
  assert.equal(c.entries().length, 3);
});

test("entries() hands back a copy", () => {
  const turns = run(2);
  const c = new Chain();
  for (const e of turns) c.append(e);

  const got = c.entries();
  got.push(env({ seq: 99, prev: null }));
  got.length = 0;

  assert.equal(c.entries().length, 2);
  assert.deepEqual(c.expectedNext(), { seq: 3, prev: envelopeHash(turns[1]!) });
});

// ---------------------------------------------------------------------------
// The whole point: a chain built on one machine has to verify on the other
// ---------------------------------------------------------------------------

test("a chain built by the sender verifies on the receiver, `from` and all", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const sent = new Chain();
  const received = new Chain();

  for (const body of ["one", "two", "three"]) {
    const { seq, prev } = sent.expectedNext();
    const mine = env({ seq, prev, body });
    sent.append(mine);

    const theirs = openEnvelope(sealEnvelope(mine, a, b.seal.pub), b, a.sign.pub);
    assert.equal(received.verify(theirs), "ok");
    received.append(theirs);
  }

  assert.deepEqual(received.expectedNext(), sent.expectedNext());
  assert.equal(sent.entries()[1]!.from, "");
  assert.match(received.entries()[1]!.from, FINGERPRINT);
});

test("a receiver notices a turn that never arrived", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const sent = new Chain();
  const wire: Envelope[] = [];

  for (const body of ["one", "two", "three"]) {
    const { seq, prev } = sent.expectedNext();
    const mine = env({ seq, prev, body });
    sent.append(mine);
    wire.push(openEnvelope(sealEnvelope(mine, a, b.seal.pub), b, a.sign.pub));
  }

  const received = new Chain();
  received.append(wire[0]!);
  assert.equal(received.verify(wire[2]!), "gap");
});
