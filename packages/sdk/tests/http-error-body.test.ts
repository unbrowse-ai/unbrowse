import { expect, test } from "bun:test";
import { Unbrowse, UnbrowseError, UnbrowseMcp } from "../src/index.ts";

for (const transport of ["REST", "MCP"] as const) {
  for (const [status, statusText] of [[401, "Unauthorized"], [503, "Service Unavailable"]] as const) {
    for (const body of [null, { error: { code: "fixture_error", message: "Synthetic server error" } }]) {
      test(`${transport} preserves HTTP ${status} with a ${body === null ? "null" : "structured"} JSON error body`, async () => {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            return new Response(JSON.stringify(body), {
              status,
              statusText,
              headers: { "content-type": "application/json" },
            });
          },
        });
        try {
          const origin = `http://127.0.0.1:${server.port}`;
          const request = transport === "REST"
            ? new Unbrowse({ baseUrl: origin, apiKey: "" }).usage()
            : new UnbrowseMcp({ url: `${origin}/mcp`, apiKey: "", endUser: "" }).listTools();
          const error = await request.catch((error: unknown) => error);
          expect(error).toBeInstanceOf(UnbrowseError);
          expect(error).toMatchObject({
            status,
            code: body?.error.code ?? "http_error",
            message: body?.error.message ?? statusText,
            body,
          });
        } finally {
          server.stop(true);
        }
      });
    }
  }
}
