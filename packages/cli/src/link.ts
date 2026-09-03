/**
 * The one thing you send someone.
 *
 * Every earlier version of this made the other person do two things: point at a
 * relay, then pair with a code. Two things is one thing too many, and the
 * second one only exists because of an implementation detail they should never
 * have to know about. So the code and the relay travel together:
 *
 *     7-tandem-verdict@dry-forest-1a2b.trycloudflare.com
 *
 * It is not a secret. It carries a pairing code and a hostname, and the code is
 * a bearer to a single-claim mailbox holding PUBLIC keys. Someone who steals it
 * can pair with you, at tier 1, words only, and the real invitee's join then
 * fails loudly rather than silently succeeding for both. The four safety words
 * are what actually catch a man in the middle, on this path and every other.
 */

export type SeshiLink = { code: string; relay: string };

/** Turn a code and a relay address into the single line a human sends. */
export function formatLink(code: string, relayUrl: string): string {
  return `${code}@${relayUrl.replace(/^wss?:\/\//, "")}`;
}

/**
 * Parse what they pasted, forgivingly.
 *
 * People paste with a scheme, without one, wrapped in angle brackets by their
 * mail client, with a trailing full stop from the sentence they typed it into,
 * and with smart quotes. Rejecting any of that teaches them the tool is fussy,
 * so all of it is accepted.
 */
export function parseLink(input: string): SeshiLink {
  const cleaned = input
    .trim()
    .replace(/^[<"'“‘]+|[>"'”’.,;]+$/g, "")
    .replace(/^seshi:\/\//, "");

  const at = cleaned.lastIndexOf("@");
  if (at <= 0 || at === cleaned.length - 1) {
    throw new Error(
      `that does not look like a seshi link.\n` +
        `Expected something like:  7-tandem-verdict@dry-forest-1a2b.trycloudflare.com\n` +
        `Got:  ${input.trim().slice(0, 80)}`,
    );
  }

  const code = cleaned.slice(0, at).trim();
  const host = cleaned.slice(at + 1).trim();

  if (code === "") throw new Error("that link has no pairing code before the @");
  if (!/^[a-z0-9.:-]+$/i.test(host)) {
    throw new Error(`that link's address looks wrong: ${host}`);
  }

  // Plain ws:// is allowed to your own machine and to a private network, and
  // nowhere else. Two people at one desk should not have to route through a
  // stranger's tunnel to talk, and a public host is always a stranger's box.
  //
  // What that costs on a shared wifi: anyone sniffing sees two routing
  // fingerprints, frame sizes and timing. They never see content. Frames are
  // sealed end to end and the relay is handed ciphertext either way.
  const bare = host.replace(/:\d+$/, "");
  const local =
    /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(bare) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(bare);
  return { code, relay: `${local ? "ws" : "wss"}://${host}` };
}
