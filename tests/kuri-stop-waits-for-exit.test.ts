import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { waitForProcessExit } from "../src/kuri/client.ts";

describe("kuri stopOn — waitForProcessExit (the fix for zombie kuri leak)", () => {
  test("resolves true within deadline when child exits on SIGTERM", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    expect(child.pid).toBeGreaterThan(0);
    const t0 = Date.now();
    child.kill("SIGTERM");
    const exited = await waitForProcessExit(child, 3000);
    const elapsed = Date.now() - t0;
    expect(exited).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  test("resolves false on deadline when child traps SIGTERM, then SIGKILL works", async () => {
    const script = "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True: time.sleep(1)";
    const child = spawn("python3", ["-c", script], { stdio: "ignore" });
    expect(child.pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));

    child.kill("SIGTERM");
    const exitedOnTerm = await waitForProcessExit(child, 500);
    expect(exitedOnTerm).toBe(false);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);

    child.kill("SIGKILL");
    const exitedOnKill = await waitForProcessExit(child, 2000);
    expect(exitedOnKill).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  test("resolves true immediately when child is already dead", async () => {
    const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const t0 = Date.now();
    const exited = await waitForProcessExit(child, 1000);
    expect(exited).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
