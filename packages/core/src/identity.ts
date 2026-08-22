// Local identity: one Ed25519 signing pair, one X25519 sealing pair.
//
// The two pairs are deliberately separate. Signing proves authorship of a turn,
// sealing hides it from the relay, and reusing one key for both would tie the
// two properties together for no gain.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { WORDLIST } from "./wordlist.ts";

export type KeyPair = { pub: Uint8Array; priv: Uint8Array };
export type Identity = { sign: KeyPair; seal: KeyPair };

const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-f]{64}$/;

export function generateIdentity(): Identity {
  const signPriv = ed25519.utils.randomSecretKey();
  const sealPriv = x25519.utils.randomSecretKey();
  return {
    sign: { priv: signPriv, pub: ed25519.getPublicKey(signPriv) },
    seal: { priv: sealPriv, pub: x25519.getPublicKey(sealPriv) },
  };
}

/**
 * The 32 lowercase hex chars (128 bits) that name a party everywhere in seshi.
 *
 * BOTH public keys are bound in, and that is not decoration. If only the
 * signing key were covered, an interceptor could take a real invite, leave
 * signPub alone (they cannot forge a signature anyway) and swap in their own
 * SEALING key. The fingerprint would still check out, the victim would pair
 * happily, and every message they sent "to Jake" would be encrypted to the
 * interceptor instead. That attack is a test in test/e2e/two-people.test.ts.
 *
 * 128 bits, not 64: a fingerprint is a trust-on-first-use pin, so impersonating
 * a pinned contact is a second-preimage search. 2^64 is grindable.
 */
export function fingerprint(signPub: Uint8Array, sealPub: Uint8Array): string {
  if (signPub.length !== KEY_BYTES) {
    throw new Error(`fingerprint: signing key must be ${KEY_BYTES} bytes, got ${signPub.length}`);
  }
  if (sealPub.length !== KEY_BYTES) {
    throw new Error(`fingerprint: sealing key must be ${KEY_BYTES} bytes, got ${sealPub.length}`);
  }
  const bound = new Uint8Array(KEY_BYTES * 2);
  bound.set(signPub, 0);
  bound.set(sealPub, KEY_BYTES);
  return bytesToHex(sha256(bound)).slice(0, 32);
}

/**
 * Words both humans read aloud to confirm they share a key. Derived from the
 * pairing session's shared secret, so a man in the middle cannot make both
 * sides show the same list.
 *
 * n is capped at 16 because each word eats two bytes of one sha256 digest.
 */
export function safetyWords(sharedSecret: Uint8Array, n = 4): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error(`safetyWords: n must be an integer between 1 and 16, got ${n}`);
  }
  const h = sha256(sharedSecret);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // 2048 divides 65536, so the modulo is unbiased.
    const idx = (((h[i * 2] as number) << 8) | (h[i * 2 + 1] as number)) % WORDLIST.length;
    out.push(WORDLIST[idx] as string);
  }
  return out;
}

export function serializeIdentity(id: Identity): string {
  return JSON.stringify({
    v: 1,
    sign: { pub: bytesToHex(id.sign.pub), priv: bytesToHex(id.sign.priv) },
    seal: { pub: bytesToHex(id.seal.pub), priv: bytesToHex(id.seal.priv) },
  });
}

export function parseIdentity(json: string): Identity {
  const o: unknown = JSON.parse(json);
  if (typeof o !== "object" || o === null) throw new Error("malformed identity: not an object");
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) throw new Error(`unsupported identity version: ${String(r["v"])}`);
  return {
    sign: readPair(r["sign"], "sign"),
    seal: readPair(r["seal"], "seal"),
  };
}

function readPair(value: unknown, name: string): KeyPair {
  if (typeof value !== "object" || value === null) {
    throw new Error(`malformed identity: missing ${name} keys`);
  }
  const p = value as Record<string, unknown>;
  return { pub: readKey(p["pub"], `${name}.pub`), priv: readKey(p["priv"], `${name}.priv`) };
}

function readKey(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !HEX_KEY.test(value)) {
    throw new Error(`malformed identity: ${name} must be ${KEY_BYTES} bytes of lowercase hex`);
  }
  return hexToBytes(value);
}
