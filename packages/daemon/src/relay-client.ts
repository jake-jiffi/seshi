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

import { WebSocket } from "ws";
import { capEnvelope, openEnvelope, sealEnvelope } from "@seshi/core/envelope";
import type { Envelope } from "@seshi/core/envelope";
import type { Identity } from "@seshi/core/identity";
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
};

export type RelayStatus = "connecting" | "open" | "closed";

const hexToBytes = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

export class RelayClient {
  readonly #opts: RelayClientOptions;
  readonly #fingerprint: string;
  #socket: WebSocket | null = null;
  #closed = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: RelayClientOptions) {
    this.#opts = opts;
    // Our own routing label. Derived, never configured, so it cannot drift
    // from the key we actually sign with.
    this.#fingerprint = fingerprintOfIdentity(opts.identity);
  }

  get fingerprint(): string {
    return this.#fingerprint;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.#closed = false;
    this.#opts.onStatus?.("connecting");

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#opts.url);
      this.#socket = socket;

      socket.on("open", () => {
        socket.send(JSON.stringify({ t: "hello", fp: this.#fingerprint }));
        this.#opts.onStatus?.("open");
        resolve();
      });

      socket.on("message", (data: Buffer | string) => this.#onMessage(String(data)));

      socket.on("close", () => {
        if (this.#socket === socket) this.#socket = null;
        this.#opts.onStatus?.("closed");
        this.#scheduleReconnect();
      });

      // A transport error can carry frame bytes, so it is never logged.
      socket.on("error", (err) => {
        if (!this.connected) reject(err);
      });
    });
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
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }

  #push(message: unknown): Promise<void> {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("relay client is not connected"));
    }
    return new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (err) => (err ? reject(err) : resolve()));
    });
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

    this.#opts.onEnvelope(envelope, contact);
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
  return fingerprintFn(id.sign.pub);
}

import { fingerprint as fingerprintFn } from "@seshi/core/identity";
