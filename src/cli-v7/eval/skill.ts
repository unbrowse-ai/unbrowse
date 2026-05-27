/**
 * `unbrowse eval skill <skill-id>` — one skill detail.
 *
 * 1:1 mapping (kind-map.ts row "eval skill"):
 *   CLI subcommand  : eval skill
 *   MCP tool        : unbrowse_skill
 *   Covenant kind   : observe_skill
 *   Verb            : eval
 *
 * Wraps the v6 backend `GET /v1/skills/:id` (see
 * backend/src/routes/skills.ts). Prints endpoint count, action_kinds,
 * last_executed. 404 maps to EX_USAGE (64) with an actionable
 * `next_step` per CLAUDE.md no-stubs discipline.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { DEFAULT_BACKEND_URL } from "../../version.js";

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

interface SkillDetail {
  readonly skill_id: string;
  readonly domain?: string;
  readonly endpoint_count: number;
  readonly action_kinds: string[];
  readonly last_executed: number | string | null;
  readonly source: "marketplace" | "local";
  readonly path?: string;
  readonly raw: unknown;
}

function uniq(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).filter((v) => v && v.length > 0).sort();
}

function summarizeManifest(skillId: string, raw: Record<string, unknown>, source: "marketplace" | "local", path?: string): SkillDetail {
  const endpoints = Array.isArray(raw.endpoints) ? raw.endpoints : [];
  const actionKinds = uniq(
    endpoints
      .map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        return typeof r.action_kind === "string" ? r.action_kind : "";
      })
      .filter((s): s is string => typeof s === "string"),
  );
  const lastExecuted =
    typeof raw.last_executed === "number" || typeof raw.last_executed === "string"
      ? (raw.last_executed as number | string)
      : null;
  return {
    skill_id: skillId,
    domain: typeof raw.domain === "string" ? raw.domain : undefined,
    endpoint_count:
      typeof raw.endpoint_count === "number" ? raw.endpoint_count : endpoints.length,
    action_kinds: actionKinds,
    last_executed: lastExecuted,
    source,
    path,
    raw,
  };
}

async function readLocalSkill(skillId: string): Promise<SkillDetail | null> {
  const dir = join(homedir(), ".unbrowse", "skills");
  const path = join(dir, `${skillId}.json`);
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return summarizeManifest(skillId, parsed, "local", path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "skill")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval skill",
      {
        summary: "Detail one captured skill by id (endpoint count, action_kinds, last_executed).",
        usage: "unbrowse eval skill <skill-id> [--fresh]",
        positional: [
          { name: "skill-id", description: "Skill id from `unbrowse eval skills`.", required: true },
        ],
        flags: [
          { name: "--fresh", description: "Bypass CDN / KV cache." },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const skillId =
    parsed.positional[0] ??
    (typeof parsed.flags["skill-id"] === "string" ? parsed.flags["skill-id"] : undefined) ??
    (typeof parsed.flags.skill === "string" ? parsed.flags.skill : undefined);
  if (!skillId || typeof skillId !== "string" || skillId.trim().length === 0) {
    emitErr(new Error("skill_id_required: usage: unbrowse eval skill <skill-id>"), opts);
    process.exit(EX_USAGE);
  }

  const fresh = parsed.flags.fresh === true;
  const offlineForced = process.env.UNBROWSE_BACKEND_OFFLINE === "1";

  try {
    const base = resolveApiBase();
    let status = 0;
    let detail: SkillDetail | null = null;
    let backendError: string | null = null;

    if (!offlineForced) {
      const url = `${base.replace(/\/$/, "")}/v1/skills/${encodeURIComponent(skillId)}`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (fresh) headers["cache-control"] = "no-cache";
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const r = await fetch(url, { headers, signal: ctrl.signal });
        status = r.status;
        if (r.ok) {
          const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          detail = summarizeManifest(skillId, raw, "marketplace");
        } else if (status !== 404) {
          backendError = `backend_status:${status}`;
        }
      } catch (err) {
        backendError = (err as Error).message;
      } finally {
        clearTimeout(t);
      }
    }

    // Local fallback — useful when the skill is captured but not yet
    // published, or when the backend is offline.
    if (!detail) {
      detail = await readLocalSkill(skillId);
    }

    if (!detail) {
      // 404-shaped honest empty-state with actionable next-step.
      emit(
        {
          ok: false,
          subcommand: "eval skill",
          covenant_kind: meta.covenant_kind,
          error: "skill_not_found",
          skill_id: skillId,
          api_base: base,
          backend_status: status,
          backend_error: backendError,
          next_step:
            "list skills via `unbrowse eval skills`, or capture one via `unbrowse breath go <url>` + `breath close --publish`",
        },
        opts,
      );
      // sysexits.h EX_DATAERR = 65 (matches the prompt's "404 → exit 65").
      process.exit(65);
    }

    emit(
      {
        ok: true,
        subcommand: "eval skill",
        covenant_kind: meta.covenant_kind,
        api_base: base,
        backend_status: status,
        skill_id: detail.skill_id,
        domain: detail.domain ?? null,
        endpoint_count: detail.endpoint_count,
        action_kinds: detail.action_kinds,
        last_executed: detail.last_executed,
        source: detail.source,
        ...(detail.path ? { local_path: detail.path } : {}),
        raw: detail.raw,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
