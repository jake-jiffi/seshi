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

import { createHash } from "node:crypto";
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
  /**
   * The conversation's mode. Not optional in spirit: capitulation means
   * something completely different in teach (a learner accepting is the
   * point) and review (an author accepting real findings is the goal) than
   * it does in decide, where an advocate who never argues has stopped
   * advocating. Defaults to decide, the strict reading.
   */
  mode?: string;
};

const CAPITULATION_ACTS: readonly Act[] = ["ACCEPT", "CONCEDE"];

/**
 * The hash a signature is checked against.
 *
 * Nothing verified this before, so `artefact.sha256` was whatever the model
 * typed. Two agents could each write "agreed" over completely different
 * documents and the agreement detector counted it as a shared signature. A
 * signature that is not checked against what it signs is decoration.
 */
export function artefactHash(diff: string): string {
  return createHash("sha256").update(canonicaliseArtefact(diff), "utf8").digest("hex");
}

/**
 * Two sides produce their artefact independently, so byte equality is the wrong
 * test: a trailing newline, CRLF, or trailing whitespace blocked agreement
 * entirely. Verifying the hash was right; demanding identical bytes was not,
 * and it turned a false positive into a false negative that would have meant
 * `agreement` essentially never fired.
 *
 * This still does not solve the harder case: a real `git diff` embeds
 * `index <blob>..<blob>` lines that depend on each person's base tree, so two
 * independently generated diffs of the same change are never equal however they
 * are normalised. The real fix is one side proposing exact artefact bytes and
 * the other echoing those same bytes, which is a protocol change and is noted
 * in the README as an open gap rather than pretended away here.
 */
export function canonicaliseArtefact(diff: string): string {
  return diff
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

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
    if (e.artefact === undefined) continue;
    // The claimed hash must actually be the hash of the diff it travels with.
    // Otherwise "we both signed the same thing" is two agents agreeing on a
    // string while holding different documents.
    if (artefactHash(e.artefact.diff) !== e.artefact.sha256) continue;
    signatures.set(e.from, e.artefact.sha256);
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
  //
  //     Only in decide and build. In teach the learner is supposed to accept,
  //     and in review the author accepting valid findings is the goal. Running
  //     this arm there flags the healthiest possible conversation, and a
  //     detector the human learns to ignore costs you every real detection.
  const mode = input.mode ?? "decide";
  const capitulationApplies = mode === "decide" || mode === "build";
  for (const party of capitulationApplies ? parties : []) {
    // HUMAN turns are the person cutting in, not the agent's own moves. They
    // must not dilute the rate: three folds plus three interjections is still
    // an agent that folded every time it spoke.
    const turns = input.history.filter(
      (e) => e.from === party && e.act !== "BRIEF" && e.act !== "HUMAN",
    );
    if (turns.length < 3) continue;
    const folds = turns.filter((e) => CAPITULATION_ACTS.includes(e.act)).length;
    const rate = folds / turns.length;
    // >= not >: sitting exactly on the limit was a way through.
    if (rate >= CAPITULATION_LIMIT) {
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
      if (concessions === undefined) continue;
      if (concessions.length === 0) {
        out.push({
          kind: "degenerate",
          because: `${e.from} red-teamed but could not name a single position it gave up or what that cost its human`,
          evidence: { party: e.from, seq: e.seq },
        });
        continue;
      }
      // Whether a NAMED concession is genuine is a semantic judgement, and
      // lexical overlap is the wrong instrument for it: a real concession is
      // routinely stated as an abstraction ("I dropped my latency
      // requirement" when the argument said "freshness"), which shares no
      // words with the transcript and got flagged as fake. Meanwhile any
      // pleasant sentence reusing two words passed. Only the ABSENCE of a
      // concession is a signal we can read honestly, so that is all we read.
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
      (p) =>
        input.history.filter((e) => e.from === p && e.act !== "BRIEF" && e.act !== "HUMAN").length,
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
/** The most recent envelope before `e` that satisfies `pred`. */
function lastBefore(
  history: Envelope[],
  e: Envelope,
  pred: (o: Envelope) => boolean,
): Envelope | null {
  const i = history.indexOf(e);
  if (i <= 0) return null;
  for (let j = i - 1; j >= 0; j -= 1) {
    const candidate = history[j]!;
    if (pred(candidate)) return candidate;
  }
  return null;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "so", "we", "i", "it", "is", "are", "to",
  "of", "for", "on", "in", "that", "this", "with", "as", "be", "our", "you",
  "will", "was", "have", "has", "not", "can", "his", "her", "their", "them",
  "gave", "give", "given", "up", "which", "costs", "cost",
]);

export function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function positionFingerprint(e: Envelope): string {
  return [...new Set(contentWords(`${e.headline} ${e.body}`))].sort().join(" ");
}
