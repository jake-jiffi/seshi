// The wire envelope: one signed, sealed JSON object per turn (spec §5).
//
// Wire layout, all binary, no framing characters:
//
//   [ 32 bytes ephemeral X25519 public key ]
//   [ 24 bytes XChaCha20 nonce             ]
//   [ ciphertext + 16 byte Poly1305 tag    ]
//
// and inside the ciphertext:
//
//   [ 64 bytes Ed25519 signature ][ UTF-8 JSON envelope ]
//
// The signature lives inside the sealed blob on purpose: the relay routes by
// fingerprint and must not learn who signed what.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToUtf8, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { fingerprint, type Identity } from "./identity.ts";

export const ACTS = [
  "BRIEF",
  "ASK",
  "EVIDENCE",
  "PROPOSE",
  "COUNTER",
  "ACCEPT",
  "REJECT",
  "REFUSE",
  "CONCEDE",
  "PARK",
  "NOT_UNDERSTOOD",
  "RED_TEAM",
  "PROPOSE_FINAL",
  "CLOSE",
] as const;

export type Act = (typeof ACTS)[number];

export const LEDGER_STATES = [
  "open",
  "claimed",
  "proposed",
  "agreed",
  "parked",
  "escalated",
] as const;

export type LedgerState = (typeof LEDGER_STATES)[number];
export type LedgerEntry = { id: string; state: LedgerState };

export type Envelope = {
  v: 1;
  convo: string;
  seq: number;
  prev: string | null; // "sha256:<64 hex>" of this author's previous envelope
  from: string; // set by the RECEIVER, never trusted from the wire
  act: Act;
  headline: string; // <= HEADLINE_MAX
  body: string; // <= BODY_MAX
  ledger?: LedgerEntry[];
  artefact?: { diff: string; sha256: string };
};

export const HEADLINE_MAX = 200;
export const BODY_MAX = 1200;

/**
 * Prefixed to the signed bytes together with the recipient's sealing key.
 *
 * Binding the recipient is what stops a paired peer from re-sealing somebody
 * else's signed turn on to a third party, which would otherwise read as a turn
 * that party never received.
 */
export const SIGN_DOMAIN = "seshi-envelope-v1";

const EPH_BYTES = 32;
const NONCE_BYTES = 24;
const SIG_BYTES = 64;
const TAG_BYTES = 16;
const PREV_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * `convo` becomes a directory name under `$SESHI_HOME/convos/` (spec §4.5) and
 * arrives from a peer, so "../../.ssh" has to die here rather than at the point
 * some later component joins it on to a path. ULIDs and the test ids both fit.
 */
const CONVO_ID = /^[A-Za-z0-9_-]{1,64}$/;

const ACT_SET: ReadonlySet<string> = new Set(ACTS);
const LEDGER_STATE_SET: ReadonlySet<string> = new Set(LEDGER_STATES);

/**
 * Truncate the two capped fields. Never throws: the caps are a protocol rule
 * applied to whatever the model produced, not a request the model can decline.
 *
 * Call this before sealing and before hashing into the chain, so the sender's
 * record and the receiver's record are the same bytes. Escaping happens later,
 * at render time: cap first, escape second.
 */
export function capEnvelope(e: Envelope): Envelope {
  return { ...e, headline: truncate(e.headline, HEADLINE_MAX), body: truncate(e.body, BODY_MAX) };
}

/** Cut a string to `max` UTF-16 units without ever leaving half a surrogate pair behind. */
function truncate(s: string, max: number): string {
  // The typeof guard is not redundant in practice: the daemon builds envelopes
  // from model output, and a non-string field should reach validate()'s clear
  // message rather than die with a TypeError in here.
  if (typeof s !== "string" || s.length <= max) return s;
  const lastKept = s.charCodeAt(max - 1);
  const firstDropped = s.charCodeAt(max);
  const splitsPair =
    lastKept >= 0xd800 && lastKept <= 0xdbff && firstDropped >= 0xdc00 && firstDropped <= 0xdfff;
  return s.slice(0, splitsPair ? max - 1 : max);
}

/** Sign `e` as `from`, then seal it to `toSealPub`. Returns the frame to hand the relay. */
export function sealEnvelope(e: Envelope, from: Identity, toSealPub: Uint8Array): Uint8Array {
  if (toSealPub.length !== EPH_BYTES) {
    throw new Error(`sealEnvelope: recipient sealing key must be 32 bytes, got ${toSealPub.length}`);
  }

  // Serialise the validated copy, never the caller's object. Otherwise an extra
  // key, a getter or a toJSON on `e` would put bytes on the wire that validate()
  // never saw, and the signature would cover them.
  //
  // `from` rides along exactly as the spec draws it, and is decoration. The
  // receiver overwrites it. Nothing downstream may read it off the wire.
  const jsonBytes = utf8ToBytes(JSON.stringify(validate(e)));
  const sig = ed25519.sign(signedBytes(toSealPub, jsonBytes), from.sign.priv);

  const ephPriv = x25519.utils.randomSecretKey();
  const nonce = randomBytes(NONCE_BYTES);
  const key = sha256(x25519.getSharedSecret(ephPriv, toSealPub));
  const ct = xchacha20poly1305(key, nonce).encrypt(concatBytes(sig, jsonBytes));

  return concatBytes(x25519.getPublicKey(ephPriv), nonce, ct);
}

/**
 * Open a frame addressed to `me` and claimed to come from `fromSignPub`.
 *
 * `fromSignPub` is the key the receiving daemon resolved from the authenticated
 * transport, never a key read out of the frame. Order matters and is tested:
 * decrypt, parse, verify, and only then stamp `from`.
 */
export function openEnvelope(wire: Uint8Array, me: Identity, fromSignPub: Uint8Array): Envelope {
  const plaintext = decrypt(wire, me);

  if (plaintext.length < SIG_BYTES) {
    throw new Error("decrypt failed: plaintext is shorter than a signature");
  }
  const sig = plaintext.subarray(0, SIG_BYTES);
  const jsonBytes = plaintext.subarray(SIG_BYTES);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(jsonBytes));
  } catch {
    throw new Error("malformed envelope: payload is not JSON");
  }

  if (!verify(sig, signedBytes(me.seal.pub, jsonBytes), fromSignPub)) {
    throw new Error("bad signature: envelope was not signed by the expected key");
  }

  const e = validate(parsed);

  // Spec §5.1. Whatever the sender wrote here is decoration; the only identity
  // that survives is the one we just proved with the signature.
  e.from = fingerprint(fromSignPub);
  return e;
}

function decrypt(wire: Uint8Array, me: Identity): Uint8Array {
  if (wire.length < EPH_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new Error("decrypt failed: frame is too short to hold a sealed envelope");
  }
  const ephPub = wire.subarray(0, EPH_BYTES);
  const nonce = wire.subarray(EPH_BYTES, EPH_BYTES + NONCE_BYTES);
  const ct = wire.subarray(EPH_BYTES + NONCE_BYTES);
  try {
    const key = sha256(x25519.getSharedSecret(me.seal.priv, ephPub));
    return xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    // Deliberately one message for every failure: a bad tag, a bad ephemeral
    // key and a frame meant for someone else must not be distinguishable.
    throw new Error("decrypt failed: authentication tag mismatch");
  }
}

/** ed25519.verify throws rather than returning false on a malformed key, so a
 *  corrupt contacts entry must not surface as something other than a rejection. */
function verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

function signedBytes(toSealPub: Uint8Array, jsonBytes: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes(SIGN_DOMAIN), toSealPub, jsonBytes);
}

/**
 * The one schema gate, used on the way out and on the way in.
 *
 * Inbound this runs on bytes a signed peer chose, so a peer running a patched
 * client is exactly who it is defending against. Over-cap fields are rejected
 * rather than trimmed here: trimming would fork the hash chain silently.
 */
function validate(value: unknown): Envelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("malformed envelope: not an object");
  }
  const r = value as Record<string, unknown>;

  if (r["v"] !== 1) throw new Error(`envelope: unsupported version ${JSON.stringify(r["v"])}`);

  const convo = r["convo"];
  if (typeof convo !== "string" || !CONVO_ID.test(convo)) {
    throw new Error(
      `envelope: convo must be 1-64 chars of [A-Za-z0-9_-], got ${JSON.stringify(convo)}`,
    );
  }

  const seq = r["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`envelope: seq must be a non-negative integer, got ${JSON.stringify(seq)}`);
  }

  const prev = r["prev"];
  if (prev !== null && (typeof prev !== "string" || !PREV_HASH.test(prev))) {
    throw new Error("envelope: prev must be null or \"sha256:<64 hex>\"");
  }

  const act = r["act"];
  if (typeof act !== "string" || !ACT_SET.has(act)) {
    throw new Error(`envelope: unknown act ${JSON.stringify(act)}`);
  }

  const headline = r["headline"];
  if (typeof headline !== "string") throw new Error("envelope: headline must be a string");
  if (headline.length > HEADLINE_MAX) {
    throw new Error(
      `envelope: headline exceeds the ${HEADLINE_MAX} char cap (${headline.length}); call capEnvelope first`,
    );
  }

  const body = r["body"];
  if (typeof body !== "string") throw new Error("envelope: body must be a string");
  if (body.length > BODY_MAX) {
    throw new Error(
      `envelope: body exceeds the ${BODY_MAX} char cap (${body.length}); call capEnvelope first`,
    );
  }

  const out: Envelope = {
    v: 1,
    convo,
    seq,
    prev,
    from: typeof r["from"] === "string" ? r["from"] : "",
    act: act as Act,
    headline,
    body,
  };

  if (r["ledger"] !== undefined) out.ledger = readLedger(r["ledger"]);
  if (r["artefact"] !== undefined) out.artefact = readArtefact(r["artefact"]);
  return out;
}

function readLedger(value: unknown): LedgerEntry[] {
  if (!Array.isArray(value)) throw new Error("envelope: ledger must be an array");
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`envelope: ledger[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const id = e["id"];
    const state = e["state"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`envelope: ledger[${i}].id must be a non-empty string`);
    }
    if (typeof state !== "string" || !LEDGER_STATE_SET.has(state)) {
      throw new Error(`envelope: ledger[${i}].state is not a ledger state: ${JSON.stringify(state)}`);
    }
    return { id, state: state as LedgerState };
  });
}

function readArtefact(value: unknown): { diff: string; sha256: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("envelope: artefact must be an object");
  }
  const a = value as Record<string, unknown>;
  if (typeof a["diff"] !== "string") throw new Error("envelope: artefact.diff must be a string");
  if (typeof a["sha256"] !== "string") throw new Error("envelope: artefact.sha256 must be a string");
  return { diff: a["diff"], sha256: a["sha256"] };
}
