/**
 * Four local, deterministic detectors that decide when a conversation is
 * finished, wedged, or lying to itself.
 *
 * The ordering of importance is not obvious and it matters. The documented
 * dominant failure of LLM-to-LLM debate is not deadlock, it is premature
 * sycophantic consensus: two agents converge fast, agree warmly, and produce a
 * decision neither human would have accepted. Deadlock is loud and a human
 * notices. A fold is quiet and looks like success.
 *
 * So `degenerate` is the detector that earns its keep, and it fires on three
 * independent conditions rather than one, because a fold shows up differently
 * depending on which agent did the folding.
 */

import type { Act, Envelope } from "./envelope.ts";
import { Ledger } from "./ledger.ts";

export type DetectionKind = "agreement" | "deadlock" | "looping" | "degenerate";

export type Detection = {
  kind: DetectionKind;
  /** One line a human can act on. */
  because: string;
  /** Whatever the detector counted, so a human can check its arithmetic. */
  evidence: Record<string, unknown>;
};

export type DetectInput = {
  /** Every envelope in the conversation, in the order it was recorded. */
  history: Envelope[];
  ledger: Ledger;
  /** Ledger fingerprints, oldest first, one per turn. */
  ledgerTrail?: string[];
  /**
   * Concessions each party named in its RED_TEAM turn, keyed by fingerprint.
   * An empty array means the agent red-teamed but could not name a position it
   * gave up, which is the third fold signal.
   */
  namedConcessions?: Record<string, string[]>;
};

const CAPITULATION_ACTS: readonly Act[] = ["ACCEPT", "CONCEDE"];

/** Share of a party's substantive turns that simply gave way. */
export const CAPITULATION_LIMIT = 0.7;
/** Turns with an unmoved ledger before we call it looping. */
export const LOOP_TURNS = 4;
/** Identical position fingerprints before we call it deadlock. */
export const DEADLOCK_REPEATS = 3;

export function detect(input: DetectInput): Detection[] {
  const out: Detection[] = [];
  const parties = [...new Set(input.history.map((e) => e.from).filter((f) => f !== ""))];

  const agreement = detectAgreement(input, parties);
  if (agreement !== null) out.push(agreement);

  const degenerate = detectDegenerate(input, parties);
  out.push(...degenerate);

  const looping = detectLooping(input);
  if (looping !== null) out.push(looping);

  const deadlock = detectDeadlock(input, parties);
  if (deadlock !== null) out.push(deadlock);

  return out;
}

/**
 * Genuine agreement needs all three: nothing open, both sides actually
 * red-teamed, and both signed the SAME artefact hash. Two agents saying "yes"
 * is not agreement if they are holding different documents.
 */
function detectAgreement(input: DetectInput, parties: string[]): Detection | null {
  if (parties.length < 2) return null;
  const open = input.ledger.openCount();
  if (open > 0) return null;

  const redTeamed = new Set(
    input.history.filter((e) => e.act === "RED_TEAM").map((e) => e.from),
  );
  if (!parties.every((p) => redTeamed.has(p))) return null;

  const signatures = new Map<string, string>();
  for (const e of input.history) {
    if (e.artefact !== undefined) signatures.set(e.from, e.artefact.sha256);
  }
  if (signatures.size < parties.length) return null;
  const hashes = new Set(signatures.values());
  if (hashes.size !== 1) return null;

  return {
    kind: "agreement",
    because: "the ledger is empty, both sides red-teamed, and both signed the same artefact",
    evidence: { openIssues: 0, redTeamed: [...redTeamed], artefact: [...hashes][0] },
  };
}

/** The fold detector. Any one of three conditions is enough. */
function detectDegenerate(input: DetectInput, parties: string[]): Detection[] {
  const out: Detection[] = [];

  // (a) One side simply gave way most of the time.
  for (const party of parties) {
    const turns = input.history.filter((e) => e.from === party && e.act !== "BRIEF");
    if (turns.length < 3) continue;
    const folds = turns.filter((e) => CAPITULATION_ACTS.includes(e.act)).length;
    const rate = folds / turns.length;
    if (rate > CAPITULATION_LIMIT) {
      out.push({
        kind: "degenerate",
        because: `${party} accepted or conceded on ${Math.round(rate * 100)}% of its turns, which is agreement by exhaustion rather than by argument`,
        evidence: { party, folds, turns: turns.length, rate, limit: CAPITULATION_LIMIT },
      });
    }
  }

  // (b) A conflict that was known at the start reached `agreed` without anyone
  //     ever arguing it. If the briefs disagreed and nobody countered, the
  //     disagreement did not get resolved, it got skipped.
  const uncontested = input.ledger.uncontestedSeededAgreements();
  if (uncontested.length > 0) {
    out.push({
      kind: "degenerate",
      because: `${uncontested.length} seeded conflict(s) reached agreed with no COUNTER or REJECT ever raised against them`,
      evidence: { issues: uncontested.map((i) => ({ id: i.id, text: i.text })) },
    });
  }

  // (c) An agent red-teamed its own position but could not name what it gave
  //     up. A real concession has a cost and the agent can state it.
  const named = input.namedConcessions;
  if (named !== undefined) {
    for (const e of input.history) {
      if (e.act !== "RED_TEAM") continue;
      const concessions = named[e.from];
      if (concessions !== undefined && concessions.length === 0) {
        out.push({
          kind: "degenerate",
          because: `${e.from} red-teamed but could not name a single position it gave up or what that cost its human`,
          evidence: { party: e.from, seq: e.seq },
        });
      }
    }
  }

  return out;
}

/** The ledger has not moved for LOOP_TURNS turns. They are talking past each other. */
function detectLooping(input: DetectInput): Detection | null {
  const trail = input.ledgerTrail ?? [];
  if (trail.length < LOOP_TURNS) return null;
  const recent = trail.slice(-LOOP_TURNS);
  const first = recent[0]!;
  if (!recent.every((f) => f === first)) return null;
  if (input.ledger.openCount() === 0) return null;

  return {
    kind: "looping",
    because: `the ledger has not changed in ${LOOP_TURNS} turns while ${input.ledger.openCount()} issue(s) are still open`,
    evidence: { turns: LOOP_TURNS, fingerprint: first, open: input.ledger.openCount() },
  };
}

/**
 * Both sides have restated the same position DEADLOCK_REPEATS times, and it has
 * held across two consecutive rounds. This is the honest kind of stuck, and it
 * is the one that goes to the humans.
 */
function detectDeadlock(input: DetectInput, parties: string[]): Detection | null {
  if (parties.length < 2) return null;

  const stuck: string[] = [];
  for (const party of parties) {
    const prints = input.history
      .filter((e) => e.from === party && (e.act === "PROPOSE" || e.act === "COUNTER"))
      .map(positionFingerprint);
    if (prints.length < DEADLOCK_REPEATS) continue;
    const tail = prints.slice(-DEADLOCK_REPEATS);
    if (tail.every((p) => p === tail[0])) stuck.push(party);
  }
  if (stuck.length < 2) return null;

  // Confirmed over two consecutive rounds: the repeats must span at least
  // DEADLOCK_REPEATS + 1 turns of real exchange, not one agent talking twice.
  const rounds = Math.min(
    ...stuck.map(
      (p) => input.history.filter((e) => e.from === p && e.act !== "BRIEF").length,
    ),
  );
  if (rounds < DEADLOCK_REPEATS + 1) return null;

  return {
    kind: "deadlock",
    because: `both sides have restated the same position ${DEADLOCK_REPEATS} times running; this needs the humans`,
    evidence: { parties: stuck, repeats: DEADLOCK_REPEATS, rounds },
  };
}

/**
 * A cheap, stable summary of what an agent is arguing, so a restatement is
 * detectable without asking a model. Lowercased, punctuation-stripped, sorted
 * unique content words, so rephrasing the same position still matches.
 */
export function positionFingerprint(e: Envelope): string {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "so", "we", "i", "it", "is", "are", "to",
    "of", "for", "on", "in", "that", "this", "with", "as", "be", "our", "you",
  ]);
  const words = `${e.headline} ${e.body}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  return [...new Set(words)].sort().join(" ");
}
