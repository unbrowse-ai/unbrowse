// Phase 0d gate (CLI surface): `unbrowse` CLI commands dispatch
// in-process with NO :6969 HTTP daemon. Real-runtime, no mocks: spawns
// `bun src/cli.ts health`, asserts it returns real health JSON AND
// nothing is ever listening on :6969 (proof the CLI did not spawn a
// daemon). Pre-Phase-0d this FAILED: the CLI called
// ensureLocalServer(BASE_URL,...) which auto-spawned the Fastify daemon
// on 6969, so the port-refused assertion was false.

import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (refused: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(refused);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 800);
  });
}

test(
  "unbrowse CLI serves `health` in-process with no :6969 daemon",
  async () => {
    // Precondition: nothing on 6969 (loud, not silently green).
    expect(await portRefused(6969)).toBe(true);

    const child = spawn(process.execPath, [CLI_ENTRY, "health"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, UNBROWSE_NON_INTERACTIVE: "1" },
    });

    let out = "";
    // Drain stderr so the child cannot deadlock on a full stderr pipe.
    child.stderr!.on("data", () => {});
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
    });

    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-2);
      }, 40_000);
    });

    expect(exitCode).toBe(0);

    // The CLI prints one JSON object on stdout (plus a non-JSON ToS line
    // on stderr, which we drained). Find the health JSON line.
    const jsonLine = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const health = JSON.parse(jsonLine!);
    expect(health.status).toBe("ok");
    expect(typeof health.package_version).toBe("string");

    // Core stateless assertion: the CLI spawned NO daemon. app.inject()
    // is in-memory; nothing binds 6969.
    expect(await portRefused(6969)).toBe(true);
  },
  60_000,
);
