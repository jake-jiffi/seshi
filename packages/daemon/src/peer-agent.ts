/**
 * The peer agent: one `claude -p` process per conversation.
 *
 * This is where constraint C1 is actually enforced. Everything else in seshi is
 * arranged so that the only tokens spent are the ones each person's own
 * subscription spends, and the only place that claim can be checked at runtime
 * is the `init` event this process reads back off the child's stdout. If that
 * event does not say `apiKeySource: "none"`, `start()` fails and the
 * conversation does not happen (spec §2 C1, §4.3).
 *
 * Two more things follow from the shape rather than the code:
 *
 *  - One process per conversation is what makes per-peer trust tiers
 *    enforceable at all. A PreToolUse hook is handed a session_id and never an
 *    originator, so "Dave at tier 2 caused this tool call" is only knowable if
 *    the process *is* Dave-at-tier-2.
 *  - `--setting-sources user` is mandatory, not stylistic. Without it a hostile
 *    repo's `.claude/settings.json` beats user settings and can set
 *    `disableAllHooks: true`, which disarms the tier deny list this process is
 *    supposed to be running under.
 *
 * Framing: NDJSON in both directions. One `{"type":"user",...}` line per turn on
 * stdin; on stdout, hook chatter, then an `init` event, `assistant` events as
 * the model speaks, and one `result` event closing the turn. Verified against
 * Claude Code 2.1.240.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";

export type PeerAgentOptions = {
  /** Stable UUID for this conversation, passed as `--session-id`. Never a pid. */
  convoId: string;
  /** Absolute path to the generated tier settings file (see tiers.ts). */
  settingsPath: string;
  /** The one directory this agent may work in, passed as `--add-dir`. */
  scopedDir: string;
  /** Working directory for the child. Defaults to the daemon's own. */
  cwd?: string;
  /**
   * Budget for the whole of start(): cold start, the init event, and the
   * priming turn. Claude Code's cold start alone is several seconds and the
   * priming turn is a real model round trip, so this is minutes, not seconds.
   */
  startTimeoutMs?: number;
};

const DEFAULT_START_TIMEOUT_MS = 300_000;

/**
 * The Claude Code build the tier deny list and the stream parsing were
 * verified against. Raise it when re-auditing on an upgrade (spec 11.5).
 */
export const MIN_CLAUDE_CODE = "2.1.240";

/** `a >= b` for dotted numeric versions. Anything non-numeric compares as 0. */
export function atLeast(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * The one thing seshi ever says to a model it has not yet vetted.
 *
 * A `claude -p --input-format stream-json` child emits nothing but hook chatter
 * until the first frame arrives on stdin: the init event is produced at the
 * start of a turn, not at startup (measured on 2.1.240 — init at 8.1s, one
 * second after the first frame was written, having sat silent before it). So
 * the C1 check cannot precede a turn, and the only choice left is *whose* words
 * are in that turn. They are these ones: fixed, short, and containing nothing
 * from the peer or from the human's brief.
 */
const PRIMING_TURN =
  "seshi startup check. Reply with the single word READY and nothing else. Do not use any tools.";

/**
 * Environment variables removed from every peer process.
 *
 * The first group would route this process's thinking through something other
 * than the human's own subscription, which is a C1 violation whatever the
 * intent. The second group is the local peer bus: `CLAUDE_CODE_MESSAGING_*` is
 * exported into every Bash tool call and inherited by subagents, so a peer
 * process that kept them could address the human's own live sessions
 * (docs/CORRECTIONS.md C3). Tiers deny `SendMessage`, `ListAgents` and every
 * shell as well; this is the belt to that pair of braces.
 */
const STRIPPED_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

/**
 * The spawn line.
 *
 * `--bare` is absent deliberately and permanently: it cannot read OAuth
 * credentials, so a code path that reaches for it is a code path that needs an
 * API key.
 *
 * `--verbose` is not in the plan's spawn line and is not optional. Claude Code
 * 2.1.240 exits 1 without it: "When using --print, --output-format=stream-json
 * requires --verbose". It does not change the event stream.
 */
export function buildArgs(opts: PeerAgentOptions): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "user",
    "--settings", opts.settingsPath,
    "--session-id", opts.convoId,
    "--add-dir", opts.scopedDir,
  ];
}

export function buildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

/** Text blocks only. Thinking blocks are the agent's business, not the peer's. */
function assistantText(event: Record<string, unknown>): string {
  const message = event["message"];
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as Record<string, unknown>;
      return b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
    })
    .join("");
}

/**
 * Supervises one `claude -p` child.
 *
 * Turns are strictly serial: a conversation has one turn token, so a second
 * `send()` while one is in flight is a bug in the caller, not something to
 * queue silently.
 *
 * Events: `text` (assistant text as it arrives, priming turn excluded), `exit`
 * with `{ code, signal }`.
 */
export class PeerAgent extends EventEmitter {
  #opts: PeerAgentOptions;
  #child: ChildProcess | null = null;
  #reader: ReadlineInterface | null = null;
  #stderr = "";
  #started = false;
  #ready = false;
  #stopped = false;
  #exited = false;
  #sawInit = false;
  #priming = false;
  #sessionId: string | null = null;
  #onInitEvent: { resolve: () => void; reject: (e: Error) => void } | null = null;
  #onTurn: { resolve: (text: string) => void; reject: (e: Error) => void } | null = null;

  constructor(opts: PeerAgentOptions) {
    super();
    this.#opts = opts;
  }

  /**
   * True while the child exists and can still take a turn. Stopping is a
   * decision, so it counts immediately, without waiting for the exit event.
   */
  get running(): boolean {
    return this.#child !== null && !this.#exited && !this.#stopped;
  }

  /** The session id the child reported in its init event, once started. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * Spawn the child, prove it is thinking on a subscription, and leave it idle
   * and warm. Rejects on an API-keyed init, on an early exit, and on silence
   * past the timeout. Nothing peer-supplied is written until this resolves.
   */
  start(): Promise<void> {
    if (this.#started) return Promise.reject(new Error("peer agent already started"));
    if (this.#stopped) return Promise.reject(new Error("peer agent was stopped before it started"));
    this.#started = true;

    const child = spawn("claude", buildArgs(this.#opts), {
      cwd: this.#opts.cwd,
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Bounded: a chatty child must not become a memory leak in the daemon.
      this.#stderr = (this.#stderr + chunk).slice(-8192);
    });

    if (child.stdout !== null) {
      this.#reader = createInterface({ input: child.stdout });
      this.#reader.on("line", (line) => this.#handleLine(line));
    }

    child.stdin?.on("error", (err: Error) => this.#fail(err));
    child.on("error", (err: Error) => this.#fail(err));
    child.on("exit", (code, signal) => {
      this.#exited = true;
      this.emit("exit", { code, signal });
      this.#fail(
        new Error(
          `claude exited with code ${String(code)} signal ${String(signal)}` +
            (this.#stderr.trim() === "" ? "" : `: ${this.#stderr.trim()}`),
        ),
      );
    });

    const inited = new Promise<void>((resolve, reject) => {
      this.#onInitEvent = { resolve, reject };
    });
    this.#priming = true;
    const primed = new Promise<string>((resolve, reject) => {
      this.#onTurn = { resolve, reject };
    });
    // Attached now, not later, so a rejection racing the init check is never an
    // unhandled rejection.
    let primeError: Error | null = null;
    const primeSettled = primed.then(
      () => undefined,
      (e: Error) => {
        primeError = e;
      },
    );

    this.#write(PRIMING_TURN);

    const timeoutMs = this.#startTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.stop();
        reject(new Error(`claude did not finish starting within ${String(timeoutMs)}ms; timed out`));
      }, timeoutMs);
      timer.unref();
    });

    const startup = (async () => {
      await inited;
      await primeSettled;
      if (primeError !== null) throw primeError;
      this.#ready = true;
    })();

    return Promise.race([startup, timeout])
      .catch((err: unknown) => {
        // A start that failed for any reason must not leave a `claude` behind.
        // The bad-init path has already SIGKILLed; this is for the rest.
        this.stop();
        throw err;
      })
      .finally(() => {
        clearTimeout(timer);
        this.#priming = false;
      });
  }

  /** One turn. Resolves with the child's final result text. */
  send(userText: string): Promise<string> {
    if (!this.#ready) return Promise.reject(new Error("peer agent not started"));
    if (this.#onTurn !== null)
      return Promise.reject(new Error("a turn is already in flight; turns are serial"));
    if (!this.running) return Promise.reject(new Error("peer agent is not running"));

    return new Promise<string>((resolve, reject) => {
      this.#onTurn = { resolve, reject };
      this.#write(userText);
    });
  }

  /** Idempotent. Safe to call before start(), after stop(), or after the child died. */
  stop(): void {
    this.#stopped = true;
    this.#ready = false;
    this.#reader?.close();
    this.#reader = null;
    const child = this.#child;
    if (child === null || this.#exited) return;
    child.stdin?.end();
    child.kill("SIGTERM");
  }

  #startTimeoutMs(): number {
    return this.#opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  /** One user frame, one line. Write failures settle the turn rather than throwing. */
  #write(text: string): void {
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined) {
      this.#settleTurn(null, new Error("peer agent has no stdin to write to"));
      return;
    }
    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.#sessionId ?? this.#opts.convoId,
    });
    stdin.write(`${frame}\n`, (err) => {
      if (err) this.#settleTurn(null, err);
    });
  }

  #handleLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Startup chatter from hooks and plugins shares this pipe. Ignoring a
      // line we cannot parse is right; treating it as a protocol error is not.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const event = parsed as Record<string, unknown>;

    if (event["type"] === "system" && event["subtype"] === "init") {
      this.#handleInit(event);
      return;
    }
    if (event["type"] === "assistant") {
      if (this.#priming) return;
      const text = assistantText(event);
      if (text !== "") this.emit("text", text);
      return;
    }
    if (event["type"] === "result") {
      this.#handleResult(event);
    }
  }

  /**
   * The C1 gate. `apiKeySource` is the only field in the stream that says which
   * wallet this thinking is billed to, and "none" is the only acceptable value:
   * on a subscription-authenticated machine `claude -p` reports exactly that
   * (verified, Claude Code 2.1.240). Anything else, including the field being
   * missing because a future version renamed it, is a hard stop.
   *
   * SIGKILL rather than SIGTERM, and before anything else: init is emitted at
   * the top of the turn, roughly two seconds ahead of the model's first token,
   * so killing on this line is the difference between a refused conversation
   * and a billed one.
   *
   * Every init event is checked, not only the first. A session that re-inits
   * mid-conversation and comes back on an API key is the same violation as one
   * that started that way, and costs three lines to catch.
   */
  #handleInit(event: Record<string, unknown>): void {
    const source = event["apiKeySource"];
    const sessionId = event["session_id"];
    if (typeof sessionId === "string" && this.#sessionId === null) this.#sessionId = sessionId;

    if (source !== "none") {
      this.#child?.kill("SIGKILL");
      this.#stopped = true;
      const error = new Error(
        `refusing to run: claude reported apiKeySource ${JSON.stringify(source)}, ` +
          `expected "none". seshi only ever thinks on the user's own subscription.`,
      );
      const pending = this.#onInitEvent;
      this.#onInitEvent = null;
      pending?.reject(error);
      this.#settleTurn(null, error);
      return;
    }

    // The tier deny list is an enumeration of tool names and the stream
    // parsing was verified against one build. A newer Claude Code may add a
    // tool the list does not name; an older one may not honour the settings
    // this process relies on. Refuse anything older than the verified build,
    // and refuse a missing or unreadable version the same way: an init event
    // that does not say what it is cannot be trusted to behave.
    const version = event["claude_code_version"];
    if (typeof version !== "string" || !atLeast(version, MIN_CLAUDE_CODE)) {
      this.#child?.kill("SIGKILL");
      this.#stopped = true;
      const error = new Error(
        `refusing to run: Claude Code ${typeof version === "string" ? version : "of unknown version"} ` +
          `is older than ${MIN_CLAUDE_CODE}, the build seshi's permission rules were verified ` +
          `against. Update Claude Code and try again.`,
      );
      const pending = this.#onInitEvent;
      this.#onInitEvent = null;
      pending?.reject(error);
      this.#settleTurn(null, error);
      return;
    }

    if (this.#sawInit) return;
    this.#sawInit = true;
    const pending = this.#onInitEvent;
    this.#onInitEvent = null;
    pending?.resolve();
  }

  #handleResult(event: Record<string, unknown>): void {
    const text = typeof event["result"] === "string" ? event["result"] : "";
    if (event["is_error"] === true) {
      const subtype = typeof event["subtype"] === "string" ? event["subtype"] : "unknown";
      this.#settleTurn(
        null,
        new Error(`claude turn failed (${subtype}): ${text === "" ? "no detail" : text}`),
      );
      return;
    }
    this.#settleTurn(text, null);
  }

  #settleTurn(text: string | null, err: Error | null): void {
    const pending = this.#onTurn;
    if (pending === null) return;
    this.#onTurn = null;
    if (err !== null) pending.reject(err);
    else pending.resolve(text ?? "");
  }

  /** One error path for spawn failure and for exit: whoever is waiting hears about it. */
  #fail(err: Error): void {
    const startPending = this.#onInitEvent;
    this.#onInitEvent = null;
    startPending?.reject(err);
    this.#settleTurn(null, err);
  }
}
