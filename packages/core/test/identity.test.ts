import { test } from "node:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import assert from "node:assert/strict";
import {
  generateIdentity,
  fingerprint,
  safetyWords,
  serializeIdentity,
  parseIdentity,
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

  assert.ok(ed25519.verify(ed25519.sign(msg, a.sign.priv), msg, a.sign.pub));
  assert.ok(!ed25519.verify(ed25519.sign(msg, a.sign.priv), msg, b.sign.pub));

  const fromA = x25519.getSharedSecret(a.seal.priv, b.seal.pub);
  const fromB = x25519.getSharedSecret(b.seal.priv, a.seal.pub);
  assert.deepEqual(fromA, fromB);
  // the point of safety words: both humans read the same list off their own machine
  assert.deepEqual(safetyWords(fromA), safetyWords(fromB));
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
