/**
 * The composition root: one person's seshi.
 *
 * Storage owns the durable state, RelayClient owns the wire, PeerAgent owns the
 * thinking, and this module is the only place that knows about all three. It is
 * deliberately thin — if logic belongs to one of those three, it lives there.
 *
 * PAIRING, and an honest note about what this is.
 *
 * The spec (§8) wants a three-word spoken code backed by a PAKE. This prototype
 * ships something simpler and different in kind: the invite is a base64url
 * bundle of the inviter's PUBLIC keys plus the relay URL. It is not a secret.
 * Leaking it discloses a public key and nothing else, and it cannot be replayed
 * into an impersonation, because possession of the matching private key is
 * proved by every signature thereafter.
 *
 * What it does NOT do is prove the bundle came from the person you think. That
 * is what the four safety words are for: both sides derive them from the ECDH
 * shared secret, and they only match if nobody sat in the middle. Confirming
 * them over a different channel is the whole defence, exactly as it is in
 * Signal and SSH. A short spoken code is a UX improvement over this, not a
 * security one, and it belongs in phase 2.
 */

import { randomUUID } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  fingerprint,
  generateIdentity,
  safetyWords,
  type Identity,
} from "@seshi/core/identity";
import type { Envelope } from "@seshi/core/envelope";
import { Storage, type Contact, type ConvoRecord, type PublicBrief } from "./storage.ts";
import { RelayClient } from "./relay-client.ts";

/** Same shape storage enforces, because a fingerprint becomes a directory name. */
const FINGERPRINT = /^[0-9a-f]{16}$/;

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

export type InviteBundle = {
  v: 1;
  fp: string;
  name: string;
  signPub: string;
  sealPub: string;
  relay: string;
};

export type SeshiNodeOptions = {
  home: string;
  relayUrl: string;
  /** Display name the peer sees. Defaults to the OS user. */
  name?: string;
  /** Tier granted to a contact created by pairing. Defaults to 1, words only. */
  defaultTier?: 1 | 2 | 3;
};

export type InboundTurn = { envelope: Envelope; contact: Contact };

export class SeshiNode {
  readonly storage: Storage;
  readonly identity: Identity;
  readonly name: string;
  readonly #relayUrl: string;
  readonly #defaultTier: 1 | 2 | 3;
  readonly #client: RelayClient;
  readonly #inbox: InboundTurn[] = [];
  readonly #rejects: Array<{ from: string; reason: string }> = [];
  readonly #waiters: Array<(t: InboundTurn) => void> = [];

  private constructor(opts: SeshiNodeOptions, storage: Storage, identity: Identity) {
    this.storage = storage;
    this.identity = identity;
    this.name = opts.name ?? "someone";
    this.#relayUrl = opts.relayUrl;
    this.#defaultTier = opts.defaultTier ?? 1;

    this.#client = new RelayClient({
      url: opts.relayUrl,
      identity,
      resolveContact: (fp) => this.storage.getContact(fp),
      onEnvelope: (envelope, contact) => this.#deliver(envelope, contact),
      onReject: (from, reason) => this.#rejects.push({ from, reason }),
    });
  }

  /** Open (or create) a seshi home and connect to the relay. */
  static async open(opts: SeshiNodeOptions): Promise<SeshiNode> {
    const storage = Storage.open(opts.home);
    let identity = storage.readIdentity();
    if (identity === null) {
      identity = generateIdentity();
      storage.writeIdentity(identity);
    }
    const node = new SeshiNode(opts, storage, identity);
    await node.#client.connect();
    return node;
  }

  get fingerprint(): string {
    return fingerprint(this.identity.sign.pub);
  }

  get rejects(): ReadonlyArray<{ from: string; reason: string }> {
    return this.#rejects;
  }

  /** The string you paste to someone. Public keys only, not a secret. */
  invite(): string {
    const bundle: InviteBundle = {
      v: 1,
      fp: this.fingerprint,
      name: this.name,
      signPub: hex(this.identity.sign.pub),
      sealPub: hex(this.identity.seal.pub),
      relay: this.#relayUrl,
    };
    return `seshi1_${Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url")}`;
  }

  /**
   * Accept an invite. Creates the contact locally and hands back the safety
   * words, which mean nothing until the other person reads theirs aloud.
   */
  pair(code: string): { contact: Contact; safetyWords: string[] } {
    const bundle = parseInvite(code);
    if (bundle.fp === this.fingerprint) throw new Error("that is your own invite");

    const existing = this.storage.getContact(bundle.fp);
    if (existing !== null && existing.signPub !== bundle.signPub) {
      // Spec §8: a known contact presenting a new key hard-fails. It never
      // warns and continues, because "Dave on a new laptop" and "someone
      // pretending to be Dave" are the same bytes.
      throw new Error(
        `${existing.name} is already paired with a different key. This is either a new device ` +
          `or an impersonation, and they look identical from here. Confirm with them over a ` +
          `different channel, then delete contacts/${bundle.fp} to re-pair.`,
      );
    }

    const contact: Contact = {
      fingerprint: bundle.fp,
      name: bundle.name,
      signPub: bundle.signPub,
      sealPub: bundle.sealPub,
      tier: existing?.tier ?? this.#defaultTier,
      verifiedAt: existing?.verifiedAt ?? null,
    };
    this.storage.putContact(contact);
    return { contact, safetyWords: this.safetyWordsFor(contact) };
  }

  /**
   * Four words derived from the ECDH shared secret. Both sides compute the same
   * words from opposite ends, and a man in the middle cannot make them agree.
   */
  safetyWordsFor(contact: Contact): string[] {
    return safetyWords(x25519.getSharedSecret(this.identity.seal.priv, unhex(contact.sealPub)));
  }

  contact(nameOrFp: string): Contact {
    // Storage refuses anything that is not a fingerprint, because a contact id
    // becomes a directory name. So the shape is checked here rather than
    // letting a display name reach a path.
    if (FINGERPRINT.test(nameOrFp)) {
      const byFp = this.storage.getContact(nameOrFp);
      if (byFp !== null) return byFp;
    }
    const matches = this.storage.listContacts().filter((c) => c.name === nameOrFp);
    if (matches.length === 0) throw new Error(`no contact called ${nameOrFp}`);
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} contacts are called ${nameOrFp}. Use a fingerprint: ` +
          matches.map((c) => c.fingerprint).join(", "),
      );
    }
    return matches[0]!;
  }

  /** Mark a contact as having had their safety words confirmed out of band. */
  verify(nameOrFp: string): Contact {
    const c = this.contact(nameOrFp);
    const verified = { ...c, verifiedAt: new Date().toISOString() };
    this.storage.putContact(verified);
    return verified;
  }

  startConvo(input: {
    peer: string;
    mode: string;
    brief: PublicBrief;
    turns?: number;
  }): ConvoRecord {
    const peer = this.contact(input.peer);
    const record: ConvoRecord = {
      id: randomUUID(),
      peer: peer.fingerprint,
      mode: input.mode,
      state: "live",
      createdAt: new Date().toISOString(),
      budget: { turns: input.turns ?? 24, warnAt: 16, used: 0 },
      brief: input.brief,
    };
    this.storage.putConvo(record);
    return record;
  }

  /** Send one envelope into a conversation. Records locally before the wire. */
  async send(convoId: string, e: Omit<Envelope, "v" | "convo" | "from">): Promise<Envelope> {
    const convo = this.storage.getConvo(convoId);
    if (convo === null) throw new Error(`unknown conversation: ${convoId}`);
    const peer = this.contact(convo.peer);

    const envelope: Envelope = { ...e, v: 1, convo: convoId, from: "" };
    this.storage.appendLog(convoId, "self", envelope);
    this.storage.appendAudit(convoId, {
      at: new Date().toISOString(),
      to: peer.fingerprint,
      act: envelope.act,
      bytes: Buffer.byteLength(envelope.body, "utf8"),
    });
    this.storage.putConvo({ ...convo, budget: { ...convo.budget, used: convo.budget.used + 1 } });

    await this.#client.send(peer, envelope);
    return envelope;
  }

  /** Resolve with the next inbound turn, or reject on timeout. */
  waitForTurn(opts: { timeoutMs?: number } = {}): Promise<InboundTurn> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<InboundTurn>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(push);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error("timed out waiting for the peer's turn"));
      }, opts.timeoutMs ?? 30_000);
      const push = (t: InboundTurn): void => {
        clearTimeout(timer);
        resolve(t);
      };
      this.#waiters.push(push);
    });
  }

  close(): void {
    this.#client.close();
  }

  #deliver(envelope: Envelope, contact: Contact): void {
    this.storage.appendLog(envelope.convo, contact.fingerprint, envelope);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ envelope, contact });
    else this.#inbox.push({ envelope, contact });
  }
}

export function parseInvite(code: string): InviteBundle {
  const trimmed = code.trim();
  if (!trimmed.startsWith("seshi1_")) throw new Error("not a seshi invite");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice("seshi1_".length), "base64url").toString("utf8"));
  } catch {
    throw new Error("invite is corrupt");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("invite is corrupt");
  const b = parsed as Record<string, unknown>;
  const str = (k: string): string => {
    const v = b[k];
    if (typeof v !== "string" || v === "") throw new Error(`invite is missing ${k}`);
    return v;
  };
  const bundle: InviteBundle = {
    v: 1,
    fp: str("fp"),
    name: str("name"),
    signPub: str("signPub"),
    sealPub: str("sealPub"),
    relay: str("relay"),
  };
  if (!/^[0-9a-f]{64}$/.test(bundle.signPub) || !/^[0-9a-f]{64}$/.test(bundle.sealPub)) {
    throw new Error("invite carries a malformed key");
  }
  // The fingerprint is derived, never trusted: an invite that lies about its
  // own fingerprint is rejected here rather than becoming a mislabelled contact.
  if (fingerprint(unhex(bundle.signPub)) !== bundle.fp) {
    throw new Error("invite fingerprint does not match its signing key");
  }
  return bundle;
}
