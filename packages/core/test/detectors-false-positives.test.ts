/**
 * Healthy conversations that must NOT be flagged.
 *
 * A detector the human learns to ignore is worse than no detector, because it
 * costs you every real detection too. The third adversarial review built eight
 * healthy shapes and five of them fired a spurious "degenerate", across all
 * four arms. These are those shapes.
 *
 * Read this file as the specification for what "healthy" looks like. Anything
 * here that starts failing means a detector has become noise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Act, Envelope } from "../src/envelope.ts";
import { Ledger } from "../src/ledger.ts";
import { detect, artefactHash } from "../src/detectors.ts";

const JAKE = "a".repeat(32);
const DAVE = "b".repeat(32);

let seq = 0;
function turn(from: string, act: Act, headline: string, body = headline, extra: Partial<Envelope> = {}): Envelope {
  seq += 1;
  return { v: 1, convo: "c1", seq, prev: null, from, act, headline, body, ...extra };
}

const folds = (history: Envelope[], opts: Parameters<typeof detect>[0] extends infer _ ? Record<string, unknown> : never = {}) =>
  detect({ history, ledger: new Ledger(), ...opts } as Parameters<typeof detect>[0])
    .filter((d) => d.kind === "degenerate");

// ---- teach mode: the learner is SUPPOSED to accept and to restate ----

test("teach: a learner restating the method to confirm understanding is not a fold", () => {
  const method = "seams follow the silhouette break rather than the material break on hard surface";
  const history = [
    turn(DAVE, "EVIDENCE", method),
    turn(JAKE, "EVIDENCE", method), // restating, which teach mode explicitly asks for
    turn(DAVE, "EVIDENCE", `${method} except on organics`),
    turn(JAKE, "PROPOSE", `${method} except on organics`),
  ];
  const found = detect({ history, ledger: new Ledger(), mode: "teach" });
  assert.equal(
    found.filter((d) => d.kind === "degenerate").length,
    0,
    `teach mode tells the learner to restate the method; flagging that is punishing the instruction: ${JSON.stringify(found.map((d) => d.because))}`,
  );
});

test("teach: a learner accepting most of what they are taught is not a fold", () => {
  const history = [
    turn(DAVE, "EVIDENCE", "here is how I decide edge flow on hard surface"),
    turn(JAKE, "ACCEPT", "understood, edge flow follows the silhouette"),
    turn(DAVE, "EVIDENCE", "and here is where it stops applying"),
    turn(JAKE, "ACCEPT", "understood, it stops on organics"),
    turn(DAVE, "EVIDENCE", "and the failure mode when you get it wrong"),
    turn(JAKE, "ACCEPT", "understood, the mesh shatters at the bake"),
    turn(JAKE, "ASK", "what about hard surface with organic detail"),
  ];
  const found = detect({ history, ledger: new Ledger(), mode: "teach" });
  assert.equal(
    found.filter((d) => d.kind === "degenerate").length,
    0,
    "a learner accepting what they are taught is the point of teach mode",
  );
});

// ---- review mode: the author accepting valid findings is the goal ----

test("review: an author accepting every valid finding is not a fold", () => {
  const history = [
    turn(DAVE, "REJECT", "unbounded loop in the retry path"),
    turn(JAKE, "ACCEPT", "correct, I will add a guard"),
    turn(DAVE, "REJECT", "the error is swallowed on line 40"),
    turn(JAKE, "ACCEPT", "correct, it should propagate"),
    turn(DAVE, "REJECT", "no test covers the empty case"),
    turn(JAKE, "ACCEPT", "correct, adding one"),
  ];
  const found = detect({ history, ledger: new Ledger(), mode: "review" });
  assert.equal(
    found.filter((d) => d.kind === "degenerate").length,
    0,
    "accepting real bugs is what review mode is for",
  );
});

// ---- decide mode: folding here IS a fold, so this must still fire ----

test("decide: an advocate accepting everything IS still caught", () => {
  const history = [
    turn(DAVE, "PROPOSE", "do it my way please"),
    turn(JAKE, "ACCEPT", "sure"),
    turn(DAVE, "PROPOSE", "and this too"),
    turn(JAKE, "ACCEPT", "fine"),
    turn(DAVE, "PROPOSE", "and this as well"),
    turn(JAKE, "ACCEPT", "yes"),
  ];
  const found = detect({ history, ledger: new Ledger(), mode: "decide" });
  assert.ok(
    found.some((d) => d.kind === "degenerate"),
    "an advocate who never argues is exactly what this detector is for",
  );
});

// ---- (b): agreeing on a seeded topic is not automatically a fold ----

test("a seeded item both sides genuinely agreed on is not a fold unless the briefs opposed", () => {
  // The conflict set is a heuristic guess from two briefs and over-includes:
  // a shared TOPIC is not a contest. Only genuine opposition counts.
  const ledger = Ledger.seeded([{ id: "i-01", text: "the sidecar format" }]);
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  const history = [
    turn(JAKE, "PROPOSE", "use JSON for the sidecar, everything can read it"),
    turn(DAVE, "ACCEPT", "yes, JSON works for me too"),
    turn(JAKE, "EVIDENCE", "here is the schema"),
  ];
  const found = detect({ history, ledger, mode: "decide" });
  assert.equal(
    found.filter((d) => /seeded conflict/.test(d.because)).length,
    0,
    "two people happening to agree is not a fold",
  );
});

test("a seeded item the briefs genuinely OPPOSED, agreed with no contest, IS a fold", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "push or poll", opposed: true }]);
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  const history = [
    turn(JAKE, "PROPOSE", "poll"),
    turn(DAVE, "ACCEPT", "fine, poll"),
  ];
  const found = detect({ history, ledger, mode: "decide" });
  assert.ok(
    found.some((d) => /seeded conflict/.test(d.because)),
    "the briefs directly disagreed and nobody argued it; that is the fold",
  );
});

// ---- (c): a genuine concession phrased abstractly must not be flagged ----

test("a real concession phrased in different words than the argument is not flagged", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "the polling interval", opposed: true }]);
  ledger.markContested("i-01");
  const history = [
    turn(JAKE, "PROPOSE", "we need freshness, stale data breaks the ticker"),
    turn(DAVE, "COUNTER", "responsiveness costs us wasted requests all day"),
    turn(JAKE, "RED_TEAM", "arguing against my own position before I sign"),
  ];
  const found = detect({
    history, ledger, mode: "decide",
    // A genuine concession, stated as an abstraction. Zero content words shared
    // with the transcript, which the old relatedness check flagged as fake.
    namedConcessions: { [JAKE]: ["I dropped my latency requirement"] },
  });
  assert.equal(
    found.filter((d) => d.kind === "degenerate").length,
    0,
    "real concessions are routinely stated as synonyms or abstractions",
  );
});

test("a RED_TEAM naming NO concession at all is still caught", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x", opposed: true }]);
  ledger.markContested("i-01");
  const history = [
    turn(JAKE, "PROPOSE", "my position on the interval"),
    turn(DAVE, "COUNTER", "my counter position"),
    turn(JAKE, "RED_TEAM", "nothing to report, we agreed on everything"),
  ];
  const found = detect({ history, ledger, mode: "decide", namedConcessions: { [JAKE]: [] } });
  assert.ok(found.some((d) => d.kind === "degenerate"), "naming nothing is still the signal");
});

// ---- agreement must survive cosmetic differences in independently-made diffs ----

test("agreement survives trailing newline, CRLF and trailing whitespace differences", () => {
  const ledger = new Ledger();
  const doc = "# Handoff\n\nOBJ plus a JSON sidecar.\n";
  const theirs = "# Handoff\r\n\r\nOBJ plus a JSON sidecar.   ";
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: doc, sha256: artefactHash(doc) }, concessions: ["gave up mm"] }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: theirs, sha256: artefactHash(theirs) }, concessions: ["gave up metres"] }),
  ];
  const found = detect({
    history, ledger, mode: "decide",
    namedConcessions: { [JAKE]: ["gave up mm"], [DAVE]: ["gave up metres"] },
  });
  assert.ok(
    found.some((d) => d.kind === "agreement"),
    "two sides producing the same document independently must be able to agree",
  );
});

test("agreement is still refused over genuinely different documents", () => {
  const ledger = new Ledger();
  const a = "OBJ plus a JSON sidecar";
  const b = "GLB with an extras block";
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: a, sha256: artefactHash(a) }, concessions: ["c"] }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: b, sha256: artefactHash(b) }, concessions: ["c"] }),
  ];
  const found = detect({ history, ledger, mode: "decide", namedConcessions: { [JAKE]: ["c"], [DAVE]: ["c"] } });
  assert.equal(found.some((d) => d.kind === "agreement"), false);
});

test("a fabricated hash is still not a signature", () => {
  const ledger = new Ledger();
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: "jake's doc", sha256: "agreed" }, concessions: ["c"] }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: "dave's other doc", sha256: "agreed" }, concessions: ["c"] }),
  ];
  const found = detect({ history, ledger, mode: "decide", namedConcessions: { [JAKE]: ["c"], [DAVE]: ["c"] } });
  assert.equal(found.some((d) => d.kind === "agreement"), false);
});

void folds;
