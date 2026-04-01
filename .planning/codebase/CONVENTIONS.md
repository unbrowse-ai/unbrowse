# Coding Conventions

**Analysis Date:** 2026-04-01

## Module Style

**All internal imports use `.js` extensions, even for `.ts` source files:**

```typescript
import { log } from "../logger.js";
import { getRegistrableDomain } from "../domain.js";
import { extractEndpoints } from "../reverse-engineer/index.js";
```

This is required because the compiled output uses ESM and Node/Bun resolves `.js` -> `.ts` at dev time via tsx/bun.

**Import ordering (observed):** external packages first, then internal modules:

```typescript
import * as kuri from "../kuri/client.js";     // internal SDK wrapper
import { nanoid } from "nanoid";                 // external
import { getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import type { BrowserAccessConfig } from "../runtime/browser-access.js";
import { DEFAULT_BROWSER_ACCESS } from "../runtime/browser-access.js";
```

**Type-only imports use `import type`:**

```typescript
import type { BrowserAccessConfig } from "../runtime/browser-access.js";
import type { RawRequest } from "../src/capture/index.js";
```

## Naming Patterns

**Files:** `kebab-case.ts` for all source files (e.g., `intent-match.ts`, `reverse-engineer/index.ts`)

**Functions:** `camelCase` (e.g., `assessIntentResult`, `extractEndpoints`, `buildCases`)

**Constants (module-level):** `SCREAMING_SNAKE_CASE` (e.g., `CAPTURE_TIMEOUT_MS`, `CHROME_UA`, `MAX_CONCURRENT_TABS`)

**Types/Interfaces:** `PascalCase` (e.g., `BrowserAccessConfig`, `RawRequest`, `TestAnalysis`)

**Environment variables:** `UNBROWSE_*` prefix for all product env vars (e.g., `UNBROWSE_API_URL`, `UNBROWSE_FORCE_CAPTURE`, `UNBROWSE_LOCAL_ONLY`)

## Logging Pattern

Use `log(module, message)` from `src/logger.ts` for structured output:

```typescript
import { log } from "../logger.js";

log("capture", "Cloudflare challenge detected, waiting for clearance...");
log("execution", `lifecycle attribution: capture=${ms}ms`);
log("exec", `endpoint ${id}: cookies=${n}`);
```

Format written: `[HH:MM:SS] [module] message` to both stdout and `~/.unbrowse/logs/unbrowse-YYYY-MM-DD.log`.

The logger never throws — it catches all filesystem errors silently so logging failures never crash the server.

**Direct `console.log` is also used** in some modules (particularly `src/orchestrator/index.ts`) with a `[tag]` prefix convention:

```typescript
console.log(`[domain-cache] loaded ${n} entries from disk`);
console.log(`[lifecycle] ${breakdown}`);
console.log(`[auth] auth prerequisite unresolved for ${domain} — continuing`);
```

## Error Handling

**Pattern: try/catch with silent fallthrough for non-fatal ops:**

```typescript
try {
  const hasCf = await kuri.hasCloudflareChallenge(tabId);
  // ...
} catch {
  // Tab not available — skip CF detection
}
```

**Pattern: `??` null-coalescing for all defaults:**

```typescript
const u = entry.request?.url ?? "?";
const m = entry.request?.method ?? "?";
const s = entry.response?.status ?? 0;
```

**Optional chaining on all HAR entry fields** (see HAR Entry Guards below).

**Backend errors are treated as skips, not failures** in live integration tests:

```typescript
async function tryLive<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
// In test: if (result === null) return; // backend unavailable — skip
```

## HAR Entry Guards

Kuri HAR entries may have `undefined` headers and response fields. Always guard:

```typescript
// Correct
const reqHeaders = entry.request?.headers ?? [];
for (const h of entry.request.headers ?? []) reqHeaders[h.name] = h.value;

// Correct — optional chaining on all fields
const u = entry.request?.url ?? "?";
const method = entry.request?.method?.toUpperCase() ?? "GET";
const reqBody = entry.request?.postData?.text;
```

The test `tests/har-headers-guard.test.ts` enforces this by scanning `src/capture/index.ts` source text
for unguarded `for (const h of entry.request.headers)` patterns and failing if found.

**Never write:**
```typescript
for (const h of entry.request.headers)   // unguarded — will throw if undefined
for (const h of entry.response.headers)  // unguarded — will throw if undefined
```

## Kuri Evaluate Result Guards

`kuri.getCurrentUrl` and `kuri.getPageHtml` may return `"[object Object]"` when the Kuri CDP response shape changes. Always validate:

- URL result must start with `http`
- HTML result must start with `<`

## Configuration and Env Vars

**dotenv loaded at entry points** — both `.env` and `.env.runtime` are loaded:

```typescript
import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", override: false, quiet: true });
```

**Key env vars read via `process.env.VAR ?? default` pattern:**

```typescript
const API_URL = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";
const LOCAL_ONLY = process.env.UNBROWSE_LOCAL_ONLY === "1";
const TIMEOUT_MS = Number(process.env.UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS ?? "120000");
```

Backend URL is `beta-api.unbrowse.ai` — not `api.unbrowse.ai`. Override via `UNBROWSE_API_URL`.

**Profile system:** `UNBROWSE_PROFILE` selects a named config stored under `~/.unbrowse/profiles/<name>/`.

## Commit Conventions

Conventional commit prefixes are required: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`

All notable changes must be written to `CHANGELOG.md`.

## Critical Footguns (from CLAUDE.md)

**Never edit `src/kuri/client.ts`** unless explicitly asked. Kuri is a separately maintained Zig binary; its Node client wrapper is fragile and tightly coupled.

**Always kill the running unbrowse server after `npm i -g`** before testing. Stale servers serve old code:
```bash
pkill -9 -f 'unbrowse|kuri'; sleep 2
```

**Guard HAR entry iteration.** Use `entry.request.headers ?? []`, never bare `entry.request.headers`.

**Guard kuri evaluate results.** Validate URL starts with `http` and HTML starts with `<`.

**`rach/restart-base` is the working branch**, not `main`. Main is broken. Do not merge from or rebase onto main.

**`autoExtract` must be `true`** in `executeBrowserCapture`'s cookie resolution. `false` silently skips browser cookie extraction and breaks all gated sites.

**Packaged CLI spawns a separate server process.** `bun src/cli.ts` runs inline (same process), but `unbrowse` (global install) spawns a detached node+tsx server. Stale servers are the #1 cause of "works from source, broken from package".

**Never mock in tests.** See TESTING.md.

## Kuri Runtime Packaging

When touching Kuri discovery, packaging, runtime paths, or `packages/skill/`, run:
```bash
bash scripts/check-packaged-kuri.sh
```

Kuri must work as a bundled binary from the vendor path — never require end users to install Zig or a separate `kuri` binary.

## Versioning

Versions are synced across `package.json`, `packages/skill/package.json`, and `version.json`. Do not bump versions or create tags manually — `release-it` handles it.

---

*Convention analysis: 2026-04-01*
