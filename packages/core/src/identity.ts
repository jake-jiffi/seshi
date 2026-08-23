// Local identity: one Ed25519 signing pair, one X25519 sealing pair.
//
// The two pairs are deliberately separate. Signing proves authorship of a turn,
// sealing hides it from the relay, and reusing one key for both would tie the
// two properties together for no gain.
//
// Everything runs on node:crypto, which is the reason installing seshi is one
// line: the client has no npm dependencies at all. This module is also the only
// place that knows how a 32 byte key becomes something node will accept, so the
// rest of the codebase keeps passing plain Uint8Arrays around.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { WORDLIST } from "./wordlist.ts";

export type KeyPair = { pub: Uint8Array; priv: Uint8Array };
export type Identity = { sign: KeyPair; seal: KeyPair };

const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * node:crypto takes and returns DER, never the 32 raw bytes seshi puts on the
 * wire. For Ed25519 and X25519 (RFC 8410) that DER is a fixed prefix followed
 * by the key itself, so the translation is a slice one way and a concat the
 * other. The last byte of each OID is the algorithm: 0x70 Ed25519, 0x6e X25519.
 */
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");

export function generateIdentity(): Identity {
  return { sign: generateSignPair(), seal: generateSealPair() };
}

function generateSignPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: rawKey(publicKey, ED_SPKI, "spki"), priv: rawKey(privateKey, ED_PKCS8, "pkcs8") };
}

/**
 * A fresh X25519 pair: the durable sealing key here, and in envelope.ts the
 * throwaway pair that seals exactly one message.
 */
export function generateSealPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { pub: rawKey(publicKey, X_SPKI, "spki"), priv: rawKey(privateKey, X_PKCS8, "pkcs8") };
}

/** Ed25519 over the message itself. `null` is node's way of saying "no prehash". */
export function signBytes(message: Uint8Array, signPriv: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, keyObject(ED_PKCS8, signPriv, "pkcs8")));
}

/**
 * False, never a throw. node rejects a malformed or wrong-length key by
 * throwing, and a corrupt contacts entry has to surface as a failed signature
 * check rather than as a crypto error escaping the caller.
 */
export function verifyBytes(sig: Uint8Array, message: Uint8Array, signPub: Uint8Array): boolean {
  try {
    return verify(null, message, keyObject(ED_SPKI, signPub, "spki"), sig);
  } catch {
    return false;
  }
}

/**
 * X25519. Throws when the peer key is not a usable point (all zeroes, say), so
 * callers handling hostile input must catch it.
 */
export function sharedSecret(myPriv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return new Uint8Array(
    diffieHellman({
      privateKey: keyObject(X_PKCS8, myPriv, "pkcs8"),
      publicKey: keyObject(X_SPKI, theirPub, "spki"),
    }),
  );
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
  return createHash("sha256").update(signPub).update(sealPub).digest("hex").slice(0, 32);
}

/**
 * Words both humans read aloud to confirm they share a key. Derived from the
 * pairing session's shared secret, so a man in the middle cannot make both
 * sides show the same list.
 *
 * n is capped at 16 because each word eats two bytes of one sha256 digest.
 */
export function safetyWords(secret: Uint8Array, n = 4): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error(`safetyWords: n must be an integer between 1 and 16, got ${n}`);
  }
  const h = createHash("sha256").update(secret).digest();
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
    sign: { pub: hex(id.sign.pub), priv: hex(id.sign.priv) },
    seal: { pub: hex(id.seal.pub), priv: hex(id.seal.priv) },
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
  return new Uint8Array(Buffer.from(value, "hex"));
}

/**
 * Wrap 32 raw bytes back into the DER node insists on.
 *
 * The length check is not belt and braces. The DER prefix declares its own
 * length, and OpenSSL stops reading there, so `key ‖ anything` parses as `key`
 * and a 33 byte "key" verifies signatures made by the 32 byte one. Two spellings
 * of one key is exactly the confusion a fingerprint is supposed to prevent, so
 * anything that is not 32 bytes is refused here rather than quietly truncated.
 */
function keyObject(prefix: Buffer, raw: Uint8Array, type: "spki" | "pkcs8"): KeyObject {
  if (raw.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, got ${raw.length}`);
  }
  const der = Buffer.concat([prefix, raw]);
  return type === "spki"
    ? createPublicKey({ key: der, format: "der", type })
    : createPrivateKey({ key: der, format: "der", type });
}

/** The 32 bytes out of a generated key, checked against the wrapper we expect. */
function rawKey(key: KeyObject, prefix: Buffer, type: "spki" | "pkcs8"): Uint8Array {
  const der = key.export({ format: "der", type });
  if (der.length !== prefix.length + KEY_BYTES || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error(`identity: node exported an unexpected ${type} DER shape`);
  }
  return new Uint8Array(der.subarray(prefix.length));
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}
