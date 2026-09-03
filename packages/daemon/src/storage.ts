/**
 * $SESHI_HOME on disk (spec §4.5).
 *
 *   $SESHI_HOME/                     0700
 *     identity.json                  0600  Ed25519 signing + X25519 sealing keys
 *     control.key                    0600  token that authenticates local control callers
 *     control.sock                   0600  the daemon's control socket
 *     contacts/<fingerprint>/
 *       contact.json                 0600  name, pubkeys, tier, verified-at
 *       memory/                            relationship memory (phase 4, directory only)
 *     convos/<convo-id>/
 *       convo.json                         mode, public brief, state, budget
 *       brief.private.json           0600  concession ladder, never transmitted
 *       log/<party>.jsonl                  append-only, hash-chained, per author
 *       LEDGER.json                        derived, authoritative on disk
 *       SCRATCHPAD.md                      derived, regenerated on append
 *       DECISION.md                        the artefact
 *       audit.jsonl                        every outbound frame, hashed
 *
 * Two rules this file exists to enforce.
 *
 * 1. Anything holding a secret is created 0600 and *verified* 0600 on read. A
 *    file created with a mode is still subject to umask, and a file that
 *    already exists keeps whatever mode it had, so mode is set explicitly after
 *    writing and checked again before the contents are trusted.
 * 2. Every path component that comes from outside this process is validated
 *    before it is joined. Convo ids and party names reach the daemon from the
 *    control socket and from the wire; `../../identity.json` is a plausible
 *    thing for either to contain.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../../core/src/identity.ts";
import { fingerprint, parseIdentity, serializeIdentity } from "../../core/src/identity.ts";
import type { Tier } from "./tiers.ts";

/** Longest socket path that binds on every platform seshi runs on, with room for the NUL. */
const SOCKET_PATH_MAX = 100;

/** Owner-only, for directories and for every file holding a secret. */
const DIR_MODE = 0o700;
const SECRET_MODE = 0o600;

const FINGERPRINT = /^[0-9a-f]{32}$/;
/** Convo ids are ULIDs in practice; this is the widest safe shape for a path component. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Contact = {
  fingerprint: string;
  name: string;
  /** hex, 32 bytes */
  signPub: string;
  /** hex, 32 bytes */
  sealPub: string;
  tier: Tier;
  verifiedAt: string | null;
};

export type PublicBrief = {
  objective: string;
  definitionOfDone: string[];
  nonNegotiables: Array<{ text: string; reason: string }>;
  facts: string[];
};

export type ConvoRecord = {
  id: string;
  /** the peer's fingerprint */
  peer: string;
  mode: string;
  state: string;
  createdAt: string;
  budget: { turns: number; warnAt: number; used: number };
  brief: PublicBrief;
};

export function defaultSeshiHome(): string {
  const fromEnv = process.env["SESHI_HOME"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(homedir(), ".seshi");
}

/**
 * Reject anything that is not a single, ordinary path component.
 *
 * The regex is an allow list on purpose. A deny list here would have to
 * anticipate `..`, `.`, `/`, `\`, NUL, and whatever the next filesystem thinks
 * is special.
 */
function checkIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value))
    throw new Error(`unsafe ${label} identifier: ${JSON.stringify(value)}`);
  return value;
}

function checkFingerprint(value: string): string {
  if (!FINGERPRINT.test(value))
    throw new Error(`unsafe contact identifier, expected 32 hex chars: ${JSON.stringify(value)}`);
  return value;
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is masked by umask, and an existing directory keeps its own.
  chmodSync(path, DIR_MODE);
  return path;
}

/**
 * Replace a file in one step, so a reader never sees a half-written record and
 * a crash never leaves a truncated one.
 *
 * The mode is set on the temp file before the rename, because rename preserves
 * the source's mode and there is otherwise a window where the real path exists
 * at the wrong permissions.
 */
function writeAtomic(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone; the original error is the one that matters.
    }
    throw err;
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Refuse to read a secret out of a file anyone else on the box can read. */
function requirePrivate(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== SECRET_MODE)
    throw new Error(
      `${path} must be mode 0600, found ${mode.toString(8).padStart(4, "0")}; ` +
        `refusing to use it until you fix the permissions`,
    );
}

/**
 * Append one JSON line.
 *
 * O_APPEND makes every write land at the true end of the file, so two writers
 * cannot overwrite each other's bytes even across processes. The single
 * `writeSync` is what keeps a line from being torn: Node's `appendFileSync`
 * loops on short writes, which is exactly how two lines interleave. A short
 * write on a regular file means the disk is full or the write was interrupted,
 * and there is nothing useful to do with a half-written line except say so.
 */
function appendLine(path: string, line: string): void {
  const buf = Buffer.from(line, "utf8");
  const fd = openSync(path, "a", SECRET_MODE);
  try {
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length)
      throw new Error(`short append to ${path}: wrote ${written} of ${buf.length} bytes`);
  } finally {
    closeSync(fd);
  }
}

function readJsonl(path: string): unknown[] {
  const raw = readIfExists(path);
  if (raw === null) return [];
  const out: unknown[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`corrupt record in ${path} at line ${i + 1}`);
    }
  }
  return out;
}

export class Storage {
  readonly home: string;

  private constructor(home: string) {
    this.home = home;
  }

  /** Open (creating if needed) a $SESHI_HOME. Defaults to `defaultSeshiHome()`. */
  static open(home: string = defaultSeshiHome()): Storage {
    ensureDir(home);
    ensureDir(join(home, "contacts"));
    ensureDir(join(home, "convos"));
    return new Storage(home);
  }

  // --- identity ---------------------------------------------------------

  identityPath(): string {
    return join(this.home, "identity.json");
  }

  readIdentity(): Identity | null {
    const path = this.identityPath();
    if (!existsSync(path)) return null;
    requirePrivate(path);
    return parseIdentity(readFileSync(path, "utf8"));
  }

  writeIdentity(id: Identity): void {
    writeAtomic(this.identityPath(), serializeIdentity(id), SECRET_MODE);
  }

  /** This machine's own fingerprint. Throws if there is no identity yet. */
  fingerprint(): string {
    const id = this.readIdentity();
    if (id === null) throw new Error(`no identity in ${this.home}; run \`seshi init\` first`);
    return fingerprint(id.sign.pub, id.seal.pub);
  }

  // --- control socket ---------------------------------------------------

  /**
   * Where the control socket lives.
   *
   * A Unix socket path is capped at 104 bytes on macOS and 108 on Linux, and
   * `listen` fails with EINVAL past that. A home under a deep directory (a
   * scratch path, a long username, SESHI_HOME inside a project) hit it in the
   * first live run and killed the joining side right after pairing. So a home
   * whose socket path would not fit gets a short one in the temp directory,
   * derived from the home so every process computes the same path. The
   * token in control.key is still the credential; the path was never one.
   */
  controlSocketPath(): string {
    const inHome = join(this.home, "control.sock");
    if (Buffer.byteLength(inHome, "utf8") <= SOCKET_PATH_MAX) return inHome;
    const tag = createHash("sha256").update(this.home, "utf8").digest("hex").slice(0, 16);
    return join(tmpdir(), `seshi-${tag}.sock`);
  }

  /**
   * The token every local control caller must present, created on first use.
   *
   * This is the whole of the mitigation in spec §11.6: the daemon's socket is
   * an outbound network leg for every same-uid process on the machine, and a
   * prompt-injected session sitting on a client repo is same-uid. Being unable
   * to read this file is what stops it.
   */
  controlKey(): string {
    const path = join(this.home, "control.key");
    const existing = readIfExists(path);
    if (existing !== null) {
      requirePrivate(path);
      const token = existing.trim();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`malformed control key in ${path}`);
      return token;
    }
    const token = randomBytes(32).toString("hex");
    writeAtomic(path, `${token}\n`, SECRET_MODE);
    return token;
  }

  // --- contacts ---------------------------------------------------------

  contactDir(fp: string): string {
    return join(this.home, "contacts", checkFingerprint(fp));
  }

  putContact(c: Contact): void {
    const dir = this.contactDir(c.fingerprint);
    ensureDir(dir);
    // Relationship memory is phase 4; the directory is part of the layout now
    // so nothing has to guess where it goes later.
    ensureDir(join(dir, "memory"));
    writeAtomic(join(dir, "contact.json"), `${JSON.stringify(c, null, 2)}\n`, SECRET_MODE);
  }

  /**
   * Always a fresh read. Spec §6: the tier is re-read from disk per inbound
   * message, so that a human lowering a tier in their terminal takes effect on
   * the next message rather than on the next daemon restart.
   */
  getContact(fp: string): Contact | null {
    const raw = readIfExists(join(this.contactDir(fp), "contact.json"));
    if (raw === null) return null;
    return JSON.parse(raw) as Contact;
  }

  listContacts(): Contact[] {
    const dir = join(this.home, "contacts");
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && FINGERPRINT.test(e.name))
      .map((e) => this.getContact(e.name))
      .filter((c): c is Contact => c !== null);
  }

  // --- conversations ----------------------------------------------------

  convoDir(id: string): string {
    return join(this.home, "convos", checkIdentifier(id, "convo"));
  }

  putConvo(c: ConvoRecord): void {
    ensureDir(this.convoDir(c.id));
    writeAtomic(join(this.convoDir(c.id), "convo.json"), `${JSON.stringify(c, null, 2)}\n`, 0o644);
  }

  getConvo(id: string): ConvoRecord | null {
    const raw = readIfExists(join(this.convoDir(id), "convo.json"));
    return raw === null ? null : (JSON.parse(raw) as ConvoRecord);
  }

  listConvos(): ConvoRecord[] {
    const dir = join(this.home, "convos");
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && IDENTIFIER.test(e.name))
      .map((e) => this.getConvo(e.name))
      .filter((c): c is ConvoRecord => c !== null);
  }

  /** The half of the brief that is never transmitted (spec §7.2). */
  writePrivateBrief(convoId: string, brief: unknown): void {
    ensureDir(this.convoDir(convoId));
    writeAtomic(
      join(this.convoDir(convoId), "brief.private.json"),
      `${JSON.stringify(brief, null, 2)}\n`,
      SECRET_MODE,
    );
  }

  readPrivateBrief(convoId: string): unknown | null {
    const path = join(this.convoDir(convoId), "brief.private.json");
    if (!existsSync(path)) return null;
    requirePrivate(path);
    return JSON.parse(readFileSync(path, "utf8"));
  }

  // --- append-only records ---------------------------------------------

  logPath(convoId: string, party: string): string {
    return join(this.convoDir(convoId), "log", `${checkIdentifier(party, "party")}.jsonl`);
  }

  appendLog(convoId: string, party: string, entry: unknown): void {
    const path = this.logPath(convoId, party);
    ensureDir(join(this.convoDir(convoId), "log"));
    appendLine(path, `${JSON.stringify(entry)}\n`);
  }

  readLog(convoId: string, party: string): unknown[] {
    return readJsonl(this.logPath(convoId, party));
  }

  /** Every party that has written a log line in this conversation. */
  logParties(convoId: string): string[] {
    const dir = join(this.convoDir(convoId), "log");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  appendAudit(convoId: string, entry: unknown): void {
    ensureDir(this.convoDir(convoId));
    appendLine(join(this.convoDir(convoId), "audit.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  readAudit(convoId: string): unknown[] {
    return readJsonl(join(this.convoDir(convoId), "audit.jsonl"));
  }

  // --- derived files ----------------------------------------------------

  writeLedger(convoId: string, ledger: unknown): void {
    ensureDir(this.convoDir(convoId));
    writeAtomic(join(this.convoDir(convoId), "LEDGER.json"), `${JSON.stringify(ledger, null, 2)}\n`, 0o644);
  }

  readLedger(convoId: string): unknown | null {
    const raw = readIfExists(join(this.convoDir(convoId), "LEDGER.json"));
    return raw === null ? null : JSON.parse(raw);
  }

  writeScratchpad(convoId: string, markdown: string): void {
    ensureDir(this.convoDir(convoId));
    writeAtomic(join(this.convoDir(convoId), "SCRATCHPAD.md"), markdown, 0o644);
  }

  writeDecision(convoId: string, markdown: string): void {
    ensureDir(this.convoDir(convoId));
    writeAtomic(join(this.convoDir(convoId), "DECISION.md"), markdown, 0o644);
  }

  readDecision(convoId: string): string | null {
    return readIfExists(join(this.convoDir(convoId), "DECISION.md"));
  }
}
