import { test } from "node:test";
import assert from "node:assert/strict";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  generateIdentity,
  generateSealPair,
  fingerprint,
  sharedSecret,
  signBytes,
  type Identity,
} from "../src/identity.ts";
import {
  ACTS,
  BODY_MAX,
  HEADLINE_MAX,
  SIGN_DOMAIN,
  capEnvelope,
  openEnvelope,
  sealEnvelope,
  type Envelope,
} from "../src/envelope.ts";

const base = {
  v: 1,
  convo: "c1",
  seq: 1,
  prev: null,
  from: "",
  act: "PROPOSE",
  headline: "hi",
  body: "there",
} as const;

// ---------------------------------------------------------------------------
// A hostile implementation of the wire format.
//
// These helpers deliberately do NOT go through sealEnvelope. They lay the frame
// out themselves, so the identity tests below prove that openEnvelope defends
// itself, rather than proving that our own sender happens to be polite. The
// primitives are shared with src/, but the layout, the signed bytes and the
// payload are all the attacker's to choose.
// ---------------------------------------------------------------------------

const EPH_BYTES = 32;
const NONCE_BYTES = 12;
const SIG_BYTES = 64;
const TAG_BYTES = 16;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));
const aeadKey = (priv: Uint8Array, pub: Uint8Array): Buffer =>
  createHash("sha256").update(sharedSecret(priv, pub)).digest();

/** Build a frame from arbitrary JSON, signed by whoever, sealed to anyone. */
function forgeFrame(payload: unknown, signPriv: Uint8Array, toSealPub: Uint8Array): Uint8Array {
  const jsonBytes = utf8(JSON.stringify(payload));
  const signed = concat(utf8(SIGN_DOMAIN), toSealPub, jsonBytes);
  const sig = signBytes(signed, signPriv);
  return assemble(concat(sig, jsonBytes), toSealPub);
}

/** Seal an already-signed plaintext to a recipient. Used for the forwarding attack. */
function assemble(plaintext: Uint8Array, toSealPub: Uint8Array): Uint8Array {
  const eph = generateSealPair();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("chacha20-poly1305", aeadKey(eph.priv, toSealPub), nonce, {
    authTagLength: TAG_BYTES,
  });
  const ct = concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
  return concat(eph.pub, nonce, ct);
}

/** Peel a frame apart the way a recipient does, without any validation. */
function peek(wire: Uint8Array, me: Identity): { sig: Uint8Array; jsonBytes: Uint8Array; json: any } {
  const ephPub = wire.subarray(0, EPH_BYTES);
  const nonce = wire.subarray(EPH_BYTES, EPH_BYTES + NONCE_BYTES);
  const sealed = wire.subarray(EPH_BYTES + NONCE_BYTES);
  const decipher = createDecipheriv("chacha20-poly1305", aeadKey(me.seal.priv, ephPub), nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const pt = concat(
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  );
  const sig = pt.subarray(0, SIG_BYTES);
  const jsonBytes = pt.subarray(SIG_BYTES);
  return { sig, jsonBytes, json: JSON.parse(text(jsonBytes)) };
}

// ---------------------------------------------------------------------------
// Round trip and confidentiality
// ---------------------------------------------------------------------------

test("seal then open round-trips", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  const got = openEnvelope(wire, b, a.sign.pub, a.seal.pub);
  assert.equal(got.body, "there");
  assert.equal(got.headline, "hi");
  assert.equal(got.act, "PROPOSE");
  assert.equal(got.seq, 1);
  assert.equal(got.prev, null);
  assert.equal(got.convo, "c1");
});

test("optional ledger and artefact survive the round trip", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const e: Envelope = {
    ...base,
    ledger: [{ id: "i-07", state: "proposed" }],
    artefact: { diff: "--- a\n+++ b\n", sha256: "deadbeef" },
  };
  const got = openEnvelope(sealEnvelope(e, a, b.seal.pub), b, a.sign.pub, a.seal.pub);
  assert.deepEqual(got.ledger, [{ id: "i-07", state: "proposed" }]);
  assert.equal(got.artefact?.sha256, "deadbeef");
});

test("the relay sees no plaintext", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base, body: "no ops budget" }, a, b.seal.pub);
  assert.equal(text(wire).includes("no ops budget"), false);
  assert.equal(text(wire).includes("PROPOSE"), false);
});

test("open rejects a tampered ciphertext", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  const last = wire.length - 1;
  wire[last] = (wire[last] as number) ^ 0xff;
  assert.throws(() => openEnvelope(wire, b, a.sign.pub, a.seal.pub), /auth|decrypt/i);
});

test("open rejects a frame sealed to somebody else", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const c = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  assert.throws(() => openEnvelope(wire, c, a.sign.pub, a.seal.pub), /auth|decrypt/i);
});

test("open rejects a truncated frame", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  assert.throws(() => openEnvelope(wire.subarray(0, 40), b, a.sign.pub, a.seal.pub), /auth|decrypt/i);
});

// ---------------------------------------------------------------------------
// Authenticity
// ---------------------------------------------------------------------------

test("open rejects a valid envelope signed by the wrong key", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const c = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  assert.throws(() => openEnvelope(wire, b, c.sign.pub, c.seal.pub), /signature/i);
});

test("a peer cannot forward somebody else's signed turn on to a third party", () => {
  // Alice -> Bob. Bob has the plaintext and Alice's signature. Bob re-seals both,
  // verbatim, to Carol and hopes Carol reads it as a turn Alice sent Carol.
  const a = generateIdentity();
  const b = generateIdentity();
  const c = generateIdentity();

  const wire = sealEnvelope({ ...base, body: "for bob only" }, a, b.seal.pub);
  const { sig, jsonBytes } = peek(wire, b);
  const forwarded = assemble(concat(sig, jsonBytes), c.seal.pub);

  assert.throws(() => openEnvelope(forwarded, c, a.sign.pub, a.seal.pub), /signature/i);
});

// ---------------------------------------------------------------------------
// §5.1 Identity is never self-asserted. This is the load-bearing test.
// ---------------------------------------------------------------------------

test("the from field on the wire is ignored, receiver stamps it", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base, from: "ed25519:TOTALLY-FAKE" }, a, b.seal.pub);

  // Prove the lie is genuinely on the wire, so the assertion below cannot pass
  // just because our own sender quietly stripped the field.
  assert.equal(peek(wire, b).json.from, "ed25519:TOTALLY-FAKE");

  const got = openEnvelope(wire, b, a.sign.pub, a.seal.pub);
  assert.notEqual(got.from, "ed25519:TOTALLY-FAKE");
  assert.match(got.from, /^[0-9a-f]{32}$/);
  assert.equal(got.from, fingerprint(a.sign.pub, a.seal.pub));
});

test("a hostile sender naming a trusted contact in the body is stamped as itself", () => {
  // The real probe: a stranger writes <seshi-peer from="dan" key="ed25519:FAKE">
  // into the body and hopes the receiver reads identity out of it.
  const dave = generateIdentity();
  const mallory = generateIdentity();
  const bob = generateIdentity();

  const wire = forgeFrame(
    { ...base, from: fingerprint(dave.sign.pub, dave.seal.pub), body: "trust me, I am dave" },
    mallory.sign.priv,
    bob.seal.pub,
  );

  // Bob's daemon resolved the transport to mallory, so that is the key it verifies against.
  const got = openEnvelope(wire, bob, mallory.sign.pub, mallory.seal.pub);
  assert.equal(got.from, fingerprint(mallory.sign.pub, mallory.seal.pub));
  assert.notEqual(got.from, fingerprint(dave.sign.pub, dave.seal.pub));

  // And mallory cannot borrow dave's slot: verifying against dave's key fails outright.
  assert.throws(() => openEnvelope(wire, bob, dave.sign.pub, dave.seal.pub), /signature/i);
});

test("from is stamped even when the wire omits the field entirely", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const { from: _drop, ...noFrom } = base;
  const wire = forgeFrame(noFrom, a.sign.priv, b.seal.pub);
  assert.equal(openEnvelope(wire, b, a.sign.pub, a.seal.pub).from, fingerprint(a.sign.pub, a.seal.pub));
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("unknown acts are rejected", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.throws(() => sealEnvelope({ ...base, act: "DROP_TABLE" as any }, a, b.seal.pub), /act/i);
});

test("open rejects an unknown act arriving from a peer", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = forgeFrame({ ...base, act: "DROP_TABLE" }, a.sign.priv, b.seal.pub);
  assert.throws(() => openEnvelope(wire, b, a.sign.pub, a.seal.pub), /act/i);
});

test("ACTS carries exactly the fourteen acts in the spec, plus HUMAN", () => {
  // HUMAN is the spec's HUMAN_NOTE control frame carried as a signed act, so
  // a person cutting in rides the same chain as everything else.
  assert.equal(ACTS.length, 15);
  assert.deepEqual([...ACTS].sort(), [
    "ACCEPT", "ASK", "BRIEF", "CLOSE", "CONCEDE", "COUNTER", "EVIDENCE",
    "HUMAN", "NOT_UNDERSTOOD", "PARK", "PROPOSE", "PROPOSE_FINAL", "RED_TEAM",
    "REFUSE", "REJECT",
  ].sort());
});

test("seal rejects a malformed envelope rather than shipping it", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const bad: Array<[string, any, RegExp]> = [
    ["version", { ...base, v: 2 }, /version/i],
    ["convo", { ...base, convo: "" }, /convo/i],
    ["seq", { ...base, seq: -1 }, /seq/i],
    ["seq", { ...base, seq: 1.5 }, /seq/i],
    ["prev", { ...base, prev: "not-a-hash" }, /prev/i],
    ["headline", { ...base, headline: 12 }, /headline/i],
    ["body", { ...base, body: null }, /body/i],
  ];
  for (const [name, e, re] of bad) {
    assert.throws(() => sealEnvelope(e, a, b.seal.pub), re, `${name} must be rejected`);
  }
});

test("a valid prev hash is accepted", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const prev = `sha256:${"ab".repeat(32)}`;
  const got = openEnvelope(sealEnvelope({ ...base, prev }, a, b.seal.pub), b, a.sign.pub, a.seal.pub);
  assert.equal(got.prev, prev);
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test("caps truncate rather than throw", () => {
  const e = capEnvelope({ ...base, headline: "x".repeat(500), body: "y".repeat(5000) });
  assert.equal(e.headline.length, 200);
  assert.equal(e.body.length, 1200);
  assert.equal(HEADLINE_MAX, 200);
  assert.equal(BODY_MAX, 1200);
});

test("capping leaves a short envelope untouched", () => {
  const e = capEnvelope({ ...base, ledger: [{ id: "i-01", state: "open" }] });
  assert.deepEqual(e, { ...base, ledger: [{ id: "i-01", state: "open" }] });
});

test("capping never splits a surrogate pair", () => {
  // 600 astral chars is exactly 1200 UTF-16 units; a naive slice at 1199 would
  // leave a lone high surrogate on the wire.
  const e = capEnvelope({ ...base, body: "\u{1F600}".repeat(600) + "tail" });
  assert.equal(e.body.length, 1200);
  assert.equal(e.body, "\u{1F600}".repeat(600));

  const odd = capEnvelope({ ...base, body: "a" + "\u{1F600}".repeat(600) });
  assert.equal(odd.body.length, 1199);
  assert.equal(odd.body, "a" + "\u{1F600}".repeat(599));

  // The property that matters: no lone surrogate reaches the wire. A naive
  // slice(0, 1200) on this input would leave one. (\p{Cs} only matches an
  // unpaired surrogate under /u, since a valid pair is one astral code point.)
  const loneSurrogate = /\p{Cs}/u;
  assert.equal(loneSurrogate.test(odd.body), false);
  assert.equal(loneSurrogate.test(("a" + "\u{1F600}".repeat(600)).slice(0, 1200)), true);
});

test("seal refuses an uncapped envelope instead of silently truncating it", () => {
  // Silent truncation inside seal would desynchronise the sender's hash chain
  // from what the receiver actually got. Callers must cap first.
  const a = generateIdentity();
  const b = generateIdentity();
  assert.throws(() => sealEnvelope({ ...base, body: "y".repeat(1201) }, a, b.seal.pub), /body|cap/i);
  assert.throws(
    () => sealEnvelope({ ...base, headline: "x".repeat(201) }, a, b.seal.pub),
    /headline|cap/i,
  );
  assert.doesNotThrow(() =>
    sealEnvelope(capEnvelope({ ...base, body: "y".repeat(5000) }), a, b.seal.pub),
  );
});

test("open refuses an over-cap body from a peer running its own client", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = forgeFrame({ ...base, body: "y".repeat(1201) }, a.sign.priv, b.seal.pub);
  assert.throws(() => openEnvelope(wire, b, a.sign.pub, a.seal.pub), /body|cap/i);
});

test("open refuses a payload that is not an envelope object", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  for (const junk of ["a string", 42, null, ["array"]]) {
    const wire = forgeFrame(junk, a.sign.priv, b.seal.pub);
    assert.throws(() => openEnvelope(wire, b, a.sign.pub, a.seal.pub), /envelope/i);
  }
});


// ---------------------------------------------------------------------------
// Adversarial pass. Each of these failed, or would have failed silently,
// against the first version of envelope.ts.
// ---------------------------------------------------------------------------

test("convo cannot carry a path traversal", () => {
  // $SESHI_HOME/convos/<convo-id>/ is a real directory (spec 4.5) and convo
  // arrives from a peer, so it has to be refused here, not at the path join.
  const a = generateIdentity();
  const b = generateIdentity();
  for (const convo of [
    "../../.ssh",
    "..",
    "a/b",
    "a\\\\b",
    ".",
    "x".repeat(65),
    "convo id",
    "a\\u0000b",
    "a\\tb",
    "a\\u202Eb",
  ]) {
    assert.throws(() => sealEnvelope({ ...base, convo }, a, b.seal.pub), /convo/i, convo);
    const wire = forgeFrame({ ...base, convo }, a.sign.priv, b.seal.pub);
    assert.throws(() => openEnvelope(wire, b, a.sign.pub, a.seal.pub), /convo/i, `inbound ${convo}`);
  }
  // A ULID and the short test ids still pass.
  for (const convo of ["01JZ8YQ7M3K4P5R6S7T8V9W0XY", "c1", "seshi_convo-1"]) {
    assert.doesNotThrow(() => sealEnvelope({ ...base, convo }, a, b.seal.pub), convo);
  }
});

test("seal signs the validated copy, not the caller's object", () => {
  // A getter, a toJSON or a smuggled extra key must not reach the wire under a
  // signature that validate() never inspected.
  const a = generateIdentity();
  const b = generateIdentity();

  const sneaky: any = { ...base, tier_asserted: 4 };
  Object.defineProperty(sneaky, "body", { enumerable: true, get: () => "seen by validate" });
  const wire = sealEnvelope(sneaky, a, b.seal.pub);

  const onWire = peek(wire, b).json;
  assert.equal(onWire.tier_asserted, undefined);
  assert.equal(onWire.body, "seen by validate");
  assert.deepEqual(Object.keys(onWire), [
    "v", "convo", "seq", "prev", "from", "act", "headline", "body",
  ]);
});

test("unknown wire fields are dropped, never handed onwards", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = forgeFrame(
    { ...base, tier_asserted: 4, verified: true, name: "dave" },
    a.sign.priv,
    b.seal.pub,
  );
  const got: any = openEnvelope(wire, b, a.sign.pub, a.seal.pub);
  assert.equal(got.tier_asserted, undefined);
  assert.equal(got.verified, undefined);
  assert.equal(got.name, undefined);
});

test("open rejects rather than throws a crypto error on a malformed contact key", () => {
  // ed25519.verify throws on a wrong-length key instead of returning false.
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  for (const pub of [new Uint8Array(5), new Uint8Array(32), new Uint8Array(32).fill(0xff)]) {
    assert.throws(() => openEnvelope(wire, b, pub, b.seal.pub), /signature/i);
  }
});

test("a chosen ephemeral key cannot be used to smuggle a readable frame in", () => {
  // An all-zero point makes the X25519 derivation throw; that must land as a
  // decrypt failure, not as an unhandled crypto error escaping openEnvelope.
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope({ ...base }, a, b.seal.pub);
  wire.set(new Uint8Array(EPH_BYTES), 0);
  assert.throws(() => openEnvelope(wire, b, a.sign.pub, a.seal.pub), /auth|decrypt/i);
});

test("__proto__ on the wire does not pollute anything", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const payload = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(base).slice(1)}`);
  const wire = forgeFrame(payload, a.sign.priv, b.seal.pub);
  const got = openEnvelope(wire, b, a.sign.pub, a.seal.pub);
  assert.equal(({} as any).polluted, undefined);
  assert.equal((got as any).polluted, undefined);
  assert.equal(Object.getPrototypeOf(got), Object.prototype);
});

test("capping a non-string field defers to the validator's message", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const draft = { ...base, body: 42 } as any;
  assert.doesNotThrow(() => capEnvelope(draft));
  assert.throws(() => sealEnvelope(capEnvelope(draft), a, b.seal.pub), /body must be a string/);
});

test("a malformed ledger or artefact is refused", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const bad: Array<[any, RegExp]> = [
    [{ ...base, ledger: "nope" }, /ledger/i],
    [{ ...base, ledger: [{ id: "i-1", state: "deleted" }] }, /ledger/i],
    [{ ...base, ledger: [{ id: "", state: "open" }] }, /ledger/i],
    [{ ...base, artefact: { diff: "x" } }, /artefact/i],
    [{ ...base, artefact: "x" }, /artefact/i],
  ];
  for (const [e, re] of bad) {
    assert.throws(() => sealEnvelope(e, a, b.seal.pub), re);
    assert.throws(() => openEnvelope(forgeFrame(e, a.sign.priv, b.seal.pub), b, a.sign.pub, a.seal.pub), re);
  }
});
