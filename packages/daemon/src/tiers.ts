/**
 * Per-peer trust tiers, expressed as Claude Code settings.
 *
 * This file is the security boundary of seshi. A peer agent is a `claude -p`
 * process on your machine, driven by text a remote person's agent wrote. The
 * only thing standing between that text and your filesystem, your credentials
 * and your other Claude sessions is the deny list generated here plus the
 * process boundary (spec §4.3, §6).
 *
 * Three rules govern everything below.
 *
 *  1. Deny lists, never allow lists. Rules are evaluated deny, then ask, then
 *     allow, and the first match wins regardless of specificity, so a deny rule
 *     cannot carry allowlist exceptions and an allow rule cannot loosen a deny.
 *     An allow list would also be widened by the user's own settings, which
 *     `--setting-sources user` loads into the same process.
 *  2. A bare tool name in `deny` removes the tool from the model's context
 *     entirely. A scoped rule such as a `Read` path pattern leaves the tool
 *     present and blocks matching calls.
 *  3. A rule with a typo is a rule that does not exist. Claude Code warns at
 *     startup about a deny rule naming an unknown tool, but names containing
 *     `_` or `*` are exempt from that check, and a path pattern that matches
 *     nothing is never warned about at all. Hence the syntax tests.
 *
 * Syntax verified against https://code.claude.com/docs/en/permissions and
 * https://code.claude.com/docs/en/tools-reference, read 2026-08-23, and against
 * a live `claude --debug` run on CLI 2.1.240 (see the task report).
 *
 * Honest limits, carried deliberately:
 *  - Read and Edit deny rules bind Claude Code's own file tools and the file
 *    commands it recognises inside Bash. They do not bind arbitrary
 *    subprocesses. That is why tiers 2 and 3 deny every shell outright rather
 *    than trying to filter one.
 *  - This is an enumeration, so a tool introduced by a future Claude Code
 *    version is not denied until this list is updated. Pin a minimum CLI
 *    version and re-audit on upgrade (spec §11.5).
 *  - Confining tier 3 writes *to* the worktree is not expressible as a deny
 *    list. That bound comes from `--add-dir` and the PreToolUse hook (spec §6).
 *  - Home-anchored rules trust `~` not to be a symlink. Absolute rules do not:
 *    see resolvedPaths below.
 */

import { realpathSync } from "node:fs";

export type Tier = 1 | 2 | 3;

export type TierOptions = {
  /** Absolute path to $SESHI_HOME. Holds the private keys, so it is denied outright. */
  seshiHome: string;
  /** Absolute path to the throwaway git worktree. Required at tier 3, unused otherwise. */
  worktree?: string;
};

export type TierSettings = {
  permissions: {
    deny: string[];
    disableBypassPermissionsMode: "disable";
    disableAutoMode: "disable";
  };
};

/**
 * Tools denied at every tier that runs a process.
 *
 * `Task` is the pre-2.1 name for `Agent` and `KillShell`-era names are gone;
 * both spellings of the subagent tool are listed because the cost of a stale
 * name is one startup warning and the cost of a missing one is a subagent.
 */
const DENIED_TOOLS: readonly string[] = [
  // Shells. Bash and PowerShell are the same hole on different platforms, and
  // a shell walks straight past every Read and Edit rule below.
  "Bash",
  "PowerShell",

  // Anything that runs code or spawns another agent.
  "Agent",        // subagents
  "Task",         // legacy name for Agent
  "Workflow",     // orchestrates subagents in the background
  "Monitor",      // "runs a command in the background" — a shell by another name
  "LSP",          // starts language server binaries supplied by the project

  // File writes. NotebookEdit is listed separately at every tier because a
  // `Read` deny rule blocks Edit and Write on the same path but not NotebookEdit.
  "NotebookEdit",

  // Egress. Every one of these is a way for peer-supplied text to get something
  // off this machine without going through the daemon's outbound scanner.
  "WebFetch",
  "WebSearch",
  "Artifact",              // publishes a page to claude.ai
  "DesignSync",            // publishes a design canvas
  "SendUserFile",          // pushes a file to the human's device
  "ShareOnboardingGuide",  // uploads a file and returns a share link
  "PushNotification",      // speaks to the human as if it were their own session

  // Escape into the human's own sessions, or onto their other machines.
  // Non-negotiable: without these two a peer process hops out of its box into
  // live sessions on this machine with no further permission (spec §6).
  "SendMessage",
  "ListAgents",
  "RemoteTrigger",

  // Persistence. A conversation must not leave anything scheduled behind it.
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  "TaskGet",
  "TaskList",
  "TaskOutput",

  // Moving the session out of the directory it was scoped to with --add-dir.
  "EnterWorktree",
  "ExitWorktree",

  // MCP. The tool-name glob covers every server's tools; the three resource
  // readers and the deferred-tool loader are built-ins, so `mcp__*` never
  // matches them and they would otherwise reach MCP data anyway.
  "mcp__*",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  "ToolSearch",
];

/** Denied at tier 2 only; tier 3 exists to produce a patch, so it keeps these. */
const WRITE_TOOLS: readonly string[] = ["Write", "Edit"];

/**
 * Paths no peer agent may read, at any tier.
 *
 * Anchors matter more than the names. A single leading `/` anchors at the
 * directory of the settings file that defines the rule, which for us is inside
 * $SESHI_HOME, so `/…` rules would match nothing. `//` is the filesystem root
 * and `~/` is the home directory; those are the only two anchors used here.
 *
 * Bare filename patterns are rooted at `//` and prefixed with a cross-directory
 * wildcard so they hold anywhere on the disk, not only under the working directory.
 */
const SECRET_PATHS: readonly string[] = [
  // Secrets that live next to code.
  "//**/.env*",            // .env, .env.local, .envrc
  "//**/*.pem",
  "//**/*.key",
  "//**/*.p12",
  "//**/*.pfx",
  "//**/id_*",             // id_rsa, id_ed25519, and their .pub siblings
  "//**/.git-credentials",
  "//**/.npmrc",
  "//**/.netrc",
  "//**/.pypirc",

  // Credential stores in the home directory.
  "~/.ssh/**",
  "~/.aws/**",
  "~/.gnupg/**",
  "~/.kube/**",
  "~/.docker/**",
  "~/.azure/**",
  "~/.config/gcloud/**",
  "~/Library/Keychains/**",

  // Claude Code's own state. This is the biggest single prize on the machine:
  // OAuth credentials on Linux and Windows, every prompt the human has ever
  // typed in history.jsonl, and full transcripts of every other project under
  // projects/. Denying the whole tree also blocks a skill from reading its own
  // bundled reference files, which is a real cost, accepted knowingly.
  "~/.claude/**",
  "~/.claude.json*",

  // Shell state. Exported tokens live in rc files, and history files hold
  // whatever was typed next to them.
  "~/.zshrc",
  "~/.zshenv",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.profile",
  "~/.zsh_history",
  "~/.bash_history",
];

/**
 * Paths a tier 3 agent may not write, on top of every secret path above.
 *
 * Each of these runs, or reconfigures the agent, without anyone deciding to run
 * it: git hooks, editor and CI config, package lifecycle scripts, and the files
 * Claude Code reads as instructions. A write here converts "propose a patch"
 * into "run something on Jake's machine later". A Makefile is deliberately not
 * on the list, because `make` is a decision someone makes.
 */
const NO_WRITE_PATHS: readonly string[] = [
  "//**/.git/**",                 // hooks run on the next commit, checkout or push
  "//**/.claude/**",              // settings.json, hooks, agents, commands
  "//**/.claude-plugin/**",
  "//**/CLAUDE.md",               // instructions injected into the human's own session
  "//**/AGENTS.md",
  "//**/.mcp.json",               // MCP servers are commands with arguments
  "//**/.vscode/**",              // tasks.json can run on folder open
  "//**/.idea/**",
  "//**/.github/workflows/**",    // CI runs it on push
  "//**/package.json",            // lifecycle scripts run on the next install
];

/**
 * Escape the gitignore metacharacters. Rules Claude Code writes for itself are
 * escaped; rules we write are not escaped for us.
 *
 * Backslash escaping is the form the matcher honours. Verified on CLI 2.1.240:
 * against a directory literally named `a[i]rd*x`, a backslash-escaped rule
 * blocked the read and a POSIX character-class rule (`a[[]i[]]rd[*]x`) did not.
 */
function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/**
 * The path as given, plus the path it resolves to, when they differ.
 *
 * A `//` rule is matched against the path the file tools resolve to. Naming
 * only a symlink therefore produces a rule that matches nothing, and nothing
 * warns about it. This is not an edge case on macOS: `/tmp` and `os.tmpdir()`
 * both sit behind symlinks, so a $SESHI_HOME under either would be readable.
 * Verified on CLI 2.1.240: a deny rule on `//tmp/<dir>/**` did not block a read
 * that the same rule written as `//private/tmp/<dir>/**` did block.
 *
 * If the path does not exist yet there is nothing to resolve, and the literal
 * path is the best available answer.
 */
function resolvedPaths(path: string): string[] {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return [path];
  }
  return real === path ? [path] : [path, real];
}

/** Turn an absolute filesystem path into a `//`-anchored, escaped rule prefix. */
function absolutePattern(path: string, label: string): string {
  if (!path.startsWith("/"))
    throw new Error(`${label} must be an absolute path, got ${JSON.stringify(path)}`);
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "")
    throw new Error(`${label} must be an absolute path, got ${JSON.stringify(path)}`);
  return `//${escapeGlob(trimmed.slice(1))}`;
}

export function tierSettings(tier: Tier, opts: TierOptions): TierSettings {
  if (tier === 1)
    throw new Error(
      "tier 1 spawns no process, so there are no settings to generate; " +
        "seshid renders the peer's words in its own pane instead",
    );
  if (tier !== 2 && tier !== 3) throw new Error(`unknown tier: ${String(tier)}`);
  if (tier === 3 && opts.worktree === undefined)
    throw new Error("tier 3 requires a worktree to write into");

  const homes = resolvedPaths(opts.seshiHome).map((p) => absolutePattern(p, "seshiHome"));
  // The worktree bound itself comes from --add-dir and the PreToolUse hook; all
  // this file can do is refuse to generate settings for a nonsensical one.
  if (opts.worktree !== undefined) absolutePattern(opts.worktree, "worktree");

  const secretPaths = [...SECRET_PATHS, ...homes.flatMap((h) => [h, `${h}/**`])];

  const deny = [
    ...DENIED_TOOLS,
    ...(tier === 2 ? WRITE_TOOLS : []),
    ...secretPaths.map((p) => `Read(${p})`),
    // Tier 2 already denies Edit and Write by name. Tier 3 keeps them, so every
    // read deny needs its write twin, plus the paths that become code later.
    ...(tier === 3
      ? [...secretPaths, ...NO_WRITE_PATHS].map((p) => `Edit(${p})`)
      : []),
  ];

  return {
    permissions: {
      // Deduplicated: resolving $SESHI_HOME can restate a path already listed.
      deny: [...new Set(deny)],
      // Neither mode can override a deny rule, but both would let this process
      // act without the human who is meant to be watching it.
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
    },
  };
}
