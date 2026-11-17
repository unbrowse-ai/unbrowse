// A stub `unbrowse-node` for the tests that start one, and what they ask of it. Not a test file: `--test-timeout` covers
// a whole file, so the start tests are split across files that share this.
import http from "node:http";
// The stub proves itself as the node does, with the client's own proof code (checked against the node's in client.test).
const PROOF = new URL("../dist/proof.js", import.meta.url).href;
// Its door signs as the node's does (signed-fixture.mjs).
const SIGNING = new URL("./signed-fixture.mjs", import.meta.url).href;

// The token is made of parts at runtime, as the node derives one; it is no real key.
export const TOKEN = ["stub", "agent", Date.now().toString(36)].join("-");

export const STUB = `#!/usr/bin/env node
const PROOF_URL = ${JSON.stringify(PROOF)};
const SIGNING_URL = ${JSON.stringify(SIGNING)};
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.UNBROWSE_HOME;
fs.mkdirSync(home, { recursive: true });
const log = (what) => fs.appendFileSync(path.join(home, "stub.log"), what + "\\n");
if (process.argv[2] === "agent" && process.argv[3] === "token") {
  // The first key exists once the node has been up a moment.
  if (!fs.existsSync(path.join(home, "key-made"))) { console.error("no live agent key yet"); process.exit(3); }
  console.log(process.env.STUB_TOKEN);
  process.exit(0);
}
log("started " + (process.env.UNBROWSE_BROWSER || ""));
const port = Number(process.env.UNBROWSE_PORT);
import(SIGNING_URL).then(({ signing }) => http.createServer(signing((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/v1/node/proof") {
    return import(PROOF_URL).then(({ nodeProof, tokenKey }) => {
      const challenge = Uint8Array.from((url.searchParams.get("challenge") || "").match(/../g) || [], (b) => parseInt(b, 16));
      const mine = url.searchParams.get("key") === tokenKey(process.env.STUB_TOKEN);
      res.end(JSON.stringify({ agents: mine ? [nodeProof(process.env.STUB_TOKEN, port, challenge)] : [] }));
    });
  }
  if (url.pathname === "/die") process.exit(1); // the node crashing
  if (req.headers.authorization !== "Bearer " + process.env.STUB_TOKEN) { res.statusCode = 401; return res.end(JSON.stringify({ error: "unknown, revoked or expired agent key" })); }
  if (url.pathname === "/v1/whoami") return res.end(JSON.stringify({ agent: "agent", address: "0xabc", node: "stub", browser: "missing", browser_fetch: true }));
  res.statusCode = 404; res.end(JSON.stringify({ error: "no such route" }));
}, () => [process.env.STUB_TOKEN])).listen(port, "127.0.0.1", () => setTimeout(() => fs.writeFileSync(path.join(home, "key-made"), "1"), 300)));
process.on("SIGTERM", () => { log("stopped"); process.exit(0); });
`;

export async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

export async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/node/proof?challenge=00`);
    return true;
  } catch {
    return false;
  }
}
