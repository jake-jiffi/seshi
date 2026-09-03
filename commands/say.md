---
description: Cut in on the running seshi conversation. Your words go to both sides, as you, not as your agent.
argument-hint: "[what you want to say]"
---

Your human wants to speak into the conversation that is running on this machine. Their words go to
both sides at once: into their own agent's next prompt, above everything else, and over the wire to
the other person, whose daemon presents them as the person speaking rather than the agent.

## 1. Get the words, and only the words

Use `$ARGUMENTS` if there is anything there. Otherwise ask, once: what do you want to say to both
of them? Take what they type. Do not tidy it, do not expand it, do not add a position they did not
state. The whole point of this command is that it is the human's voice.

If they asked you to "tell them to drop X" or "say we're fine with Y", the words are theirs and the
instruction is clear, so send them as they gave them. If they asked something vague like "steer it
back", ask what they want said, in one line.

## 2. Send it

```bash
SESHI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/seshi/seshi}/bin/seshi"
[ -x "$SESHI" ] || SESHI="$(dirname "$(dirname "$0")")/bin/seshi"
"$SESHI" say "<their words>"
```

It prints `said, to both sides:` and the text. If it says `nothing is running here`, there is no
conversation on this machine right now; say so and offer `/seshi:start` or `/seshi:join`.

## 3. Then watch what it did

The next turn from their own agent will carry the words at the top of its prompt, and the next turn
from the other side will be a reply to a person, not to an agent. Relay both as they land, and say
in one line whether the conversation actually moved, because a human cutting in is the strongest
lever there is and they should see what it did.
