// The CLI matches the MCP: every core tool the hosted MCP exports (skill/references/tools.json) is a CLI command.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { CLI_FOR_TOOL, MCP_COMMANDS } from "../src/mcp-tools.ts";

const root = join(import.meta.dir, "../../..");
const exported = (JSON.parse(readFileSync(join(root, "skill/references/tools.json"), "utf8")) as { tools: { name: string }[] }).tools.map((t) => t.name);

async function help(): Promise<string> {
  let text = "";
  await main(["help"], { out: (s: string) => void (text += `${s}\n`), err: () => {}, interactive: false } as never);
  return text;
}

test("every exported MCP tool has a CLI command", () => {
  expect(exported.length).toBeGreaterThan(20);
  expect(exported.filter((t) => !CLI_FOR_TOOL[t])).toEqual([]);
});

test("every mapped command is in `unbrowse help`", async () => {
  const text = await help();
  const missing = [...new Set(Object.values(CLI_FOR_TOOL))].filter((c) => !new RegExp(`^  ${c.replace(/ /g, " ")}\\b`, "m").test(text));
  expect(missing).toEqual([]);
});

test("each MCP-backed command names one tool, and no tool twice", () => {
  const tools = MCP_COMMANDS.map((c) => c.tool);
  expect(new Set(tools).size).toBe(tools.length);
  for (const c of MCP_COMMANDS) expect(c.usage.startsWith(c.sub ? `${c.cmd} ${c.sub}` : c.cmd)).toBe(true);
});
