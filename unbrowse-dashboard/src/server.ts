// Worker entry: /healthz and /api/* are plain handlers; everything else is the TanStack Start page.
import { createServerEntry, createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { handleApi } from "./lib/api.mjs";

const start = createStartHandler(defaultStreamHandler);

export default createServerEntry({
  async fetch(request, opts) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" || path.startsWith("/api/")) {
      return (await handleApi(request, env)) ?? new Response("not found", { status: 404 });
    }
    return start(request, opts);
  },
});
