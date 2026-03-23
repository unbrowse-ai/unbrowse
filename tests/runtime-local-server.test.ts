import { afterEach, describe, expect, it } from "bun:test";
import http from "node:http";
import { ensureLocalServer } from "../src/runtime/local-server.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("ensureLocalServer", () => {
  it("fails clearly when another process already owns the port", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end("nope");
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(ensureLocalServer(baseUrl, false, import.meta.url)).rejects.toThrow(
      `Port 127.0.0.1:${address.port} already in use`,
    );
  });
});
