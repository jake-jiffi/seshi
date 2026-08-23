import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateIdentity,
  fingerprint,
  safetyWords,
  serializeIdentity,
  parseIdentity,
  sharedSecret,
  signBytes,
  verifyBytes,
} from "../src/identity.ts";
import { WORDLIST } from "../src/wordlist.ts";

test("identity has distinct signing and sealing keys", () => {
  const id = generateIdentity();
  assert.equal(id.sign.pub.length, 32);
  assert.equal(id.seal.pub.length, 32);
  assert.equal(id.sign.priv.length, 32);
  assert.equal(id.seal.priv.length, 32);
  assert.notDeepEqual(id.sign.pub, id.seal.pub);
});

test("two identities are different", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.notDeepEqual(a.sign.priv, b.sign.priv);
  assert.notDeepEqual(a.seal.priv, b.seal.priv);
});

test("fingerprint is stable, 32 hex chars", () => {
  const id = generateIdentity();
  const f = fingerprint(id.sign.pub, id.seal.pub);
  assert.match(f, /^[0-9a-f]{32}$/);
  assert.equal(f, fingerprint(id.sign.pub, id.seal.pub));
});

test("fingerprint differs for different keys", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.notEqual(fingerprint(a.sign.pub, a.seal.pub), fingerprint(b.sign.pub, b.seal.pub));
});

test("fingerprint rejects anything that is not a 32 byte key", () => {
  assert.throws(() => fingerprint(new Uint8Array(31), new Uint8Array(32)), /32/);
  assert.throws(() => fingerprint(new Uint8Array(33), new Uint8Array(32)), /32/);
  assert.throws(() => fingerprint(new Uint8Array(32), new Uint8Array(31)), /32/);
});

test("safety words are deterministic and come from the wordlist", () => {
  const secret = new Uint8Array(32).fill(7);
  const a = safetyWords(secret);
  assert.equal(a.length, 4);
  assert.deepEqual(a, safetyWords(secret));
  const other = new Uint8Array(32).fill(8);
  assert.notDeepEqual(a, safetyWords(other));
  for (const w of a) assert.ok(WORDLIST.includes(w), `${w} must come from the wordlist`);
});

test("safety words honour n and refuse an out of range n", () => {
  const secret = new Uint8Array(32).fill(3);
  assert.equal(safetyWords(secret, 2).length, 2);
  assert.equal(safetyWords(secret, 16).length, 16);
  // the first n words are a prefix of a longer draw, so 3-word sensitive codes
  // extend the 2-word code rather than replacing it
  assert.deepEqual(safetyWords(secret, 2), safetyWords(secret, 4).slice(0, 2));
  assert.throws(() => safetyWords(secret, 0), /between 1 and 16/);
  assert.throws(() => safetyWords(secret, 17), /between 1 and 16/);
  assert.throws(() => safetyWords(secret, 2.5), /between 1 and 16/);
});

test("identity round-trips through serialization", () => {
  const id = generateIdentity();
  const back = parseIdentity(serializeIdentity(id));
  assert.deepEqual(back.sign.priv, id.sign.priv);
  assert.deepEqual(back.sign.pub, id.sign.pub);
  assert.deepEqual(back.seal.priv, id.seal.priv);
  assert.deepEqual(back.seal.pub, id.seal.pub);
});

test("a round-tripped identity still signs, verifies and agrees on a shared secret", () => {
  const a = parseIdentity(serializeIdentity(generateIdentity()));
  const b = parseIdentity(serializeIdentity(generateIdentity()));
  const msg = new TextEncoder().encode("the artefact both sides sign");

  assert.ok(verifyBytes(signBytes(msg, a.sign.priv), msg, a.sign.pub));
  assert.ok(!verifyBytes(signBytes(msg, a.sign.priv), msg, b.sign.pub));

  const fromA = sharedSecret(a.seal.priv, b.seal.pub);
  const fromB = sharedSecret(b.seal.priv, a.seal.pub);
  assert.deepEqual(fromA, fromB);
  // the point of safety words: both humans read the same list off their own machine
  assert.deepEqual(safetyWords(fromA), safetyWords(fromB));
});

// ---------------------------------------------------------------------------
// Known answers, not self-consistency.
//
// Signing and key agreement now run through node:crypto, which takes DER and
// not the 32 raw bytes seshi stores. A wrong DER wrapper would be invisible to
// every test above, because both ends of the round trip would be wrong the same
// way, and seshi would happily talk to itself in a dialect no other Ed25519 or
// X25519 implementation understands. These two vectors are the fixed point.
// ---------------------------------------------------------------------------

const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

test("signing matches RFC 8032 test vector 1", () => {
  const priv = unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const pub = unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const expected =
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

  const sig = signBytes(new Uint8Array(0), priv);
  assert.equal(Buffer.from(sig).toString("hex"), expected);
  assert.ok(verifyBytes(sig, new Uint8Array(0), pub));
});

test("key agreement matches RFC 7748 section 6.1", () => {
  const alicePriv = unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const alicePub = unhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  const bobPriv = unhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPub = unhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  const expected = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

  assert.equal(Buffer.from(sharedSecret(alicePriv, bobPub)).toString("hex"), expected);
  assert.equal(Buffer.from(sharedSecret(bobPriv, alicePub)).toString("hex"), expected);
});

test("a key with bytes glued on the end is not the same key", () => {
  // DER declares its own length and OpenSSL stops reading there, so `key + junk`
  // parses as `key` unless something refuses it. That would be one key with
  // infinitely many spellings, only one of which has the right fingerprint.
  const id = generateIdentity();
  const msg = new TextEncoder().encode("one key, one spelling");
  const sig = signBytes(msg, id.sign.priv);
  const padded = new Uint8Array(33);
  padded.set(id.sign.pub, 0);

  assert.ok(verifyBytes(sig, msg, id.sign.pub), "the real key still verifies");
  assert.equal(verifyBytes(sig, msg, padded), false);
  assert.throws(() => sharedSecret(id.seal.priv, padded), /32 bytes/);
  assert.throws(() => signBytes(msg, new Uint8Array(33)), /32 bytes/);
});

test("an all-zero peer key is refused rather than agreed with", () => {
  // The all-zero point has no shared secret worth the name. node throws; the
  // envelope layer relies on that landing as a decrypt failure.
  const id = generateIdentity();
  assert.throws(() => sharedSecret(id.seal.priv, new Uint8Array(32)));
});

test("serialized identity is hex-only JSON at version 1", () => {
  const id = generateIdentity();
  const o = JSON.parse(serializeIdentity(id)) as {
    v: number;
    sign: { pub: string; priv: string };
    seal: { pub: string; priv: string };
  };
  assert.equal(o.v, 1);
  for (const h of [o.sign.pub, o.sign.priv, o.seal.pub, o.seal.priv]) {
    assert.match(h, /^[0-9a-f]{64}$/);
  }
});

test("parseIdentity rejects a malformed or truncated file", () => {
  const id = generateIdentity();
  const good = JSON.parse(serializeIdentity(id)) as Record<string, unknown> & {
    sign: { pub: string; priv: string };
  };
  assert.throws(() => parseIdentity("not json"), SyntaxError);
  assert.throws(() => parseIdentity(JSON.stringify({ ...good, v: 2 })), /version/i);
  assert.throws(() => parseIdentity(JSON.stringify({ v: 1 })), /identity/i);
  assert.throws(
    () =>
      parseIdentity(
        JSON.stringify({ ...good, sign: { pub: good.sign.pub.slice(0, 62), priv: good.sign.priv } }),
      ),
    /32 bytes|hex/i,
  );
  assert.throws(
    () =>
      parseIdentity(
        JSON.stringify({ ...good, sign: { pub: "z".repeat(64), priv: good.sign.priv } }),
      ),
    /hex/i,
  );
});

test("the wordlist is 2048 unique lowercase words", () => {
  assert.equal(WORDLIST.length, 2048);
  assert.equal(new Set(WORDLIST).size, 2048);
  for (const w of WORDLIST) assert.match(w, /^[a-z]{3,8}$/);
});

test("wordlist entries are distinguishable by their first four letters", () => {
  const prefixes = new Set(WORDLIST.map((w) => w.slice(0, 4)));
  assert.equal(prefixes.size, 2048);
});
