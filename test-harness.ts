#!/usr/bin/env bun
/**
 * Standalone CLI for testing unbrowse tools through the real OpenClaw agent.
 *
 * Usage:
 *   bun test-harness.ts "list my captured API skills"
 *   bun test-harness.ts "parse the HAR file at /path/to/file.har"
 *   bun test-harness.ts "analyze the todoapp skill with deep mode"
 *   bun test-harness.ts --session mytest "learn this HAR" "now analyze it"
 *
 * Sends real messages to a real OpenClaw agent. No mocking.
 * Requires: OpenClaw gateway running, agent "main" configured.
 */

import { createTestHarness } from "./src/__tests__/harness.js";

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
    printHelp();
    return;
  }

  // Parse flags
  let agent = "main";
  let sessionId: string | undefined;
  let timeout = 120;
  const messages: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--agent" && rawArgs[i + 1]) {
      agent = rawArgs[++i];
    } else if (arg === "--session" && rawArgs[i + 1]) {
      sessionId = rawArgs[++i];
    } else if (arg === "--timeout" && rawArgs[i + 1]) {
      timeout = parseInt(rawArgs[++i], 10);
    } else if (!arg.startsWith("--")) {
      messages.push(arg);
    }
  }

  if (messages.length === 0) {
    console.error("No messages provided. Pass one or more quoted strings.");
    process.exit(1);
  }

  const oc = createTestHarness({ agent, sessionId, timeoutSeconds: timeout });
  console.log(`Session: ${oc.sessionId}`);
  console.log(`Agent: ${oc.agent}`);
  console.log("");

  for (const msg of messages) {
    console.log(`>>> ${msg}`);
    console.log("─".repeat(60));

    try {
      const res = await oc.send(msg);

      console.log(res.text);
      console.log("");
      console.log(
        `  [${res.status}] ${res.durationMs}ms | ` +
        `${res.meta.model} | ` +
        `tokens: ${res.meta.usage.total}`
      );
    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}`);
    }

    console.log("─".repeat(60));
    console.log("");
  }

  // Summary
  const usage = oc.totalUsage();
  console.log(`Total: ${oc.history.length} messages, ${usage.total} tokens`);
}

function printHelp() {
  console.log(`
unbrowse test harness — Send real messages to OpenClaw

Usage:
  bun test-harness.ts "message"                         Single message
  bun test-harness.ts "msg1" "msg2" "msg3"              Multi-turn conversation
  bun test-harness.ts --session mytest "msg1" "msg2"    Named session (persists)
  bun test-harness.ts --agent ops "message"             Use a different agent

Options:
  --agent <id>       Agent to use (default: main)
  --session <id>     Session ID for multi-turn (auto-generated if omitted)
  --timeout <sec>    Timeout per message in seconds (default: 120)

Examples:
  bun test-harness.ts "Call unbrowse_skills"
  bun test-harness.ts "Call unbrowse_learn with harPath=./test.har"
  bun test-harness.ts --session demo "learn the HAR at ./api.har" "now analyze it"
`.trim());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
