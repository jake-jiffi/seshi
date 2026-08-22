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
