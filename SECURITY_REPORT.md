# Security Report — Unbrowse

**Date:** 2026-02-28  
**Scope:** `justrach/unbrowse34` full codebase  
**Reviewed branches:** `main`, `fix/auth-recommended-hint` (PR #33), `fix/skill-not-found-after-resolve` (PR #35)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 2 |
| Medium   | 3 |
| Low      | 2 |
| Info     | 2 |

---

## Findings

### [HIGH-1] Shell Injection via Domain in `sqliteQuery`

**File:** `src/auth/browser-cookies.ts:193`

```typescript
function sqliteQuery(dbPath: string, sql: string): string {
  return execSync(`sqlite3 -separator '|' "${dbPath}" "${sql}"`, { ... });
}
```

The `sql` string is built from a user-supplied domain via `buildDomainWhereClause`. SQL single-quotes are escaped (`'` → `''`) but the command string uses double-quote wrapping. A domain containing `"` or `$(...)` can break out of the shell argument.

`new URL(url).hostname` filters most dangerous inputs but valid international hostnames can contain characters that survive the URL parser and still break shell quoting.

**Impact:** Remote code execution on the local machine if the server is called with a crafted URL.

**Fix:** Replace the `execSync` shell invocation with the `better-sqlite3` npm package (in-process, no shell), or use `execFileSync` with `sqlite3` as the command and SQL/path as separate array arguments (no shell interpolation):

```typescript
execFileSync("sqlite3", ["-separator", "|", dbPath, sql], { encoding: "utf8" });
```

---

### [HIGH-2] `/v1/auth/steal` — Cookie Exfiltration Endpoint Has No Scope Guard

**File:** `src/api/routes.ts:131–150`

```typescript
app.post("/v1/auth/steal", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, ...)
```

This endpoint reads Chrome and Firefox SQLite cookie databases for **any domain** a caller requests. The only guard is:

1. The global API key gate (requires `~/.unbrowse/config.json` key — set once on first run)
2. A localhost binding (Fastify binds to `127.0.0.1` by default)
3. Rate limit: 30 req/min

Any process running as the same OS user (or any browser tab via `fetch("http://localhost:6969/v1/auth/steal", ...)` due to CORS) can call this endpoint and extract cookies for `google.com`, `github.com`, banking sites, etc.

Additionally, PR #33 (`fix/auth-recommended-hint`) adds this to API response bodies:

```
"auth_hint": "Run POST /v1/auth/steal to extract cookies from your local browser..."
```

This advertises the endpoint's existence and name to any caller receiving a capture response.

**Impact:** Session hijacking for any site the user is logged into in Chrome/Firefox.

**Fixes:**
1. **CORS lockdown:** Add an `onRequest` hook rejecting requests with an `Origin` header (blocks fetch from browser tabs)
2. **Scope the `auth_hint`:** Replace the literal endpoint path with a generic message like `"Re-run with stored browser auth"` — don't expose internal route names in API responses
3. Consider requiring an explicit `--allow-steal` flag at server startup to enable the endpoint

---

### [MEDIUM-1] Vault Encryption Key Stored as Plaintext File

**File:** `src/vault/index.ts:27–33`

```typescript
const KEY_FILE = join(VAULT_DIR, ".key");

function getOrCreateKey(): Buffer {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE);
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}
```

The AES-256 key protecting the credential vault is stored in `~/.unbrowse/vault/.key` at mode `0600`. When `keytar` (macOS Keychain) is available the encrypted-file fallback is not used, but on Linux/CI there is no keychain.

A process with the same UID can read the key and decrypt all stored cookies.

**Fix:** On Linux, use the kernel keyring (`keyctl`) or a secret-service D-Bus socket instead of a file. Keep the file fallback for environments with neither but document it clearly.

---

### [MEDIUM-2] Catch-all Proxy Forwards API Key to Upstream

**File:** `src/api/routes.ts:191–212`

```typescript
app.all("/v1/*", async (req, reply) => {
  const key = getApiKey();
  const upstream = `${BETA_API_URL}${req.url}`;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(upstream, { method: req.method, headers, body: ... });
  ...
});
```

Every unrecognized `/v1/*` path is forwarded to `beta-api.unbrowse.ai` with the user's Bearer token. If a confused-deputy attack or SSRF vector causes this proxy to be called with an attacker-controlled path, the API key is leaked to the upstream.

Additionally, if `BETA_API_URL` were ever misconfigured (e.g. via environment variable injection), all proxied traffic including credentials would go to an attacker server.

**Fix:**
1. Maintain an explicit allowlist of routes permitted to proxy instead of a catch-all
2. Validate `BETA_API_URL` at startup against a hardcoded expected hostname

---

### [MEDIUM-3] AES-256-CBC Without Authentication (Vault)

**File:** `src/vault/index.ts:48–65`

The vault uses AES-256-**CBC** with a random IV but no MAC (no HMAC, no GCM tag). An attacker who can read and modify the vault file can perform a padding oracle attack to decrypt stored cookies without knowing the key, given enough oracle queries.

**Fix:** Use AES-256-**GCM** which provides authenticated encryption. Migration path: detect old CBC format by checking ciphertext length; re-encrypt on first successful read.

---

### [LOW-1] `yolo` Mode Opens Full Chrome Profile

**File:** `src/auth/index.ts:202–215`

`POST /v1/auth/login` accepts `{ yolo: true }` which launches Playwright against the user's **main Chrome profile** (not an isolated one). This gives the automated browser access to all stored passwords, payment info, extensions, and session cookies across every site.

While user-opt-in, the name `yolo` undersells the risk. If the login flow is ever triggered automatically (e.g. by an AI agent following the `auth_hint`), this could result in inadvertent access to sensitive profile data.

**Fix:** Require explicit confirmation in the HTTP response before proceeding (`dry_run` step), and rename the flag to something that communicates the scope (e.g. `use_main_profile`).

---

### [LOW-2] API Key Stored Plaintext in Config

**File:** Referenced in `src/api/routes.ts` via `getApiKey()`

The server API key is read from `~/.unbrowse/config.json`. Unlike vault credentials, the API key is not encrypted. Any process with read access to the home directory can obtain it and make authenticated calls to the local server (including `/v1/auth/steal`).

**Fix:** Move the API key into the encrypted vault using the same `storeCredential` / `getCredential` path.

---

### [INFO-1] Full Pre-commit Sweep Still Includes a Networked Smoke

**File:** `scripts/precommit-full.sh`

The default staged-file pre-commit path is fast-only now, but `bun run precommit:full` still runs one live Codex harness smoke against a public site. That remains opt-in and can still fail in offline environments or when the local server cannot start cleanly.

**Recommendation:** Keep `precommit:full` opt-in and treat it as a local release gate, not a mandatory offline-safe hook.

---

### [INFO-2] Issue #24 Closed — EmergentDB Read-After-Write

Issue #24 (EmergentDB `qdkv/get` returning 404 for recently published skills) was resolved on the EmergentDB infrastructure side and confirmed by the owner. The issue has been closed.

The local disk cache (`~/.unbrowse/skill-cache/`) remains as the correct fallback and is unaffected.

---

## Open PRs Status

| PR | Branch | Status | Notes |
|----|--------|--------|-------|
| #35 | `fix/skill-not-found-after-resolve` | MERGEABLE | Fixes issue #34: cache-first publish, local `GET /v1/skills/:id`, publish error logging. Ready to merge. |
| #33 | `fix/auth-recommended-hint` | MERGEABLE | Surfaces `auth_recommended` hint on no-data captures. See HIGH-2 above re: `auth_hint` leaking `/v1/auth/steal` endpoint name. |

---

## Recommended Priority

1. **HIGH-1** — Fix `execSync` shell injection → use `execFileSync` (10-min fix)
2. **HIGH-2** — Add CORS `Origin` block hook + sanitize `auth_hint` message before merging PR #33
3. **MEDIUM-3** — Migrate vault to AES-256-GCM (before any public release)
4. **MEDIUM-2** — Allowlist catch-all proxy routes
5. **MEDIUM-1** — Linux keyring support for vault key
