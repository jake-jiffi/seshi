// The relay is deliberately dumb. It sees a recipient fingerprint and an opaque
// base64 frame, and nothing else. It never decodes a frame, never stores one
// beyond the offline queue, and never writes one to a log. The pairing
// mailboxes below hold opaque base64 under a hashed id on the same terms.
//
// The relay-sees-only-ciphertext shape is taken from agent-talk/retalk (MIT).
import { WebSocketServer, WebSocket } from "ws";

/** Hard cap on one frame, enforced here rather than by convention (spec s4.2). */
const MAX_FRAME_CHARS = 256 * 1024;

/** Frames held for one offline recipient before the oldest starts falling off. */
const MAX_QUEUE = 500;

const FINGERPRINT = /^[0-9a-f]{32}$/;

// ---- Pairing mailboxes (spec s8) --------------------------------------------
//
// A mailbox is a one-shot dead drop keyed by a hash of a spoken pairing code.
// One side leaves a bundle of public keys in it, the other takes it out. The
// relay cannot compute the id without the code and never looks inside the blob.
//
// Mailbox ops deliberately do NOT require a hello. Tying a mailbox to a routing
// fingerprint would tell the relay operator which identity is behind a pending
// invite, and buys nothing: the id is already the only credential.

/** A mailbox lives 24 hours, then it is gone whether or not anyone took it. */
const MBOX_TTL_MS = 24 * 60 * 60 * 1000;

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

type QueuedFrame = { from: string; frame: string };

export type Relay = {
  port: number;
  close(): Promise<void>;
};

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

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
      deliver(socket, item.from, item.frame);
    }
    if (queued.length === 0) queues.delete(fp);
  }

  function route(from: string, to: string, frame: string, reply: (m: unknown) => void): void {
    const target = live.get(to);
    if (target && target.readyState === WebSocket.OPEN) {
      deliver(target, from, frame);
      return;
    }
    let queued = queues.get(to);
    if (!queued) {
      queued = [];
      queues.set(to, queued);
    }
    if (queued.length >= MAX_QUEUE) {
      queued.shift();
      reply({ t: "overflow", to });
    }
    queued.push({ from, frame });
    reply({ t: "queued" });
  }

  wss.on("connection", (socket) => {
    let fp: string | null = null;

    const reply = (m: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
    };
    const fail = (msg: string): void => reply({ t: "error", msg });

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

      if (m["t"] === "hello") {
        // NOTE: hello is self-asserted. This prototype relay does not prove key
        // possession, so a fingerprint is a routing label here, not an identity.
        // Spec s4.2 wants authenticated endpoints; see the relay README task.
        if (fp !== null) {
          fail("already registered");
          return;
        }
        const claimed = asString(m["fp"]);
        if (claimed === null || !FINGERPRINT.test(claimed)) {
          fail("bad fingerprint");
          return;
        }
        fp = claimed;
        const previous = live.get(claimed);
        // Set first: the replaced socket's close handler checks identity before
        // deleting, so it must not find itself still registered.
        live.set(claimed, socket);
        if (previous && previous !== socket) previous.close(4000, "replaced");
        drain(claimed, socket);
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
        route(me, to, frame, reply);
        return;
      }

      if (m["t"] === "mbox_put") {
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
          fail("mailbox is already occupied");
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
        const id = asString(m["id"]);
        if (id === null || !MBOX_ID.test(id)) {
          fail("bad mailbox id");
          return;
        }
        sweepMailboxes();
        const box = liveMailbox(id);
        if (box === null) {
          reply({ t: "mbox_empty" });
          return;
        }
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
