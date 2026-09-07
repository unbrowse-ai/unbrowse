/**
 * Live proof that obscura drives a real page — read AND actuate — with no Chrome.
 * Run by native/obscura-capture/live-page-gate.sh (which asserts no Chrome spawns).
 *   1. READER: obscura CLI markdown of a real page carries the page's content.
 *   2. DRIVER: obscura MCP session navigate -> fill -> read the value back.
 */
import { obscuraMarkdown } from "../../src/obscura/readers.js";
import { ObscuraMcpSession } from "../../src/obscura/mcp-session.js";

const FAIL = (m: string): never => {
  console.error("LIVE-PAGE FAIL:", m);
  process.exit(1);
};

// 1. Reader (stateless, obscura CLI --dump markdown)
const md = await obscuraMarkdown("https://quotes.toscrape.com/", { timeoutMs: 60000 });
if (!/Einstein|Quotes to Scrape|change the world/i.test(md)) {
  FAIL(`markdown missing page content (${md.length} chars)`);
}
console.log(`READER PASS: obscura markdown -> ${md.length} chars with page content`);

// 2. Driver (stateful, obscura MCP session): navigate + fill + read back
const s = new ObscuraMcpSession({ callTimeoutMs: 30000 });
try {
  await s.navigate("https://quotes.toscrape.com/login");
  await s.fill("input[name=username]", "alice");
  const val = await s.evaluate("document.querySelector('input[name=username]').value");
  if (!/alice/.test(val)) FAIL(`fill did not stick; readback=${JSON.stringify(val)}`);
  console.log(`DRIVER PASS: obscura MCP navigate+fill+readback -> ${val.trim()}`);
} finally {
  s.dispose();
}
console.log("LIVE-PAGE PASS: obscura reads and actuates a live page, no Chrome");
