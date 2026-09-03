/**
 * The composition root: one person's seshi.
 *
 * Storage owns the durable state, RelayClient owns the wire, PeerAgent owns the
 * thinking, and this module is the only place that knows about all three. It is
 * deliberately thin — if logic belongs to one of those three, it lives there.
 *
 * PAIRING, and an honest note about what this is.
 *
 * There are two paths in and they carry the same bytes.
 *
 *   invite() / joinWithCode()      "seshi join 7-tandem-verdict"
 *   inviteBundle() / pairWithBundle()   the 300 character seshi1_ blob
 *
 * The code path routes the blob through a relay mailbox instead of through the
 * human. The inviter leaves their bundle in the mailbox derived from the code,
 * the joiner takes it, leaves their own in the answer mailbox, and the inviter
 * picks that up. What crosses is identical either way: a bundle of PUBLIC keys
 * plus the relay URL. It is not a secret. Leaking it discloses a public key and
 * nothing else, and it cannot be replayed into an impersonation, because
 * possession of the matching private key is proved by every signature after.
 *
 * The code is NOT a PAKE password, and this is the honest gap against spec §8.
 * A PAKE would put the mailbox contents beyond the relay. A hashed mailbox id
 * does not: an actively malicious relay can swap the offer for keys of its own,
 * pocket the answer, and sit in the middle of both sides. So the mailbox does
 * not improve the relay's trust position at all, and it is not meant to. What
 * it improves is the human's: a three-word code read aloud beats a blob that
 * nobody proofreads.
 *
 * The four safety words remain the only thing that catches a man in the middle,
 * on either path. Both sides derive them from the ECDH shared secret and they
 * agree only if nobody sat between. Confirming them over a different channel is
 * the whole defence, exactly as it is in Signal and SSH.
 */

import { randomUUID } from "node:crypto";
import {
  fingerprint,
  generateIdentity,
  safetyWords,
  type Identity,
} from "../../core/src/identity.ts";
import { sharedSecret } from "../../core/src/identity.ts";
import type { Envelope } from "../../core/src/envelope.ts";
import { generateCode, mailboxIds, normaliseCode } from "../../core/src/pairing.ts";
import { Chain } from "../../core/src/chain.ts";
import { Storage, type Contact, type ConvoRecord, type PublicBrief } from "./storage.ts";
import { RelayClient } from "./relay-client.ts";
import { MailboxOccupiedError, mailboxPut, mailboxTake } from "./mailbox.ts";

/** Same shape storage enforces, because a fingerprint becomes a directory name. */
const FINGERPRINT = /^[0-9a-f]{32}$/;

/**
 * Rejected frames kept for the human to read. Anyone who has seen an invite
 * link knows a fingerprint, can hello as anyone and throw garbage at it, and
 * every piece of garbage is one reject. The newest are the ones worth reading.
 */
const MAX_REJECTS = 256;

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

export type Pairing = {
  contact: Contact;
  safetyWords: string[];
  /**
   * What the peer's own bundle called them, which is not necessarily what the
   * contact ends up called.
   *
   * It matters when the two disagree. "seshi invite dave" names the contact
   * dave because that is who Jake meant to invite, so if the person who
   * actually walked through the door calls themselves something else, the only
   * place that shows up is here. Worth putting in front of a human before they
   * read the safety words.
   */
  claimedName: string;
};

/** What `invite()` hands back: the words to read out, and the wait. */
export type PendingInvite = {
  /** e.g. "7-tandem-verdict". Read this to the other person. */
  code: string;
  /**
   * Poll the answer mailbox until the invitee replies. Resolves with the same
   * pairing a pasted bundle would have produced, or rejects on timeout, having
   * first taken our own offer back so an abandoned code cannot be spent later.
   */
  waitForPeer(opts?: { pollMs?: number; timeoutMs?: number }): Promise<Pairing>;
};

/** Poll interval and patience for `waitForPeer`, from the brief. */
const POLL_MS = 2_000;
const WAIT_MS = 10 * 60_000;

// Deliberately NOT unref'd. This timer is the only handle holding the process
// open between mailbox polls: the relay socket opened by `open()` is closed by
// an idle tunnel after a couple of minutes, and the client's reconnect timer IS
// unref'd. Unref this one too and node exits 0, silently, mid-pairing, long
// before WAIT_MS is up. The visible symptom is `seshi start` printing the invite
// and then just ending while the other person is still installing.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A mailbox carries base64. The bundle is already a string, so this is a
 *  second encoding and not a second format. */
const toMailbox = (bundle: string): string => Buffer.from(bundle, "utf8").toString("base64");
const fromMailbox = (data: string): string => Buffer.from(data, "base64").toString("utf8");

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
  /** One hash chain per (conversation, party). Keyed `${convo}/${party}`. */
  readonly #chains = new Map<string, Chain>();
  /**
   * Armed, one contact at a time, while a human is sitting at `seshi join`
   * waiting for the other side to open. See `expectOpenFrom`.
   */
  #expecting: { fingerprint: string; brief: PublicBrief; mode: string } | null = null;

  private constructor(opts: SeshiNodeOptions, storage: Storage, identity: Identity) {
    this.storage = storage;
    this.identity = identity;
    this.name = opts.name ?? "someone";
    this.#relayUrl = opts.relayUrl;
    this.#defaultTier = opts.defaultTier ?? 1;

    this.#client = new RelayClient({
      url: opts.relayUrl,
      identity,
      // Without this the reconnect path is dead code: `#scheduleReconnect`
      // returns early on a 0 interval, so the first idle drop is permanent. A
      // quick tunnel kills an idle socket at ~126s, which is shorter than one
      // agent turn, and the relay only drains a queued frame on the next hello.
      reconnectMs: 2_000,
      resolveContact: (fp) => this.storage.getContact(fp),
      onEnvelope: (envelope, contact) => this.#deliver(envelope, contact),
      onReject: (from, reason) => this.#noteReject({ from, reason }),
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
    return fingerprint(this.identity.sign.pub, this.identity.seal.pub);
  }

  get rejects(): ReadonlyArray<{ from: string; reason: string }> {
    return this.#rejects;
  }

  #noteReject(entry: { from: string; reason: string }): void {
    this.#rejects.push(entry);
    if (this.#rejects.length > MAX_REJECTS) {
      this.#rejects.splice(0, this.#rejects.length - MAX_REJECTS);
    }
  }

  /**
   * Start a code pairing.
   *
   * Publishes our bundle to the offer mailbox BEFORE returning, so the code is
   * already live the moment a human reads it out. `name` is our local label for
   * whoever joins with this code: "seshi invite dave" means the contact ends up
   * called dave regardless of what their bundle says about itself, which is one
   * fewer self-asserted string to trust.
   */
  async invite(name?: string): Promise<PendingInvite> {
    const code = generateCode();
    const box = mailboxIds(code);
    await mailboxPut(this.#relayUrl, box.offer, toMailbox(this.inviteBundle()));
    return {
      code,
      waitForPeer: (opts = {}) => this.#waitForPeer(box, name, opts),
    };
  }

  async #waitForPeer(
    box: { offer: string; answer: string },
    name: string | undefined,
    opts: { pollMs?: number; timeoutMs?: number },
  ): Promise<Pairing> {
    const pollMs = opts.pollMs ?? POLL_MS;
    const deadline = Date.now() + (opts.timeoutMs ?? WAIT_MS);
    // One slow or dropped poll used to end the whole wait, so a single blip on
    // a tunnel read as "your friend never turned up". Remember the last failure
    // instead, and only speak up about it if we never get a good answer.
    let lastError: Error | null = null;
    for (;;) {
      try {
        const data = await mailboxTake(this.#relayUrl, box.answer);
        // parseInvite runs inside pairWithBundle. A mailbox is untrusted
        // transport exactly like the relay, so what comes out of it gets the
        // same fingerprint check a pasted blob gets.
        if (data !== null) return this.pairWithBundle(fromMailbox(data), name);
        lastError = null;
      } catch (err) {
        lastError = err as Error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Spend our own offer so a code that leaked into Slack scrollback is
        // dead when we stop waiting, rather than live for the rest of its TTL.
        await mailboxTake(this.#relayUrl, box.offer).catch(() => {});
        throw new Error(
          lastError === null
            ? "nobody joined with that code. Run invite again for a fresh one."
            : `the relay stopped answering while waiting: ${lastError.message}`,
        );
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }

  /**
   * Join a pairing someone else started, using only their spoken code.
   *
   * The offer is claimed first and validated before we post anything of our
   * own, so a code that leads to a garbage bundle costs us nothing.
   */
  async joinWithCode(code: string): Promise<Pairing> {
    const box = mailboxIds(code);
    const data = await mailboxTake(this.#relayUrl, box.offer);
    if (data === null) {
      throw new Error(
        `no invite is waiting on ${normaliseCode(code)}. Either the code is wrong or expired, ` +
          `or somebody else claimed it first. A code can only be claimed once, so if they are ` +
          `sure they just sent it, treat this as an attack: get a fresh code over a different ` +
          `channel and do not use this one.`,
      );
    }
    const bundle = fromMailbox(data);
    const parsed = parseInvite(bundle);
    if (parsed.fp === this.fingerprint) throw new Error("that is your own invite code");

    try {
      await mailboxPut(this.#relayUrl, box.answer, toMailbox(this.inviteBundle()));
    } catch (err) {
      // Two very different situations, and calling both an attack would train
      // people to ignore the word. Either way the offer is spent and the code
      // is dead, so both messages end at the same place: get a fresh one.
      if (err instanceof MailboxOccupiedError) {
        throw new Error(
          `somebody has already answered this code, which means they knew it. Treat it as an ` +
            `attack: get a fresh code from them over a different channel, and do not use this one.`,
        );
      }
      throw new Error(
        `claimed the invite but could not reply to it: ${(err as Error).message}. The code is ` +
          `spent either way, so ask them for a fresh one.`,
      );
    }
    // No local label on this side: the joiner never named anyone, they were
    // handed a code. parseInvite already ran, above and again in here, which is
    // cheap and keeps pairWithBundle the single place a contact is committed.
    return this.pairWithBundle(bundle);
  }

  /** The string you paste to someone. Public keys only, not a secret. */
  inviteBundle(): string {
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
   * Accept a pasted invite bundle. Creates the contact locally and hands back
   * the safety words, which mean nothing until the other person reads theirs
   * aloud.
   *
   * `localName` is what WE call them. When it is absent the contact takes the
   * name out of the bundle, which is self-asserted and therefore only a label.
   */
  pairWithBundle(code: string, localName?: string): Pairing {
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
      name: localName ?? bundle.name,
      signPub: bundle.signPub,
      sealPub: bundle.sealPub,
      tier: existing?.tier ?? this.#defaultTier,
      verifiedAt: existing?.verifiedAt ?? null,
    };
    this.storage.putContact(contact);
    return { contact, safetyWords: this.safetyWordsFor(contact), claimedName: bundle.name };
  }

  /**
   * Four words derived from the ECDH shared secret. Both sides compute the same
   * words from opposite ends, and a man in the middle cannot make them agree.
   */
  safetyWordsFor(contact: Contact): string[] {
    return safetyWords(sharedSecret(this.identity.seal.priv, unhex(contact.sealPub)));
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

    // seq and prev come from OUR chain, not from the caller. A caller that
    // guesses them wrong would produce a chain the peer reads as a fork.
    const mine = this.#chain(convoId, "self");
    const next = mine.expectedNext();
    const envelope: Envelope = {
      ...e,
      v: 1,
      convo: convoId,
      from: this.fingerprint,
      seq: next.seq,
      prev: next.prev,
    };
    mine.append(envelope);
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

  /**
   * Re-send an envelope exactly as it was. Only useful for proving that the
   * receiving side refuses a replay, which is why it exists.
   */
  async resend(convoId: string, envelope: Envelope): Promise<void> {
    const convo = this.storage.getConvo(convoId);
    if (convo === null) throw new Error(`unknown conversation: ${convoId}`);
    await this.#client.send(this.contact(convo.peer), envelope);
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

  /**
   * Everything a verified frame must still survive before it counts as a turn.
   *
   * The signature proves WHO sent it. It does not prove the envelope belongs to
   * a conversation we are in, nor that we have not already seen it. Without the
   * first check a paired peer can name any conversation id and materialise a
   * directory on our disk for a conversation we never started. Without the
   * second, anyone who captures a frame (including the relay operator) can
   * replay a turn to skew the transcript, the budget and the capitulation rate.
   */
  #deliver(envelope: Envelope, contact: Contact): void {
    let convo = this.storage.getConvo(envelope.convo);
    if (convo === null) {
      const opened = this.#tryOpen(envelope, contact);
      if (opened === null) {
        this.#noteReject({
          from: contact.fingerprint,
          reason: `unknown conversation ${envelope.convo}: we never started or joined it`,
        });
        return;
      }
      convo = opened;
    }
    if (convo.peer !== contact.fingerprint) {
      this.#noteReject({
        from: contact.fingerprint,
        reason: `conversation ${envelope.convo} is with ${convo.peer}, not with them`,
      });
      return;
    }

    const chain = this.#chain(envelope.convo, contact.fingerprint);
    const verdict = chain.verify(envelope);
    if (verdict === "fork") {
      // A replayed or rewritten turn. Both look identical from here and both
      // are refused: an honest peer never sends either.
      this.#noteReject({
        from: contact.fingerprint,
        reason: `replayed or rewritten turn at seq ${envelope.seq}: chain says fork`,
      });
      return;
    }
    if (verdict === "gap") {
      // A turn went missing. Record it and carry on: the transcript is now
      // known-incomplete, which is better than pretending it is not.
      this.#noteReject({
        from: contact.fingerprint,
        reason: `gap before seq ${envelope.seq}: a turn never arrived`,
      });
    }
    chain.append(envelope, { tolerateGap: verdict === "gap" });

    this.storage.appendLog(envelope.convo, contact.fingerprint, envelope);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ envelope, contact });
    else this.#inbox.push({ envelope, contact });
  }

  /**
   * The chain for one party in one conversation, rehydrated from disk on first
   * use.
   *
   * Rehydration is the whole point. seshid exits when the last client
   * disconnects, so an in-memory-only chain forgets every turn on a normal
   * restart and anyone holding a captured frame can replay it afterwards. The
   * append-only log is the durable record, so the chain is derived from it.
   */
  /**
   * Let ONE named contact open ONE conversation, once.
   *
   * Without this the other person cannot start a conversation at all: their
   * opening turn names an id we have never seen, and the scoping check refuses
   * it, correctly. The seamless flow needs someone to be able to say the first
   * word.
   *
   * So the permission is made as small as it can be and still work. It is armed
   * by a human running `seshi join`, it names exactly one contact, it accepts
   * exactly one conversation, it disarms the moment that conversation is
   * created, and it still refuses anyone unverified or below tier 2. Everything
   * the reviewers found (a stranger materialising directories, a paired peer
   * injecting into a conversation that is with someone else) stays refused.
   */
  expectOpenFrom(nameOrFp: string, brief: PublicBrief, mode: string): void {
    const contact = this.contact(nameOrFp);
    if (contact.verifiedAt === null) {
      throw new Error(
        `${contact.name} has not been verified. Compare your four safety words with them over a ` +
          `different channel first, otherwise you are opening a channel to whoever answered.`,
      );
    }
    if (contact.tier < 2) {
      throw new Error(`${contact.name} is tier ${contact.tier}, which is words only`);
    }
    this.#expecting = { fingerprint: contact.fingerprint, brief, mode };
  }

  stopExpecting(): void {
    this.#expecting = null;
  }

  /** The one narrow case where an unknown conversation is allowed to exist. */
  #tryOpen(envelope: Envelope, contact: Contact): ConvoRecord | null {
    const expecting = this.#expecting;
    if (expecting === null) return null;
    if (expecting.fingerprint !== contact.fingerprint) return null;
    // Only an OPENING turn. A mid-conversation act naming an unknown id is not
    // someone starting a conversation, it is someone doing something else.
    if (envelope.act !== "BRIEF" || envelope.seq !== 1) return null;
    if (!/^[0-9a-f-]{36}$/i.test(envelope.convo)) return null;

    const record: ConvoRecord = {
      id: envelope.convo,
      peer: contact.fingerprint,
      mode: expecting.mode,
      state: "live",
      createdAt: new Date().toISOString(),
      budget: { turns: 24, warnAt: 16, used: 0 },
      brief: expecting.brief,
    };
    this.storage.putConvo(record);
    this.#expecting = null; // one conversation, then disarmed
    return record;
  }

  #chain(convoId: string, party: string): Chain {
    const key = `${convoId}/${party}`;
    let chain = this.#chains.get(key);
    if (chain === undefined) {
      chain = new Chain();
      for (const entry of this.storage.readLog(convoId, party)) {
        // Tolerant on the way back in: the log may already contain a gap we
        // accepted before the restart, and refusing our own history here would
        // wedge the conversation permanently.
        try {
          chain.append(entry as Envelope, { tolerateGap: true });
        } catch {
          // A log line that is not a well-formed turn. Skip it rather than
          // refusing to open the conversation at all.
        }
      }
      this.#chains.set(key, chain);
    }
    return chain;
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
  if (fingerprint(unhex(bundle.signPub), unhex(bundle.sealPub)) !== bundle.fp) {
    throw new Error("invite fingerprint does not match its signing key");
  }
  return bundle;
}

