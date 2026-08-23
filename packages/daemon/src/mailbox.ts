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

export type MailboxOptions = { timeoutMs?: number };

function request(
  url: string,
  message: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let settled = false;

    const finish = (err: Error | null, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // close(), not terminate(): the built-in WebSocket has no terminate, and
      // the answer is already in hand, so a tidy close costs nothing.
      socket.close();
      if (err !== null) reject(err);
      else resolve(value as Record<string, unknown>);
    };

    const timer = setTimeout(
      () => finish(new Error("the relay did not answer the mailbox in time")),
      timeoutMs,
    );
    timer.unref?.();

    socket.addEventListener("open", () => socket.send(JSON.stringify(message)));
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
