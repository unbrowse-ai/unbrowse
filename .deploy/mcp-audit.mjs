#!/usr/bin/env node
// Contract audit of a deployed MCP server over streamable HTTP: does it answer, is its tool list sound and of a size a
// client can hold, do the named calls work, and does it refuse a stranger? Run after every deploy, before promotion.
//
//   MCP_URL=https://…/mcp  node mcp-audit.mjs [--call 'whoami={}'] [--call 'recall={"question":"…"}'] [--expect-auth]
//                                              [--max-list-bytes 2000000] [--max-tool-bytes 25000] [--max-call-ms 20000]
//                                              [--min-tools 1] [--require-tool name]…
//                                              [--require-tools-file names.txt] [--wait-s 600]
//
// --require-tools-file: one tool name a line (what the build about to be judged contains). --wait-s: when a required
// tool is missing, list again every 15 s for that long before judging. A Durable Object keeps running the old code
// for minutes after a deploy (five, once: production's gate passed on the version before, 2026-11-13), so a gate
// that runs straight after a deploy must wait for the new version to serve, and fail if it never does.
//
// Headers: MCP_HEADERS='{"authorization":"Bearer …"}' (static), or MCP_HEADER_CMD='bun scripts/sign.ts' — a command that
// prints a JSON object of headers, run before every request (for single-use signed assertions). Secrets stay in env.
// Ends with a success-only marker:  MCP_AUDIT_OK tools=… list_bytes=… calls=…   Any failed check: MCP_AUDIT_FAIL, exit 1.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const all = (name) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
const arg = (name, dflt) => all(name)[0] ?? dflt;
const url = process.env.MCP_URL ?? arg("url");
if (!url) { console.error("usage: MCP_URL=https://…/mcp node mcp-audit.mjs [--call 'tool={json}']…"); process.exit(2); }
const maxList = Number(arg("max-list-bytes", "2000000")), maxTool = Number(arg("max-tool-bytes", "25000")), maxCallMs = Number(arg("max-call-ms", "20000"));
const minTools = Number(arg("min-tools", "1"));

const headers = () => {
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (process.env.MCP_HEADER_CMD) return { ...base, ...JSON.parse(execSync(process.env.MCP_HEADER_CMD, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })) };
  return { ...base, ...JSON.parse(process.env.MCP_HEADERS || "{}") };
};
let id = 0;
/** One JSON-RPC request; the answer may come as JSON or as an event stream. */
async function rpc(method, params, { auth = true } = {}) {
  const t0 = Date.now();
  const res = await fetch(url, { method: "POST", headers: auth ? headers() : { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(Math.max(maxCallMs, 30_000) + 5000) });
  const raw = await res.text();
  const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? raw;
  let json = null;
  try { json = JSON.parse(data); } catch { /* not JSON: reported by the caller */ }
  return { status: res.status, bytes: raw.length, ms: Date.now() - t0, json, raw };
}

const fails = [];
const check = (ok, text) => { console.log(`${ok ? "ok  " : "FAIL"} ${text}`); if (!ok) fails.push(text); };

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-audit", version: "1" } });
  check(init.status === 200 && !!init.json?.result?.serverInfo?.name, `initialize: HTTP ${init.status}, server ${init.json?.result?.serverInfo?.name ?? "?"} ${init.json?.result?.serverInfo?.version ?? ""} in ${init.ms} ms`);

  const fromFile = arg("require-tools-file"), built = fromFile && existsSync(fromFile) ? readFileSync(fromFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  if (fromFile && !built.length) check(false, `--require-tools-file ${fromFile} names no tool: nothing to hold the server to`);
  const required = [...new Set([...all("require-tool"), ...built])], waitS = Number(arg("wait-s", "0")), began = Date.now();
  let list = await rpc("tools/list", {});
  const missingIn = (l) => { const have = new Set((l.json?.result?.tools ?? []).map((t) => t.name)); return required.filter((n) => !have.has(n)); };
  // The version before may still be serving: ask again until everything the build has is listed, or the wait is over.
  while (required.length && missingIn(list).length && Date.now() - began < waitS * 1000) {
    await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(250, (waitS * 1000) / 8))));
    list = await rpc("tools/list", {});
  }
  const waited = Math.round((Date.now() - began) / 1000);
  const tools = list.json?.result?.tools ?? [];
  check(list.status === 200 && Array.isArray(list.json?.result?.tools), `tools/list: HTTP ${list.status}, ${tools.length} tools in ${list.ms} ms`);
  check(tools.length >= minTools, `at least ${minTools} tools listed (${tools.length})`);
  check(list.bytes <= maxList, `the listing is ${list.bytes} bytes (limit ${maxList}: a client holds it whole, and so does the server per caller)`);
  const sized = tools.map((t) => [JSON.stringify(t).length, t.name]).sort((a, b) => b[0] - a[0]);
  check(!sized.length || sized[0][0] <= maxTool, `the largest tool is ${sized[0]?.[1]} at ${sized[0]?.[0]} bytes (limit ${maxTool})`);
  const names = tools.map((t) => t.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  check(dup.length === 0, `tool names are unique${dup.length ? `: ${[...new Set(dup)].slice(0, 5).join(", ")}` : ""}`);
  const badName = names.filter((n) => !/^[A-Za-z0-9_.-]{1,64}$/.test(String(n)));
  check(badName.length === 0, `every name fits a client's rules (letters, digits, _ . -, at most 64)${badName.length ? `: ${badName.slice(0, 5).join(", ")}` : ""}`);
  const noDesc = tools.filter((t) => String(t.description ?? "").trim().length < 10).map((t) => t.name);
  check(noDesc.length === 0, `every tool says what it does${noDesc.length ? `: ${noDesc.slice(0, 5).join(", ")} do not` : ""}`);
  const badSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object").map((t) => t.name);
  check(badSchema.length === 0, `every tool's input is an object schema${badSchema.length ? `: ${badSchema.slice(0, 5).join(", ")}` : ""}`);
  for (const need of all("require-tool")) check(names.includes(need), `lists ${need}`);
  if (built.length) {
    const gone = built.filter((n) => !names.includes(n));
    check(gone.length === 0, gone.length ? `${gone.length} of the build's ${built.length} tools are not served${waitS ? ` after waiting ${waited} s` : ""}: ${gone.slice(0, 6).join(", ")}${gone.length > 6 ? "…" : ""} (the version before is still answering: a Durable Object can take minutes to restart onto a deploy)`
      : `serves every tool the build has (${built.length})${waited >= 15 ? `, after waiting ${waited} s for the new version` : ""}`);
  }

  let calls = 0;
  for (const spec of all("call")) {
    const eq = spec.indexOf("="), name = eq < 0 ? spec : spec.slice(0, eq), args = eq < 0 ? {} : JSON.parse(spec.slice(eq + 1) || "{}");
    const r = await rpc("tools/call", { name, arguments: args });
    const text = (r.json?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    const ok = r.status === 200 && !!r.json?.result && r.json.result.isError !== true && !r.json.error && r.ms <= maxCallMs;
    check(ok, `${name} answered in ${r.ms} ms (limit ${maxCallMs})${ok ? "" : `: HTTP ${r.status} ${JSON.stringify(r.json?.error ?? text).slice(0, 200)}`}`);
    calls++;
  }
  // A name no tool has: a JSON-RPC answer saying so, never a crash.
  const none = await rpc("tools/call", { name: "no_such_tool_audit", arguments: {} });
  check(none.status < 500 && (!!none.json?.error || none.json?.result?.isError === true), `an unknown tool is refused cleanly (HTTP ${none.status})`);
  if (process.argv.includes("--expect-auth")) {
    const anon = await rpc("tools/list", {}, { auth: false });
    check(anon.status === 401 || anon.status === 403, `a request with no credentials is refused (HTTP ${anon.status})`);
  }

  if (fails.length) { console.log(`MCP_AUDIT_FAIL reasons=${fails.length}`); process.exit(1); }
  console.log(`MCP_AUDIT_OK tools=${tools.length} list_bytes=${list.bytes} calls=${calls}`);
} catch (e) {
  console.log(`FAIL the audit could not finish: ${String(e?.message ?? e).slice(0, 300)}`);
  console.log("MCP_AUDIT_FAIL reasons=1");
  process.exit(1);
}
