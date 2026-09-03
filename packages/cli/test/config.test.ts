import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptDefaultRelay, DEFAULT_RELAY, readConfig, relayUrl, writeConfig } from "../src/config.ts";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "seshi-config-"));
  const prevHome = process.env["SESHI_HOME"];
  const prevRelay = process.env["SESHI_RELAY"];
  process.env["SESHI_HOME"] = home;
  delete process.env["SESHI_RELAY"];
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) delete process.env["SESHI_HOME"];
    else process.env["SESHI_HOME"] = prevHome;
    if (prevRelay === undefined) delete process.env["SESHI_RELAY"];
    else process.env["SESHI_RELAY"] = prevRelay;
    rmSync(home, { recursive: true, force: true });
  }
}

test("with nothing set, the relay is the declared default and it is wss", () => {
  withHome(() => {
    assert.equal(relayUrl(), DEFAULT_RELAY);
    assert.match(DEFAULT_RELAY, /^wss:\/\//, "the default must be TLS, it is a stranger's box");
  });
});

test("the default is adopted once: written to config, and only the first call says so", () => {
  withHome((home) => {
    assert.equal(adoptDefaultRelay(), true, "first run should announce");
    assert.equal(readConfig().relay, DEFAULT_RELAY);
    assert.match(readFileSync(join(home, "config.json"), "utf8"), /relay\.seshi\.sh/);
    assert.equal(adoptDefaultRelay(), false, "second run should be quiet");
  });
});

test("a relay chosen with `seshi use` beats the default, and the environment beats both", () => {
  withHome(() => {
    writeConfig({ relay: "wss://mine.example" });
    assert.equal(relayUrl(), "wss://mine.example");
    assert.equal(adoptDefaultRelay(), false, "a chosen relay is never overwritten");
    process.env["SESHI_RELAY"] = "ws://127.0.0.1:1";
    assert.equal(relayUrl(), "ws://127.0.0.1:1");
    assert.equal(adoptDefaultRelay(), false);
  });
});
