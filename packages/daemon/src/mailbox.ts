/**
 * The pairing mailbox client: one request, one answer, one socket.
 *
 * A short-lived connection per operation rather than a method on RelayClient,
 * for two reasons.
 *
 *  1. The relay's replies carry no correlation id, so mailbox answers sharing
 *     the long-lived envelope socket would have to be matched to requests by
 *     arrival order. A `queued` or an `error` from an unrelated send would sit
 *     in the middle of that queue and be mis-attributed.
 *
 *  2. A mailbox op on the envelope socket would be a mailbox op from a socket
 *     that has already said hello with our fingerprint, which tells the relay
 *     operator exactly which identity is behind a pending invite. On its own
 *     socket it tells them nothing but an IP.
 *
 * Pairing happens at human speed, a handful of times per contact, so a socket
 * per poll costs nothing worth optimising.
 */

// No import for WebSocket: Node 24 has one built in, so the client ships with
// no npm dependencies and installs in one line.

/** Long enough for a slow relay, short enough that a poll loop keeps polling. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Extra tries for a connection that never got off the ground. See `attempt`. */
const CONNECT_RETRIES = 2;
const RETRY_PAUSE_MS = 150;

export type MailboxOptions = { timeoutMs?: number };

/**
 * The three ways one attempt can end, kept apart because they are not equally
 * safe to repeat.
 *
 * A mailbox op is NOT idempotent: mbox_take deletes what it returns, and
 * mbox_put refuses a second write. So the only failure worth retrying is one
 * where the request provably never arrived, which is exactly the case where
 * the socket never opened. A socket that opened and then died is ambiguous:
 * the relay may have claimed the mailbox and lost the answer on the way back,
 * and a retry would report an empty mailbox for an invite that was in fact
 * spent. That is reported as a failure instead.
 */
type Attempt =
  | { reply: Record<string, unknown> }
  | { unreachable: Error }
  | { failed: Error };

function attempt(url: string, message: unknown, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let settled = false;
    let opened = false;

    const finish = (err: Error | null, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // close(), not terminate(): the built-in WebSocket has no terminate, and
      // whatever the outcome, this socket has no further use.
      socket.close();
      if (err === null) resolve({ reply: value as Record<string, unknown> });
      else resolve(opened ? { failed: err } : { unreachable: err });
    };

    const timer = setTimeout(
      () => finish(new Error("the relay did not answer the mailbox in time")),
      timeoutMs,
    );
    timer.unref?.();

    socket.addEventListener("open", () => {
      opened = true;
      socket.send(JSON.stringify(message));
    });
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer),
        );
      } catch {
        finish(new Error("the relay answered with something that is not json"));
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        finish(new Error("the relay answered with something that is not an object"));
        return;
      }
      finish(null, parsed as Record<string, unknown>);
    });
    socket.addEventListener("close", () => finish(new Error("the relay closed before answering")));
    // Never logged: an error can carry the bytes that caused it.
    socket.addEventListener("error", () => finish(new Error("could not reach the relay")));
  });
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

async function request(
  url: string,
  message: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let last: Error = new Error("could not reach the relay");
  for (let i = 0; i <= CONNECT_RETRIES; i++) {
    if (i > 0) await pause(RETRY_PAUSE_MS);
    const outcome = await attempt(url, message, timeoutMs);
    if ("reply" in outcome) return outcome.reply;
    if ("failed" in outcome) throw outcome.failed;
    last = outcome.unreachable;
  }
  throw last;
}

/**
 * The relay refused a put because something is already in that mailbox.
 *
 * Its own type because the caller must not confuse it with a network failure:
 * an occupied pairing answer means somebody who knew the code answered first,
 * and that is an alarm rather than a retry.
 */
export class MailboxOccupiedError extends Error {}

const refusal = (m: Record<string, unknown>): string =>
  typeof m["msg"] === "string" ? m["msg"] : `unexpected reply ${String(m["t"])}`;

/** Leave `data` in mailbox `id`. Throws if the mailbox is already occupied. */
export async function mailboxPut(
  url: string,
  id: string,
  data: string,
  opts: MailboxOptions = {},
): Promise<void> {
  const m = await request(url, { t: "mbox_put", id, data }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (m["t"] === "mbox_ok") return;
  if (m["code"] === "occupied") throw new MailboxOccupiedError(refusal(m));
  throw new Error(`the relay refused the mailbox: ${refusal(m)}`);
}

/**
 * Claim mailbox `id`. Returns null when there is nothing in it, which covers
 * expired, never-written, and already-claimed alike: the relay does not tell
 * them apart and neither should a caller.
 *
 * This DELETES the mailbox server side. Calling it is spending the code.
 */
export async function mailboxTake(
  url: string,
  id: string,
  opts: MailboxOptions = {},
): Promise<string | null> {
  const m = await request(url, { t: "mbox_take", id }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (m["t"] === "mbox_empty") return null;
  if (m["t"] === "mbox_data") {
    const data = m["data"];
    if (typeof data !== "string") throw new Error("the relay sent a mailbox with no data in it");
    return data;
  }
  throw new Error(`the relay refused the mailbox: ${refusal(m)}`);
}
