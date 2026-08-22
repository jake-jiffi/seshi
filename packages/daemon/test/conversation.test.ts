import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelopeReply } from "../src/conversation.ts";

test("a plain JSON reply parses", () => {
  const r = parseEnvelopeReply('{"act":"PROPOSE","headline":"h","body":"b"}');
  assert.equal(r.act, "PROPOSE");
  assert.equal(r.body, "b");
});

test("a fenced reply with prose around it still parses", () => {
  const r = parseEnvelopeReply(
    'Sure, here you go:\n```json\n{"act":"COUNTER","headline":"h","body":"b"}\n```\nHope that helps.',
  );
  assert.equal(r.act, "COUNTER");
});

test("an invented ledger state is dropped, not passed to the wire", () => {
  // This is the exact failure from the first live run: the model emitted
  // "closed", which is not a ledger state, and it crashed the send path.
  const r = parseEnvelopeReply(
    '{"act":"COUNTER","headline":"h","body":"b","ledger":[{"id":"i-01","state":"closed"},{"id":"i-02","state":"agreed"}]}',
  );
  assert.deepEqual(r.ledger, [{ id: "i-02", state: "agreed" }]);
});

test("a ledger of nothing but invented states becomes no ledger at all", () => {
  const r = parseEnvelopeReply(
    '{"act":"COUNTER","headline":"h","body":"b","ledger":[{"id":"i-01","state":"closed"}]}',
  );
  assert.equal(r.ledger, undefined);
});

test("malformed ledger entries are dropped without throwing", () => {
  const r = parseEnvelopeReply(
    '{"act":"COUNTER","headline":"h","body":"b","ledger":["nope",null,{"id":""},{"state":"open"},{"id":"i-03","state":"open"}]}',
  );
  assert.deepEqual(r.ledger, [{ id: "i-03", state: "open" }]);
});

test("an unparseable reply becomes NOT_UNDERSTOOD rather than throwing", () => {
  const r = parseEnvelopeReply("I would rather just talk about this in prose, honestly.");
  assert.equal(r.act, "NOT_UNDERSTOOD");
  assert.match(r.body, /could not be parsed/);
});

test("an unknown act becomes NOT_UNDERSTOOD", () => {
  const r = parseEnvelopeReply('{"act":"DROP_TABLE","headline":"h","body":"b"}');
  assert.equal(r.act, "NOT_UNDERSTOOD");
});

test("caps are enforced at the parse boundary", () => {
  const r = parseEnvelopeReply(
    JSON.stringify({ act: "PROPOSE", headline: "h".repeat(500), body: "b".repeat(5000) }),
  );
  assert.equal(r.headline.length, 200);
  assert.equal(r.body.length, 1200);
});

test("observe refuses an envelope that was built locally rather than received", async () => {
  const { Conversation } = await import("../src/conversation.ts");
  const local = {
    v: 1 as const, convo: "c", seq: 1, prev: null, from: "",
    act: "PROPOSE" as const, headline: "h", body: "b",
  };
  // Reach the guard without booting a whole node: it is the first statement.
  assert.throws(
    () => Conversation.prototype.observe.call({} as never, local),
    /received from the wire/,
  );
});


test("each side of a conversation gets its own local session id", async () => {
  const { localSessionId } = await import("../src/conversation.ts");
  const convo = "46d0a108-aaa2-4dbb-b5f6-17a7eb66234a";
  const jake = "a".repeat(32);
  const dave = "b".repeat(32);

  const a = localSessionId(convo, jake);
  const b = localSessionId(convo, dave);

  // Claude Code refuses a session id already in use, so the two sides must
  // differ or the second agent to start dies.
  assert.notEqual(a, b, "both sides sharing a session id kills the second agent");
  assert.notEqual(a, convo, "the shared conversation id must not be used directly");

  // Stable, so --resume finds the same session after a restart.
  assert.equal(a, localSessionId(convo, jake));

  // And a real UUID, which is what --session-id accepts.
  for (const id of [a, b]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});
