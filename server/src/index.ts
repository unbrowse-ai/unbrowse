/**
 * Unbrowse Skill Index Server
 *
 * Cloud marketplace for API skills discovered by unbrowse agents.
 * Skills are published for free, downloaded via x402 Solana USDC payments.
 * Creators earn per download — wallet address embedded in each skill.
 *
 * Routes:
 *   GET  /skills/search           — Free full-text search
 *   GET  /skills/:id/summary      — Free skill summary with endpoints
 *   GET  /skills/:id/download     — x402 paywalled full skill package
 *   POST /skills/publish          — Publish a skill (free)
 *   GET  /health                  — Health check
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, getDb } from "./db.js";
import { searchSkills, getLeaderboard } from "./routes/search.js";
import { getSkillSummary } from "./routes/summary.js";
import { downloadSkill } from "./routes/download.js";
import { publishSkill } from "./routes/publish.js";
import { handleDownloadPaymentGate, isX402Enabled, getDownloadPriceUsd } from "./x402.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "4402");

// Initialize database
initDb();
console.log(`[unbrowse-index] Database initialized`);

// Log x402 status
if (isX402Enabled()) {
  console.log(`[unbrowse-index] x402 enabled — $${getDownloadPriceUsd()} USDC per download (Solana)`);
} else {
  console.log("[unbrowse-index] No FDRY_TREASURY_WALLET set — downloads are free (dev mode)");
}

// ── Router ──────────────────────────────────────────────────────────────────

const WEB_DIST = join(__dirname, "..", "web", "dist");

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Payment",
      "Access-Control-Expose-Headers": "X-Payment-Response",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      let response: Response;

      // Health check
      if (path === "/health" && method === "GET") {
        response = Response.json({
          ok: true,
          service: "unbrowse-skill-index",
          x402: isX402Enabled(),
        });
      }
      // Search
      else if (path === "/skills/search" && method === "GET") {
        response = searchSkills(req);
      }
      // Leaderboard — top abilities by unique payers
      else if (path === "/abilities/leaderboard" && method === "GET") {
        response = getLeaderboard(req);
      }
      // Summary (free)
      else if (path.match(/^\/skills\/([^/]+)\/summary$/) && method === "GET") {
        const id = path.match(/^\/skills\/([^/]+)\/summary$/)![1];
        response = getSkillSummary(id);
      }
      // Download (x402 paywalled)
      else if (path.match(/^\/skills\/([^/]+)\/download$/) && method === "GET") {
        const id = path.match(/^\/skills\/([^/]+)\/download$/)![1];

        // Look up creator wallet for payment split
        const db = getDb();
        const row = db.query("SELECT creator_wallet FROM skills WHERE id = ?").get(id) as any;
        const creatorWallet: string | null = row?.creator_wallet ?? null;

        // x402 payment gate
        const gateResult = await handleDownloadPaymentGate(req, id, creatorWallet);
        if (gateResult.response) {
          return addCors(gateResult.response, corsHeaders);
        }

        // Payment verified — proceed with download
        response = downloadSkill(id, {
          signature: gateResult.signature,
          amount: gateResult.amount,
          splits: gateResult.splits,
        });
      }
      // Publish
      else if (path === "/skills/publish" && method === "POST") {
        response = await publishSkill(req);
      }
      // Serve web frontend static files
      else {
        const filePath = path === "/" ? "/index.html" : path;
        const file = Bun.file(join(WEB_DIST, filePath));
        if (await file.exists()) {
          return new Response(file);
        }
        // SPA fallback — serve index.html for client-side routing
        const indexFile = Bun.file(join(WEB_DIST, "index.html"));
        if (await indexFile.exists()) {
          return new Response(indexFile);
        }
        response = Response.json({ error: "Not found" }, { status: 404 });
      }

      return addCors(response, corsHeaders);
    } catch (err) {
      console.error(`[unbrowse-index] Error: ${err}`);
      return addCors(
        Response.json({ error: "Internal server error" }, { status: 500 }),
        corsHeaders,
      );
    }
  },
});

function addCors(resp: Response, headers: Record<string, string>): Response {
  const newHeaders = new Headers(resp.headers);
  for (const [k, v] of Object.entries(headers)) {
    newHeaders.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: newHeaders,
  });
}

console.log(`[unbrowse-index] Listening on http://localhost:${server.port}`);
