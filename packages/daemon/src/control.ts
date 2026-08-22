/**
 * The daemon's local control socket.
 *
 * Newline-delimited JSON over a unix socket at `$SESHI_HOME/control.sock`.
 *
 *   request   {"id":1,"token":"<64 hex>","verb":"status","args":{}}
 *   reply     {"id":1,"ok":true,"result":…}  |  {"id":1,"ok":false,"error":"…"}
 *   event     {"t":"event","event":{…}}          (watch only, unsolicited)
 *
 * The token is not ceremony. Spec §11.6: seshid's socket hands every same-uid
 * process an outbound network leg it did not previously have, and "every
 * same-uid process" includes the user's own prompt-injectable Claude sessions
 * sitting on client repos. Socket permissions alone are not enough, because
 * they are exactly what a same-uid process satisfies. So the caller must also
 * present a secret it can only get by reading a 0600 file that every peer tier
 * denies (`Read($SESHI_HOME/**)`, see tiers.ts).
 *
 * Three consequences of that threat model, all implemented below:
 *  - the token is compared in constant time, so a caller cannot search for it
 *    one byte at a time;
 *  - a connection that fails to authenticate is answered once and then closed,
 *    and never learns which verbs exist;
 *  - an unauthenticated connection does not count as a client, so it can
 *    neither keep the daemon alive nor receive a single broadcast event.
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";

/** One request line. Matches the relay's frame cap so neither side is the odd one out. */
const MAX_LINE_BYTES = 256 * 1024;

/** How long a connection may sit without authenticating before it is dropped. */
const AUTH_TIMEOUT_MS = 5_000;

export type ControlContext = {
  /** Push an unsolicited event to this one caller. */
  emit(event: unknown): void;
};

export type VerbHandler = (
  args: Record<string, unknown>,
  ctx: ControlContext,
) => unknown | Promise<unknown>;

export type ControlServer = {
  socketPath: string;
  /** Authenticated connections currently open. */
  clientCount(): number;
  /** Send an event to every watching caller. */
  broadcast(event: unknown): void;
  close(): Promise<void>;
};

export type ControlServerOptions = {
  socketPath: string;
  token: string;
  /** `watch` is handled by the transport itself and must not appear here. */
  verbs: Record<string, VerbHandler>;
  /** Called whenever the number of authenticated clients changes. */
  onClientCount?: (n: number) => void;
};

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first. That is not for secrecy, it is so the comparison
 * is always over 32 equal bytes: `timingSafeEqual` throws on a length mismatch,
 * and catching that throw would leak the token's length to anyone probing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** True if something is listening on this socket path right now. */
function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (live: boolean) => {
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(path, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  if ("watch" in opts.verbs)
    throw new Error("`watch` is implemented by the control transport, not by a verb handler");

  /** Connections that have presented a valid token. */
  const authed = new Set<Socket>();
  /** The subset of those that asked to receive events. */
  const watchers = new Set<Socket>();

  const server = createServer();
  server.on("connection", (socket) => onConnection(socket));

  try {
    await listen(server, opts.socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    // Either a daemon owns this home, or a previous one died without cleaning
    // up. Only a connect attempt can tell the two apart.
    if (await isSocketLive(opts.socketPath))
      throw new Error(`a seshi daemon is already running on ${opts.socketPath}`);
    unlinkSync(opts.socketPath);
    await listen(server, opts.socketPath);
  }

  // Belt as well as braces: the home directory is already 0700, but a socket
  // inherited from a looser umask would be reachable if the home ever loosened.
  chmodSync(opts.socketPath, 0o600);

  function announceClientCount(): void {
    opts.onClientCount?.(authed.size);
  }

  function onConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let isAuthed = false;
    let closed = false;
    // Handlers may be async; without this chain two pipelined requests could
    // reply out of order, which the id field would paper over but the watch
    // stream would not.
    let queue: Promise<void> = Promise.resolve();

    const authTimer = setTimeout(() => {
      if (!isAuthed) socket.destroy();
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();

    const write = (obj: unknown): void => {
      if (!closed && socket.writable) socket.write(`${JSON.stringify(obj)}\n`);
    };

    const refuse = (id: unknown, error: string): void => {
      write({ id: id ?? null, ok: false, error });
      // An unauthenticated or malformed caller gets one answer and no second
      // guess. `end` rather than `destroy` so the reply is actually flushed.
      closed = true;
      socket.end();
    };

    const finish = (): void => {
      clearTimeout(authTimer);
      if (isAuthed) {
        authed.delete(socket);
        watchers.delete(socket);
        announceClientCount();
      }
    };

    socket.on("error", () => socket.destroy());
    socket.on("close", finish);

    socket.on("data", (chunk: string) => {
      if (closed) return;
      buffer += chunk;
      let nl: number;
      while (!closed && (nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        queue = queue.then(() => handleLine(line));
      }
      // Checked on what is left after the complete lines have been taken, so
      // the cap is per line rather than per burst: pipelining several ordinary
      // requests into one packet must not look like an oversized one.
      if (!closed && Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES)
        refuse(null, `request too large, cap is ${MAX_LINE_BYTES} bytes`);
    });

    async function handleLine(line: string): Promise<void> {
      if (closed) return;
      let req: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          throw new Error("not an object");
        req = parsed as Record<string, unknown>;
      } catch {
        refuse(null, "malformed request, expected one JSON object per line");
        return;
      }

      const id = req["id"] ?? null;

      // The token is checked before anything else is looked at, so an
      // unauthenticated caller cannot learn a verb name or an argument shape.
      const token = typeof req["token"] === "string" ? req["token"] : "";
      if (!constantTimeEqual(token, opts.token)) {
        refuse(id, "bad or missing control token");
        return;
      }
      if (!isAuthed) {
        isAuthed = true;
        clearTimeout(authTimer);
        authed.add(socket);
        announceClientCount();
      }

      const verb = req["verb"];
      if (typeof verb !== "string") {
        write({ id, ok: false, error: "missing verb" });
        return;
      }

      if (verb === "watch") {
        watchers.add(socket);
        write({ id, ok: true, result: { watching: true } });
        return;
      }

      const handler = Object.prototype.hasOwnProperty.call(opts.verbs, verb)
        ? opts.verbs[verb]
        : undefined;
      if (handler === undefined) {
        write({ id, ok: false, error: `unknown verb: ${verb}` });
        return;
      }

      const rawArgs = req["args"];
      const args =
        typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};

      try {
        const result = await handler(args, { emit: (event) => write({ t: "event", event }) });
        write({ id, ok: true, result: result ?? null });
      } catch (err) {
        write({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    socketPath: opts.socketPath,
    clientCount: () => authed.size,
    broadcast(event: unknown): void {
      const line = `${JSON.stringify({ t: "event", event })}\n`;
      for (const socket of watchers) if (socket.writable) socket.write(line);
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
            return reject(err);
          if (existsSync(opts.socketPath)) {
            try {
              unlinkSync(opts.socketPath);
            } catch {
              // Another daemon may already own the path; not ours to clean up.
            }
          }
          resolve();
        });
        // `server.close` waits for open connections, and a watcher never closes
        // on its own, so the connections are dropped explicitly.
        for (const socket of authed) socket.destroy();
      });
    },
  };
}

/**
 * One request, one reply, over a fresh connection. This is what the CLI and the
 * plugin hook use; `watch` needs a connection that stays open and so is driven
 * directly with `node:net`.
 */
export function controlRequest(
  socketPath: string,
  token: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, token, verb, args })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      socket.end();
      let reply: { ok?: boolean; result?: unknown; error?: unknown };
      try {
        reply = JSON.parse(buffer.slice(0, nl)) as typeof reply;
      } catch {
        reject(new Error("malformed reply from the seshi daemon"));
        return;
      }
      if (reply.ok === true) resolve(reply.result);
      else reject(new Error(String(reply.error ?? "control request failed")));
    });
    socket.on("error", (err) => reject(err));
  });
}
