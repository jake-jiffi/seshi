import { test } from "node:test";
import assert from "node:assert/strict";
import type { Act, Envelope } from "../src/envelope.ts";
import { Ledger } from "../src/ledger.ts";
import { detect, positionFingerprint, artefactHash, CAPITULATION_LIMIT } from "../src/detectors.ts";

const JAKE = "a".repeat(32);
const DAVE = "b".repeat(32);

let seq = 0;
function turn(from: string, act: Act, headline: string, body = headline, extra: Partial<Envelope> = {}): Envelope {
  seq += 1;
  return { v: 1, convo: "c1", seq, prev: null, from, act, headline, body, ...extra };
}

/** A conversation where both sides genuinely argued and then converged. */
function healthyHistory(): { history: Envelope[]; ledger: Ledger } {
  const ledger = Ledger.seeded([{ id: "i-01", text: "push or poll" }]);
  const history = [
    turn(JAKE, "BRIEF", "poll, no ops budget"),
    turn(DAVE, "BRIEF", "push, fewer wasted requests"),
    turn(JAKE, "PROPOSE", "poll every 30s"),
    turn(DAVE, "COUNTER", "2800 empty requests a day for one client"),
    turn(JAKE, "EVIDENCE", "under 50 rps and the client backgrounds"),
    turn(DAVE, "PROPOSE", "long poll, no new infrastructure"),
    turn(JAKE, "ACCEPT", "long poll satisfies the ops constraint"),
  ];
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  return { history, ledger };
}

test("a healthy converged conversation is not flagged as degenerate", () => {
  const { history, ledger } = healthyHistory();
  const found = detect({ history, ledger });
  assert.equal(found.filter((d) => d.kind === "degenerate").length, 0);
});

test("agreement needs an empty ledger, both red teams, and one shared artefact hash", () => {
  const { history, ledger } = healthyHistory();

  // Ledger is empty but nobody red-teamed yet.
  assert.equal(detect({ history, ledger }).some((d) => d.kind === "agreement"), false);

  // Only one side red-teams. Still not agreement.
  // Hashes must genuinely cover their diff now (R2), so the fixtures use real
  // ones. A made-up string here used to be enough, which was the defect.
  const doc = "the agreed document";
  const oneSide = [...history, turn(JAKE, "RED_TEAM", "I gave up push", "conceded latency", { artefact: { diff: doc, sha256: artefactHash(doc) } })];
  assert.equal(detect({ history: oneSide, ledger }).some((d) => d.kind === "agreement"), false);

  // Both red-team but sign DIFFERENT artefacts. Two yeses on two documents.
  const mismatched = [
    ...oneSide,
    turn(DAVE, "RED_TEAM", "I gave up 30s", "conceded freshness", { artefact: { diff: "a different document", sha256: artefactHash("a different document") } }),
  ];
  assert.equal(detect({ history: mismatched, ledger }).some((d) => d.kind === "agreement"), false);

  // Both red-team and sign the SAME artefact.
  const agreed = [
    ...oneSide,
    turn(DAVE, "RED_TEAM", "I gave up 30s", "conceded freshness", { artefact: { diff: doc, sha256: artefactHash(doc) } }),
  ];
  const found = detect({ history: agreed, ledger });
  assert.equal(found.some((d) => d.kind === "agreement"), true);
});

test("agreement is refused while any issue is still open", () => {
  const { history } = healthyHistory();
  const ledger = Ledger.seeded([{ id: "i-01", text: "a" }, { id: "i-02", text: "still open" }]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  const both = [
    ...history,
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: "d", sha256: artefactHash("d") } }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: "d", sha256: artefactHash("d") } }),
  ];
  assert.equal(detect({ history: both, ledger }).some((d) => d.kind === "agreement"), false);
});

// ---- degenerate (a): capitulation rate ----

test("degenerate fires when one side simply gives way most of the time", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  const history = [
    turn(JAKE, "BRIEF", "my opening position"),
    turn(DAVE, "BRIEF", "my opening position"),
    turn(DAVE, "PROPOSE", "do it my way"),
    turn(JAKE, "ACCEPT", "sure"),
    turn(DAVE, "PROPOSE", "and this too"),
    turn(JAKE, "ACCEPT", "fine"),
    turn(DAVE, "PROPOSE", "and this"),
    turn(JAKE, "CONCEDE", "ok"),
    turn(DAVE, "PROPOSE", "and this"),
    turn(JAKE, "ACCEPT", "yes"),
  ];
  const found = detect({ history, ledger }).filter((d) => d.kind === "degenerate");
  assert.equal(found.length, 1);
  assert.match(found[0]!.because, /accepted or conceded/);
  assert.equal(found[0]!.evidence["party"], JAKE);
  assert.ok((found[0]!.evidence["rate"] as number) > CAPITULATION_LIMIT);
});

test("a couple of accepts in a long argued conversation is not a fold", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  const history = [
    turn(JAKE, "PROPOSE", "a"),
    turn(JAKE, "COUNTER", "b"),
    turn(JAKE, "EVIDENCE", "c"),
    turn(JAKE, "COUNTER", "d"),
    turn(JAKE, "ACCEPT", "e"),
    turn(DAVE, "PROPOSE", "f"),
    turn(DAVE, "COUNTER", "g"),
    turn(DAVE, "ACCEPT", "h"),
  ];
  assert.equal(detect({ history, ledger }).some((d) => d.kind === "degenerate"), false);
});

// ---- degenerate (b): seeded conflict agreed uncontested ----

test("degenerate fires when a seeded conflict is agreed without ever being contested", () => {
  // Both marked opposed: the briefs genuinely disagreed. Without that, two
  // people happening to agree on a shared topic reads as a fold.
  const ledger = Ledger.seeded([
    { id: "i-01", text: "push or poll", opposed: true },
    { id: "i-02", text: "who owns retries", opposed: true },
  ]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  // i-02 is quietly agreed. Nobody ever countered it.
  ledger.transition("i-02", "proposed");
  ledger.transition("i-02", "agreed");

  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "EVIDENCE", "c"), turn(DAVE, "PROPOSE", "d"),
  ];
  const found = detect({ history, ledger }).filter((d) => d.kind === "degenerate");
  assert.equal(found.length, 1);
  assert.match(found[0]!.because, /seeded conflict/);
  const issues = found[0]!.evidence["issues"] as Array<{ id: string }>;
  assert.deepEqual(issues.map((i) => i.id), ["i-02"]);
});

test("an issue raised mid-conversation and agreed quietly is NOT a fold", () => {
  // Only conflicts known at the start prove the disagreement was skipped.
  const ledger = Ledger.seeded([{ id: "i-01", text: "seeded" }]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  ledger.add("i-99", "came up later");
  ledger.transition("i-99", "proposed");
  ledger.transition("i-99", "agreed");
  const history = [turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b")];
  assert.equal(detect({ history, ledger }).some((d) => d.kind === "degenerate"), false);
});

// ---- degenerate (c): red team that names no concession ----

test("degenerate fires when an agent red-teams but names no concession", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "nothing to report, we agreed on everything"),
  ];
  const found = detect({
    history,
    ledger,
    namedConcessions: { [JAKE]: [], [DAVE]: ["dropped the 30s interval"] },
  }).filter((d) => d.kind === "degenerate");
  assert.equal(found.length, 1);
  assert.match(found[0]!.because, /could not name a single position/);
});

test("a red team that names a real concession is not a fold", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "I gave up sub-second freshness, which costs us the live ticker"),
  ];
  const found = detect({
    history,
    ledger,
    namedConcessions: { [JAKE]: ["sub-second freshness, costs the live ticker"] },
  });
  assert.equal(found.some((d) => d.kind === "degenerate"), false);
});

// ---- looping ----

test("looping fires when the ledger has not moved in four turns", () => {
  const ledger = new Ledger();
  ledger.add("i-01", "still open");
  const fp = ledger.fingerprint();
  const history = [turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b")];
  const found = detect({ history, ledger, ledgerTrail: [fp, fp, fp, fp] });
  assert.equal(found.some((d) => d.kind === "looping"), true);
});

test("looping does not fire when the ledger moved, nor when nothing is open", () => {
  const ledger = new Ledger();
  ledger.add("i-01", "still open");
  const a = ledger.fingerprint();
  ledger.transition("i-01", "proposed");
  const b = ledger.fingerprint();
  const history = [turn(JAKE, "PROPOSE", "a")];
  assert.equal(detect({ history, ledger, ledgerTrail: [a, a, a, b] }).some((d) => d.kind === "looping"), false);

  const done = new Ledger();
  done.add("i-01", "x");
  done.transition("i-01", "proposed");
  done.transition("i-01", "agreed");
  const f = done.fingerprint();
  assert.equal(
    detect({ history, ledger: done, ledgerTrail: [f, f, f, f] }).some((d) => d.kind === "looping"),
    false,
    "an empty ledger that stopped moving is finished, not looping",
  );
});

// ---- deadlock ----

test("deadlock fires when both sides restate the same position three times", () => {
  const ledger = new Ledger();
  ledger.add("i-01", "still open");
  const history = [
    turn(JAKE, "PROPOSE", "poll every 30 seconds, no broker"),
    turn(DAVE, "PROPOSE", "push over websockets, fewer wasted calls"),
    turn(JAKE, "PROPOSE", "no broker: poll every 30 seconds"),
    turn(DAVE, "PROPOSE", "fewer wasted calls: push over websockets"),
    turn(JAKE, "PROPOSE", "every 30 seconds we poll, no broker"),
    turn(DAVE, "PROPOSE", "websockets push over, wasted calls fewer"),
    turn(JAKE, "ASK", "can we settle this"),
    turn(DAVE, "ASK", "I do not think so"),
  ];
  assert.equal(detect({ history, ledger }).some((d) => d.kind === "deadlock"), true);
});

test("deadlock does not fire when one side is actually moving", () => {
  const ledger = new Ledger();
  ledger.add("i-01", "still open");
  const history = [
    turn(JAKE, "PROPOSE", "poll every 30 seconds no broker"),
    turn(DAVE, "PROPOSE", "push over websockets"),
    turn(JAKE, "PROPOSE", "poll every 30 seconds no broker"),
    turn(DAVE, "PROPOSE", "long poll instead, that is different"),
    turn(JAKE, "PROPOSE", "poll every 30 seconds no broker"),
    turn(DAVE, "PROPOSE", "server sent events, another idea entirely"),
  ];
  assert.equal(detect({ history, ledger }).some((d) => d.kind === "deadlock"), false);
});

test("the position fingerprint survives rephrasing but not a change of position", () => {
  const a = positionFingerprint(turn(JAKE, "PROPOSE", "Poll every 30 seconds, no broker."));
  const b = positionFingerprint(turn(JAKE, "PROPOSE", "no broker; we poll every 30 seconds"));
  const c = positionFingerprint(turn(JAKE, "PROPOSE", "push over websockets with a broker"));
  assert.equal(a, b, "reordering and punctuation must not change the position");
  assert.notEqual(a, c);
});

test("detect returns nothing on an empty conversation", () => {
  assert.deepEqual(detect({ history: [], ledger: new Ledger() }), []);
});

// ---- R2: the artefact hash must be verified, not taken on trust ----

test("R2: agreement is refused when the signed hash does not match the signed diff", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");

  // Both sides claim the same sha256 over COMPLETELY DIFFERENT diffs. Two
  // agents can manufacture agreement over two different documents, and a
  // sycophantic model can just echo whatever short string it saw.
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: "jake's document", sha256: "agreed" }, concessions: ["gave up X"] }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: "dave's ENTIRELY different document", sha256: "agreed" }, concessions: ["gave up Y"] }),
  ];
  const found = detect({ history, ledger, namedConcessions: { [JAKE]: ["gave up X"], [DAVE]: ["gave up Y"] } });
  assert.equal(
    found.some((d) => d.kind === "agreement"),
    false,
    "a hash that does not match its own diff must never count as a signature",
  );
});

test("R2: agreement still fires when both sides genuinely sign the same document", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  ledger.markContested("i-01");
  ledger.transition("i-01", "proposed");
  ledger.transition("i-01", "agreed");

  const doc = "the agreed handoff spec";
  const hash = artefactHash(doc);
  const history = [
    turn(JAKE, "PROPOSE", "a"), turn(DAVE, "COUNTER", "b"),
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: doc, sha256: hash }, concessions: ["gave up X"] }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: doc, sha256: hash }, concessions: ["gave up Y"] }),
  ];
  const found = detect({ history, ledger, namedConcessions: { [JAKE]: ["gave up X"], [DAVE]: ["gave up Y"] } });
  assert.ok(found.some((d) => d.kind === "agreement"), "a real shared signature must still count");
});

// ---- R1: folds that dodge the act label or the concession check ----

test("KNOWN GAP: a fold that avoids ACCEPT/CONCEDE in decide mode is NOT caught", () => {
  // An adoption detector used to catch this by comparing position fingerprints.
  // It was DELETED, and deliberately: it fired on a teach learner honestly
  // restating a method (which teach mode explicitly instructs) and it missed
  // any fold that paraphrased, because the fingerprint is set-equality over
  // content words. It caught the wrong direction.
  //
  // This test exists so the gap is recorded rather than forgotten. If it ever
  // starts failing, someone has found a better instrument, and that is good
  // news that should be reviewed rather than a regression.
  const ledger = Ledger.seeded([{ id: "i-01", text: "x", opposed: true }]);
  const line = "we should use long poll on a thirty second interval";
  const history = [
    turn(DAVE, "PROPOSE", line),
    turn(JAKE, "PROPOSE", line),
    turn(DAVE, "PROPOSE", line + " and metres"),
    turn(JAKE, "EVIDENCE", line + " and metres"),
  ];
  assert.equal(
    detect({ history, ledger, mode: "decide" }).some((d) => d.kind === "degenerate"),
    false,
    "recorded gap: relabelled folds are not detected",
  );
});

test("R1: a fold held at exactly the limit is caught", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "x" }]);
  // 7 of 10 is exactly 0.7, which a strict > comparison lets through.
  const history = [
    ...Array.from({ length: 7 }, (_, i) => turn(JAKE, "ACCEPT", `yes ${i}`)),
    ...Array.from({ length: 3 }, (_, i) => turn(JAKE, "ASK", `question ${i}`)),
    turn(DAVE, "PROPOSE", "a"), turn(DAVE, "PROPOSE", "b"), turn(DAVE, "PROPOSE", "c"),
  ];
  const found = detect({ history, ledger });
  assert.ok(
    found.some((d) => d.kind === "degenerate"),
    "sitting exactly on the limit must not be a way through",
  );
});

test("KNOWN GAP: a plausible but fake concession is NOT caught", () => {
  // A relatedness check (>= 2 content words shared with the transcript) used to
  // flag these. It was DELETED because it flagged GENUINE concessions phrased as
  // abstractions or synonyms, which is how people actually state them, while any
  // pleasant sentence reusing two words sailed through. Lexical overlap is the
  // wrong instrument for a semantic property.
  //
  // Only the ABSENCE of a concession is a signal we can read honestly.
  const ledger = Ledger.seeded([{ id: "i-01", text: "the polling interval", opposed: true }]);
  ledger.markContested("i-01");
  const history = [
    turn(JAKE, "PROPOSE", "poll every thirty seconds because we have no ops budget"),
    turn(DAVE, "COUNTER", "push over websockets, fewer wasted requests"),
    turn(JAKE, "RED_TEAM", "my red team", "arguing against this deal"),
  ];
  assert.equal(
    detect({
      history, ledger, mode: "decide",
      namedConcessions: { [JAKE]: ["we will be extra friendly in code review"] },
    }).some((d) => d.kind === "degenerate"),
    false,
    "recorded gap: a fake but plausible concession passes",
  );
});

test("a concession that references the argument is not flagged", () => {
  const ledger = Ledger.seeded([{ id: "i-01", text: "the polling interval" }]);
  ledger.markContested("i-01");
  const history = [
    turn(JAKE, "PROPOSE", "poll every thirty seconds because we have no ops budget"),
    turn(DAVE, "COUNTER", "push over websockets, fewer wasted requests"),
    turn(JAKE, "RED_TEAM", "my red team", "arguing against this deal"),
  ];
  const found = detect({
    history,
    ledger,
    namedConcessions: { [JAKE]: ["I gave up the thirty second polling interval, which costs us freshness"] },
  });
  assert.equal(
    found.some((d) => d.kind === "degenerate" && /unrelated|nothing that was contested/i.test(d.because)),
    false,
  );
});
