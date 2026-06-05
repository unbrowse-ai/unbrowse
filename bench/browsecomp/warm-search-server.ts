// warm-search-server.ts — a warm front server for the browsecomp eval. Builds the
// unbrowse in-process app ONCE (no per-call cold-boot) and exposes:
//   POST /v1/intent/resolve  → proxied to the warm app via in-process inject()
//   POST /fetch              → deep page content via curl-impersonate (warm)
// so a strong agent can run the full eval (resolve + DEEP enrichment) without the
// cold-boot binary wedging — the maxed-out retrieval path.
import Fastify from "fastify";
import { getInProcessApp } from "../../src/runtime/in-process-app.js";
import { tryCurlImpersonateFetch } from "../../src/capture/curl-impersonate-fallback.js";
import { htmlToMarkdown } from "../../src/cli-v7/eval/markdown.js";

const inproc = await getInProcessApp(); // warm, built once (its own routes are locked)
const server = Fastify({ bodyLimit: 8 * 1024 * 1024 });

server.post("/v1/intent/resolve", async (req, reply) => {
  const r = await inproc.inject({
    method: "POST", url: "/v1/intent/resolve",
    payload: req.body as object, headers: { "content-type": "application/json" },
  });
  reply.code(r.statusCode).header("content-type", "application/json").send(r.body);
});

server.post("/fetch", async (req, reply) => {
  const url = (req.body as { url?: string } | null)?.url;
  if (!url) return reply.code(400).send({ error: "url required" });
  try {
    const r = await tryCurlImpersonateFetch({ url });
    const raw = r?.html ?? "";
    // Return clean MARKDOWN (turndown), not raw HTML — same as the CLI `fetch`. Raw
    // HTML drowns the agent's context with tags/scripts and tanks accuracy to ~0.
    const md = raw ? await htmlToMarkdown(raw).catch(() => raw) : "";
    return { html: md, status: r?.status ?? 0, final_url: r?.final_url ?? url };
  } catch (e) {
    return { html: "", status: 0, error: String(e) };
  }
});

const port = Number(process.env.WARM_PORT || 6969);
await server.listen({ port, host: "127.0.0.1" });
console.log(`[warm-search] warm front on http://127.0.0.1:${port} (resolve via inject + deep /fetch)`);
