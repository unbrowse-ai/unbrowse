// What the core's README and PRIVACY.md say is collected, held to what the worker takes and the node sends (UNB-208,
// ledger row T08): every field, the source tag and its shape, and the sign-in join's signed events and visitor id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as schema from "../src/schema.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const README = read("../../README.md");
const PRIVACY = read("../../PRIVACY.md");
const TELEMETRY_RS = read("../../unbrowse-node/app/src/telemetry.rs");
const LINK_RS = read("../../unbrowse-node/app/src/link.rs");
const MAIN_RS = read("../../unbrowse-node/app/src/main.rs");

/** The README's "What is sent" table: the backticked names in each row's first cell. */
function sentFields() {
  const at = README.indexOf("**What is sent**");
  assert.ok(at >= 0, "the README has its What is sent table");
  const rows = README.slice(at).split("\n\n")[1].split("\n").filter((l) => l.startsWith("| `"));
  return rows.flatMap((r) => [...r.split("|")[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
}

test("the README's table of what is sent names every field the worker takes, and no other", () => {
  assert.deepEqual([...sentFields()].sort(), [...schema.FIELDS].sort());
  const eventRow = README.split("\n").find((l) => l.startsWith("| `event` |"));
  for (const e of schema.EVENTS) assert.ok(eventRow.includes(`\`${e}\``), `the event row names ${e}`);
});

test("the README and PRIVACY.md say what the source tag is, how it is set, where it is kept and on which event it rides", () => {
  assert.equal(schema.FROM_EVENT, "node_start");
  for (const [name, doc] of [["README.md", README], ["PRIVACY.md", PRIVACY]]) {
    for (const said of ["`from`", "--from <tag>", "UNBROWSE_FROM", "~/.unbrowse/from.json", `\`${schema.FROM_EVENT}\``]) {
      assert.ok(doc.includes(said), `${name} says ${said}`);
    }
  }
  // The shape the README gives is the one the node and the worker check: 1 to FROM_MAX characters.
  const max = Number(/pub const FROM_MAX: usize = (\d+);/.exec(TELEMETRY_RS)[1]);
  assert.equal(schema.FROM_PATTERN.source, `^[a-z0-9][a-z0-9-]{0,${max - 1}}$`);
  assert.match(README, new RegExp(`Valid tags are 1 to ${max} lowercase letters, digits and dashes starting with a letter or digit`));
});

test("the README and PRIVACY.md name each signed event the sign-in join sends, the install id and the visitor id it carries", () => {
  const told = new Set([...`${LINK_RS}\n${MAIN_RS}`.matchAll(/\btell\(\s*&?\w+,\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1]));
  assert.deepEqual([...told].sort(), ["node_started", "owner_linked", "owner_unlinked"], "the node's signed events were read");
  assert.match(LINK_RS, /"install": install/, "the signed event carries the install id");
  assert.match(LINK_RS, /e\["vid"\] = json!\(vid\)/, "and the visitor id");
  for (const [name, doc] of [["README.md", README], ["PRIVACY.md", PRIVACY]]) {
    for (const ev of told) assert.ok(doc.includes(`\`${ev}\``), `${name} names ${ev}`);
    for (const said of ["`install_id`", "`ub_vid`", "~/.unbrowse/owner.json", "Global Privacy Control", "unbrowse.ai/privacy"]) {
      assert.ok(doc.includes(said), `${name} says ${said}`);
    }
  }
});
