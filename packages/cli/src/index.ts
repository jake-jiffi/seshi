#!/usr/bin/env node
/**
 * seshi — your Claude talks to their Claude.
 *
 * Two commands carry the whole product:
 *
 *   seshi start dave decide "the thing"   -> spins everything up, prints one link
 *   seshi join <link> "my angle"          -> one paste, and you are talking
 *
 * Everything else is inspection. The CLI holds no logic of its own; it opens a
 * SeshiNode, calls one method, and prints.
 */

import { createInterface } from "node:readline/promises";
import { SeshiNode } from "../../daemon/src/node.ts";
import { Conversation } from "../../daemon/src/conversation.ts";
import type { PublicBrief } from "../../daemon/src/storage.ts";
import type { Envelope } from "../../core/src/envelope.ts";
import { displayName, NO_RELAY_HELP, relayUrl, seshiHome, writeConfig } from "./config.ts";
import { formatLink, parseLink } from "./link.ts";

const USAGE = `seshi — your Claude talks to their Claude

  seshi start <name> <mode> "<objective>"
        Start a conversation. Prints the single line you send the other person.
        Modes: teach | decide | build | review

  seshi join <link> "<your objective>"
        The other side. One paste, and you are talking.

  seshi serve                 run a relay and print its address
  seshi use <wss://...>       point at someone else's relay
  seshi contacts              who you are paired with
  seshi trust <name> <1|2|3>  set what a contact's agent may do
  seshi convos                conversations on this machine
  seshi decision <id>         read what a conversation produced
  seshi whoami                this machine's identity

Node 24+. No npm install, no API key. Each side thinks on its own subscription.
`;

const MODES = ["teach", "decide", "build", "review"];

/**
 * `--yes` skips the safety-word prompt. It does NOT skip the safety words.
 *
 * It exists because the Claude Code skill shows the words in chat and asks the
 * human there, so a second prompt on a pipe would deadlock. Anything that
 * passes this is asserting a human has already read the words and said they
 * match. Nothing else may pass it.
 */
const ASSUME_YES = process.argv.includes("--yes");

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const out = (s: string): void => void process.stdout.write(s);
const rule = (): void => out(`  ${"-".repeat(64)}\n`);

function briefFrom(objective: string): PublicBrief {
  return {
    objective,
    definitionOfDone: [`both sides sign one decision on: ${objective}`],
    nonNegotiables: [{ text: objective, reason: "stated as the point of this conversation" }],
    facts: [],
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv.filter((a) => a !== "--yes");
  if (cmd === undefined || ["help", "--help", "-h"].includes(cmd)) {
    out(USAGE);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    out("seshi 0.2.0\n");
    return 0;
  }
  if (cmd === "serve") {
    // Imported lazily and ONLY here. `serve` reaches the relay, and the relay
    // is the one part of seshi that needs a dependency (`ws`, because Node has
    // a WebSocket client but no server). Importing it at the top meant a clean
    // clone could not even print its help, which is a rotten first impression
    // for a tool whose whole pitch is that it needs no install.
    const { serve } = await import("./serve.ts");
    return await serve(Number(args[0] ?? 8787));
  }

  if (cmd === "use") {
    const url = args[0];
    if (url === undefined) throw new Error("usage: seshi use wss://...");
    writeConfig({ relay: url.replace(/^https:/, "wss:").replace(/^http:/, "ws:") });
    out(`  relay set to ${relayUrl()}\n`);
    return 0;
  }

  // `join` carries its own relay inside the link, so it runs before the relay
  // check that every other command needs.
  if (cmd === "join") {
    const link = args[0];
    if (link === undefined) throw new Error('usage: seshi join <link> "<your objective>"');
    return await join(link, args.slice(1).join(" "));
  }

  const relay = relayUrl();
  if (relay === null) {
    process.stderr.write(`${NO_RELAY_HELP}\n`);
    return 1;
  }

  const node = await SeshiNode.open({ home: seshiHome(), relayUrl: relay, name: displayName() });
  const holdOpen = cmd === "start";
  try {
    switch (cmd) {
      case "whoami":
        out(`  ${node.name}  ${node.fingerprint}\n  relay ${relay}\n  home  ${seshiHome()}\n`);
        return 0;

      case "contacts": {
        const all = node.storage.listContacts();
        if (all.length === 0) {
          out(`  nobody yet. run: seshi start <their-name> decide "<what you need to settle>"\n`);
          return 0;
        }
        for (const c of all) {
          const state = c.verifiedAt === null ? "UNVERIFIED" : "verified";
          out(`  ${c.name.padEnd(14)} tier ${c.tier}  ${state.padEnd(11)}${c.fingerprint}\n`);
        }
        return 0;
      }

      case "trust": {
        const [who, raw] = args;
        if (who === undefined || raw === undefined) {
          throw new Error("usage: seshi trust <name> <1|2|3>");
        }
        const tier = Number(raw);
        if (![1, 2, 3].includes(tier)) throw new Error("tier must be 1, 2 or 3");
        const c = node.contact(who);
        if (tier > 1 && c.verifiedAt === null) {
          process.stderr.write(
            `${c.name} has not been verified. Compare your four safety words with them over a\n` +
              `channel other than the one that sent the link, then run: seshi verify ${c.name}\n`,
          );
          return 1;
        }
        node.storage.putContact({ ...c, tier: tier as 1 | 2 | 3 });
        out(`  ${c.name} is now tier ${tier}\n`);
        return 0;
      }

      case "verify": {
        const who = args[0];
        if (who === undefined) throw new Error("usage: seshi verify <name>");
        out(`  ${node.verify(who).name} verified\n`);
        return 0;
      }

      case "convos": {
        for (const c of node.storage.listConvos()) {
          out(`  ${c.id}  ${c.mode.padEnd(7)} ${c.state.padEnd(6)} ${c.brief.objective}\n`);
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
        out(`${md}\n`);
        return 0;
      }

      case "start": {
        const [who, mode] = args;
        const objective = args.slice(2).join(" ");
        if (who === undefined || mode === undefined || objective === "") {
          throw new Error('usage: seshi start <name> <teach|decide|build|review> "<objective>"');
        }
        if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}`);
        return await start(node, relay, who, mode, objective);
      }

      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    if (!holdOpen) node.close();
  }
}

/** Pair if we have to, confirm the words, then open the conversation. */
async function start(
  node: SeshiNode,
  relay: string,
  who: string,
  mode: string,
  objective: string,
): Promise<number> {
  let contact = node.storage.listContacts().find((c) => c.name === who) ?? null;

  if (contact === null) {
    const pending = await node.invite(who);
    out("\n");
    rule();
    out(`  Send ${who} this line. It is not a secret.\n\n`);
    out(`      /seshi join ${formatLink(pending.code, relay)}\n\n`);
    rule();
    out(`\n  waiting for ${who} to join...\n`);

    const paired = await pending.waitForPeer();
    if (!(await confirmWords(paired.safetyWords, paired.contact.name))) return 1;
    node.verify(paired.contact.fingerprint);
    node.storage.putContact({ ...node.contact(paired.contact.fingerprint), tier: 2 });
    contact = node.contact(paired.contact.fingerprint);
  }

  if (contact.verifiedAt === null || contact.tier < 2) {
    const unverified = contact.verifiedAt === null ? " and unverified" : "";
    process.stderr.write(
      `${contact.name} is tier ${contact.tier}${unverified}.\n` +
        `Compare safety words, then: seshi trust ${contact.name} 2\n`,
    );
    return 1;
  }

  const convo = node.startConvo({ peer: contact.fingerprint, mode, brief: briefFrom(objective) });
  const side = new Conversation({
    node,
    convo,
    peer: contact,
    scopedDir: node.storage.convoDir(convo.id),
    ...(contact.tier === 3 ? { repo: process.cwd() } : {}),
  });

  out(`\n  ${mode} with ${contact.name}\n  ${objective}\n\n  starting your agent...\n`);
  await side.open();

  const opening = await side.openingTurn();
  print("you", opening);
  await node.send(convo.id, opening);

  return await runLoop(node, side, contact.name, convo.id, convo.budget.turns);
}

/** One paste: sets the relay, pairs, confirms, and waits for their opening. */
async function join(link: string, objective: string): Promise<number> {
  const { code, relay } = parseLink(link);
  writeConfig({ relay });

  const node = await SeshiNode.open({ home: seshiHome(), relayUrl: relay, name: displayName() });
  out(`\n  relay ${relay}\n  pairing with ${code}...\n`);

  const paired = await node.joinWithCode(code);
  if (!(await confirmWords(paired.safetyWords, paired.contact.name))) {
    node.close();
    return 1;
  }
  node.verify(paired.contact.fingerprint);
  node.storage.putContact({ ...node.contact(paired.contact.fingerprint), tier: 2 });
  const contact = node.contact(paired.contact.fingerprint);

  const stated =
    objective !== ""
      ? objective
      : await ask("\n  What do YOU want out of this? (your own angle, in your words)\n  > ");
  if (stated === "") {
    process.stderr.write("  a conversation needs your objective, not just theirs.\n");
    node.close();
    return 1;
  }

  // Armed for exactly this contact, exactly one conversation, then disarmed.
  node.expectOpenFrom(contact.fingerprint, briefFrom(stated), "decide");
  out(`\n  waiting for ${contact.name} to open...\n`);

  const first = await node.waitForTurn({ timeoutMs: 600_000 });
  const convo = node.storage.getConvo(first.envelope.convo);
  if (convo === null) throw new Error("their opening turn did not open a conversation");

  const side = new Conversation({
    node,
    convo,
    peer: contact,
    scopedDir: node.storage.convoDir(convo.id),
    ...(contact.tier === 3 ? { repo: process.cwd() } : {}),
  });
  out(`  ${convo.mode} with ${contact.name}\n  starting your agent...\n`);
  await side.open();

  print(contact.name, first.envelope);
  side.observe(first.envelope);
  const reply = await side.replyTo(first.envelope);
  print("you", reply);
  await node.send(convo.id, reply);

  return await runLoop(node, side, contact.name, convo.id, convo.budget.turns);
}

/** The half both sides share: read a turn, report detectors, answer, repeat. */
async function runLoop(
  node: SeshiNode,
  side: Conversation,
  peerName: string,
  convoId: string,
  turns: number,
): Promise<number> {
  const stop = (): void => {
    side.discardWorktree();
    side.stop();
    node.close();
  };
  process.on("SIGINT", () => {
    out("\n  interrupted. writing what we have.\n");
    side.writeDecision(side.detections());
    stop();
    process.exit(0);
  });

  for (let i = 0; i < turns; i += 1) {
    let inbound;
    try {
      inbound = await node.waitForTurn({ timeoutMs: 600_000 });
    } catch {
      out(`\n  ${peerName} went quiet. Writing what we have.\n`);
      break;
    }
    print(peerName, inbound.envelope);
    const found = side.observe(inbound.envelope);

    for (const d of found) {
      out(`  ! ${d.kind}: ${d.because}\n`);
      if (d.kind === "agreement" || d.kind === "deadlock") {
        side.writeDecision(found);
        out(`\n  ${d.kind}. read it with:  seshi decision ${convoId}\n`);
        stop();
        return 0;
      }
    }

    const reply = await side.replyTo(inbound.envelope);
    print("you", reply);
    await node.send(convoId, reply);
    if (reply.act === "CLOSE") break;
  }

  side.writeDecision(side.detections());
  out(`\n  done. read it with:  seshi decision ${convoId}\n`);
  stop();
  return 0;
}

/**
 * The only unskippable ceremony in the product, and the only thing standing
 * between the two of you and someone in the middle.
 */
async function confirmWords(words: string[], name: string): Promise<boolean> {
  out("\n");
  rule();
  out(`  Paired with ${name}. You should both see these four words:\n\n`);
  out(`      ${words.join("   ")}\n\n`);
  out(`  Read them to each other OUT LOUD, on a call or in person.\n`);
  out(`  Not in the chat you sent the link through.\n`);
  rule();
  if (ASSUME_YES) {
    out("\n  (--yes: taking it that a human has confirmed these match)\n");
    return true;
  }
  const answer = await ask("\n  Do they match on both sides? [y/N] ");
  if (!/^y(es)?$/i.test(answer)) {
    process.stderr.write(
      "\n  Stopping, and nothing was trusted.\n" +
        "  If the words differ, someone is between you. Start again with a fresh link.\n",
    );
    return false;
  }
  return true;
}

function print(who: string, e: Envelope): void {
  out(`  ${who.padEnd(10)} ${e.act.padEnd(15)} ${e.headline}\n`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
