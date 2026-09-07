/**
 * A real, listening Unbrowse runtime for the SDK gate.
 *
 * `@unbrowse/sdk` is an HTTP client: it spawns or adopts a local runtime and
 * talks to it over a loopback socket (packages/sdk/src/runtime.ts). To gate the
 * SDK's ability to replay a learned route we need that runtime to actually be
 * listening, under an isolated HOME.
 *
 * This binds the SAME route surface the product binds — `registerRoutes` from
 * src/api/routes.ts, which is what both src/server.ts:147 and
 * src/runtime/in-process-app.ts:56 call. It deliberately does NOT go through
 * `startUnbrowseServer`, which additionally writes a pidfile, installs an idle
 * reaper, and runs `pkill -f chrome-headless-shell` — process management that
 * would reach outside the test.
 *
 * Prints `READY <port>` on stdout once bound. Spawned by
 * tests/replay-surface-sdk.test.ts; never imported by a test.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "../src/api/routes.js";

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await registerRoutes(app);
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
console.log(`READY ${port}`);
