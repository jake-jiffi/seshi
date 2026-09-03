/**
 * The skill and the slash commands are instructions to a model, so nothing
 * fails loudly when they drift from the CLI. They drifted once: the skill told
 * a session to run `invite`, `talk` and `join-convo`, none of which have ever
 * existed, and the result was a person on the other end of a real conversation
 * watching a terminal do nothing while the invite expired.
 *
 * So: every command these files tell a model to run must be one the CLI
 * actually dispatches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

/** The command names `main()` dispatches on, read from the source of truth. */
function cliCommands(): Set<string> {
  const src = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/cmd === "([a-z][a-z-]*)"/g)) names.add(m[1] as string);
  for (const m of src.matchAll(/case "([a-z][a-z-]*)":/g)) names.add(m[1] as string);
  return names;
}

/** Every `"$SESHI" <word>` a markdown file tells the model to run. */
function invocationsIn(text: string): string[] {
  return [...text.matchAll(/"\$SESHI"\s+([a-z][a-z-]*)/g)].map((m) => m[1] as string);
}

const docs = [
  join(root, "skills/seshi/SKILL.md"),
  ...(existsSync(join(root, "commands"))
    ? readdirSync(join(root, "commands"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(root, "commands", f))
    : []),
];

test("the CLI dispatch is readable, or this whole file proves nothing", () => {
  const cmds = cliCommands();
  // If the parse breaks, an empty set would pass every check below silently.
  for (const known of ["start", "join", "serve", "use", "contacts", "decision"]) {
    assert.ok(cmds.has(known), `expected the CLI to dispatch ${known}; parsed: ${[...cmds]}`);
  }
});

test("no instruction file names a command the CLI does not have", () => {
  const cmds = cliCommands();
  for (const path of docs) {
    for (const used of invocationsIn(readFileSync(path, "utf8"))) {
      assert.ok(
        cmds.has(used),
        `${path.replace(root, ".")} tells the model to run "seshi ${used}", which does not exist. ` +
          `Real commands: ${[...cmds].sort().join(", ")}`,
      );
    }
  }
});

test("the slash commands exist and carry front matter", () => {
  for (const name of ["start", "join", "say"]) {
    const path = join(root, "commands", `${name}.md`);
    assert.ok(existsSync(path), `missing commands/${name}.md, so /seshi:${name} does not exist`);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^---\n[\s\S]*?\n---/, `commands/${name}.md has no front matter`);
    assert.match(text, /^description:/m, `commands/${name}.md has no description`);
    assert.match(text, /^argument-hint:/m, `commands/${name}.md has no argument-hint`);
  }
});

test("neither slash command reaches for --yes", () => {
  // --yes skips the safety-word prompt, which is the only defence against a
  // man in the middle. The commands hold stdin open on a pipe instead.
  for (const name of ["start", "join", "say"]) {
    const text = readFileSync(join(root, "commands", `${name}.md`), "utf8");
    const runs = [...text.matchAll(/"\$SESHI"\s+[a-z-]+[^\n]*/g)].map((m) => m[0]);
    for (const line of runs) {
      assert.ok(!line.includes("--yes"), `commands/${name}.md runs the CLI with --yes: ${line}`);
    }
  }
});
