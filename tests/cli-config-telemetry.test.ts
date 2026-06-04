import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("config set telemetry false disables sharing without starting the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-config-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");

  const proc = Bun.spawn({
    cmd: ["bun", "src/cli.ts", "config", "set", "telemetry", "false"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      UNBROWSE_CONFIG_PATH: configPath,
      UNBROWSE_CONFIG_DIR: dir,
      UNBROWSE_URL: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("localhost");
  expect(JSON.parse(stdout).telemetry).toBe(false);

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    contribution?: { share_pointers?: boolean };
    capture_pipeline?: { auto_publish_checkpoints?: boolean };
  };
  expect(config.contribution?.share_pointers).toBe(false);
  expect(config.capture_pipeline?.auto_publish_checkpoints).toBe(false);
});
