/**
 * `unbrowse eval skills` — list captured skills.
 *
 * 1:1 mapping (kind-map.ts row "eval skills"):
 *   CLI subcommand  : eval skills
 *   MCP tool        : unbrowse_skills
 *   Covenant kind   : observe_skills
 *   Verb            : eval
 *
 * Wraps the v6 backend `GET /v1/skills?view=card` (see
 * backend/src/routes/skills.ts:58) — card view is the only auth-free
 * shape and carries enough pointer metadata (domain, endpoint count,
 * last-executed) for the agent to pick. When the backend is unreachable
 * (network error / 5xx / explicit UNBROWSE_BACKEND_OFFLINE=1), we fall
 * through to the local pointer store at `~/.unbrowse/skills/*.json`.
 *
 * Pointer discipline (contract 3c2dd353): rows carry skill_id + domain
 * + counts only. The full endpoint manifest only loads via
 * `eval skill <id>` so list calls stay light.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
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

interface LocalSkillRow {
  readonly source: "local";
  readonly skill_id: string;
  readonly domain?: string;
  readonly path: string;
  readonly updatedAt: number;
  readonly endpoint_count?: number;
}

interface RemoteSkillRow {
  readonly source: "marketplace";
  readonly skill_id?: string;
  readonly id?: string;
  readonly domain?: string;
  readonly endpoint_count?: number;
  readonly last_executed?: number | string | null;
  // Keep the original card payload so the agent has the full row.
  readonly raw: unknown;
}

type SkillRow = LocalSkillRow | RemoteSkillRow;

/** Walk `~/.unbrowse/skills/*.json` — pointer-only metadata. */
async function listLocalSkills(): Promise<LocalSkillRow[]> {
  const dir = join(homedir(), ".unbrowse", "skills");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rows: LocalSkillRow[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const skillId =
        typeof parsed.skill_id === "string"
          ? parsed.skill_id
          : typeof parsed.id === "string"
            ? parsed.id
            : name.replace(/\.json$/, "");
      const domain =
        typeof parsed.domain === "string" ? parsed.domain : undefined;
      const endpointCount = Array.isArray(parsed.endpoints)
        ? parsed.endpoints.length
        : typeof parsed.endpoint_count === "number"
          ? parsed.endpoint_count
          : undefined;
      rows.push({
        source: "local",
        skill_id: skillId,
        domain,
        path,
        updatedAt: st.mtimeMs,
        endpoint_count: endpointCount,
      });
    } catch {
      // Skip unreadable / malformed; do not throw.
    }
  }
  // Newest first.
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

async function fetchRemoteSkills(opts: {
  base: string;
  limit?: number;
  includeDeprecated: boolean;
  domain?: string;
  fresh: boolean;
}): Promise<{ rows: RemoteSkillRow[]; status: number; ok: boolean }> {
  const params = new URLSearchParams({ view: "card" });
  if (opts.limit && opts.limit > 0) params.set("limit", String(opts.limit));
  if (opts.includeDeprecated) params.set("include_deprecated", "1");
  const url = `${opts.base.replace(/\/$/, "")}/v1/skills?${params.toString()}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.fresh) headers["cache-control"] = "no-cache";

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const status = r.status;
    if (!r.ok) {
      return { rows: [], status, ok: false };
    }
    const body = (await r.json().catch(() => ({}))) as { skills?: unknown };
    const list = Array.isArray(body.skills) ? body.skills : [];
    let rows: RemoteSkillRow[] = list.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return {
        source: "marketplace",
        skill_id: typeof e.skill_id === "string" ? e.skill_id : undefined,
        id: typeof e.id === "string" ? e.id : undefined,
        domain: typeof e.domain === "string" ? e.domain : undefined,
        endpoint_count:
          typeof e.endpoint_count === "number" ? e.endpoint_count : undefined,
        last_executed:
          typeof e.last_executed === "number" || typeof e.last_executed === "string"
            ? (e.last_executed as number | string)
            : null,
        raw: e,
      };
    });
    if (opts.domain) {
      const d = opts.domain.toLowerCase();
      rows = rows.filter((r) => (r.domain ?? "").toLowerCase() === d);
    }
    return { rows, status, ok: true };
  } finally {
    clearTimeout(t);
  }
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "skills")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval skills",
      {
        summary: "List captured skills (marketplace card view; local fallback).",
        usage: "unbrowse eval skills [--domain D] [--limit N] [--include-deprecated] [--fresh]",
        flags: [
          { name: "--domain", description: "Filter by domain.", value_expected: true },
          { name: "--limit", description: "Max rows.", value_expected: true },
          { name: "--include-deprecated", description: "Include stale/deprecated skills." },
          { name: "--fresh", description: "Bypass CDN / KV cache." },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const domainFlag =
    typeof parsed.flags.domain === "string" ? parsed.flags.domain : undefined;
  const limitFlag = typeof parsed.flags.limit === "string"
    ? Number.parseInt(parsed.flags.limit, 10)
    : NaN;
  const limit = Number.isFinite(limitFlag) && limitFlag > 0 ? limitFlag : undefined;
  const includeDeprecated = parsed.flags["include-deprecated"] === true;
  const fresh = parsed.flags.fresh === true;
  const offlineForced = process.env.UNBROWSE_BACKEND_OFFLINE === "1";

  try {
    const base = resolveApiBase();
    let rows: SkillRow[] = [];
    let usedFallback = false;
    let backendStatus = 0;
    let backendError: string | null = null;

    if (!offlineForced) {
      try {
        const remote = await fetchRemoteSkills({
          base,
          limit,
          includeDeprecated,
          domain: domainFlag,
          fresh,
        });
        backendStatus = remote.status;
        if (remote.ok) {
          rows = remote.rows;
        } else {
          usedFallback = true;
        }
      } catch (err) {
        backendError = (err as Error).message;
        usedFallback = true;
      }
    } else {
      usedFallback = true;
    }

    if (usedFallback) {
      let local = await listLocalSkills();
      if (domainFlag) {
        const d = domainFlag.toLowerCase();
        local = local.filter((r) => (r.domain ?? "").toLowerCase() === d);
      }
      if (limit) local = local.slice(0, limit);
      rows = local;
    }

    emit(
      {
        ok: true,
        subcommand: "eval skills",
        covenant_kind: meta.covenant_kind,
        api_base: base,
        backend_status: backendStatus,
        backend_error: backendError,
        used_fallback: usedFallback,
        count: rows.length,
        skills: rows,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
