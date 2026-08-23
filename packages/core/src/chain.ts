// The per-author hash chain (spec §5: `"prev": "sha256:..."`, hash chain, per author).
//
// Each author numbers their own turns from 1 and points every turn at the hash of
// their previous one. That lets a receiver tell three situations apart: a turn that
// follows on from the last one (ok), a turn arriving after one that never turned up
// (gap), and a history that disagrees with the one already recorded (fork).
//
// The hash EXCLUDES `from`, and that exclusion is the whole reason this file needs
// a comment. `from` is stamped by the receiving daemon from the authenticated
// transport (spec §5.1), so the sender's copy of a turn and the receiver's copy of
// the same turn hold different values there. A hash covering `from` would give the
// two machines different hashes for identical turns, every `prev` would mismatch,
// and every chain would read as a fork the moment it crossed the wire.
//
// Authorship is not what this hash is for. The signature inside the sealed frame
// proves who wrote a turn; the chain proves nothing was dropped, reordered or
// rewritten afterwards.

import { createHash } from "node:crypto";
import type { Envelope } from "./envelope.ts";

/** Every author's first turn. `prev` is null there and nowhere else. */
const FIRST_SEQ = 1;

/** What `Chain.verify` says about a candidate turn. */
export type Verdict = "ok" | "gap" | "fork";

/** `"sha256:<64 hex>"` over the canonical form of everything but `from`. */
export function envelopeHash(e: Envelope): string {
  return `sha256:${createHash("sha256").update(canonicalJson(covered(e)), "utf8").digest("hex")}`;
}

/**
 * Exactly the fields the envelope schema keeps, minus `from`.
 *
 * A whitelist rather than a copy-and-delete: envelopes are built by spreading
 * (`capEnvelope` does), so a stray property can ride along on the sender's local
 * object. `sealEnvelope` drops it before the bytes leave the machine, so the hash
 * has to drop it too, or the sender would chain on to a turn nobody received.
 */
function covered(e: Envelope): Record<string, unknown> {
  const out: Record<string, unknown> = {
    v: e.v,
    convo: e.convo,
    seq: e.seq,
    prev: e.prev,
    act: e.act,
    headline: e.headline,
    body: e.body,
  };
  if (e.ledger !== undefined) out["ledger"] = e.ledger.map((x) => ({ id: x.id, state: x.state }));
  if (e.artefact !== undefined) out["artefact"] = { diff: e.artefact.diff, sha256: e.artefact.sha256 };
  return out;
}

/**
 * JSON with every object's keys in code-unit order, so two envelopes holding the
 * same values serialise to the same bytes whatever order those values were set in.
 * Numbers use JSON's own shortest round-tripping form, which is identical across
 * engines and exact for the integers this protocol carries.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    // JSON.stringify turns NaN and the infinities into `null`, which would quietly
    // hash two different envelopes to the same digest. Refuse instead.
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${value} has no JSON form`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    const fields = Object.keys(r)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(r[k])}`);
    return `{${fields.join(",")}}`;
  }
  throw new Error(`canonicalJson: cannot serialise a ${typeof value}`);
}

/**
 * One author's turns, in order. A conversation holds one of these per party:
 * the local one records what we sent, the remote one what we accepted from them.
 */
export class Chain {
  private readonly log: Envelope[] = [];
  private head: string | null = null;

  /**
   * Record a turn. Throws unless `verify` returns "ok", because a chain that
   * accepted a gap or a fork would move its own expectation on to the bad turn
   * and never report the break again.
   */
  /**
   * Add a turn.
   *
   * `tolerateGap` exists because a gap is not the peer's fault and not a
   * security event: the relay drops the oldest frame on queue overflow, so a
   * gap is a normal consequence of one side being offline too long. Refusing to
   * append one wedged the chain and, because the throw was uncaught, took the
   * daemon down with it. A fork is different and is never tolerated.
   */
  append(e: Envelope, opts: { tolerateGap?: boolean } = {}): void {
    const verdict = this.verify(e);
    if (verdict === "gap" && opts.tolerateGap === true) {
      this.log.push(e);
      this.head = envelopeHash(e);
      return;
    }
    if (verdict !== "ok") {
      const want = this.expectedNext();
      throw new Error(
        `chain: refusing to append (${verdict}): expected seq ${want.seq} prev ${want.prev}, ` +
          `got seq ${e.seq} prev ${e.prev}`,
      );
    }
    this.log.push(e);
    this.head = envelopeHash(e);
  }

  /** The seq and prev the author's next turn must carry. */
  expectedNext(): { seq: number; prev: string | null } {
    return { seq: FIRST_SEQ + this.log.length, prev: this.head };
  }

  verify(e: Envelope): Verdict {
    const want = this.expectedNext();
    if (e.seq > want.seq) return "gap";
    if (e.seq < want.seq) return "fork";
    return e.prev === want.prev ? "ok" : "fork";
  }

  entries(): Envelope[] {
    return [...this.log];
  }
}
