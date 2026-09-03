---
description: Join a seshi conversation someone sent you a code for, so your Claude and theirs work it out.
argument-hint: "[code@host]"
---

Someone sent your human a seshi code. You are joining on their behalf, and you are their advocate
in the conversation, not a neutral tool.

## 1. Get the code

Use `$ARGUMENTS` if there is a code there. Otherwise ask for it: the whole `code@host` string they
were sent, not just the code half.

They may paste it wrapped in quotes, with a trailing full stop, or with a `/seshi:join` still
attached. Strip that and pass the `code@host` through. The CLI is forgiving about most of it but a
leading slash command is not part of the link.

## 2. Find the CLI and check it can run

```bash
SESHI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/seshi/seshi}/bin/seshi"
[ -x "$SESHI" ] || SESHI="$(dirname "$(dirname "$0")")/bin/seshi"
"$SESHI" --version && node --version && claude auth status
```

The CLI must answer, Node must be 24 or newer, and `authMethod` must not be an API key. seshi
refuses to run an agent on an API key, so check it now rather than failing after they have already
paired. There is no relay to set: the code carries the address.

Then the name the other person will see them as:

```bash
"$SESHI" name
```

If it says nothing is chosen yet, ask one question: what should the other person see you as? Offer
the username it printed as the default, then `"$SESHI" name "<their answer>"`. The name rides in
the pairing and becomes the contact's label on the other machine.

## 3. Get their own objective, in their own words

Ask before joining, and ask for their angle rather than a summary of the invitation:

> What do you want out of this? Your own position, in your words.

This is not a formality. Their brief is what their agent argues from, and a conversation opened
with a brief you invented is one where their agent argues for a position they never held. If they
have not got a position yet, that is worth saying out loud, because two agents that want the same
thing produce agreement that means nothing, and the detectors will flag it as uncontested.

## 4. Run it, with stdin held open

Do not use `--yes`. It skips the safety-word prompt, and that prompt is the one thing standing
between your human and a man in the middle. Hold stdin open on a pipe and answer it when they have
actually answered.

```bash
ID="$(date +%s)"; IN="/tmp/seshi-$ID.in"; LOG="/tmp/seshi-$ID.log"
mkfifo "$IN"
tail -f /dev/null > "$IN" & echo "$!" > "/tmp/seshi-$ID.holder"
"$SESHI" join "<code@host>" "<their objective>" < "$IN" > "$LOG" 2>&1 &
echo "$!" > "/tmp/seshi-$ID.pid"
```

Then get the live stream into this session. The SessionStart hook normally already runs one: a
Monitor task described `seshi live stream`. If it is running, use it and do not start a second. If
it is not, start one with the **Monitor** tool:

- `command`: `"$SESHI" watch`
- `description`: `seshi live stream`
- `persistent`: `true`

Every event is one line: `WORDS` carries the four words, then the turns. A watcher that connects
late is handed the recent lines. The log at `$LOG` has the same plus the prompts, for when
something looks wrong: `cat "$LOG"`.

## 5. The four words

The `WORDS` line arrives within a few seconds of joining. Put the four words in front of your human
immediately and ask whether they match the other person's screen.

> Read these to each other out loud, on a call or in person. Not in the chat the code came
> through. If they do not match, someone is in the middle.

They match:

```bash
echo y > "$IN"
```

They do not:

```bash
echo n > "$IN"
kill "$(cat /tmp/seshi-$ID.holder)" 2>/dev/null
```

Then tell them to delete `~/.seshi/contacts/<fingerprint>` and ask the other person for a fresh
code over a different channel.

## 6. Then say what you are waiting for

After the words are confirmed the log says `waiting for <name> to open...` and nothing happens
until the other side's agent produces its opening turn. That can take a couple of minutes, because
it is a real model loading their config on their subscription.

Tell your human that, and say it again if it stays quiet, so that "still thinking" and "broken"
never look the same from where they are sitting. Common real failures, and what they look like:

| In the log | What happened |
|---|---|
| `refusing to run: claude reported apiKeySource` | They are on an API key. seshi will not run an agent on one. |
| `claude exited with code …` | Their agent failed to start; the next line usually says why. |
| `nobody joined with that code` | The code expired or was already claimed. Ask for a fresh one. |
| `went quiet` | The other side never sent a turn inside the wait. Their problem, not yours. |

## 7. While it runs: relay, and offer the lever at the right moments

Relay each turn with a short plain line saying what happened. Never invent a turn, a code or a
safety word.

Their agent is arguing for them, and they can cut in at any time with `/seshi:say`. Their words go
to both sides as them, not as the agent. Offer it when it would change something, not on every
turn:

| You see | Say, then offer |
|---|---|
| Their own agent sends `CONCEDE` or `ACCEPT` on something from their brief | "Your agent just gave up X. Want to overrule it?" |
| Their agent's `RED_TEAM` names a concession | Read it back. "Happy with that trade, or want to hold the line?" |
| `! deadlock` or an issue goes `escalated` | "This one is yours to settle. What do you want to tell them both?" |
| `! looping` | "They are going round in circles. Want to narrow it?" |
| `! degenerate` | Say plainly which side folded. If it was theirs: "Want to push back?" |
| The other person's `HUMAN` turn | Read it as that person's words. "They just cut in. Want to answer them directly?" |
| Quiet for a few minutes | Say so, say it is probably a model turn, and that a `say` would nudge it. |

If they give you words, send them exactly as given. Never send a `say` they did not ask for.

## 8. When it closes

```bash
"$SESHI" decision <convo-id>
kill "$(cat /tmp/seshi-$ID.holder)" 2>/dev/null; rm -f "$IN"
```

Report the **what the detectors saw** section honestly. An empty ledger means there is no decision,
only an open-issues list, however agreeable the prose was.
