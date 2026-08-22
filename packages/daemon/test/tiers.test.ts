import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierSettings } from "../src/tiers.ts";

/**
 * Canonical built-in tool names, transcribed by hand from the Claude Code tools
 * reference (https://code.claude.com/docs/en/tools-reference, read 2026-08-23,
 * CLI 2.1.240) plus the three tools this build ships that the public reference
 * has not caught up with yet: DesignSync, ReadMcpResourceDirTool, StructuredOutput.
 *
 * Deliberately restated here rather than imported from src/. A deny rule whose
 * tool name matches no known tool is silently inert apart from a startup warning,
 * so the test has to hold an independent copy of the truth.
 */
const KNOWN_TOOLS = new Set([
  "Agent", "Artifact", "AskUserQuestion", "Bash", "CronCreate", "CronDelete",
  "CronList", "DesignSync", "Edit", "EndConversation", "EnterPlanMode",
  "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "LSP",
  "ListAgents", "ListMcpResourcesTool", "Monitor", "NotebookEdit", "PowerShell",
  "PushNotification", "Read", "ReadMcpResourceDirTool", "ReadMcpResourceTool",
  "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendMessage",
  "SendUserFile", "ShareOnboardingGuide", "Skill", "StructuredOutput",
  "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
  "Task", "TodoWrite", "ToolSearch", "WaitForMcpServers", "WebFetch",
  "WebSearch", "Workflow", "Write",
]);

// ---------------------------------------------------------------- plan tests

test("tier 1 produces no settings because no process is spawned", () => {
  assert.throws(() => tierSettings(1, { seshiHome: "/x" }), /no process/i);
});

test("tier 2 denies every write and escape tool", () => {
  const s = tierSettings(2, { seshiHome: "/x" });
  for (const t of ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch",
                   "Task", "SendMessage", "ListAgents"])
    assert.ok(s.permissions.deny.includes(t), `${t} must be denied`);
  assert.ok(s.permissions.deny.some((d) => d.includes("mcp__")));
});

test("tier 2 denies the secret paths", () => {
  const s = tierSettings(2, { seshiHome: "/x" });
  const joined = s.permissions.deny.join(" ");
  for (const p of [".env", ".ssh", ".aws", ".claude", "/x", ".pem", "id_"])
    assert.ok(joined.includes(p), `${p} must be denied`);
});

test("tier 3 allows Edit and Write but still denies Bash", () => {
  const s = tierSettings(3, { seshiHome: "/x", worktree: "/tmp/wt" });
  assert.ok(!s.permissions.deny.includes("Edit"));
  assert.ok(!s.permissions.deny.includes("Write"));
  assert.ok(s.permissions.deny.includes("Bash"));
});

test("no tier ever uses an allow list for tools", () => {
  for (const t of [2, 3] as const)
    assert.equal(
      (tierSettings(t, { seshiHome: "/x", worktree: "/tmp/wt" }) as Record<string, unknown> &
        { permissions: { allow?: unknown } }).permissions.allow ?? undefined,
      undefined,
    );
});

// ------------------------------------------------- syntax validity of rules

/**
 * Every emitted entry must be one of the three forms the permission parser
 * actually understands, per https://code.claude.com/docs/en/permissions:
 *   - a bare canonical tool name                     -> removes the tool from context
 *   - a tool-name glob (deny/ask only), e.g. mcp__*  -> removes every matching tool
 *   - Tool(specifier)                                -> scoped rule
 * Anything else is a rule that silently does not exist.
 */
test("every deny entry is a syntactically valid permission rule", () => {
  for (const tier of [2, 3] as const) {
    for (const rule of tierSettings(tier, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions.deny) {
      assert.equal(rule, rule.trim(), `rule has stray whitespace: ${JSON.stringify(rule)}`);
      if (rule === "mcp__*") continue;
      const scoped = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
      if (scoped === null) {
        assert.ok(KNOWN_TOOLS.has(rule), `bare deny names an unknown tool: ${rule}`);
        continue;
      }
      const tool = scoped[1] as string;
      const spec = scoped[2] as string;
      assert.ok(KNOWN_TOOLS.has(tool), `scoped deny names an unknown tool: ${rule}`);
      // Claude Code consults path rules for Read and Edit only; a Write(...) or
      // Glob(...) path rule is accepted, never consulted, and warned about.
      assert.ok(tool === "Read" || tool === "Edit", `path rules must use Read/Edit: ${rule}`);
      assert.ok(!spec.includes(")"), `unbalanced parenthesis in ${rule}`);
      assert.ok(!/\s/.test(spec), `path rule contains whitespace: ${rule}`);
    }
  }
});

test("path rules anchor absolutely, never with a bare leading slash", () => {
  // A single leading "/" anchors at the directory of the --settings file, which
  // is $SESHI_HOME/tiers, so "/…" rules would silently match nothing real.
  for (const tier of [2, 3] as const) {
    for (const rule of tierSettings(tier, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions.deny) {
      const scoped = /^(?:Read|Edit)\((.+)\)$/.exec(rule);
      if (scoped === null) continue;
      const spec = scoped[1] as string;
      assert.ok(
        spec.startsWith("//") || spec.startsWith("~/"),
        `path rule must anchor at // or ~/ : ${rule}`,
      );
    }
  }
});

// ----------------------------------------------------- the actual boundary

test("tier 2 denies every shell, every subagent and every background runner", () => {
  const deny = tierSettings(2, { seshiHome: "/x" }).permissions.deny;
  for (const t of [
    "Bash", "PowerShell",          // PowerShell is the shell on Windows
    "Agent", "Task", "Workflow",   // subagents, current and legacy names
    "Monitor",                     // "runs a command in the background"
    "LSP",                         // starts project-supplied language server binaries
    "EnterWorktree", "ExitWorktree", // move the session out of its scoped directory
  ])
    assert.ok(deny.includes(t), `${t} must be denied`);
});

test("tier 2 denies every outbound channel, not just WebFetch", () => {
  const deny = tierSettings(2, { seshiHome: "/x" }).permissions.deny;
  for (const t of [
    "WebFetch", "WebSearch",
    "Artifact", "DesignSync",       // publish a page to claude.ai
    "SendUserFile", "ShareOnboardingGuide", "PushNotification",
    "SendMessage", "ListAgents",    // hop into the human's own live sessions
    "RemoteTrigger",                // reach this account's other machines
  ])
    assert.ok(deny.includes(t), `${t} must be denied`);
});

test("tier 2 denies everything that outlives the conversation", () => {
  const deny = tierSettings(2, { seshiHome: "/x" }).permissions.deny;
  for (const t of ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
                   "TaskCreate", "TaskUpdate", "TaskStop", "TaskGet", "TaskList", "TaskOutput"])
    assert.ok(deny.includes(t), `${t} must be denied`);
});

test("tier 2 closes the MCP resource readers, which mcp__* does not cover", () => {
  const deny = tierSettings(2, { seshiHome: "/x" }).permissions.deny;
  // These are built-in tools, so the mcp__* tool-name glob never matches them.
  for (const t of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "ToolSearch"])
    assert.ok(deny.includes(t), `${t} must be denied`);
  assert.ok(deny.includes("mcp__*"));
});

test("SendMessage, ListAgents and mcp__* are denied at every tier", () => {
  for (const tier of [2, 3] as const) {
    const deny = tierSettings(tier, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions.deny;
    for (const t of ["SendMessage", "ListAgents", "mcp__*"])
      assert.ok(deny.includes(t), `tier ${tier} must deny ${t}`);
  }
});

test("bypass and auto permission modes are disabled", () => {
  for (const tier of [2, 3] as const) {
    const p = tierSettings(tier, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions;
    assert.equal(p.disableBypassPermissionsMode, "disable");
    assert.equal(p.disableAutoMode, "disable");
  }
});

// ------------------------------------------------------------ secret paths

test("secret reads are denied filesystem-wide, not only under the cwd", () => {
  const deny = tierSettings(2, { seshiHome: "/x" }).permissions.deny;
  for (const rule of [
    "Read(//**/.env*)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.claude/**)",
    "Read(//**/*.pem)",
    "Read(//**/id_*)",
    "Read(//**/.git-credentials)",
    "Read(//**/.netrc)",
  ])
    assert.ok(deny.includes(rule), `${rule} must be denied`);
});

test("$SESHI_HOME, which holds the private keys, is denied as a path and as a tree", () => {
  const deny = tierSettings(2, { seshiHome: "/Users/jake/.seshi" }).permissions.deny;
  assert.ok(deny.includes("Read(//Users/jake/.seshi)"));
  assert.ok(deny.includes("Read(//Users/jake/.seshi/**)"));
});

test("a seshiHome containing glob metacharacters is escaped, not silently un-denied", () => {
  const deny = tierSettings(2, { seshiHome: "/Users/jake/we[i]rd*home/" }).permissions.deny;
  assert.ok(deny.includes("Read(//Users/jake/we\\[i\\]rd\\*home/**)"),
            `got: ${deny.filter((d) => d.includes("we")).join(", ")}`);
});

test("a symlinked seshiHome is denied by its resolved path, not only as written", () => {
  // Verified against CLI 2.1.240: a "//" rule is matched against the path the
  // file tools resolve to, so a rule naming the symlink alone matches nothing.
  // On macOS this is not exotic: /tmp and os.tmpdir() both sit behind symlinks.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "seshi-tiers-")));
  try {
    const target = join(root, "real-home");
    const link = join(root, "linked-home");
    mkdirSync(target);
    symlinkSync(target, link);
    const deny = tierSettings(2, { seshiHome: link }).permissions.deny;
    assert.ok(deny.includes(`Read(/${link}/**)`), `missing rule for the symlink path`);
    assert.ok(deny.includes(`Read(/${target}/**)`), `missing rule for the resolved path`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relative seshiHome is refused rather than turned into a rule that matches nothing", () => {
  assert.throws(() => tierSettings(2, { seshiHome: "relative/path" }), /absolute/i);
});

// ------------------------------------------------------------------ tier 3

test("tier 3 without a worktree is refused", () => {
  assert.throws(() => tierSettings(3, { seshiHome: "/x" }), /worktree/i);
  assert.throws(() => tierSettings(3, { seshiHome: "/x", worktree: "wt" }), /absolute/i);
});

test("tier 3 still denies NotebookEdit, which Read deny rules do not cover", () => {
  const deny = tierSettings(3, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions.deny;
  assert.ok(deny.includes("NotebookEdit"));
});

test("tier 3 denies edits to every path that becomes code later", () => {
  const deny = tierSettings(3, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions.deny;
  for (const rule of [
    "Edit(//**/.git/**)",          // git hooks run on the human's next commit
    "Edit(//**/.claude/**)",       // settings.json, hooks, agents
    "Edit(//**/.claude-plugin/**)",
    "Edit(//**/CLAUDE.md)",        // instructions injected into the human's session
    "Edit(//**/AGENTS.md)",
    "Edit(//**/.mcp.json)",        // MCP servers are commands
    "Edit(//**/.vscode/**)",       // tasks.json runs on folder open
    "Edit(//**/.github/workflows/**)",
    "Edit(//**/package.json)",     // postinstall runs on the next npm install
    "Edit(~/.claude/**)",
    "Edit(//**/.env*)",
  ])
    assert.ok(deny.includes(rule), `${rule} must be denied at tier 3`);
});

test("tier 3 mirrors every tier 2 secret read deny as an edit deny", () => {
  const t3 = tierSettings(3, { seshiHome: "/x", worktree: "/tmp/wt" }).permissions.deny;
  const t2Reads = tierSettings(2, { seshiHome: "/x" }).permissions.deny
    .filter((d) => d.startsWith("Read("));
  assert.ok(t2Reads.length > 0);
  for (const readRule of t2Reads) {
    assert.ok(t3.includes(readRule), `tier 3 dropped ${readRule}`);
    const editRule = `Edit(${readRule.slice("Read(".length, -1)})`;
    assert.ok(t3.includes(editRule), `tier 3 must also deny ${editRule}`);
  }
});

// ------------------------------------------------------------------ hygiene

test("the deny list has no duplicates and the output is deterministic", () => {
  for (const tier of [2, 3] as const) {
    const a = tierSettings(tier, { seshiHome: "/x", worktree: "/tmp/wt" });
    const b = tierSettings(tier, { seshiHome: "/x", worktree: "/tmp/wt" });
    assert.deepEqual(a, b);
    const deny = a.permissions.deny;
    assert.equal(new Set(deny).size, deny.length,
                 `duplicates: ${deny.filter((d, i) => deny.indexOf(d) !== i).join(", ")}`);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  }
});

test("an unknown tier is refused", () => {
  assert.throws(() => tierSettings(4 as unknown as 1 | 2 | 3, { seshiHome: "/x" }), /tier/i);
});
