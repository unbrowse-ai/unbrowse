#!/usr/bin/env node
// csrf-server.mjs — synthetic CSRF server for the AC6 live CSRF bench probe.
//
// Usage: node csrf-server.mjs [PORT]
// Endpoints:
//   GET  /csrf      → 200 { csrf_token } + Set-Cookie: csrf=<uuid>; Max-Age=5; Path=/
//                     Token rotates every 5 seconds (Max-Age=5).
//                     Server tracks the current valid token in memory.
//   POST /protected → header "X-CSRF-Token: <uuid>"
//                     match → 200 { ok, message, token_used }
//                     mismatch / missing / expired → 403 { error: "csrf_invalid", expected_hint }
//   GET  /health    → 200 { ok: true }
//
// On start: prints "listening on http://127.0.0.1:<PORT>" to stdout.
// On SIGTERM/SIGINT: clean shutdown.

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] ?? 0); // 0 = random free port
const TOKEN_TTL_MS = 5000;

let currentToken = null;
let currentTokenIssuedAt = 0;

function rotateToken() {
  currentToken = randomUUID();
  currentTokenIssuedAt = Date.now();
  return currentToken;
}

function isTokenLive() {
  if (!currentToken) return false;
  return Date.now() - currentTokenIssuedAt < TOKEN_TTL_MS;
}

function send(res, status, bodyObj, extraHeaders = {}) {
  const body = JSON.stringify(bodyObj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function logLine(method, url, status) {
  process.stdout.write(
    `${new Date().toISOString()} ${method} ${url} -> ${status}\n`,
  );
}

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method === "GET" && url === "/health") {
    send(res, 200, { ok: true });
    logLine(method, url, 200);
    return;
  }

  if (method === "GET" && url === "/csrf") {
    const token = rotateToken();
    send(
      res,
      200,
      { csrf_token: token, max_age_seconds: TOKEN_TTL_MS / 1000 },
      { "Set-Cookie": `csrf=${token}; Max-Age=${TOKEN_TTL_MS / 1000}; Path=/` },
    );
    logLine(method, url, 200);
    return;
  }

  if (method === "POST" && url === "/protected") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const headerToken = req.headers["x-csrf-token"];
      if (!isTokenLive()) {
        send(res, 403, {
          error: "csrf_invalid",
          reason: "no_live_token_on_server",
          expected_hint: "call GET /csrf first",
        });
        logLine(method, url, 403);
        return;
      }
      if (!headerToken) {
        send(res, 403, {
          error: "csrf_invalid",
          reason: "missing_x_csrf_token_header",
          expected_hint: "call GET /csrf first",
        });
        logLine(method, url, 403);
        return;
      }
      if (headerToken !== currentToken) {
        send(res, 403, {
          error: "csrf_invalid",
          reason: "token_mismatch_or_stale",
          expected_hint: "call GET /csrf first",
        });
        logLine(method, url, 403);
        return;
      }
      send(res, 200, {
        ok: true,
        message: "executed",
        token_used: headerToken,
      });
      logLine(method, url, 200);
    });
    return;
  }

  send(res, 404, { error: "not_found", method, url });
  logLine(method, url, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  process.stdout.write(`listening on http://127.0.0.1:${actualPort}\n`);
});

function shutdown(signal) {
  process.stdout.write(`received ${signal}, shutting down\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
