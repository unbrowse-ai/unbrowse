/**
 * Live proof of the obscura SESSION BROKER: a page session persists across
 * INDEPENDENT attaches (= across separate CLI invocations), with no Chrome.
 * Run by native/obscura-capture/broker-gate.sh (asserts no Chrome spawns).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startObscuraSession,
  attachObscuraSession,
  stopObscuraSession,
  readObscuraSession,
} from "../../src/obscura/session-broker.js";

const FAIL = (m: string): never => {
  console.error("BROKER FAIL:", m);
  process.exit(1);
};

const env = { ...process.env, UNBROWSE_OBSCURA_SESSIONS_DIR: mkdtempSync(join(tmpdir(), "obs-broker-")) };

const rec = await startObscuraSession({ env, readyTimeoutMs: 20000 });
console.log(`BROKER UP: session ${rec.sessionId} on :${rec.port} pid ${rec.pid}`);

try {
  // Attach #1 (simulating `breath go`): navigate + fill.
  const a = attachObscuraSession(rec.sessionId, { env });
  await a.navigate("https://quotes.toscrape.com/login");
  await a.fill("input[name=username]", "broker-xyz");
  console.log("ATTACH#1: navigated + filled");

  // Attach #2 — a FRESH client (simulating a later `eval text` CLI call): read back.
  const b = attachObscuraSession(rec.sessionId, { env });
  const val = await b.evaluate("document.querySelector('input[name=username]').value");
  if (!/broker-xyz/.test(val)) FAIL(`session did not persist across attaches; readback=${JSON.stringify(val)}`);
  console.log(`ATTACH#2 (fresh client) read back: ${val.trim()} — session persisted across CLI calls`);
} finally {
  stopObscuraSession(rec.sessionId, env);
}

if (readObscuraSession(rec.sessionId, env) !== null) FAIL("stop did not remove the session record");
console.log("BROKER PASS: obscura page session persists across independent CLI calls, cleaned up, no Chrome");
