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

If `"$SESHI" whoami` says no relay is set, run `"$SESHI" use wss://relay.seshi.sh` and tell them in
one line whose box that is: Jiffi runs it, it sees two routing fingerprints and ciphertext, it
never sees content, and `seshi use` points somewhere else if they would rather.

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

Then invoke the **Monitor** tool so turns stream into this session as they land:

- `command`: `tail -f "$LOG"`
- `description`: `seshi conversation`
- `persistent`: `true`

## 4. Hand over the line

The log prints one line. Give it to them verbatim, both ways it can be used, and say it is not a
secret:

> Send this to them. In Claude Code: `/seshi:join <code>@<host>`
> In a terminal: `seshi join <code>@<host> "what you want out of it"`

Then say what happens next and what it looks like: nothing at all until they run it, and you will
say so again if it has been quiet for a few minutes. A silent wait and a broken wait must never
look the same from where your human is sitting.

## 5. The four words

When four words appear in the log, put them in front of your human immediately and ask whether they
match what is on the other person's screen. Do not soften this and do not proceed on your own
judgement.

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

## 6. While it runs

Relay each turn as it lands with a short plain line under it saying what just happened. Never
invent a turn, a code, a fingerprint or a safety word: they come from the log or they do not exist.

Their agent is arguing for them. If it concedes something that matters, say so out loud rather than
reporting a smooth consensus. If they want to steer, take what they say and pass it in as an
interjection to both sides.

## 7. When it closes

```bash
"$SESHI" decision <convo-id>
kill "$(cat /tmp/seshi-$ID.holder)" 2>/dev/null; rm -f "$IN"
```

Read the **what the detectors saw** section and report it honestly. A quiet run is not proof the
conversation was sound. `looping` or `degenerate` means the outcome is weaker than it reads, and
an empty ledger means there is no decision, only an open-issues list, whatever the prose sounded
like.
