#!/usr/bin/env node
// Parse axe JSON output and print a human + machine-readable summary.
// Usage: node scripts/a11y-report.mjs <input.json>
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: a11y-report.mjs <input.json>");
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const v = data.violations || [];
const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
let totalNodes = 0;
for (const x of v) {
  counts[x.impact] = (counts[x.impact] || 0) + 1;
  totalNodes += x.nodes.length;
}
console.log(`# A11y report for ${data.url || file}`);
console.log(`Total violation rules: ${v.length}`);
console.log(`Total violating nodes: ${totalNodes}`);
console.log(`By impact: ${JSON.stringify(counts)}`);
console.log("");
console.log("## Critical + Serious");
for (const x of v) {
  if (x.impact !== "critical" && x.impact !== "serious") continue;
  console.log(`- ${x.id} (${x.impact}) — ${x.nodes.length} node(s)`);
  console.log(`  help: ${x.help}`);
  console.log(`  url:  ${x.helpUrl}`);
  if (x.nodes[0]) {
    console.log(
      `  example target: ${JSON.stringify(x.nodes[0].target)}`
    );
    if (x.nodes[0].failureSummary) {
      console.log(
        `  reason: ${x.nodes[0].failureSummary.replace(/\n+/g, " | ")}`
      );
    }
  }
}
console.log("");
console.log("## Moderate + Minor");
for (const x of v) {
  if (x.impact === "critical" || x.impact === "serious") continue;
  console.log(`- ${x.id} (${x.impact}) — ${x.nodes.length} node(s)`);
}
if (data.incomplete && data.incomplete.length) {
  console.log("");
  console.log(`## Incomplete (review): ${data.incomplete.length}`);
  for (const x of data.incomplete.slice(0, 5)) {
    console.log(`- ${x.id} (${x.impact}) — ${x.nodes.length} node(s) — ${x.help}`);
  }
}
