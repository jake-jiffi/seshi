# Corrections to the plan, found after it was written

Applied by the orchestrator between build waves. Each one is a plan defect, not an agent defect.

## C1. Fingerprint length: 64 bits is too short

**Plan said:** `fingerprint()` returns 16 lowercase hex chars.

**Wrong because:** the fingerprint is a TOFU identity pin. Impersonating a pinned contact is a
second-preimage attack, 2^64 for a 64-bit digest. That is grindable. `retalk` uses 128 bits
(`sha256(identity|signing)[:32]`, `user.py:71-74`) and is right to.

**Fix:** 32 lowercase hex chars, 128 bits. Bind BOTH public keys into the digest, not just the
signing key, so a contact cannot be re-pointed at a different sealing key while keeping its identity:

```ts
export function fingerprint(signPub: Uint8Array, sealPub: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(signPub, sealPub))).slice(0, 32);
}
```

Every `/^[0-9a-f]{16}$/` assertion becomes `/^[0-9a-f]{32}$/`.

## C2. Inbound peer delivery IS gated, by the receiver's permission mode

**Research said:** inbound auth is Windows-only (`authRequired = t.requireAuth ?? ati()`), there is no
peer allowlist, so a peer message just lands. Our own `SESHI-IMPOSTOR` probe confirmed it by landing
in a live session mid-turn with no prompt.

**Incomplete, because:** that session was running in bypass permissions mode. A later probe against a
session in a stricter mode produced, verbatim:

```
Your message to another session was held for the recipient user's approval
Your message to another session was denied by the recipient user
```

**So:** cross-session delivery is gated by the RECEIVING session's permission mode, not by the bus.
Claude Code already ships a human consent gate for peer messages.

**Effect on the design:** better than we assumed. seshi does not have to invent the consent gate for
the local hop, and should not bypass it. Anything in seshi that would only work in bypass mode is
relying on the user having disarmed their own protection, and must be treated as unsupported.

## C3. Subagents address the peer bus AS their parent session

**Observed:** a message sent by a subagent produced a delivery notice addressed to the parent
("*your* message"). `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are exported
into the environment of every Bash tool call, and subagents inherit them.

**Effect on the design:** this is the concrete justification for the spec's rule that every peer
process denies `SendMessage` and `ListAgents`. Any subagent, or any shell command, running inside a
peer process would otherwise be able to address the human's own live sessions with no further
permission. Demonstrated, not theorised.
