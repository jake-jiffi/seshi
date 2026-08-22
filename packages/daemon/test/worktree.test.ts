import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, branchNameFor } from "../src/worktree.ts";

const dirs: string[] = [];
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "seshi-wt-repo-"));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "original\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a branch name is derived, scoped to the peer and conversation, and path-safe", () => {
  const b = branchNameFor("dave", "01JZABCDEF0123456789");
  assert.match(b, /^seshi\/dave\//);
  assert.doesNotMatch(b, /[^a-zA-Z0-9/_-]/, "a branch name must never carry a path escape");
  // A hostile contact name cannot walk out of the namespace.
  const hostile = branchNameFor("../../etc/passwd", "abc");
  assert.match(hostile, /^seshi\//);
  assert.doesNotMatch(hostile, /\.\./);
});

test("a worktree is created on its own branch, leaving the checkout untouched", () => {
  const r = repo();
  const wt = createWorktree({ repo: r, branch: branchNameFor("dave", "c1"), path: join(r, ".seshi-wt") });
  assert.ok(existsSync(join(wt.path, "README.md")), "the worktree has the repo contents");

  const branchHere = execFileSync("git", ["branch", "--show-current"], { cwd: r, encoding: "utf8" }).trim();
  assert.equal(branchHere, "main", "the human's own checkout must stay on its branch");

  wt.remove();
  assert.equal(existsSync(wt.path), false);
});

test("edits inside the worktree do not touch the human's checkout", () => {
  const r = repo();
  const wt = createWorktree({ repo: r, branch: branchNameFor("dave", "c2"), path: join(r, ".seshi-wt2") });

  writeFileSync(join(wt.path, "README.md"), "the peer agent changed this\n");
  writeFileSync(join(wt.path, "new-file.txt"), "and added this\n");

  assert.equal(
    execFileSync("cat", [join(r, "README.md")], { encoding: "utf8" }),
    "original\n",
    "the human's working copy must be untouched",
  );

  const diff = wt.diff();
  assert.match(diff, /the peer agent changed this/);
  assert.match(diff, /new-file\.txt/, "an untracked new file must appear in the patch");
  wt.remove();
});

test("the diff is a patch a human can apply, and applies cleanly", () => {
  const r = repo();
  const wt = createWorktree({ repo: r, branch: branchNameFor("dave", "c3"), path: join(r, ".seshi-wt3") });
  writeFileSync(join(wt.path, "README.md"), "proposed change\n");
  const patch = wt.diff();
  wt.remove();

  // A human applies it in their own checkout, which is the whole tier 3 flow.
  const patchFile = join(r, "peer.patch");
  writeFileSync(patchFile, patch);
  execFileSync("git", ["apply", patchFile], { cwd: r, stdio: "pipe" });
  assert.equal(execFileSync("cat", [join(r, "README.md")], { encoding: "utf8" }), "proposed change\n");
});

test("removing a worktree twice is safe, and removal survives a dirty tree", () => {
  const r = repo();
  const wt = createWorktree({ repo: r, branch: branchNameFor("dave", "c4"), path: join(r, ".seshi-wt4") });
  writeFileSync(join(wt.path, "junk.txt"), "uncommitted\n");
  mkdirSync(join(wt.path, "subdir"), { recursive: true });
  writeFileSync(join(wt.path, "subdir", "more.txt"), "also uncommitted\n");
  wt.remove();
  assert.equal(existsSync(wt.path), false, "a dirty worktree must still be removable");
  wt.remove(); // must not throw
});

test("createWorktree refuses a directory that is not a git repository", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "seshi-notrepo-"));
  dirs.push(notRepo);
  assert.throws(
    () => createWorktree({ repo: notRepo, branch: "seshi/x/y", path: join(notRepo, "wt") }),
    /not a git repository/i,
  );
});
