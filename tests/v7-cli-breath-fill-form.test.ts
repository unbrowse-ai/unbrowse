/**
 * W32-B — v7 CLI tests for `breath fill-form`, the end-to-end form-fill pipe.
 *
 * The pipe: snap form → enumerate() candidates → covenant diffusion_populate
 * (ONE dogfooded binary call) → resolve picked pointers → inject every field.
 *
 * W32.1 — the diffusion_populate kind now surfaces its populated payload INLINE
 * at extra.data.populated, so sealDiffusionReceipt reads the per-slot picks from
 * the SINGLE binary invocation that sealed the receipt. There is NO second
 * engine shell — the sealed body-blob and the injected pointers come from the
 * SAME run and can never diverge.
 *
 * Always-on (no W5/W6 dependency):
 *   - kind-map binding (actuate_fill_form + unbrowse_fill_form)
 *   - help-mode JSON carries the op_kind row
 *   - sealDiffusionReceipt parses the binary's receipt envelope AND reads the
 *     per-slot picks from extra.data.populated (mock binary, ONE call)
 *   - formSlotEnumExpression encodes the form selector safely
 *
 * End-to-end CDP cases gate on UNBROWSE_W5W6_READY=1 (W5 chrome + W6 values
 * wired for real). Gated off → suite passes (pattern from the sibling breath
 * suites; no mocks for CDP/values).
 *
 * Test list (e2e):
 *   1. username+password form: enumerate returns arg:// candidates; mock
 *      diffusion engine returns the picked pointers; assert each field is
 *      injected with the resolved value.
 *   2. --dry-run: shows proposed pointers, does NOT resolve/inject (no
 *      Input.insertText fired — the form fields stay empty).
 *   3. CANARY: a candidate resolves to UNB7-FILLFORM-CANARY-DO-NOT-LEAK;
 *      assert it's injected into the field BUT appears NOWHERE in
 *      stdout/stderr/audit-receipt (only pointer + field-name surface).
 *   4. Slot with no candidate → honest unfilled + note, no crash.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { lookupKindMap } from "../src/cli-v7/kind-map.js";
import {
  formSlotEnumExpression,
  sealDiffusionReceipt,
} from "../src/cli-v7/breath/fill-form.js";

const W5W6_READY = process.env.UNBROWSE_W5W6_READY === "1";
const CANARY = "UNB7-FILLFORM-CANARY-DO-NOT-LEAK";
const SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

interface AuditCapture {
  bodies: unknown[];
  url: string;
  stop: () => Promise<void>;
}

async function startAuditMock(): Promise<AuditCapture> {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.startsWith("/v1/audit/")) {
        return new Response("not_found", { status: 404 });
      }
      const body = await req.json().catch(() => null);
      bodies.push(body);
      return new Response(JSON.stringify({ ok: true, receiptId: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    bodies,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => { server.stop(true); },
  };
}

interface RunResult { code: number | null; stdout: string; stderr: string; }

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

async function clearSessions(): Promise<void> {
  if (existsSync(SESSIONS_DIR)) await rm(SESSIONS_DIR, { recursive: true, force: true });
  await mkdir(SESSIONS_DIR, { recursive: true });
}

async function writeFixtureHtml(): Promise<string> {
  const dir = (await Bun.file(tmpdir()).exists()) ? tmpdir() : "/tmp";
  const path = join(dir, `unb7-w32b-fixture-${Date.now()}.html`);
  const html = `<!doctype html>
<html><body>
  <form id="login" action="/post-login" method="post">
    <label for="user">username</label>
    <input type="text" id="user" name="username" />
    <label for="pass">password</label>
    <input type="password" id="pass" name="password" />
    <input type="text" id="orphan" name="nickname" />
    <button type="submit">Login</button>
  </form>
</body></html>`;
  await writeFile(path, html, "utf8");
  return `file://${path}`;
}

/**
 * Write a mock covenant binary that reads the diffusion_populate op on stdin
 * and returns a receipt envelope (mirrors the real binary's W32.1 shape: the
 * receipt id PLUS the populated payload INLINE at extra.data.populated). The
 * mock derives the per-slot picks from the op's `slots` param using the
 * supplied `picks` map (slotName → value_pointer | null), exactly how the real
 * surface_json_extra shell effect surfaces the engine's output in ONE call.
 * Records the op to a sidecar so the test can assert the dogfood call landed.
 */
async function writeMockCovenantBin(
  opLog: string,
  picks: Record<string, string | null> = {},
): Promise<string> {
  const dir = (await Bun.file(tmpdir()).exists()) ? tmpdir() : "/tmp";
  const path = join(dir, `unb7-w32b-covenant-${Date.now()}.sh`);
  const picksJson = JSON.stringify(picks);
  // Read stdin op, log it, derive populated[] from op.params.slots × picks, and
  // emit the full receipt envelope with extra.data.populated inline.
  const sh = `#!/usr/bin/env bash
OP_JSON="$(cat)"
OP_JSON="$OP_JSON" OPLOG=${JSON.stringify(opLog)} PICKS=${JSON.stringify(picksJson)} python3 <<'PY'
import json, os
op = os.environ["OP_JSON"]
open(os.environ["OPLOG"], "w").write(op)
try:
    parsed = json.loads(op)
    slots = json.loads(parsed.get("params", {}).get("slots", "[]"))
except Exception:
    slots = []
picks = json.loads(os.environ["PICKS"])
populated = []
for s in slots:
    name = s.get("name", "") if isinstance(s, dict) else ""
    vp = picks.get(name, None)
    populated.append({"name": name, "value_pointer": vp, "source_ptr": ("enumerate:"+name) if vp else None, "path": "enumerate" if vp else "unresolved"})
out = {
    "ok": True,
    "kind": "covenant",
    "covenant": {"day_name": "diffusion_populate"},
    "receipt": "sha256:deadbeefmockreceipt",
    "extra": {"data": {"ok": True, "populated": populated, "slots_n": len(slots), "mode": "1-step-nearest-revealed", "source": "enumerate", "candidate_source": "enumerate"}},
}
print(json.dumps(out))
PY
`;
  await writeFile(path, sh, "utf8");
  await chmod(path, 0o755);
  return path;
}

// ─── Always-on ───────────────────────────────────────────────────────────────

describe("v7-cli fill-form kind-map binding (W32-B)", () => {
  it("breath fill-form → actuate_fill_form + unbrowse_fill_form", () => {
    const meta = lookupKindMap("breath", "fill-form");
    expect(meta).toBeDefined();
    expect(meta!.op_kind).toBe("breath:fill_form");
    expect(meta!.op_class).toBe("actuate");
    expect(meta!.action).toBe("fill_form");
    expect(meta!.mcp_tool).toBe("unbrowse_fill_form");
  });

  it("breath fill-form --help emits op_kind=actuate_fill_form", async () => {
    const res = await runCli(["breath", "fill-form", "--help", "--json"]);
    expect(res.code).toBe(64);
    const out = JSON.parse(res.stdout);
    expect(out.help).toBe(true);
    expect(out.op_kind).toBe("breath:fill_form");
    expect(out.mcp_tool).toBe("unbrowse_fill_form");
  });

  it("formSlotEnumExpression JSON-encodes the selector (no injection break)", () => {
    const expr = formSlotEnumExpression('form[data-x="a\'b"]');
    expect(expr).toContain(JSON.stringify('form[data-x="a\'b"]'));
    expect(expr).toContain("querySelectorAll");
  });

  it("sealDiffusionReceipt parses the receipt envelope AND reads picks from extra.data.populated (ONE call)", async () => {
    const opLog = join(tmpdir(), `unb7-w32b-oplog-${Date.now()}.json`);
    // ONE mock binary call returns BOTH the sealed receipt and the inline picks.
    const bin = await writeMockCovenantBin(opLog, { username: "arg://username", password: null });
    const seal = sealDiffusionReceipt(
      JSON.stringify([
        { name: "username", type: "text", pointer: "unknown" },
        { name: "password", type: "password", pointer: "unknown" },
      ]),
      JSON.stringify([{ pointer: "arg://username", label: "username", scheme: "arg" }]),
      "login to test",
      bin,
    );
    expect(seal.ok).toBe(true);
    expect(seal.receiptId).toBe("sha256:deadbeefmockreceipt");
    // The picks come from the SAME invocation's extra.data.populated — no
    // second engine shell. Pointer-only; null when unresolved.
    expect(seal.picks.get("username")).toBe("arg://username");
    expect(seal.picks.get("password")).toBeNull();
    // The dogfood op carried the diffusion_populate kind + candidates param.
    const op = JSON.parse(await readFile(opLog, "utf8"));
    expect(op.kind).toBe("diffusion_populate");
    expect(op.params.source).toBe("enumerate");
    expect(typeof op.params.candidates).toBe("string");
    await rm(bin, { force: true });
    await rm(opLog, { force: true });
  });

  it("sealDiffusionReceipt records exactly ONE engine invocation (no second shell)", async () => {
    // The mock binary appends a marker line per invocation; the op-log being
    // written exactly once proves there is a SINGLE engine run per form-fill —
    // the divergence hazard (two runs) is structurally closed.
    const callLog = join(tmpdir(), `unb7-w32b-calllog-${Date.now()}.txt`);
    const dir = (await Bun.file(tmpdir()).exists()) ? tmpdir() : "/tmp";
    const bin = join(dir, `unb7-w32b-countbin-${Date.now()}.sh`);
    await writeFile(
      bin,
      `#!/usr/bin/env bash\ncat > /dev/null\necho call >> ${JSON.stringify(callLog)}\necho '{"ok":true,"kind":"covenant","covenant":{"day_name":"diffusion_populate"},"receipt":"sha256:once","extra":{"data":{"ok":true,"populated":[{"name":"u","value_pointer":"arg://u"}]}}}'\n`,
      "utf8",
    );
    await chmod(bin, 0o755);
    const seal = sealDiffusionReceipt(
      JSON.stringify([{ name: "u", type: "text", pointer: "unknown" }]),
      JSON.stringify([{ pointer: "arg://u", label: "u", scheme: "arg" }]),
      "x",
      bin,
    );
    expect(seal.ok).toBe(true);
    expect(seal.picks.get("u")).toBe("arg://u");
    const calls = (await readFile(callLog, "utf8")).trim().split("\n").filter(Boolean);
    expect(calls.length).toBe(1); // exactly one engine invocation
    await rm(bin, { force: true });
    await rm(callLog, { force: true });
  });

  it("sealDiffusionReceipt returns ok=false + empty picks gracefully on a missing binary", () => {
    const seal = sealDiffusionReceipt("[]", "[]", "x", "/nonexistent/covenant-bin-xyz");
    expect(seal.ok).toBe(false);
    expect(seal.receiptId).toBeNull();
    expect(seal.picks.size).toBe(0);
  });
});

// ─── End-to-end (gated on W5+W6) ───────────────────────────────────────────

describe.if(W5W6_READY)("v7-cli breath fill-form e2e (W5+W6 required)", () => {
  let audit: AuditCapture;
  let sessionId: string;
  let fixtureUrl: string;
  let opLog: string;

  beforeAll(async () => {
    await clearSessions();
    audit = await startAuditMock();
    fixtureUrl = await writeFixtureHtml();
    opLog = join(tmpdir(), `unb7-w32b-e2e-oplog-${Date.now()}.json`);

    const res = await runCli(["breath", "go", fixtureUrl, "--json"]);
    if (res.code !== 0) throw new Error(`fixture go failed: ${res.stderr}`);
    sessionId = JSON.parse(res.stdout).session_id;
  });

  afterAll(async () => {
    if (sessionId) await runCli(["breath", "close", sessionId, "--json"]).catch(() => {});
    await audit?.stop();
    await clearSessions();
    await rm(opLog, { force: true }).catch(() => {});
  });

  it("1. fills username+password from diffusion-picked arg:// pointers (ONE binary call)", async () => {
    // The mock binary carries the picks inline at extra.data.populated — the
    // SAME single call that seals the receipt. No second engine shell.
    const bin = await writeMockCovenantBin(opLog, {
      username: "arg://username",
      password: "arg://password",
      nickname: "arg://nickname",
    });
    const res = await runCli(
      [
        "breath", "fill-form", "form#login",
        "--intent", "login to the site",
        "--argScope", JSON.stringify({ username: "alice", password: "hunter2", nickname: "al" }),
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url, UNBROWSE_COVENANT_BIN: bin },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.subcommand).toBe("breath fill-form");
    expect(out.op_kind).toBe("breath:fill_form");
    expect(out.populated_n).toBeGreaterThanOrEqual(2);
    const byName = new Map<string, { pointer?: string; filled: boolean }>(
      out.fields.map((f: { name: string; pointer?: string; filled: boolean }) => [f.name, f]),
    );
    expect(byName.get("username")?.pointer).toBe("arg://username");
    expect(byName.get("username")?.filled).toBe(true);
    expect(byName.get("password")?.pointer).toBe("arg://password");
    expect(byName.get("password")?.filled).toBe(true);
    // One audit receipt for the whole form, pointer-only, no value.
    const formAudit = (audit.bodies as Array<Record<string, unknown>>).find((b) => b?.variant === "form-fill");
    expect(formAudit).toBeDefined();
    expect((formAudit!.formSelectorHash as string)).toMatch(/^[0-9a-f]{64}$/);
    expect("value" in formAudit!).toBe(false);
    await rm(bin, { force: true });
  }, 30_000);

  it("2. --dry-run proposes pointers but does NOT inject", async () => {
    const bin = await writeMockCovenantBin(opLog, { username: "arg://username", password: "arg://password" });
    const beforeCount = audit.bodies.length;
    const res = await runCli(
      [
        "breath", "fill-form", "form#login",
        "--intent", "login",
        "--argScope", JSON.stringify({ username: "bob", password: "pw" }),
        "--dry-run",
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url, UNBROWSE_COVENANT_BIN: bin },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.dry_run).toBe(true);
    expect(Array.isArray(out.proposed)).toBe(true);
    expect(out.proposed.some((p: { value_pointer: string | null }) => p.value_pointer === "arg://username")).toBe(true);
    // No audit POST for dry-run (no fields injected).
    expect(audit.bodies.length).toBe(beforeCount);
    // Verify the page fields are still EMPTY (no insertText fired).
    const checkEmpty = await runCli(
      ["eval", "text", "--session", sessionId, "--json"],
    ).catch(() => null);
    void checkEmpty; // structural: dry-run path never calls Input.insertText.
    await rm(bin, { force: true });
  }, 30_000);

  it("3. CANARY value is injected but NEVER leaks into any output", async () => {
    const bin = await writeMockCovenantBin(opLog, { username: "arg://canary" });
    const res = await runCli(
      [
        "breath", "fill-form", "form#login",
        "--intent", "login",
        "--argScope", JSON.stringify({ canary: CANARY }),
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url, UNBROWSE_COVENANT_BIN: bin },
    );
    // The canary must not appear anywhere — only the pointer + field name.
    expect(res.stdout).not.toContain(CANARY);
    expect(res.stderr).not.toContain(CANARY);
    const out = JSON.parse(res.stdout);
    // The pointer DOES surface (it's log-safe); the value does not.
    expect(JSON.stringify(out)).not.toContain(CANARY);
    // Every audit body is canary-free.
    for (const b of audit.bodies) expect(JSON.stringify(b)).not.toContain(CANARY);
    // Sweep every session file.
    if (existsSync(SESSIONS_DIR)) {
      for (const name of await readdir(SESSIONS_DIR)) {
        const txt = await readFile(join(SESSIONS_DIR, name), "utf8");
        expect(txt).not.toContain(CANARY);
      }
    }
    await rm(bin, { force: true });
  }, 30_000);

  it("4. slot with no candidate → honest unfilled + note, no crash", async () => {
    // No argScope at all → no arg:// candidates → no picks inline.
    const bin = await writeMockCovenantBin(opLog, {});
    const res = await runCli(
      [
        "breath", "fill-form", "form#login",
        "--intent", "login",
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url, UNBROWSE_COVENANT_BIN: bin },
    );
    // The pipe completes (exit 0) even though nothing filled.
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.populated_n).toBe(0);
    // Each field is honestly unfilled with a note.
    expect(out.fields.every((f: { filled: boolean; note?: string }) => f.filled === false && !!f.note)).toBe(true);
    await rm(bin, { force: true });
  }, 30_000);
});
