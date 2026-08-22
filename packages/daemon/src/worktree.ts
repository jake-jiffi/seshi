/**
 * Tier 3's blast radius.
 *
 * At tier 3 a peer's agent may write, and this is the box it writes into: a
 * throwaway git worktree on its own branch. The human's checkout never moves,
 * never changes branch, and never gains a file. What comes out is a patch the
 * human reads and applies in their own time, which is the whole point — the
 * output of a whole conversation is a diff, never a commit.
 *
 * Bash stays denied at tier 3, which is what makes this boundary hold. A
 * worktree is a filesystem convention, not a sandbox: a shell inside one can
 * `cd` straight out. It bounds an agent restricted to Edit and Write, and it
 * bounds nothing else. Do not reach for it as a substitute for the deny list.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type Worktree = {
  path: string;
  branch: string;
  /** A unified patch of everything the agent changed, including new files. */
  diff(): string;
  /** Idempotent. Survives a dirty tree, because the agent will leave one. */
  remove(): void;
};

/** Anything that is not plainly safe in a git ref or a path becomes a dash. */
function slug(s: string): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return cleaned === "" ? "peer" : cleaned;
}

/**
 * `seshi/<peer>/<convo>`. Both segments are slugged, so a contact who names
 * themselves `../../etc/passwd` lands inside the namespace like everyone else.
 */
export function branchNameFor(peerName: string, convoId: string): string {
  return `seshi/${slug(peerName)}/${slug(convoId).slice(0, 12)}`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function createWorktree(opts: { repo: string; branch: string; path: string }): Worktree {
  try {
    git(opts.repo, "rev-parse", "--git-dir");
  } catch {
    throw new Error(`not a git repository: ${opts.repo}`);
  }

  if (existsSync(opts.path)) {
    throw new Error(`worktree path already exists: ${opts.path}`);
  }
  if (!existsSync(dirname(opts.path))) {
    throw new Error(`worktree parent does not exist: ${dirname(opts.path)}`);
  }

  // -B so a re-run of the same conversation reuses its branch rather than
  // failing. The branch is ours; nothing else is expected to be on it.
  git(opts.repo, "worktree", "add", "-q", "-B", opts.branch, opts.path);

  const worktree: Worktree = {
    path: opts.path,
    branch: opts.branch,

    diff(): string {
      // Stage everything first, including untracked files, so a NEW file the
      // agent created appears in the patch. `git diff` alone would silently
      // omit it, and a patch missing the agent's new files is worse than none.
      //
      // `-f` because `add -A` honours .gitignore, so an agent writing
      // `secret.txt` or `dist/bundle.js` into a repo that ignores them would
      // vanish from the patch entirely and the human would review an
      // incomplete change believing it whole. Safe here: the worktree starts
      // from HEAD, so the only ignored files present are ones the agent just
      // created, and the human seeing them is exactly the point.
      git(opts.path, "add", "-A", "-f");
      return git(opts.path, "diff", "--cached", "--binary");
    },

    remove(): void {
      if (!existsSync(opts.path)) return;
      try {
        git(opts.repo, "worktree", "remove", "--force", opts.path);
      } catch {
        // A worktree git has lost track of, or one whose metadata is gone.
        // The directory is ours and disposable either way.
        rmSync(opts.path, { recursive: true, force: true });
        try {
          git(opts.repo, "worktree", "prune");
        } catch {
          // Nothing to prune, or no repo any more. Neither matters here.
        }
      }
    },
  };

  return worktree;
}
