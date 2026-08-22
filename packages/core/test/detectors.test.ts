import { test } from "node:test";
import assert from "node:assert/strict";
import type { Act, Envelope } from "../src/envelope.ts";
import { Ledger } from "../src/ledger.ts";
import { detect, positionFingerprint, CAPITULATION_LIMIT } from "../src/detectors.ts";

const JAKE = "a".repeat(16);
const DAVE = "b".repeat(16);

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
  const oneSide = [...history, turn(JAKE, "RED_TEAM", "I gave up push", "conceded latency", { artefact: { diff: "d", sha256: "HASH" } })];
  assert.equal(detect({ history: oneSide, ledger }).some((d) => d.kind === "agreement"), false);

  // Both red-team but sign DIFFERENT artefacts. Two yeses on two documents.
  const mismatched = [
    ...oneSide,
    turn(DAVE, "RED_TEAM", "I gave up 30s", "conceded freshness", { artefact: { diff: "d2", sha256: "OTHER" } }),
  ];
  assert.equal(detect({ history: mismatched, ledger }).some((d) => d.kind === "agreement"), false);

  // Both red-team and sign the SAME artefact.
  const agreed = [
    ...oneSide,
    turn(DAVE, "RED_TEAM", "I gave up 30s", "conceded freshness", { artefact: { diff: "d", sha256: "HASH" } }),
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
    turn(JAKE, "RED_TEAM", "x", "x", { artefact: { diff: "d", sha256: "H" } }),
    turn(DAVE, "RED_TEAM", "y", "y", { artefact: { diff: "d", sha256: "H" } }),
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
  const ledger = Ledger.seeded([
    { id: "i-01", text: "push or poll" },
    { id: "i-02", text: "who owns retries" },
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
