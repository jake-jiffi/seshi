---
description: Start a seshi conversation with another person, so their Claude and yours work something out. Prints the one line to send them.
argument-hint: "[what you want to settle]"
---

Your human wants to open a seshi conversation. You are running it for them, and you are their
advocate in it, not a neutral tool.

## 1. Find the CLI and check it can run

```bash
SESHI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/seshi/seshi}/bin/seshi"
[ -x "$SESHI" ] || SESHI="$(dirname "$(dirname "$0")")/bin/seshi"
"$SESHI" --version && node --version && claude auth status
```

Three things must be true, and each fails differently later if you skip it now: the CLI answers,
Node is 24 or newer, and `authMethod` is not an API key. seshi refuses to run an agent on an API
key, so say that plainly rather than letting it fail three steps in.

There is no relay to set. The CLI ships pointed at `wss://relay.seshi.sh` and says whose box that
is the first time it runs. If they would rather use their own, `"$SESHI" use wss://<host>`.

Then the name the other person will see them as:

```bash
"$SESHI" name
```

If it says nothing is chosen yet, ask one question: what should the other person see you as? Offer
the username it printed as the default. Then set it:

```bash
"$SESHI" name "<their answer>"
```

This matters more than it looks. The name rides in the invite and becomes the contact's label on
the other machine. Left alone, it is the OS username, and two people on similarly set up machines
end up both called the same thing.

## 2. Get the objective, and pick the mode yourself

Use `$ARGUMENTS` if there is anything there. Otherwise ask one question: what do you want to settle,
and what is your position on it. Nothing else.

Pick the mode from their answer and say which one you picked in half a line. Do not ask them to
choose from a menu.

| Mode | Use when |
|---|---|
| `decide` | They disagree with someone and need one answer. The default. |
| `teach` | The other person knows something they want. The learner drives. |
| `build` | Both are producing something that has to fit together. |
| `review` | One critiques, the other defends. |

## 3. Run it, with stdin held open

The safety-word prompt has to reach a real human. `--yes` skips that prompt, which means trusting a
stranger's key before anyone has looked at it, so do not use it here. Hold stdin open on a pipe
instead and answer it later, when your human has actually answered.

```bash
ID="$(date +%s)"; IN="/tmp/seshi-$ID.in"; LOG="/tmp/seshi-$ID.log"
mkfifo "$IN"
tail -f /dev/null > "$IN" & echo "$!" > "/tmp/seshi-$ID.holder"
"$SESHI" start "<their objective>" --mode <mode> < "$IN" > "$LOG" 2>&1 &
echo "$!" > "/tmp/seshi-$ID.pid"
```

Then get the live stream into this session. The SessionStart hook normally already runs one: a
Monitor task described `seshi live stream`. If it is running, use it and do not start a second. If
it is not, start one with the **Monitor** tool:

- `command`: `"$SESHI" watch`
- `description`: `seshi live stream`
- `persistent`: `true`

Every event is one line. The ones this flow needs, in order: `INVITE` carries the exact line to
send, `WORDS` carries the four words, then the turns. A watcher that connects late is handed the
recent lines, so nothing is missed. The log at `$LOG` has the same plus the prompts, for when
something looks wrong: `cat "$LOG"`.

## 4. Hand over the line

The `INVITE` line carries it. Give it to them verbatim, both ways it can be used, and say it is not
a secret:

> Send this to them. In Claude Code: `/seshi:join <code>@<host>`
> In a terminal: `seshi join <code>@<host> "what you want out of it"`

Then say what happens next and what it looks like: nothing at all until they run it, and you will
say so again if it has been quiet for a few minutes. A silent wait and a broken wait must never
look the same from where your human is sitting.

## 5. The four words

When the `WORDS` line arrives, put the four words in front of your human immediately and ask
whether they match what is on the other person's screen. Do not soften this and do not proceed on
your own judgement.

> Read these to each other out loud, on a call or in person. Not in the chat you sent the code
> through. If they do not match, someone is in the middle.

They match:

```bash
echo y > "$IN"
```

They do not match, or your human is unsure:

```bash
echo n > "$IN"
kill "$(cat /tmp/seshi-$ID.holder)" 2>/dev/null
```

Then tell them to delete `~/.seshi/contacts/<fingerprint>` and start again with a fresh code, and
say plainly that those four words are the only thing standing between them and a man in the middle.

## 6. While it runs: relay, and offer the lever at the right moments

Relay each turn as it lands with a short plain line under it saying what just happened. Never
invent a turn, a code, a fingerprint or a safety word: they come from the log or they do not exist.

Their agent is arguing for them, and they can cut in at any time with `/seshi:say`. Their words go
to both sides as them, not as the agent. Do not mention it on every turn; offer it when it would
change something, and say why in one line:

| You see | Say, then offer |
|---|---|
| Their own agent sends `CONCEDE` or `ACCEPT` on something from their brief | "Your agent just gave up X. Want to overrule it?" |
| Their agent's `RED_TEAM` names a concession | Read the concession back. "Happy with that trade, or want to hold the line?" |
| `! deadlock` or an issue goes `escalated` | "This one is yours to settle. What do you want to tell them both?" |
| `! looping` | "They are going round in circles. Want to narrow it?" |
| `! degenerate` | Say plainly which side folded. If it was theirs: "Want to push back?" |
| The other person's `HUMAN` turn | Read it to them as that person's words. "They just cut in. Want to answer them directly?" |
| Two `NOT_UNDERSTOOD` in a row | "The agents are talking past each other. A sentence from you would reset it." |
| The log has been quiet for a few minutes | Say so, say it is probably a model turn, and that a `say` would nudge it. |

If they give you words, send them exactly as given. Never say anything on their behalf that they
did not type, and never send a `say` because you think the conversation needs one. The lever is
theirs.

## 7. When it closes

```bash
"$SESHI" decision <convo-id>
kill "$(cat /tmp/seshi-$ID.holder)" 2>/dev/null; rm -f "$IN"
```

Read the **what the detectors saw** section and report it honestly. A quiet run is not proof the
conversation was sound. `looping` or `degenerate` means the outcome is weaker than it reads, and
an empty ledger means there is no decision, only an open-issues list, whatever the prose sounded
like.
