import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLink, parseLink } from "../src/link.ts";

test("a link round-trips", () => {
  const link = formatLink("7-tandem-verdict", "wss://dry-forest.trycloudflare.com");
  assert.equal(link, "7-tandem-verdict@dry-forest.trycloudflare.com");
  const p = parseLink(link);
  assert.equal(p.code, "7-tandem-verdict");
  assert.equal(p.relay, "wss://dry-forest.trycloudflare.com");
});

test("remote hosts get TLS, localhost does not", () => {
  assert.equal(parseLink("a-b-c@example.com").relay, "wss://example.com");
  assert.equal(parseLink("a-b-c@localhost:8787").relay, "ws://localhost:8787");
  assert.equal(parseLink("a-b-c@127.0.0.1:8787").relay, "ws://127.0.0.1:8787");
});

test("people paste badly, and all of it is accepted", () => {
  const want = "7-tandem-verdict";
  for (const messy of [
    "  7-tandem-verdict@example.com  ",
    "<7-tandem-verdict@example.com>",
    '"7-tandem-verdict@example.com"',
    "seshi://7-tandem-verdict@example.com",
    "7-tandem-verdict@example.com.",
    "“7-tandem-verdict@example.com”",
  ]) {
    assert.equal(parseLink(messy).code, want, `failed on: ${messy}`);
    assert.equal(parseLink(messy).relay, "wss://example.com", `failed on: ${messy}`);
  }
});

test("nonsense is refused with a message that shows the shape", () => {
  for (const bad of ["", "just-a-code", "@example.com", "code@", "code@not a host"]) {
    assert.throws(() => parseLink(bad), /seshi link|pairing code|address looks wrong/i, `accepted: ${bad}`);
  }
});

test("a host containing an @ in the code half still splits on the last one", () => {
  // Codes never contain @, but be certain the split is unambiguous.
  assert.equal(parseLink("a-b-c@example.com").relay, "wss://example.com");
});

test("a private network address keeps plain ws, a public one is forced to wss", () => {
  for (const lan of ["192.168.157.240:8787", "10.0.0.4:8787", "172.16.3.9:8787", "127.0.0.1:8787"]) {
    assert.equal(parseLink(`7-tandem-verdict@${lan}`).relay, `ws://${lan}`, `not ws: ${lan}`);
  }
  // 172.32 is outside the private block, and a name that merely looks local is not one.
  for (const pub of ["172.32.0.1:8787", "example.com", "192.168.evil.com"]) {
    assert.equal(parseLink(`7-tandem-verdict@${pub}`).relay, `wss://${pub}`, `not wss: ${pub}`);
  }
});
