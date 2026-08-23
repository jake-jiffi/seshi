/**
 * Short spoken pairing codes, and the mailbox ids they unlock.
 *
 * A code is what one person reads to another over Slack or out loud:
 *
 *     7-tandem-verdict
 *
 * It is a rendezvous password, not a key and not a payload. Nothing sensitive
 * travels in it, and nothing sensitive is derived from it: it only decides
 * WHICH two relay mailboxes the two sides look in. What actually goes in those
 * mailboxes is a bundle of public keys, and the four safety words derived from
 * the ECDH shared secret are still the thing that proves nobody sat in the
 * middle (spec s8).
 *
 * ENTROPY, measured rather than asserted.
 *   digit  1-9        log2(9)    = 3.17 bits
 *   word   of 2048    log2(2048) = 11 bits
 *   word   of 2048    log2(2048) = 11 bits
 *                                 --------
 *                                  25.17 bits
 *
 * That is 25.17 bits, against a floor of 22. Words are drawn independently, so
 * "3-tandem-tandem" is a legal code and the two draws are genuinely 11 bits
 * each. 25 bits is only enough because the relay grants exactly one guess per
 * code: mbox_take deletes the entry, so a wrong guess burns the mailbox and the
 * real invitee's join fails loudly instead of quietly succeeding for both. An
 * attacker who could guess repeatedly would walk 25 bits in minutes.
 */

import { createHash, randomInt } from "node:crypto";
import { WORDLIST } from "./wordlist.ts";

/** Domain separation, so the two ids for one code can never collide. */
const OFFER_PREFIX = "seshi-mbox-offer:";
const ANSWER_PREFIX = "seshi-mbox-answer:";

/** Codes longer than this are a paste of something else, not a spoken code. */
const MAX_CODE_CHARS = 128;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * A fresh pairing code. `<1-9>-<word>-<word>`, e.g. "7-tandem-verdict".
 *
 * `randomInt` is used rather than `Math.random` because this is a password:
 * it is a CSPRNG and it rejects modulo bias rather than folding it in.
 */
export function generateCode(): string {
  const digit = randomInt(1, 10);
  const word = (): string => WORDLIST[randomInt(WORDLIST.length)]!;
  return `${digit}-${word()}-${word()}`;
}

/**
 * The one canonical spelling of a code.
 *
 * People retype these from Slack, from a terminal, or from memory of hearing
 * one read out. "7 Tandem Verdict", "7-TANDEM-VERDICT" and " 7--tandem-verdict "
 * are the same code and must reach the same mailboxes, or the failure looks
 * like an attack when it is a typo.
 */
export function normaliseCode(code: string): string {
  if (typeof code !== "string") throw new Error("a pairing code must be a string");
  if (code.length > MAX_CODE_CHARS) throw new Error("that is not a pairing code, it is too long");
  const normalised = code
    .trim()
    .toLowerCase()
    // Any run of whitespace, dashes or underscores is one separator.
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalised === "") throw new Error("a pairing code cannot be empty");
  return normalised;
}

/**
 * The two mailbox ids a code unlocks.
 *
 * Two, not one, because both sides post: the inviter leaves their bundle in
 * `offer` and the joiner leaves theirs in `answer`. One shared mailbox would
 * have each side taking its own bundle back out, or overwriting the other's.
 *
 * These ids are PUBLIC to anyone holding the code, and the relay sees nothing
 * but the id and an opaque blob. The id is a hash so the relay operator cannot
 * read the spoken code off the wire, not because the id is a secret.
 */
export function mailboxIds(code: string): { offer: string; answer: string } {
  const normalised = normaliseCode(code);
  return {
    offer: sha256Hex(OFFER_PREFIX + normalised),
    answer: sha256Hex(ANSWER_PREFIX + normalised),
  };
}
