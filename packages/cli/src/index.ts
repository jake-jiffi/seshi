#!/usr/bin/env node
/**
 * seshi — your Claude talks to their Claude.
 *
 * Deliberately small. The CLI holds no logic of its own: it opens a SeshiNode,
 * calls one method, and prints. Anything it appears to decide is decided in
 * @seshi/daemon.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { SeshiNode } from "@seshi/daemon/node";
import { Conversation } from "@seshi/daemon/conversation";
import { startRelay } from "@seshi/relay/server";
import { detect } from "@seshi/core/detectors";
import type { Envelope } from "@seshi/core/envelope";

const HOME = process.env["SESHI_HOME"] ?? join(homedir(), ".seshi");
const RELAY = process.env["SESHI_RELAY"] ?? "ws://127.0.0.1:8787";

const USAGE = `seshi — your Claude talks to their Claude

  seshi init [name]            create this machine's identity
  seshi invite                 print the code you paste to someone
  seshi pair <code>            accept someone's code, then compare safety words
  seshi verify <name>          record that you confirmed the words out of band
  seshi contacts               who you are paired with, and at what tier
  seshi tier <name> <1|2|3>    lower a contact's tier (raising is a file edit, on purpose)
  seshi talk <name> <mode> <objective>
                               run a conversation. mode: teach | decide | build | review
  seshi convos                 conversations on this machine
  seshi decision <convo-id>    print the artefact
  seshi relay [port]           run a relay (default 8787)

Environment:
  SESHI_HOME   default ${join("~", ".seshi")}
  SESHI_RELAY  default ws://127.0.0.1:8787
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  // The relay needs no identity, so it is handled before a node is opened.
  if (cmd === "relay") {
    const port = Number(args[0] ?? 8787);
    const relay = await startRelay({ port });
    process.stdout.write(`seshi relay listening on ws://0.0.0.0:${relay.port}\n`);
    process.stdout.write(`It sees ciphertext and routing fingerprints. Nothing else.\n`);
    await new Promise(() => {}); // run until killed
    return 0;
  }

  const node = await SeshiNode.open({
    home: HOME,
    relayUrl: RELAY,
    name: process.env["SESHI_NAME"] ?? args[0] ?? homedir().split("/").pop() ?? "someone",
  });

  try {
    switch (cmd) {
      case "init": {
        process.stdout.write(`identity ready in ${HOME}\n`);
        process.stdout.write(`you are ${node.fingerprint}\n`);
        return 0;
      }

      case "invite": {
        process.stdout.write(`${node.invite()}\n\n`);
        process.stdout.write(`Send that to the person you want to talk to. It is not a secret:\n`);
        process.stdout.write(`it carries public keys only. When they paste it back, you will both\n`);
        process.stdout.write(`see four words. Read them to each other before you raise their tier.\n`);
        return 0;
      }

      case "pair": {
        const code = args[0];
        if (code === undefined) throw new Error("usage: seshi pair <code>");
        const { contact, safetyWords } = node.pair(code);
        process.stdout.write(`paired with ${contact.name} (${contact.fingerprint})\n`);
        process.stdout.write(`tier ${contact.tier}\n\n`);
        process.stdout.write(`  ${safetyWords.join("  ")}\n\n`);
        process.stdout.write(`Both of you must see those four words, in that order. If they differ,\n`);
        process.stdout.write(`someone is in the middle. Confirm over a different channel, then run\n`);
        process.stdout.write(`  seshi verify ${contact.name}\n`);
        return 0;
      }

      case "verify": {
        const who = args[0];
        if (who === undefined) throw new Error("usage: seshi verify <name>");
        const c = node.verify(who);
        process.stdout.write(`${c.name} verified at ${c.verifiedAt}\n`);
        return 0;
      }

      case "contacts": {
        const all = node.storage.listContacts();
        if (all.length === 0) {
          process.stdout.write(`nobody yet. run \`seshi invite\` and send the code to someone.\n`);
          return 0;
        }
        for (const c of all) {
          const v = c.verifiedAt === null ? "UNVERIFIED" : "verified";
          process.stdout.write(`  ${c.name.padEnd(16)} tier ${c.tier}  ${v.padEnd(10)} ${c.fingerprint}\n`);
        }
        return 0;
      }

      case "tier": {
        const [who, raw] = args;
        if (who === undefined || raw === undefined) throw new Error("usage: seshi tier <name> <1|2|3>");
        const wanted = Number(raw);
        const c = node.contact(who);
        if (wanted > c.tier) {
          process.stderr.write(
            `refusing to raise ${c.name} from tier ${c.tier} to ${wanted}.\n` +
              `Raising a tier is a decision a person makes at their own keyboard, so it is a\n` +
              `hand edit: ${node.storage.contactDir(c.fingerprint)}/contact.json\n`,
          );
          return 1;
        }
        node.storage.putContact({ ...c, tier: wanted as 1 | 2 | 3 });
        process.stdout.write(`${c.name} is now tier ${wanted}\n`);
        return 0;
      }

      case "convos": {
        for (const c of node.storage.listConvos()) {
          process.stdout.write(`  ${c.id}  ${c.mode.padEnd(7)} ${c.state.padEnd(6)} ${c.brief.objective}\n`);
        }
        return 0;
      }

      case "decision": {
        const id = args[0];
        if (id === undefined) throw new Error("usage: seshi decision <convo-id>");
        const md = node.storage.readDecision(id);
        if (md === null) {
          process.stderr.write(`no decision written for ${id} yet\n`);
          return 1;
        }
        process.stdout.write(`${md}\n`);
        return 0;
      }

      case "talk": {
        const [who, mode, ...rest] = args;
        const objective = rest.join(" ");
        if (who === undefined || mode === undefined || objective === "") {
          throw new Error('usage: seshi talk <name> <teach|decide|build|review> "<objective>"');
        }
        return await talk(node, who, mode, objective);
      }

      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    if (cmd !== "talk") node.close();
  }
}

/**
 * Start a conversation and stream it. This is the watching-live half of the
 * product: every turn is printed as it happens, and Ctrl-C is the interrupt.
 */
async function talk(node: SeshiNode, who: string, mode: string, objective: string): Promise<number> {
  const peer = node.contact(who);
  if (peer.tier === 1) {
    process.stderr.write(
      `${peer.name} is tier 1, which is words only: no Claude process is spawned for them.\n` +
        `That is the safe default for a new contact. Raise it once you have compared safety words.\n`,
    );
    return 1;
  }
  if (peer.verifiedAt === null) {
    process.stderr.write(
      `${peer.name} has not been verified. Compare your four safety words with them over a\n` +
        `channel other than the one that sent the invite, then run \`seshi verify ${peer.name}\`.\n`,
    );
    return 1;
  }

  const convo = node.startConvo({
    peer: peer.fingerprint,
    mode,
    brief: { objective, definitionOfDone: [], nonNegotiables: [], facts: [] },
  });

  const side = new Conversation({
    node,
    convo,
    peer,
    scopedDir: node.storage.convoDir(convo.id),
  });

  process.stdout.write(`\n  ${mode} with ${peer.name} · ${convo.id}\n`);
  process.stdout.write(`  ${objective}\n\n  starting their agent...\n`);
  await side.open();

  const opening = await side.openingTurn();
  print("you", opening);
  await node.send(convo.id, opening);

  const stop = () => {
    side.stop();
    node.close();
  };
  process.on("SIGINT", () => {
    process.stdout.write("\n  interrupted. writing what we have.\n");
    side.writeDecision(detect({ history: [...side.history], ledger: side.ledger }));
    stop();
    process.exit(0);
  });

  for (let i = 0; i < convo.budget.turns; i += 1) {
    const inbound = await node.waitForTurn({ timeoutMs: 300_000 });
    print(peer.name, inbound.envelope);
    const found = side.observe(inbound.envelope);

    for (const d of found) {
      process.stdout.write(`  ! ${d.kind}: ${d.because}\n`);
      if (d.kind === "agreement" || d.kind === "deadlock") {
        side.writeDecision(found);
        process.stdout.write(`\n  ${d.kind}. written to convos/${convo.id}/DECISION.md\n`);
        stop();
        return 0;
      }
    }

    const reply = await side.replyTo(inbound.envelope);
    print("you", reply);
    await node.send(convo.id, reply);
    if (reply.act === "CLOSE") break;
  }

  side.writeDecision(detect({ history: [...side.history], ledger: side.ledger }));
  process.stdout.write(`\n  budget spent. written to convos/${convo.id}/DECISION.md\n`);
  stop();
  return 0;
}

function print(who: string, e: Envelope): void {
  process.stdout.write(`  ${who.padEnd(10)} ${e.act.padEnd(15)} ${e.headline}\n`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
