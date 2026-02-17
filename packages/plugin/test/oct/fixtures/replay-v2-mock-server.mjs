#!/usr/bin/env node
/**
 * Local stateful API for replay-v2 OCT suite.
 *
 * Endpoints:
 * - GET  /start  -> { csrfToken }
 * - POST /submit -> requires x-csrf-token, returns { sessionId }
 * - GET  /data   -> requires ?sessionId=, returns { ok:true, sessionId }
 * - GET  /metrics -> { start, submit, data }
 */

import http from "node:http";
import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port-file") out.portFile = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.portFile) {
  // eslint-disable-next-line no-console
  console.error("usage: replay-v2-mock-server.mjs --port-file /path/to/port.txt");
  process.exit(2);
}

const state = {
  csrf: `csrf_${Math.random().toString(16).slice(2)}`,
  session: `sess_${Math.random().toString(16).slice(2)}`,
  hits: { start: 0, submit: 0, data: 0 },
};

function readJson(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); } catch { resolve(null); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (url.pathname === "/metrics" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state.hits));
    return;
  }

  if (url.pathname === "/start" && req.method === "GET") {
    state.hits.start++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ csrfToken: state.csrf }));
    return;
  }

  if (url.pathname === "/submit" && req.method === "POST") {
    state.hits.submit++;
    const csrf = String(req.headers["x-csrf-token"] ?? "");
    if (csrf !== state.csrf) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("bad csrf");
      return;
    }
    await readJson(req); // drain body; not used, but keeps it realistic
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessionId: state.session }));
    return;
  }

  if (url.pathname === "/data" && req.method === "GET") {
    state.hits.data++;
    const sid = url.searchParams.get("sessionId") ?? "";
    if (sid !== state.session) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("bad session");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionId: sid }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  writeFileSync(args.portFile, String(port), "utf-8");
  // eslint-disable-next-line no-console
  console.log(`listening ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

