/**
 * The network leg. Seals an envelope to one contact, pushes it at the relay,
 * and turns inbound frames back into envelopes.
 *
 * Two properties matter more than anything else here, and both are tested:
 *
 *  1. The relay is handed ciphertext and a routing fingerprint. It never sees
 *     a body, an act, or a ledger. Relay-sees-only-ciphertext is the shape
 *     borrowed from xhluca/agent-talk (MIT).
 *
 *  2. Identity is never read from a message. The relay stamps `from` off the
 *     socket that said hello, and this client then throws that away too: it
 *     re-derives the sender from the contact whose signing key actually
 *     verified the signature. A frame whose claimed sender is not a paired
 *     contact is rejected without ever being opened into the inbox.
 */

// No import for WebSocket: Node 24 has one built in, and every dependency the
// client does not have is an `npm install` the user does not have to run.
import { capEnvelope, openEnvelope, sealEnvelope } from "../../core/src/envelope.ts";
import type { Envelope } from "../../core/src/envelope.ts";
import { signBytes, type Identity } from "../../core/src/identity.ts";
import type { Contact } from "./storage.ts";

export type RelayClientOptions = {
  /** ws:// or wss:// URL of the relay. */
  url: string;
  identity: Identity;
  /** Look up a paired contact by the fingerprint the relay stamped. */
  resolveContact: (fingerprint: string) => Contact | null;
  /** A frame that opened and verified. */
  onEnvelope: (envelope: Envelope, from: Contact) => void;
  /** A frame that did not. Never silently dropped. */
  onReject?: (from: string, reason: string) => void;
  onStatus?: (status: RelayStatus) => void;
  /** Milliseconds between reconnect attempts. 0 disables reconnect. */
  reconnectMs?: number;
  /** Milliseconds between keepalive pings while connected. 0 disables. */
  keepaliveMs?: number;
};

/**
 * How long a send waits for a socket before giving up. Longer than one
 * reconnect attempt, shorter than a human's patience.
 */
const SEND_WAIT_MS = 15_000;

/**
 * Well inside every idle timeout measured or documented so far: a cloudflared
 * quick tunnel dropped an idle socket at 126 s, and reverse proxies commonly
 * sit at 60 s. Cheap, and it turns "reconnect and drain" from the normal path
 * into the exceptional one.
 */
const KEEPALIVE_MS = 25_000;

/** Must match the relay. The relay challenges, we sign `domain || nonce`. */
const HELLO_DOMAIN = "seshi-hello-v1";

/** A relay that never challenges, or never welcomes, is not one we are on. */
const HANDSHAKE_MS = 10_000;

export type RelayStatus = "connecting" | "open" | "closed";

const hexToBytes = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

export class RelayClient {
  readonly #opts: RelayClientOptions;
  readonly #fingerprint: string;
  #socket: WebSocket | null = null;
  #closed = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  /** The connect in flight, if any, so two callers share one socket. */
  #pending: Promise<void> | null = null;
  /** Sends parked until the socket is open again. */
  readonly #openWaiters: Array<() => void> = [];
  /** True between the relay's welcome and the socket closing. */
  #registered = false;
  /** The connect in progress, so the handshake messages can settle it. */
  #handshake: { socket: WebSocket; resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(opts: RelayClientOptions) {
    this.#opts = opts;
    // Our own routing label. Derived, never configured, so it cannot drift
    // from the key we actually sign with.
    this.#fingerprint = fingerprintOfIdentity(opts.identity);
  }

  get fingerprint(): string {
    return this.#fingerprint;
  }

  /** Open AND registered: a socket that has not been welcomed cannot send. */
  get connected(): boolean {
    return this.#registered && this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    // One connect at a time. A second caller mid-handshake would open a second
    // socket, and the relay would close the first as replaced, by ourselves.
    if (this.#pending !== null) return this.#pending;
    this.#closed = false;
    this.#opts.onStatus?.("connecting");

    const pending = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#opts.url);
      // The relay speaks JSON text frames. A relay that sends the same JSON as
      // a binary frame still has to be readable, hence the decode below.
      socket.binaryType = "arraybuffer";
      this.#socket = socket;

      // The handshake is driven from #onMessage: the relay sends a challenge,
      // we answer with a signed hello, and `welcome` is what resolves this.
      const timer = setTimeout(() => {
        if (this.#handshake?.socket === socket) {
          this.#handshake = null;
          socket.close();
          reject(new Error(`the relay at ${this.#opts.url} did not complete the handshake`));
        }
      }, HANDSHAKE_MS);
      timer.unref?.();
      this.#handshake = {
        socket,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };

      socket.addEventListener("message", (event) => {
        const data: unknown = event.data;
        this.#onMessage(
          typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer),
        );
      });

      socket.addEventListener("close", () => {
        if (this.#socket === socket) this.#socket = null;
        this.#registered = false;
        if (this.#handshake?.socket === socket) {
          const h = this.#handshake;
          this.#handshake = null;
          h.reject(new Error(`the relay at ${this.#opts.url} closed during the handshake`));
        }
        this.#stopKeepalive();
        this.#opts.onStatus?.("closed");
        this.#scheduleReconnect();
      });

      // A transport error can carry frame bytes, so it is never logged.
      //
      // The handler is unconditional on purpose. An `error` event with no
      // listener is an unhandled error in Node, and a relay closing under a
      // client that is already connected (a normal shutdown, or a test tearing
      // down) would print a stack trace from deep inside undici. Noise like
      // that hides real failures, so the error is surfaced through onStatus and
      // the socket is left to its close handler.
      socket.addEventListener("error", (event) => {
        if (this.#handshake?.socket === socket) {
          const cause: unknown = (event as { error?: unknown }).error;
          const h = this.#handshake;
          this.#handshake = null;
          h.reject(new Error(`could not reach the relay at ${this.#opts.url}`, { cause }));
          return;
        }
        this.#opts.onStatus?.("closed");
      });
    });
    this.#pending = pending;
    const settled = (): void => {
      if (this.#pending === pending) this.#pending = null;
    };
    void pending.then(settled, settled);
    return pending;
  }

  /**
   * Seal `e` to `to` and send it. The envelope is capped BEFORE sealing, so an
   * oversized body cannot reach the wire even if a model ignored its brief.
   */
  send(to: Contact, e: Envelope): Promise<void> {
    return this.sendRaw(to.fingerprint, e, hexToBytes(to.sealPub));
  }

  /** Escape hatch used by tests to seal to a key other than the contact's. */
  sendRaw(toFingerprint: string, e: Envelope, sealPub: Uint8Array): Promise<void> {
    const wire = sealEnvelope(capEnvelope(e), this.#opts.identity, sealPub);
    const frame = Buffer.from(wire).toString("base64");
    return this.#push({ t: "send", to: toFingerprint, frame });
  }

  close(): void {
    this.#closed = true;
    this.#stopKeepalive();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }

  async #push(message: unknown): Promise<void> {
    if (!this.connected) {
      if (this.#closed) throw new Error("relay client is closed");
      // Between an idle drop and the reconnect there is a window of a couple
      // of seconds. A turn that finished inside it was recorded locally and
      // then refused here, which the peer read as a gap and the human read as
      // a crash with no artefact. So a send waits for the socket instead.
      await this.#untilOpen(SEND_WAIT_MS);
    }
    // The built-in WebSocket has no send callback. send() queues the frame and
    // throws only when the socket is not open, which the wait above covers.
    (this.#socket as WebSocket).send(JSON.stringify(message));
  }

  /** Resolve once a socket is open, reconnecting now rather than on the timer. */
  #untilOpen(ms: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.connect().catch(() => this.#scheduleReconnect());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#openWaiters.indexOf(release);
        if (i >= 0) this.#openWaiters.splice(i, 1);
        reject(new Error(`relay client is not connected, and could not reconnect within ${ms}ms`));
      }, ms);
      const release = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.#openWaiters.push(release);
    });
  }

  #startKeepalive(socket: WebSocket): void {
    this.#stopKeepalive();
    const every = this.#opts.keepaliveMs ?? KEEPALIVE_MS;
    if (every <= 0) return;
    this.#pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "ping" }));
    }, every);
    this.#pingTimer.unref?.();
  }

  #stopKeepalive(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const m = parsed as Record<string, unknown>;

    if (m["t"] === "challenge") {
      const nonce = typeof m["nonce"] === "string" ? m["nonce"] : "";
      const socket = this.#handshake?.socket ?? this.#socket;
      if (socket === null || !/^[0-9a-f]{64}$/.test(nonce)) return;
      const id = this.#opts.identity;
      const sig = signBytes(
        Buffer.concat([Buffer.from(HELLO_DOMAIN, "utf8"), Buffer.from(nonce, "hex")]),
        id.sign.priv,
      );
      socket.send(
        JSON.stringify({
          t: "hello",
          signPub: Buffer.from(id.sign.pub).toString("hex"),
          sealPub: Buffer.from(id.seal.pub).toString("hex"),
          sig: Buffer.from(sig).toString("hex"),
        }),
      );
      return;
    }

    if (m["t"] === "welcome") {
      const h = this.#handshake;
      if (h === null) return;
      this.#handshake = null;
      this.#registered = true;
      this.#startKeepalive(h.socket);
      this.#opts.onStatus?.("open");
      for (const release of this.#openWaiters.splice(0)) release();
      h.resolve();
      return;
    }

    if (m["t"] === "error" && this.#handshake !== null) {
      // The relay refused our hello. Nothing else can be in flight yet.
      const h = this.#handshake;
      this.#handshake = null;
      h.reject(new Error(`the relay refused the hello: ${String(m["msg"])}`));
      h.socket.close();
      return;
    }

    if (m["t"] !== "deliver") return;

    const claimedFrom = typeof m["from"] === "string" ? m["from"] : "";
    const frame = typeof m["frame"] === "string" ? m["frame"] : null;
    if (frame === null) {
      this.#reject(claimedFrom, "frame was not a string");
      return;
    }

    // The relay's `from` is a routing label from an unauthenticated hello. It
    // is good enough to pick which contact's key to TRY, and nothing more: the
    // signature check below is what actually establishes who sent this.
    const contact = this.#opts.resolveContact(claimedFrom);
    if (contact === null) {
      this.#reject(claimedFrom, `unknown contact ${claimedFrom}: not a paired contact`);
      return;
    }

    let envelope: Envelope;
    try {
      envelope = openEnvelope(
        Uint8Array.from(Buffer.from(frame, "base64")),
        this.#opts.identity,
        hexToBytes(contact.signPub),
        hexToBytes(contact.sealPub),
      );
    } catch (err) {
      this.#reject(claimedFrom, `could not open frame: ${(err as Error).message}`);
      return;
    }

    // openEnvelope has already overwritten `from` with the fingerprint of the
    // key that verified. If that disagrees with the contact we looked up, the
    // relay's routing label was wrong and we trust the signature, not the label.
    if (envelope.from !== contact.fingerprint) {
      this.#reject(claimedFrom, "signature does not match the routed contact");
      return;
    }

    try {
      this.#opts.onEnvelope(envelope, contact);
    } catch (err) {
      // This runs inside a socket event handler, where a throw is an uncaught
      // exception that takes the whole process down. A frame the daemon could
      // not file is a reject, and one corrupt log line is not a reason to die.
      this.#reject(claimedFrom, `could not file the turn: ${(err as Error).message}`);
    }
  }

  #reject(from: string, reason: string): void {
    this.#opts.onReject?.(from, reason);
  }

  #scheduleReconnect(): void {
    const every = this.#opts.reconnectMs ?? 0;
    if (this.#closed || every <= 0) return;
    if (this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect().catch(() => this.#scheduleReconnect());
    }, every);
    this.#reconnectTimer.unref?.();
  }
}

function fingerprintOfIdentity(id: Identity): string {
  // Imported lazily through a helper so this module has exactly one place that
  // knows how a fingerprint is derived.
  return fingerprintFn(id.sign.pub, id.seal.pub);
}

import { fingerprint as fingerprintFn } from "../../core/src/identity.ts";
