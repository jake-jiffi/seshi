/**
 * The code is the whole user-facing surface of pairing, so the things tested
 * here are the things a human can get wrong: case, spacing, dashes, and the
 * two mailboxes never being the same mailbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateCode, mailboxIds, normaliseCode } from "../src/pairing.ts";
import { WORDLIST } from "../src/wordlist.ts";

const HEX64 = /^[0-9a-f]{64}$/;

test("a code is a digit and two words from the list", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    const parts = code.split("-");
    assert.equal(parts.length, 3, `${code} is not <digit>-<word>-<word>`);
    const digit = Number(parts[0]);
    assert.ok(Number.isInteger(digit) && digit >= 1 && digit <= 9, `bad digit in ${code}`);
    assert.ok(WORDLIST.includes(parts[1]!), `${parts[1]} is not in the wordlist`);
    assert.ok(WORDLIST.includes(parts[2]!), `${parts[2]} is not in the wordlist`);
    // Normalisation must be the identity on a code we generated ourselves.
    assert.equal(normaliseCode(code), code);
  }
});

test("the entropy the module claims is the entropy the wordlist can pay", () => {
  // The header comment claims 25.17 bits: log2(9) + 2 * log2(2048). That is
  // only true while the list is 2048 long, so it is asserted rather than
  // trusted.
  assert.equal(WORDLIST.length, 2048);
  const bits = Math.log2(9) + 2 * Math.log2(WORDLIST.length);
  assert.ok(bits >= 22, `only ${bits.toFixed(2)} bits, the floor is 22`);
  assert.equal(bits.toFixed(2), "25.17");
});

test("codes do not repeat in any small sample", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(generateCode());
  // 25 bits against 500 draws: a collision is possible but a heavy clump is
  // the signature of a broken generator.
  assert.ok(seen.size > 495, `only ${seen.size} distinct codes in 500 draws`);
});

test("every spelling a human might use reaches the same mailboxes", () => {
  const canonical = mailboxIds("7-tandem-verdict");
  const spellings = [
    "7-tandem-verdict",
    "7 tandem verdict",
    "7 Tandem Verdict",
    "  7-TANDEM-VERDICT  ",
    "7--tandem---verdict",
    "7_tandem_verdict",
    "-7-tandem-verdict-",
    "7\ttandem\nverdict",
  ];
  for (const s of spellings) {
    assert.deepEqual(mailboxIds(s), canonical, `${JSON.stringify(s)} landed somewhere else`);
    assert.equal(normaliseCode(s), "7-tandem-verdict");
  }
});

test("the offer and answer mailboxes are different mailboxes", () => {
  for (const code of ["7-tandem-verdict", "1-abandon-zoo", generateCode()]) {
    const { offer, answer } = mailboxIds(code);
    assert.match(offer, HEX64);
    assert.match(answer, HEX64);
    assert.notEqual(offer, answer);
  }
});

test("different codes reach different mailboxes", () => {
  const a = mailboxIds("7-tandem-verdict");
  const b = mailboxIds("8-tandem-verdict");
  const c = mailboxIds("7-tandem-verdicu");
  assert.notEqual(a.offer, b.offer);
  assert.notEqual(a.offer, c.offer);
  assert.notEqual(a.answer, b.answer);
  // And no id from one code is ever an id of another.
  assert.equal(new Set([a.offer, a.answer, b.offer, b.answer, c.offer, c.answer]).size, 6);
});

test("the derivation is pinned, so changing it is a deliberate act", () => {
  // Hard-coded rather than recomputed: these strings are a wire format shared
  // by two machines, and a silent change to the prefixes would look like two
  // people mistyping a code at each other.
  assert.deepEqual(mailboxIds("7-tandem-verdict"), {
    offer: "dac28b432f2e5bbe9c4aa37ce8586ca5cf98d65dadc66afc3d79b9581af72a1d",
    answer: "e3a5d753740f460c4f334598b9d185605f001c73e5f9707d1e868e1ff5c29907",
  });
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  assert.equal(mailboxIds("7-tandem-verdict").offer, sha("seshi-mbox-offer:7-tandem-verdict"));
  assert.equal(mailboxIds("7-tandem-verdict").answer, sha("seshi-mbox-answer:7-tandem-verdict"));
});

test("an empty or absurd code is refused rather than hashed into a real id", () => {
  for (const bad of ["", "   ", "-", "---", "\t\n"]) {
    assert.throws(() => mailboxIds(bad), /cannot be empty/, `${JSON.stringify(bad)} was accepted`);
  }
  assert.throws(() => mailboxIds("x".repeat(129)), /too long/);
  // 128 is the boundary and is still a code, however silly.
  assert.match(mailboxIds("x".repeat(128)).offer, HEX64);
});
