/**
 * An audit of the node:crypto rewrite, written because the agent that did it
 * never reported back and this is the part where being subtly wrong is silent.
 *
 * The two things that would not show up in ordinary tests: raw key material
 * being sliced out of DER by fixed prefix (wrong by one byte and everything
 * still "works" until it does not), and nonce reuse (catastrophic for AEAD, and
 * invisible until someone has two ciphertexts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  generateIdentity,
  generateSealPair,
  signBytes,
  verifyBytes,
  sharedSecret,
  fingerprint,
} from "../src/identity.ts";
import { sealEnvelope, openEnvelope } from "../src/envelope.ts";
import type { Envelope } from "../src/envelope.ts";

const env = (body: string): Envelope => ({
  v: 1, convo: "c1", seq: 1, prev: null, from: "",
  act: "PROPOSE", headline: "h", body,
});

test("raw keys survive export and re-import: signatures made with them verify", () => {
  // If the DER prefix slicing were off by a byte this would fail, and nothing
  // else in the suite would notice until two machines disagreed.
  for (let i = 0; i < 50; i += 1) {
    const id = generateIdentity();
    assert.equal(id.sign.priv.length, 32, "signing private key must be raw 32 bytes");
    assert.equal(id.sign.pub.length, 32, "signing public key must be raw 32 bytes");
    assert.equal(id.seal.priv.length, 32);
    assert.equal(id.seal.pub.length, 32);

    const msg = new Uint8Array([1, 2, 3, i & 0xff]);
    const sig = signBytes(msg, id.sign.priv);
    assert.equal(sig.length, 64);
    assert.ok(verifyBytes(sig, msg, id.sign.pub), "a key round-tripped through raw bytes must verify");
    assert.ok(!verifyBytes(sig, new Uint8Array([9, 9, 9]), id.sign.pub), "wrong message must fail");
  }
});

test("ECDH agrees in both directions, over many keys", () => {
  for (let i = 0; i < 50; i += 1) {
    const a = generateIdentity();
    const b = generateIdentity();
    const ab = sharedSecret(a.seal.priv, b.seal.pub);
    const ba = sharedSecret(b.seal.priv, a.seal.pub);
    assert.equal(ab.length, 32);
    assert.deepEqual(ab, ba, "both ends must derive the same secret or safety words are meaningless");
    // And it is not a constant.
    const c = generateIdentity();
    assert.notDeepEqual(ab, sharedSecret(a.seal.priv, c.seal.pub));
  }
});

test("no nonce and no ephemeral key is ever reused across 500 seals", () => {
  // The 12-byte nonce is only safe because the AEAD key is fresh per message.
  // If generateSealPair() were ever hoisted out of sealEnvelope, this catches it.
  const a = generateIdentity();
  const b = generateIdentity();
  const nonces = new Set<string>();
  const ephs = new Set<string>();

  for (let i = 0; i < 500; i += 1) {
    const wire = sealEnvelope(env(`message ${i}`), a, b.seal.pub);
    const eph = Buffer.from(wire.subarray(0, 32)).toString("hex");
    const nonce = Buffer.from(wire.subarray(32, 44)).toString("hex");
    assert.ok(!ephs.has(eph), `ephemeral key reused at ${i}`);
    assert.ok(!nonces.has(nonce), `nonce reused at ${i}`);
    ephs.add(eph);
    nonces.add(nonce);
  }
  assert.equal(ephs.size, 500);
  assert.equal(nonces.size, 500);
});

test("sealing the SAME envelope twice produces different ciphertext", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const one = sealEnvelope(env("identical"), a, b.seal.pub);
  const two = sealEnvelope(env("identical"), a, b.seal.pub);
  assert.notDeepEqual(one, two, "deterministic ciphertext would leak that two turns are the same");
  // Both still open to the same thing.
  for (const w of [one, two]) {
    assert.equal(openEnvelope(w, b, a.sign.pub, a.seal.pub).body, "identical");
  }
});

test("flipping any single byte anywhere in the frame breaks it", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope(env("tamper me"), a, b.seal.pub);

  // Sample across every region: ephemeral key, nonce, ciphertext, auth tag.
  const positions = [0, 15, 31, 32, 38, 43, 44, 60, wire.length - 17, wire.length - 8, wire.length - 1];
  for (const i of positions) {
    const bad = Uint8Array.from(wire);
    bad[i] = (bad[i]! ^ 0xff) & 0xff;
    assert.throws(
      () => openEnvelope(bad, b, a.sign.pub, a.seal.pub),
      /decrypt|signature|envelope|malformed/i,
      `a flipped byte at ${i} must not open`,
    );
  }
});

test("a peer who CAN read a turn cannot re-seal it to a third party", () => {
  // The real forwarding attack: b opens a's turn, keeps the signature and the
  // exact JSON, and re-seals that same body to c. If the signature did not
  // cover the recipient's sealing key, c would accept it as genuinely from a.
  const a = generateIdentity();
  const b = generateIdentity();
  const c = generateIdentity();

  const wire = sealEnvelope(env("for b only"), a, b.seal.pub);

  // b decrypts, exactly as its own daemon would.
  const eph = wire.subarray(0, 32);
  const nonce = wire.subarray(32, 44);
  const ct = wire.subarray(44);
  const key = createHash("sha256").update(sharedSecret(b.seal.priv, eph)).digest();
  const dec = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const body = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);

  // b re-seals that untouched body (a's signature and a's JSON) to c.
  const eph2 = generateSealPair();
  const nonce2 = randomBytes(12);
  const key2 = createHash("sha256").update(sharedSecret(eph2.priv, c.seal.pub)).digest();
  const enc = createCipheriv("chacha20-poly1305", key2, nonce2, { authTagLength: 16 });
  const ct2 = Buffer.concat([enc.update(body), enc.final(), enc.getAuthTag()]);
  const forwarded = Buffer.concat([Buffer.from(eph2.pub), nonce2, ct2]);

  // c decrypts it fine, and then refuses it: the signature covers b's sealing
  // key, not c's, so it does not verify as a turn addressed to c.
  assert.throws(
    () => openEnvelope(new Uint8Array(forwarded), c, a.sign.pub, a.seal.pub),
    /signature/i,
    "a forwarded turn must not verify for its new recipient",
  );
});

test("a truncated frame is refused rather than read past its end", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const wire = sealEnvelope(env("short"), a, b.seal.pub);
  for (const cut of [0, 1, 31, 32, 43, 44, wire.length - 1]) {
    assert.throws(() => openEnvelope(wire.subarray(0, cut), b, a.sign.pub, a.seal.pub), /decrypt|frame|short/i);
  }
});

test("fingerprints are 128 bits, stable, and bind both keys", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = generateIdentity();
    const f = fingerprint(id.sign.pub, id.seal.pub);
    assert.match(f, /^[0-9a-f]{32}$/);
    assert.equal(f, fingerprint(id.sign.pub, id.seal.pub), "must be stable");
    assert.ok(!seen.has(f), "collision in 200 keys would be catastrophic");
    seen.add(f);
    const other = generateIdentity();
    assert.notEqual(f, fingerprint(id.sign.pub, other.seal.pub), "sealing key must be bound in");
    assert.notEqual(f, fingerprint(other.sign.pub, id.seal.pub), "signing key must be bound in");
  }
});
