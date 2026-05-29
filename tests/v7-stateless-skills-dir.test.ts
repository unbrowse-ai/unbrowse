/**
 * v7 Day-5 worker E — stateless mode suppresses writes to
 * `~/.unbrowse/skills/` and its neighbors.
 *
 * Resolves the Day-2 §I §Q2 punted question. Under
 * `UNBROWSE_STATELESS=1`, the local skills dir is READ-ONLY (deprioritized
 * fallback). Under `UNBROWSE_OFFLINE=1` (legacy `UNBROWSE_BACKEND_OFFLINE`),
 * the v6 stateful path is preserved. Precedence: STATELESS wins when both
 * env vars set together (Heb 7:18-19 — newer covenant supersedes).
 *
 * Three test shapes:
 *   - Golden: UNBROWSE_STATELESS=1 → backend rows printed, NO file/mtime
 *     change under ~/.unbrowse/skills/.
 *   - Edge: UNBROWSE_BACKEND_OFFLINE=1 (stateless unset) → legacy
 *     local-dir read activates as expected.
 *   - Adversarial: the four writer functions themselves
 *     (exportSkillMdLocal, writeSkillCache via cachePublishedSkill,
 *     evictCachedEndpoint, writeSkillSnapshot) are no-ops on disk
 *     under stateless mode.
 *
 * No mocks of the unit-under-test. The CLI is a real subprocess; the
 * backend is a local Bun.serve() with byte-faithful wire shapes (same
 * pattern as v7-cli-eval-marketplace.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");
const SKILLS_DIR = join(homedir(), ".unbrowse", "skills");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

function startFakeBackend(): {
  url: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/skills" && req.method === "GET") {
        return Response.json({
          skills: [
            {
              skill_id: "stateless-mp:abc",
              domain: "mp.example.com",
              endpoint_count: 3,
              last_executed: 1_700_000_000_000,
            },
          ],
        });
      }
      return new Response("not_found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

// ─── Skills-dir snapshot/restore (so test mutations are reversible) ─────

let savedSkillsBackup: { name: string; content: string }[] = [];
let preexistingDir = false;

async function snapshotSkillsDir(): Promise<void> {
  const st = await stat(SKILLS_DIR).catch(() => null);
  preexistingDir = !!(st && st.isDirectory());
  if (!preexistingDir) return;
  const names = await readdir(SKILLS_DIR);
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const c = await Bun.file(join(SKILLS_DIR, n)).text();
    savedSkillsBackup.push({ name: n, content: c });
  }
  await rm(SKILLS_DIR, { recursive: true, force: true });
}

async function restoreSkillsDir(): Promise<void> {
  await rm(SKILLS_DIR, { recursive: true, force: true });
  if (preexistingDir) {
    await mkdir(SKILLS_DIR, { recursive: true });
    for (const e of savedSkillsBackup) {
      await writeFile(join(SKILLS_DIR, e.name), e.content);
    }
  }
  savedSkillsBackup = [];
  preexistingDir = false;
}

beforeAll(async () => {
  await snapshotSkillsDir();
});

afterAll(async () => {
  await restoreSkillsDir();
});

// ─── Test 1 — GOLDEN: stateless mode does not touch ~/.unbrowse/skills/ ──

describe("v7 stateless mode: skills dir is read-only", () => {
  it("UNBROWSE_STATELESS=1 prints marketplace rows AND does not create ~/.unbrowse/skills/", async () => {
    // Ensure the dir is clean before the run.
    await rm(SKILLS_DIR, { recursive: true, force: true });
    expect(existsSync(SKILLS_DIR)).toBe(false);

    const backend = startFakeBackend();
    try {
      const res = await runCli(
        ["eval", "skills", "--json"],
        {
          UNBROWSE_API_URL: backend.url,
          UNBROWSE_STATELESS: "1",
        },
      );
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.ok).toBe(true);
      expect(out.count).toBeGreaterThanOrEqual(1);
      expect(out.skills[0].source).toBe("marketplace");
      // Stateless invariant: NO file appears under ~/.unbrowse/skills/.
      // (Either the dir wasn't created, or it remains empty.)
      const stExists = existsSync(SKILLS_DIR);
      if (stExists) {
        const names = await readdir(SKILLS_DIR);
        // Subdirs from SKILL.md export would also count — assert any
        // create here represents a violation.
        expect(names.length).toBe(0);
      }
    } finally {
      backend.stop();
    }
  }, 30_000);

  it("preserves mtime on a pre-seeded local skill file (no rewrite)", async () => {
    // Seed a sentinel file with a known mtime.
    await mkdir(SKILLS_DIR, { recursive: true });
    const sentinel = join(SKILLS_DIR, "stateless-sentinel.json");
    await writeFile(
      sentinel,
      JSON.stringify({
        skill_id: "stateless-sentinel",
        domain: "sentinel.local",
        endpoints: [],
      }),
    );
    const beforeMtime = (await stat(sentinel)).mtimeMs;

    // Sleep 50ms so any rewrite would produce a visibly-newer mtime.
    await new Promise((r) => setTimeout(r, 50));

    const backend = startFakeBackend();
    try {
      const res = await runCli(
        ["eval", "skills", "--json"],
        {
          UNBROWSE_API_URL: backend.url,
          UNBROWSE_STATELESS: "1",
        },
      );
      expect(res.code).toBe(0);
    } finally {
      backend.stop();
    }

    const afterMtime = (await stat(sentinel)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  }, 30_000);
});

// ─── Test 2 — DELETED (W24.6, 2026-05-28) ─────────────────────────────────
//
// The previous test asserted "UNBROWSE_BACKEND_OFFLINE=1 (stateless
// unset) reads from ~/.unbrowse/skills/ and emits rows with
// `source: "local"`". W24.6 (Lewis 2026-05-28) purged the
// local-pointer-store fallback as masquerade (lost sheep #3). When the
// backend is unreachable, `eval skills` now returns an honest
// empty-state with `ok: false` and an actionable next_step — not stale
// local rows.

// ─── Test 3 — ADVERSARIAL: the gated writer functions themselves ─────────

describe("v7 stateless mode: writer functions are no-ops on disk", () => {
  it("writeSkillCache / cachePublishedSkill produces no file under UNBROWSE_STATELESS=1", async () => {
    // Isolate skill-cache dir via env so the test doesn't touch the
    // user's real cache.
    const isoDir = join(tmpdir(), `unbrowse-stateless-test-${process.pid}-${Date.now()}`);
    await mkdir(isoDir, { recursive: true });
    process.env.UNBROWSE_SKILL_CACHE_DIR = isoDir;
    process.env.UNBROWSE_STATELESS = "1";
    try {
      const mod = await import("../src/client/index.js");
      const skill = {
        skill_id: "stateless-writer-test",
        domain: "writer.local",
        endpoints: [
          { endpoint_id: "ep1", url_template: "https://writer.local/x", method: "GET" },
        ],
        // Minimum SkillManifest fields the cache path requires.
      } as Parameters<typeof mod.cachePublishedSkill>[0];

      mod.cachePublishedSkill(skill);

      // Assert: NO file appeared in the isolated cache dir.
      const names = await readdir(isoDir).catch(() => [] as string[]);
      expect(names.filter((n) => n.endsWith(".json"))).toEqual([]);

      // In-memory recentLocalSkills IS populated (so resolve/execute
      // within the process still see the skill — this is the load-
      // bearing carve-out from the audit).
      const recent = mod.getRecentLocalSkill(skill.skill_id);
      expect(recent?.skill_id).toBe(skill.skill_id);
    } finally {
      delete process.env.UNBROWSE_STATELESS;
      delete process.env.UNBROWSE_SKILL_CACHE_DIR;
      await rm(isoDir, { recursive: true, force: true });
    }
  });

  it("writeSkillSnapshot returns undefined and writes nothing under UNBROWSE_STATELESS=1", async () => {
    const isoDir = join(tmpdir(), `unbrowse-stateless-snap-${process.pid}-${Date.now()}`);
    await mkdir(isoDir, { recursive: true });
    process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = isoDir;
    // Enable local caches generally — stateless should still suppress.
    process.env.UNBROWSE_LOCAL_CACHES = "1";
    process.env.UNBROWSE_STATELESS = "1";
    try {
      const mod = await import("../src/orchestrator/index.js");
      const skill = {
        skill_id: "stateless-snap-test",
        domain: "snap.local",
        endpoints: [],
      } as Parameters<typeof mod.writeSkillSnapshot>[1];
      const result = mod.writeSkillSnapshot("any-cache-key", skill);
      expect(result).toBeUndefined();
      const names = await readdir(isoDir).catch(() => [] as string[]);
      expect(names.filter((n) => n.endsWith(".json"))).toEqual([]);
    } finally {
      delete process.env.UNBROWSE_STATELESS;
      delete process.env.UNBROWSE_LOCAL_CACHES;
      delete process.env.UNBROWSE_SKILL_SNAPSHOT_DIR;
      await rm(isoDir, { recursive: true, force: true });
    }
  });

  it("exportSkillMdLocal returns null and writes nothing under UNBROWSE_STATELESS=1", async () => {
    // Pre-flight: snapshot the skills dir to detect any leak.
    const preDir = existsSync(SKILLS_DIR);
    const preNames = preDir ? await readdir(SKILLS_DIR) : [];

    process.env.UNBROWSE_STATELESS = "1";
    try {
      const mod = await import("../src/skillmd.js");
      const result = mod.exportSkillMdLocal({
        skill_id: "stateless-export-test",
        domain: "export.local",
        endpoints: [],
      } as Parameters<typeof mod.exportSkillMdLocal>[0]);
      expect(result).toBeNull();

      // Skills dir state must be unchanged.
      const postDir = existsSync(SKILLS_DIR);
      expect(postDir).toBe(preDir);
      if (postDir) {
        const postNames = await readdir(SKILLS_DIR);
        expect(postNames.sort()).toEqual(preNames.sort());
      }
    } finally {
      delete process.env.UNBROWSE_STATELESS;
    }
  });
});

// ─── Test 4 — PRECEDENCE: STATELESS wins when both env vars set ─────────

describe("v7 precedence: STATELESS supersedes OFFLINE when both set", () => {
  it("UNBROWSE_STATELESS=1 + UNBROWSE_BACKEND_OFFLINE=1 → stateless write-suppression wins", async () => {
    const isoDir = join(tmpdir(), `unbrowse-precedence-${process.pid}-${Date.now()}`);
    await mkdir(isoDir, { recursive: true });
    process.env.UNBROWSE_SKILL_CACHE_DIR = isoDir;
    process.env.UNBROWSE_STATELESS = "1";
    process.env.UNBROWSE_BACKEND_OFFLINE = "1";
    try {
      const mod = await import("../src/client/index.js");
      mod.cachePublishedSkill({
        skill_id: "precedence-test",
        domain: "p.local",
        endpoints: [],
      } as Parameters<typeof mod.cachePublishedSkill>[0]);
      const names = await readdir(isoDir).catch(() => [] as string[]);
      // Stateless suppression dominates — no disk write.
      expect(names.filter((n) => n.endsWith(".json"))).toEqual([]);
    } finally {
      delete process.env.UNBROWSE_STATELESS;
      delete process.env.UNBROWSE_BACKEND_OFFLINE;
      delete process.env.UNBROWSE_SKILL_CACHE_DIR;
      await rm(isoDir, { recursive: true, force: true });
    }
  });
});
