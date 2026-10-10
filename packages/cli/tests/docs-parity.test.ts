// The CLI the docs describe is the CLI that ships. A command named in the skill or docs that does not exist
// (the skill once documented `unbrowse replay …`), or a shipped command nobody documents, fails here.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";

const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const source = read("packages/cli/src/cli.ts");

/** Commands the CLI implements: its `case "x":` dispatch, plus the two handled before it. */
const implemented = new Set([...[...source.matchAll(/^ {6}case "([a-z-]+)":/gm)].map((m) => m[1]!), "mcp", "help"]);

/** Commands `unbrowse help` lists: the first word of each two-space-indented line. */
async function helpCommands(): Promise<Set<string>> {
  let text = "";
  await main(["help"], { out: (s: string) => void (text += `${s}\n`), err: () => {}, interactive: false } as never);
  return new Set([...text.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]!));
}

/** `unbrowse <command>` inside inline code or fenced blocks of a markdown file. */
function mentioned(markdown: string): Set<string> {
  // "There is no `unbrowse browse`" names a command on purpose to say it does not exist.
  const text = markdown.replace(/\bno `unbrowse [a-z-]+`/g, "");
  const code = [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]).join("\n");
  // A command position: line start, an opening backtick, or after npx. Not `claude mcp add … unbrowse https://…`.
  return new Set([...code.matchAll(/(?:^|`|npx (?:-y )?)unbrowse(?:@[\w.-]+)? ([a-z][a-z-]*)/gm)].map((m) => m[1]!));
}

/** Commands in the CLI reference's tables: rows that start with `command`. */
function tabled(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^\| `([a-z][a-z-]*)/gm)].map((m) => m[1]!));
}

const docs = [
  "skill/SKILL.md",
  "README.md",
  "packages/cli/README.md",
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
];

test("help lists exactly the commands the CLI implements", async () => {
  const help = await helpCommands();
  expect([...implemented].filter((c) => c !== "help" && !help.has(c))).toEqual([]);
  expect([...help].filter((c) => !implemented.has(c))).toEqual([]);
});

test("every `unbrowse <command>` in the skill and docs is a real command", () => {
  const unknown = docs.flatMap((f) => [...mentioned(read(f))].filter((c) => !implemented.has(c)).map((c) => `${f}: unbrowse ${c}`));
  expect(unknown).toEqual([]);
});

test("the CLI reference documents every command", () => {
  const md = read("docs/cli.md");
  const reference = new Set([...mentioned(md), ...tabled(md)]);
  expect([...implemented].filter((c) => c !== "help" && !reference.has(c))).toEqual([]);
});

test("the parity check catches an invented command", () => {
  expect([...mentioned("Use `unbrowse replay list` or\n```sh\nnpx unbrowse@12 browse x\n```")]).toEqual(["replay", "browse"]);
  expect(mentioned("see https://unbrowse.ai and `unbrowse.ai/app`").size).toBe(0);
  expect(mentioned("`claude mcp add --transport http unbrowse https://unbrowse.ai/mcp` · There is no `unbrowse browse`").size).toBe(0);
});
