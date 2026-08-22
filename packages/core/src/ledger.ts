/**
 * The open-issues ledger.
 *
 * This is the thing that makes a seshi conversation converge instead of drift.
 * An issue enters `open` and can only leave through `agreed`, `parked` or
 * `escalated`, and it can never be removed. "Done" is not a feeling the agents
 * report, it is `openCount() === 0` plus the other conditions in detectors.ts.
 *
 * Parking and escalating both demand a reason, because an issue that vanishes
 * with no stated cause is indistinguishable from one that was quietly dropped,
 * and quietly dropping the hard ones is exactly how two agents fake agreement.
 */

import type { LedgerEntry, LedgerState } from "./envelope.ts";

export type IssueRecord = {
  id: string;
  /** One line, as first stated. Never rewritten, so drift is visible. */
  text: string;
  state: LedgerState;
  /** True once a COUNTER or REJECT has ever referenced this issue. */
  contested: boolean;
  /** Present for parked and escalated. */
  reason?: string;
  /** Set when the issue was seeded from the two briefs at turn zero. */
  seeded: boolean;
  /**
   * The two briefs stated genuinely OPPOSING positions on this, not merely
   * the same topic. The conflict set is a heuristic guess and over-includes,
   * so only real opposition counts as something that had to be argued.
   */
  opposed: boolean;
  history: Array<{ from: LedgerState; to: LedgerState; at: number; reason?: string }>;
};

/** Which states may follow which. Terminal states have no successors. */
const ALLOWED: Record<LedgerState, readonly LedgerState[]> = {
  open: ["claimed", "proposed", "parked", "escalated"],
  claimed: ["proposed", "open", "parked", "escalated"],
  proposed: ["agreed", "open", "claimed", "parked", "escalated"],
  agreed: [],
  parked: [],
  escalated: [],
};

const TERMINAL: readonly LedgerState[] = ["agreed", "parked", "escalated"];
const NEEDS_REASON: readonly LedgerState[] = ["parked", "escalated"];

export function isTerminal(state: LedgerState): boolean {
  return TERMINAL.includes(state);
}

export class Ledger {
  readonly #issues = new Map<string, IssueRecord>();
  #clock = 0;

  /** Seed the ledger from the conflict set computed off the two briefs. */
  static seeded(items: Array<{ id: string; text: string; opposed?: boolean }>): Ledger {
    const l = new Ledger();
    for (const i of items) l.add(i.id, i.text, { seeded: true, opposed: i.opposed ?? false });
    return l;
  }

  add(id: string, text: string, opts: { seeded?: boolean; opposed?: boolean } = {}): IssueRecord {
    if (this.#issues.has(id)) throw new Error(`issue ${id} already exists`);
    if (id === "") throw new Error("an issue needs an id");
    const record: IssueRecord = {
      id,
      text,
      state: "open",
      contested: false,
      seeded: opts.seeded ?? false,
      opposed: opts.opposed ?? false,
      history: [],
    };
    this.#issues.set(id, record);
    return { ...record };
  }

  get(id: string): IssueRecord | null {
    const r = this.#issues.get(id);
    return r === undefined ? null : { ...r, history: [...r.history] };
  }

  /**
   * Move an issue. Throws on an illegal transition, on an unknown issue, on any
   * attempt to move out of a terminal state, and on parking or escalating with
   * no reason.
   */
  transition(id: string, to: LedgerState, opts: { reason?: string } = {}): IssueRecord {
    const r = this.#issues.get(id);
    if (r === undefined) throw new Error(`unknown issue: ${id}`);
    if (isTerminal(r.state)) {
      throw new Error(`issue ${id} is ${r.state} and cannot be moved again`);
    }
    if (!ALLOWED[r.state].includes(to)) {
      throw new Error(`illegal transition for ${id}: ${r.state} -> ${to}`);
    }
    if (NEEDS_REASON.includes(to) && (opts.reason ?? "").trim() === "") {
      throw new Error(`moving ${id} to ${to} requires a stated reason`);
    }
    this.#clock += 1;
    r.history.push({ from: r.state, to, at: this.#clock, reason: opts.reason });
    r.state = to;
    if (opts.reason !== undefined) r.reason = opts.reason;
    return { ...r, history: [...r.history] };
  }

  /**
   * Record that an issue was actually argued over. Only COUNTER and REJECT
   * count: an ACCEPT is not a contest, and treating it as one is precisely the
   * hole the degenerate-agreement detector exists to catch.
   */
  markContested(id: string): void {
    const r = this.#issues.get(id);
    if (r === undefined) throw new Error(`unknown issue: ${id}`);
    r.contested = true;
  }

  /** Issues that still need resolving. The number that must reach zero. */
  openCount(): number {
    let n = 0;
    for (const r of this.#issues.values()) if (!isTerminal(r.state)) n += 1;
    return n;
  }

  all(): IssueRecord[] {
    return [...this.#issues.values()].map((r) => ({ ...r, history: [...r.history] }));
  }

  /**
   * Issues the two briefs genuinely disagreed about that reached `agreed`
   * without anyone ever arguing them.
   *
   * `opposed` is load-bearing. Without it, two people happening to agree on a
   * shared topic read as a fold, which is a false alarm on one of the most
   * common healthy shapes there is.
   */
  uncontestedSeededAgreements(): IssueRecord[] {
    return this.all().filter((r) => r.seeded && r.opposed && r.state === "agreed" && !r.contested);
  }

  /** The compact form that rides on an envelope. */
  toEntries(): LedgerEntry[] {
    return this.all().map((r) => ({ id: r.id, state: r.state }));
  }

  /**
   * A stable summary of the ledger's shape. Two identical fingerprints across
   * consecutive turns mean nothing moved, which is what the looping detector
   * watches.
   */
  fingerprint(): string {
    return this.all()
      .map((r) => `${r.id}:${r.state}`)
      .sort()
      .join("|");
  }
}
