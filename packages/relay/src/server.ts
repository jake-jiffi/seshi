// The relay is deliberately dumb. It sees a recipient fingerprint and an opaque
// base64 frame, and nothing else. It never decodes a frame, never stores one
// beyond the offline queue, and never writes one to a log. The pairing
// mailboxes below hold opaque base64 under a hashed id on the same terms.
//
// The relay-sees-only-ciphertext shape is taken from agent-talk/retalk (MIT).
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

/** Hard cap on one frame, enforced here rather than by convention (spec s4.2). */
const MAX_FRAME_CHARS = 256 * 1024;

/** Frames held for one offline recipient before the oldest starts falling off. */
const MAX_QUEUE = 500;

/**
 * Bytes the relay will hold for offline recipients, across everyone.
 *
 * The per-recipient cap above never bounded anything on its own: a sender
 * simply names a new recipient per frame. Measured before this existed, one
 * unauthenticated socket sending 4,000 frames at a quarter of the frame cap
 * took a relay from 86 MB to 979 MB of RSS, against a 256 MB machine. This is
 * the number that actually holds. 32 MB is 128 frames at the cap, which is
 * days of two people talking past each other.
 */
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

/**
 * Frames one sender may have waiting across all recipients. A real
 * conversation has at most one turn in flight, so this is generous, and it
 * stops one socket from owning the whole byte budget above.
 */
export const MAX_QUEUED_PER_SENDER = 64;

/**
 * How long a queued frame waits for its recipient. Without this a frame for
 * a fingerprint that never comes back is held forever, and with a byte cap in
 * place that becomes a slow leak that ends in the relay refusing everyone.
 */
export const QUEUE_TTL_MS = 6 * 60 * 60_000;

/** Full queue sweep runs at most this often. Lazy, like the mailboxes. */
const QUEUE_SWEEP_MS = 60_000;

/** Mailbox puts one connection may attempt before it is cut off. Same
 *  reasoning as MBOX_MAX_MISSES: a real inviter does one. */
const MBOX_MAX_PUTS = 20;

/**
 * Refused sends one connection may accumulate before it is cut off. A refusal
 * still costs the relay a parse of up to 256 KB, so without this a sender that
 * has hit its budget can keep the CPU busy for as long as the link allows. A
 * real client sees one refusal and stops; twenty is a flood.
 */
const MAX_REFUSALS = 20;

/**
 * Concurrent connections one client address may hold.
 *
 * Every other bound here is per fingerprint or per connection, and both are
 * free to mint. An address is not. Behind Fly the address is what the proxy
 * puts in Fly-Client-IP; anywhere else it is the socket's own peer. Nothing
 * client-supplied is trusted for this, so X-Forwarded-For is deliberately
 * ignored. 32 covers an office behind one NAT with room to spare.
 */
export const MAX_CONNS_PER_IP = 32;

const FINGERPRINT = /^[0-9a-f]{32}$/;

// ---- Authenticated hello ------------------------------------------------------
//
// A fingerprint used to be a self-asserted routing label: anyone who had seen
// an invite could hello as anyone, kick the real session off, swallow its
// queued frames and spend its sender budget. Now the relay hands every new
// connection a nonce, and a hello carries both public keys plus an Ed25519
// signature over the nonce. The relay derives the fingerprint from the keys
// itself, so the label on the socket is the label the signature proves.
//
// The two helpers below duplicate ten lines of packages/core on purpose. The
// relay ships as a single directory with one dependency and must not reach
// into the client's packages; a test asserts the derivation matches core.

/** Domain-separated so a hello signature can never be mistaken for anything else. */
const HELLO_DOMAIN = "seshi-hello-v1";
const NONCE_BYTES = 32;
const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
/** RFC 8410 SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** sha256(signPub || sealPub), first 32 hex chars. Identical to core's `fingerprint`. */
function fingerprintOf(signPub: Buffer, sealPub: Buffer): string {
  return createHash("sha256").update(signPub).update(sealPub).digest("hex").slice(0, 32);
}

/** False, never a throw: a malformed key is a failed hello, not a crash. */
function helloVerifies(nonce: Buffer, signPub: Buffer, sig: Buffer): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, signPub]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, Buffer.concat([Buffer.from(HELLO_DOMAIN, "utf8"), nonce]), key, sig);
  } catch {
    return false;
  }
}

// ---- Pairing mailboxes (spec s8) --------------------------------------------
//
// A mailbox is a one-shot dead drop keyed by a hash of a spoken pairing code.
// One side leaves a bundle of public keys in it, the other takes it out. The
// relay cannot compute the id without the code and never looks inside the blob.
//
// Mailbox ops deliberately do NOT require a hello. Tying a mailbox to a routing
// fingerprint would tell the relay operator which identity is behind a pending
// invite, and buys nothing: the id is already the only credential.

/**
 * How long a pairing mailbox lives.
 *
 * Was 24 hours, which is 96x longer than the flow it serves: `invite()` waits
 * ten minutes for the other side and then gives up. Every extra minute is
 * exposure for a code someone can guess, so the window matches the wait.
 */
export const MBOX_TTL_MS = 15 * 60_000;

/**
 * Consecutive mailbox misses one connection may make before it is cut off.
 *
 * Single claim caps an attacker at one guess per CODE. It does nothing about
 * guessing WHICH codes exist, and that is the real attack: measured before this
 * existed, one connection managed 1,172 take attempts a second, a full sweep of
 * the 25.2-bit code space in under nine hours, against mailboxes that lived a
 * whole day. A genuine joiner takes exactly one mailbox and hits it, so a budget
 * this small costs them nothing and makes enumeration need millions of
 * connections rather than one.
 */
const MBOX_MAX_MISSES = 20;

/** Total live mailboxes. Past this a put is refused, so this is not a heap. */
const MBOX_MAX = 10_000;

/** A bundle is a few hundred base64 chars. 4 KB is generous and bounded. */
const MBOX_MAX_DATA_CHARS = 4096;

/** Full expiry scan runs at most this often, plus once more at capacity. */
const MBOX_SWEEP_MS = 60_000;

const MBOX_ID = /^[0-9a-f]{64}$/;

/** Standard and url-safe base64. The relay checks the SHAPE of the blob so it
 *  cannot be used as a general store, and never the contents. */
const BASE64ISH = /^[A-Za-z0-9+/_=-]+$/;

type Mailbox = { data: string; expiresAt: number };

type QueuedFrame = { from: string; frame: string; at: number };

export type Relay = {
  port: number;
  close(): Promise<void>;
};

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The address a connection counts against. See MAX_CONNS_PER_IP. */
function clientAddress(req: IncomingMessage): string {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly !== "") return fly;
  return req.socket.remoteAddress ?? "unknown";
}

export async function startRelay(opts: {
  port: number;
  /** Injectable clock. Exists so the 24 hour TTL can be tested in milliseconds
   *  against the real constant rather than against a shortened one. */
  now?: () => number;
}): Promise<Relay> {
  const now = opts.now ?? Date.now;
  /** fingerprint -> the socket currently claiming it */
  const live = new Map<string, WebSocket>();
  /** fingerprint -> frames waiting for it to come back */
  const queues = new Map<string, QueuedFrame[]>();
  /** mailbox id -> the bundle waiting to be claimed exactly once */
  const mailboxes = new Map<string, Mailbox>();
  let lastSweep = 0;
  /** Bytes across every queue, and frames waiting per sender. Both are
   *  maintained on every push, drain, drop and expiry, so they are exact. */
  let queuedBytes = 0;
  const queuedBySender = new Map<string, number>();
  let lastQueueSweep = 0;

  function remember(item: QueuedFrame): void {
    queuedBytes += item.frame.length;
    queuedBySender.set(item.from, (queuedBySender.get(item.from) ?? 0) + 1);
  }

  function forget(item: QueuedFrame): void {
    queuedBytes -= item.frame.length;
    const n = queuedBySender.get(item.from) ?? 0;
    if (n <= 1) queuedBySender.delete(item.from);
    else queuedBySender.set(item.from, n - 1);
  }

  /** Drop frames past their TTL. Queues are appended in time order, so each
   *  one is trimmed from the front until the first live frame. */
  function sweepQueues(): void {
    const t = now();
    if (t - lastQueueSweep < QUEUE_SWEEP_MS) return;
    lastQueueSweep = t;
    for (const [fp, queued] of queues) {
      while (queued.length > 0 && (queued[0] as QueuedFrame).at + QUEUE_TTL_MS <= t) {
        forget(queued.shift() as QueuedFrame);
      }
      if (queued.length === 0) queues.delete(fp);
    }
  }

  /** Expiry is lazy: nothing runs on a timer, it is swept on the way past. */
  function sweepMailboxes(force = false): void {
    const t = now();
    if (!force && t - lastSweep < MBOX_SWEEP_MS) return;
    lastSweep = t;
    for (const [id, box] of mailboxes) if (box.expiresAt <= t) mailboxes.delete(id);
  }

  /** An expired mailbox is indistinguishable from an empty one, and dies here. */
  function liveMailbox(id: string): Mailbox | null {
    const box = mailboxes.get(id);
    if (box === undefined) return null;
    if (box.expiresAt <= now()) {
      mailboxes.delete(id);
      return null;
    }
    return box;
  }

  const wss = new WebSocketServer({
    port: opts.port,
    // Leaves room for the JSON wrapper around a maximum-size frame while still
    // bounding what a single message can make the process buffer.
    maxPayload: MAX_FRAME_CHARS * 2,
  });

  function deliver(socket: WebSocket, from: string, frame: string): void {
    socket.send(JSON.stringify({ t: "deliver", from, frame }));
  }

  function drain(fp: string, socket: WebSocket): void {
    const queued = queues.get(fp);
    if (!queued) return;
    // Frames come off the queue only as they are handed to the socket. If the
    // socket dies part way through, whatever is left stays queued for the next
    // hello instead of being dropped on the floor.
    while (queued.length > 0 && socket.readyState === WebSocket.OPEN) {
      const item = queued.shift();
      if (!item) break;
      forget(item);
      deliver(socket, item.from, item.frame);
    }
    if (queued.length === 0) queues.delete(fp);
  }

  /** True when the frame was refused rather than delivered or queued. */
  function route(from: string, to: string, frame: string, reply: (m: unknown) => void): boolean {
    const target = live.get(to);
    if (target && target.readyState === WebSocket.OPEN) {
      deliver(target, from, frame);
      return false;
    }
    sweepQueues();
    // Both refusals are coded, because a sender has to tell "slow down" from
    // "the relay is full" from "the recipient is buried", and none of the
    // three says anything about which mailboxes exist.
    if ((queuedBySender.get(from) ?? 0) >= MAX_QUEUED_PER_SENDER) {
      reply({ t: "error", msg: "too many frames waiting from this sender", code: "backlog" });
      return true;
    }
    if (queuedBytes + frame.length > MAX_QUEUED_BYTES) {
      reply({ t: "error", msg: "relay is holding as much as it can", code: "full" });
      return true;
    }
    let queued = queues.get(to);
    if (!queued) {
      queued = [];
      queues.set(to, queued);
    }
    if (queued.length >= MAX_QUEUE) {
      forget(queued.shift() as QueuedFrame);
      reply({ t: "overflow", to });
    }
    const item: QueuedFrame = { from, frame, at: now() };
    queued.push(item);
    remember(item);
    reply({ t: "queued" });
    return false;
  }

  /** client address -> open connections from it */
  const connsByIp = new Map<string, number>();

  wss.on("connection", (socket, req: IncomingMessage) => {
    const ip = clientAddress(req);
    const fromIp = (connsByIp.get(ip) ?? 0) + 1;
    if (fromIp > MAX_CONNS_PER_IP) {
      socket.close(4029, "too many connections from this address");
      return;
    }
    connsByIp.set(ip, fromIp);

    let fp: string | null = null;
    let misses = 0;
    let puts = 0;
    let refusals = 0;
    // Fresh per connection, so a captured hello cannot be replayed on another.
    const nonce = randomBytes(NONCE_BYTES);

    const reply = (m: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
    };
    /**
     * `code` is set only where a caller has to tell one refusal from another.
     *
     * "occupied" is the one that matters: a joiner whose put is refused has
     * either hit a network problem or found someone already sitting in their
     * mailbox, and those are a bad afternoon and an alarm respectively. Every
     * other refusal stays uncoded so the field cannot be used to probe.
     */
    const fail = (msg: string, code?: string): void =>
      reply(code === undefined ? { t: "error", msg } : { t: "error", msg, code });

    reply({ t: "challenge", nonce: nonce.toString("hex") });

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        fail("malformed json");
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        fail("expected an object");
        return;
      }
      const m = parsed as Record<string, unknown>;

      // Keepalive. Every proxy between two people has an idle timeout, and a
      // model turn is longer than most of them. Answered before hello so a
      // client can hold a socket open while it is still deciding who it is.
      if (m["t"] === "ping") {
        reply({ t: "pong" });
        return;
      }

      if (m["t"] === "hello") {
        if (fp !== null) {
          fail("already registered");
          return;
        }
        const signPubHex = asString(m["signPub"]);
        const sealPubHex = asString(m["sealPub"]);
        const sigHex = asString(m["sig"]);
        if (
          signPubHex === null || !HEX_KEY.test(signPubHex) ||
          sealPubHex === null || !HEX_KEY.test(sealPubHex) ||
          sigHex === null || !HEX_SIG.test(sigHex)
        ) {
          fail("hello must carry signPub, sealPub and a signature over the challenge");
          return;
        }
        const signPub = Buffer.from(signPubHex, "hex");
        const sealPub = Buffer.from(sealPubHex, "hex");
        if (!helloVerifies(nonce, signPub, Buffer.from(sigHex, "hex"))) {
          // One message for a bad key and a bad signature alike.
          fail("hello signature does not verify");
          return;
        }
        // Derived, never read off the message. Whatever `fp` the client wrote
        // is ignored, and the routing label is the one the signature proves.
        const proven = fingerprintOf(signPub, sealPub);
        fp = proven;
        const previous = live.get(proven);
        // Set first: the replaced socket's close handler checks identity before
        // deleting, so it must not find itself still registered.
        live.set(proven, socket);
        if (previous && previous !== socket) previous.close(4000, "replaced");
        reply({ t: "welcome", fp: proven });
        drain(proven, socket);
        return;
      }

      if (m["t"] === "send") {
        // `from` is the fingerprint this socket said hello with. Anything the
        // body claims about identity is ignored here, and the receiving daemon
        // re-derives it from the signature anyway (spec s5.1).
        const me = fp;
        if (me === null) {
          fail("hello first");
          return;
        }
        const to = asString(m["to"]);
        if (to === null || !FINGERPRINT.test(to)) {
          fail("bad recipient");
          return;
        }
        const frame = asString(m["frame"]);
        if (frame === null) {
          fail("frame must be a base64 string");
          return;
        }
        if (frame.length > MAX_FRAME_CHARS) {
          fail("frame exceeds the 256 KB cap");
          return;
        }
        if (route(me, to, frame, reply)) {
          refusals += 1;
          if (refusals >= MAX_REFUSALS) socket.close(4029, "rate limited");
        }
        return;
      }

      if (m["t"] === "mbox_put") {
        if (puts >= MBOX_MAX_PUTS) {
          fail("too many mailboxes from this connection, slow down");
          socket.close(4029, "rate limited");
          return;
        }
        puts += 1;
        const id = asString(m["id"]);
        if (id === null || !MBOX_ID.test(id)) {
          fail("bad mailbox id");
          return;
        }
        const data = asString(m["data"]);
        if (data === null || data === "" || !BASE64ISH.test(data)) {
          fail("mailbox data must be a base64 string");
          return;
        }
        if (data.length > MBOX_MAX_DATA_CHARS) {
          fail("mailbox data exceeds the 4 KB cap");
          return;
        }
        sweepMailboxes();
        // Refused, never overwritten. An overwrite would let anyone holding the
        // code swap their own keys in for the inviter's, and the invitee would
        // pair with them with no visible symptom at all.
        if (liveMailbox(id) !== null) {
          fail("mailbox is already occupied", "occupied");
          return;
        }
        if (mailboxes.size >= MBOX_MAX) {
          sweepMailboxes(true);
          if (mailboxes.size >= MBOX_MAX) {
            fail("relay is out of mailboxes");
            return;
          }
        }
        mailboxes.set(id, { data, expiresAt: now() + MBOX_TTL_MS });
        reply({ t: "mbox_ok" });
        return;
      }

      if (m["t"] === "mbox_take") {
        if (misses >= MBOX_MAX_MISSES) {
          fail("too many mailbox misses on this connection, slow down");
          socket.close(4029, "rate limited");
          return;
        }
        const id = asString(m["id"]);
        if (id === null || !MBOX_ID.test(id)) {
          fail("bad mailbox id");
          return;
        }
        sweepMailboxes();
        const box = liveMailbox(id);
        if (box === null) {
          // A miss is the only signal that someone is guessing, so it is the
          // thing counted. A real joiner never produces one.
          misses += 1;
          reply({ t: "mbox_empty" });
          return;
        }
        misses = 0;
        // SINGLE CLAIM. The entry dies on the way out, so a guessed or stolen
        // code buys exactly one attempt and the real invitee's join then fails
        // loudly, rather than both of them quietly succeeding.
        mailboxes.delete(id);
        reply({ t: "mbox_data", data: box.data });
        return;
      }

      fail("unknown message type");
    });

    socket.on("close", () => {
      if (fp !== null && live.get(fp) === socket) live.delete(fp);
      const left = (connsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) connsByIp.delete(ip);
      else connsByIp.set(ip, left);
    });

    // Swallowed rather than logged: a transport error can carry frame bytes.
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (err) => reject(err));
  });

  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("relay is not listening on a TCP port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
