/**
 * `seshi watch`: one line per event, for as long as it runs.
 *
 * This is what the SessionStart hook asks the Monitor tool to run, so it has
 * to be safe to start before any conversation exists and to outlive several.
 * It waits for the control socket, streams until that socket closes, and goes
 * back to waiting. Silence while nothing is happening is deliberate: every
 * line printed is an event a session should hear about.
 *
 * The line shape is the one the hook documents:
 *
 *     <ts> | <convo> | <from> | <act> | <headline>
 *
 * `<from>` is `you` for this machine's own turns and a 16-hex fingerprint the
 * daemon stamped for the other side's, never a name the sender chose. Peer
 * headlines arrive already escaped and wrapped in <seshi-peer> tags by the
 * process that received them.
 */

import { connect } from "node:net";
import { Storage } from "../../daemon/src/storage.ts";

const RETRY_MS = 2_000;

const out = (s: string): void => void process.stdout.write(`${s}\n`);

export type WatchOptions = {
  /** Stop after the first stream ends instead of waiting for the next. */
  once?: boolean;
  /** Override the home, for tests. */
  home?: string;
};

export async function watch(home: string, opts: WatchOptions = {}): Promise<number> {
  const storage = Storage.open(opts.home ?? home);
  for (;;) {
    await stream(storage.controlSocketPath(), storage.controlKey());
    if (opts.once) return 0;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

/** Resolves when the socket closes, or when there is nothing to connect to. */
function stream(socketPath: string, token: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, token, verb: "watch" })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        printEvent(line);
      }
    });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

/** Turn one control-socket line into one watch line, or nothing. */
export function formatEvent(line: string): string | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  // The watch acknowledgement is {id, ok, result}; only events are printed.
  if (m["t"] !== "event" || typeof m["event"] !== "object" || m["event"] === null) return null;
  const e = m["event"] as Record<string, unknown>;
  const at = typeof e["at"] === "string" ? e["at"] : new Date().toISOString();
  const convo = String(e["convo"] ?? "").slice(0, 8);
  const s = (k: string): string => String(e[k] ?? "");
  switch (e["kind"]) {
    case "turn":
      return `${at} | ${convo} | ${s("from")} | ${s("act")} | ${s("headline")}`;
    case "say":
      return `${at} | ${convo} | you | HUMAN | ${s("text")}`;
    case "detector":
      return `${at} | ${convo} | seshi | ${s("detector").toUpperCase()} | ${s("because")}`;
    case "dropped":
      return `${at} | ${convo} | seshi | DROPPED | ${s("reason")}`;
    case "quiet":
      return `${at} | ${convo} | seshi | QUIET | ${s("because")}`;
    case "closed":
      return `${at} | ${convo} | seshi | CLOSED | ${s("because")}`;
    default:
      return null;
  }
}

function printEvent(line: string): void {
  const formatted = formatEvent(line);
  if (formatted !== null) out(formatted);
}
