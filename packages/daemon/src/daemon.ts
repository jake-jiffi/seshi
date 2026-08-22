/**
 * `seshid`, the local daemon.
 *
 * One per machine, spawned on demand, exits when the last client disconnects
 * (spec §4.1). It owns identity, contacts, tiers, storage and, later, the relay
 * connection and peer agents. It never calls a model: that is what makes the
 * no-API-usage constraint true by construction rather than by policy.
 *
 * This file is the lifecycle and the verb implementations. The socket, its
 * framing and its authentication live in control.ts.
 */

import { fingerprint as fingerprintOf } from "@seshi/core/identity";
import { startControlServer, type ControlServer, type VerbHandler } from "./control.ts";
import { Storage, type Contact } from "./storage.ts";
import type { Tier } from "./tiers.ts";

/** Long enough that a CLI can spawn the daemon and connect, short enough to not linger. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export type DaemonOptions = {
  /** $SESHI_HOME. Defaults to `SESHI_HOME` in the environment, then `~/.seshi`. */
  home?: string;
  /** Milliseconds with no connected client before the daemon shuts itself down. 0 disables. */
  idleTimeoutMs?: number;
  /**
   * Called after `say` has been recorded locally. This is where the relay
   * client and the conversation state machine attach; without one, `say` is
   * still a real local record and a real event to every watcher.
   */
  onSay?: (convo: string, text: string) => void | Promise<void>;
};

export type Daemon = {
  home: string;
  socketPath: string;
  /** The control token callers must present. Read from `$SESHI_HOME/control.key`. */
  token: string;
  storage: Storage;
  startedAt: number;
  /** Resolves once the daemon has shut down, whether by `stop()` or by going idle. */
  stopped: Promise<void>;
  stop(): Promise<void>;
  /** Push an event to every watching client. */
  broadcast(event: unknown): void;
};

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") throw new Error(`missing argument: ${key}`);
  return value;
}

function isTier(value: unknown): value is Tier {
  return value === 1 || value === 2 || value === 3;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const storage = Storage.open(opts.home);
  const token = storage.controlKey();
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const startedAt = Date.now();

  let control: ControlServer | null = null;
  const broadcast = (event: unknown): void => control?.broadcast(event);

  const verbs: Record<string, VerbHandler> = {
    status: () => {
      const identity = storage.readIdentity();
      return {
        pid: process.pid,
        home: storage.home,
        socket: storage.controlSocketPath(),
        fingerprint: identity === null ? null : fingerprintOf(identity.sign.pub),
        uptimeMs: Date.now() - startedAt,
        clients: control?.clientCount() ?? 0,
        contacts: storage.listContacts().length,
        convos: storage.listConvos().length,
      };
    },

    contacts: () => storage.listContacts(),

    convos: () => storage.listConvos(),

    /**
     * The human's own words, into their own conversation.
     *
     * Recorded before anything is sent, so the audit trail cannot lag the wire.
     * Nothing is truncated here: the 1200-character body cap belongs to the
     * envelope, and silently cutting the human's text twice would hide which
     * cut did it.
     */
    say: async (args) => {
      const convo = requireString(args, "convo");
      const text = requireString(args, "text");
      if (storage.getConvo(convo) === null) throw new Error(`unknown conversation: ${convo}`);

      const at = new Date().toISOString();
      storage.appendLog(convo, "self", { t: "say", at, text });
      broadcast({ kind: "say", convo, text, at });
      await opts.onSay?.(convo, text);
      return { convo, at };
    },

    /**
     * Read a peer's tier, or lower it.
     *
     * Raising is refused on purpose. Spec §6 says the tier is changed only by a
     * human in their own terminal, and §5.1 says an asserted tier may only make
     * delivery more restrictive. The control socket is reachable by any
     * same-uid process that can read the token, so it gets the restrictive half
     * of that power and not the permissive half. Raising means editing
     * contact.json by hand, which is a thing only a person does.
     */
    tier: (args) => {
      const peer = requireString(args, "peer");
      const contact: Contact | null = storage.getContact(peer);
      if (contact === null) throw new Error(`unknown contact: ${peer}`);
      const requested = args["tier"];
      if (requested === undefined) return { peer, tier: contact.tier };
      if (!isTier(requested)) throw new Error("tier must be 1, 2 or 3");
      if (requested > contact.tier)
        throw new Error(
          `refusing to raise ${contact.name} from tier ${contact.tier} to ${requested} over the ` +
            `control socket; raise a tier by editing contacts/${peer}/contact.json yourself`,
        );
      storage.putContact({ ...contact, tier: requested });
      broadcast({ kind: "tier", peer, tier: requested });
      return { peer, tier: requested };
    },
  };

  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  let markStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });

  function stop(): Promise<void> {
    if (stopping !== null) return stopping;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    stopping = (control?.close() ?? Promise.resolve()).then(() => markStopped());
    return stopping;
  }

  /**
   * On-demand lifecycle: the timer is armed at boot as well as on the last
   * disconnect, so a daemon nobody ever connects to does not sit there forever.
   */
  function onClientCount(n: number): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (n > 0 || idleTimeoutMs <= 0 || stopping !== null) return;
    idleTimer = setTimeout(() => void stop(), idleTimeoutMs);
    idleTimer.unref();
  }

  control = await startControlServer({
    socketPath: storage.controlSocketPath(),
    token,
    verbs,
    onClientCount,
  });
  onClientCount(0);

  return {
    home: storage.home,
    socketPath: control.socketPath,
    token,
    storage,
    startedAt,
    stopped,
    stop,
    broadcast,
  };
}
