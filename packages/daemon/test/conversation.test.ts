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
