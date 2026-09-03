import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEvent } from "../src/watch.ts";

const line = (event: Record<string, unknown>): string | null =>
  formatEvent(JSON.stringify({ t: "event", event }));

test("the invite and the four words reach the watch stream, so one stream carries the whole flow", () => {
  assert.equal(
    line({ kind: "invite", at: "T", convo: "-", link: 'seshi join 7-tandem-verdict@relay.seshi.sh "<what you want out of it>"' }),
    'T | - | seshi | INVITE | seshi join 7-tandem-verdict@relay.seshi.sh "<what you want out of it>"',
  );
  assert.equal(
    line({ kind: "words", at: "T", convo: "-", words: "kiwi news surround polar", name: "dave" }),
    "T | - | seshi | WORDS | kiwi news surround polar   (paired with dave)",
  );
});
