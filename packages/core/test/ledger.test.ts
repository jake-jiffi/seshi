import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, isTerminal } from "../src/ledger.ts";

test("an issue starts open and uncontested", () => {
  const l = new Ledger();
  const i = l.add("i-01", "push or poll");
  assert.equal(i.state, "open");
  assert.equal(i.contested, false);
  assert.equal(l.openCount(), 1);
});

test("an id cannot be reused", () => {
  const l = new Ledger();
  l.add("i-01", "first");
  assert.throws(() => l.add("i-01", "second"), /already exists/);
});

test("an issue can never be deleted, and there is no method to try", () => {
  const l = new Ledger();
  l.add("i-01", "push or poll");
  const surface = new Set([
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(l)),
    ...Object.getOwnPropertyNames(l),
  ]);
  for (const banned of ["delete", "remove", "drop", "clear", "pop", "splice"]) {
    assert.ok(!surface.has(banned), `Ledger must not expose ${banned}()`);
  }
  // And the record handed back is a copy, so mutating it changes nothing.
  const copy = l.get("i-01")!;
  copy.state = "agreed";
  assert.equal(l.get("i-01")!.state, "open");
  assert.equal(l.openCount(), 1);
});

test("the happy path walks open -> proposed -> agreed", () => {
  const l = new Ledger();
  l.add("i-01", "push or poll");
  l.transition("i-01", "proposed");
  l.transition("i-01", "agreed");
  assert.equal(l.get("i-01")!.state, "agreed");
  assert.equal(l.openCount(), 0);
});

test("an illegal transition throws rather than being coerced", () => {
  const l = new Ledger();
  l.add("i-01", "x");
  assert.throws(() => l.transition("i-01", "agreed"), /illegal transition/);
});

test("a terminal issue cannot be moved again, in any direction", () => {
  const l = new Ledger();
  l.add("i-01", "x");
  l.transition("i-01", "proposed");
  l.transition("i-01", "agreed");
  for (const to of ["open", "proposed", "parked", "escalated", "agreed"] as const) {
    assert.throws(() => l.transition("i-01", to), /cannot be moved again/);
  }
});

test("parking and escalating demand a stated reason", () => {
  const l = new Ledger();
  l.add("i-01", "x");
  l.add("i-02", "y");
  assert.throws(() => l.transition("i-01", "parked"), /requires a stated reason/);
  assert.throws(() => l.transition("i-01", "parked", { reason: "   " }), /requires a stated reason/);
  const parked = l.transition("i-01", "parked", { reason: "needs Jake's client input" });
  assert.equal(parked.reason, "needs Jake's client input");
  assert.throws(() => l.transition("i-02", "escalated"), /requires a stated reason/);
});

test("an unknown issue throws instead of being created by accident", () => {
  const l = new Ledger();
  assert.throws(() => l.transition("nope", "proposed"), /unknown issue/);
  assert.throws(() => l.markContested("nope"), /unknown issue/);
});

test("history records every move with its reason", () => {
  const l = new Ledger();
  l.add("i-01", "x");
  l.transition("i-01", "claimed");
  l.transition("i-01", "proposed");
  l.transition("i-01", "parked", { reason: "out of scope" });
  const h = l.get("i-01")!.history;
  assert.deepEqual(h.map((s) => `${s.from}->${s.to}`), [
    "open->claimed",
    "claimed->proposed",
    "proposed->parked",
  ]);
  assert.equal(h[2]!.reason, "out of scope");
});

test("openCount counts only non-terminal issues", () => {
  const l = new Ledger();
  l.add("a", "a"); l.add("b", "b"); l.add("c", "c"); l.add("d", "d");
  l.transition("b", "proposed");
  l.transition("c", "proposed"); l.transition("c", "agreed");
  l.transition("d", "parked", { reason: "later" });
  assert.equal(l.openCount(), 2, "open and proposed are still open; agreed and parked are not");
  assert.deepEqual([isTerminal("agreed"), isTerminal("parked"), isTerminal("proposed")], [true, true, false]);
});

test("seeded issues are marked, and uncontested seeded agreements are findable", () => {
  const l = Ledger.seeded([
    { id: "i-01", text: "push or poll" },
    { id: "i-02", text: "who owns retries" },
  ]);
  l.add("i-03", "raised mid-conversation");

  // i-01 was argued over before it was agreed.
  l.markContested("i-01");
  l.transition("i-01", "proposed");
  l.transition("i-01", "agreed");

  // i-02 was agreed with nobody ever arguing it. This is the fold.
  l.transition("i-02", "proposed");
  l.transition("i-02", "agreed");

  // i-03 was not seeded, so it is not evidence of a fold either way.
  l.transition("i-03", "proposed");
  l.transition("i-03", "agreed");

  const folds = l.uncontestedSeededAgreements();
  assert.equal(folds.length, 1);
  assert.equal(folds[0]!.id, "i-02");
});

test("the fingerprint changes when the ledger moves and not otherwise", () => {
  const l = new Ledger();
  l.add("i-01", "x");
  const before = l.fingerprint();
  assert.equal(l.fingerprint(), before, "reading it twice does not change it");
  l.transition("i-01", "proposed");
  assert.notEqual(l.fingerprint(), before);
});

test("the fingerprint does not depend on insertion order", () => {
  const a = new Ledger();
  a.add("i-02", "b"); a.add("i-01", "a");
  const b = new Ledger();
  b.add("i-01", "a"); b.add("i-02", "b");
  assert.equal(a.fingerprint(), b.fingerprint());
});

test("toEntries produces the compact wire form", () => {
  const l = new Ledger();
  l.add("i-01", "x");
  l.transition("i-01", "proposed");
  assert.deepEqual(l.toEntries(), [{ id: "i-01", state: "proposed" }]);
});
