import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDisplayName, displayName, nameIsDefaulted, writeConfig } from "../src/config.ts";

test("a display name is trimmed, collapsed, stripped of control characters and capped at 64", () => {
  assert.equal(cleanDisplayName("  Dave   Lee \n"), "Dave Lee");
  assert.equal(cleanDisplayName("dave\u0000\u001b[31m"), "dave [31m");
  assert.equal(cleanDisplayName("x".repeat(80))?.length, 64);
  assert.equal(cleanDisplayName("   \t  "), null, "nothing visible is no name");
});

test("nothing chosen means the username is what the other side would see, and choosing sticks", () => {
  const home = mkdtempSync(join(tmpdir(), "seshi-name-"));
  const prevHome = process.env["SESHI_HOME"];
  const prevName = process.env["SESHI_NAME"];
  process.env["SESHI_HOME"] = home;
  delete process.env["SESHI_NAME"];
  try {
    assert.equal(nameIsDefaulted(), true);
    writeConfig({ name: "Dave" });
    assert.equal(nameIsDefaulted(), false);
    assert.equal(displayName(), "Dave");
    process.env["SESHI_NAME"] = "Env Dave";
    assert.equal(nameIsDefaulted(), false);
    assert.equal(displayName(), "Env Dave", "the environment beats config");
  } finally {
    if (prevHome === undefined) delete process.env["SESHI_HOME"]; else process.env["SESHI_HOME"] = prevHome;
    if (prevName === undefined) delete process.env["SESHI_NAME"]; else process.env["SESHI_NAME"] = prevName;
    rmSync(home, { recursive: true, force: true });
  }
});
