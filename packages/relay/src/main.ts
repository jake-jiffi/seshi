/**
 * The relay as a long-running service, for a host that already has an address.
 *
 * `seshi serve` is the laptop version of this: it starts the same relay and
 * then pokes a tunnel through NAT so two people can reach it. On a box with a
 * public address there is nothing to poke, so this is the whole program.
 *
 * Everything it holds is in memory: the mailboxes carrying pairing offers, and
 * the frames queued for whoever is offline. Run exactly ONE of these behind an
 * address. Two instances split that state, and two people who land on
 * different ones wait for each other forever.
 */

import { startRelay } from "./server.ts";

const port = Number(process.env["PORT"] ?? 8787);
const relay = await startRelay({ port });
process.stdout.write(`seshi relay listening on ${relay.port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stdout.write(`${signal}, closing.\n`);
    void relay.close().then(() => process.exit(0));
  });
}
