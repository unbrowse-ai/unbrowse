import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { trackForwarderPid, killTrackedForwarders } from "../src/env/kuri-proxy-bridge.js";

// Regression: the auth-forwarder is spawned detached+unref'd, so a one-shot
// `unbrowse run` CLI invocation used to leak it on exit (no broker shutdown to
// catch it). After a 10k-site index campaign, 8873 orphaned forwarders piled up
// to the per-user process ceiling → `fork: Resource temporarily unavailable`.
// The fix tracks spawned forwarder PIDs and reaps them when the spawning process
// exits. This test proves the reap mechanism actually kills a tracked child.
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("kuri-proxy forwarder reaping", () => {
  test("killTrackedForwarders SIGTERMs a tracked child process", async () => {
    // Stand-in for the forwarder: a real detached child that would otherwise
    // outlive us, exactly like the python forwarder (spawn shape mirrored).
    const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    child.unref();
    expect(child.pid).toBeGreaterThan(0);
    const pid = child.pid!;

    trackForwarderPid(pid);
    expect(isAlive(pid)).toBe(true);

    killTrackedForwarders();

    // Give the kernel a tick to deliver SIGTERM and reap.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(false);
  });

  test("killTrackedForwarders is idempotent and clears the registry", () => {
    // No tracked pids → must not throw.
    killTrackedForwarders();
    expect(() => killTrackedForwarders()).not.toThrow();
  });
});
