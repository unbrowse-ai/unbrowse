# Value-store adapters + CLI shape (v7)

Scope: the pointer-not-payload adapter layer for v7 fill/type/execute, and the
three-verb CLI tree (`unbrowse build | breath | eval`) that wraps it. Every value
injected into a form field, header, or API payload is a **pointer**; the
cleartext is dereferenced in-memory at the last possible moment and zeroed
within milliseconds. Receipts in the covenant ledger carry only the pointer
plus a sha256 commitment over `(value || nonce)` — never the value itself, never
a `[REDACTED]` placeholder (anti-stub rule).

Four adapters, no more: `op://`, `keychain://`, `bw://`, `arg://`. Adding a
fifth (Vault, AWS SM, Doppler) is out-of-scope for v7.0.0.

---

## The pointer trait (TypeScript signature)

```ts
// src/value-store/trait.ts
export interface ResolvedSecret extends AsyncDisposable {
  /** Raw bytes. Caller MUST consume within the disposal scope. */
  readonly value: Buffer;
  /** sha256(value || nonce) — safe to log, safe to land in ledger. */
  readonly commitment: Buffer;
  /** Identifier of the adapter that resolved this (e.g. "op", "keychain"). */
  readonly adapter: AdapterId;
  /** Original pointer URI, for audit. */
  readonly pointer: string;
  /** Best-effort zero on async-dispose. */
  [Symbol.asyncDispose](): Promise<void>;
}

export type AdapterId = "op" | "keychain" | "keychain-secure" | "bw" | "arg";

export interface ValueStoreAdapter {
  /** URI scheme(s) this adapter claims (e.g. ["op"]). */
  readonly schemes: readonly string[];

  /** Lazy auth/unlock — called once per process before first resolve. */
  ensureReady(): Promise<void>;

  /**
   * Dereference one pointer. The returned ResolvedSecret OWNS the value
   * buffer; caller MUST use `await using secret = await adapter.resolve(...)`
   * so the AsyncDisposable fires on scope exit.
   *
   * @param pointer  Full URI, e.g. "op://Personal/Twitter/username".
   * @param nonce    32-byte random nonce, bound to the call context
   *                 (fill-time hash, request-id, etc). Used in the commitment.
   */
  resolve(pointer: string, nonce: Buffer): Promise<ResolvedSecret>;
}

export interface ValueStoreRegistry {
  /** Route a pointer to its adapter by scheme; throws on unknown scheme. */
  pick(pointer: string): ValueStoreAdapter;
  /** Convenience: pick + resolve in one call. */
  resolve(pointer: string, nonce: Buffer): Promise<ResolvedSecret>;
}
```

Notes:

- The trait deliberately exposes ONE verb. No `list`, no `unlock`, no `cache`.
  Each adapter is a one-shot oracle; multi-pointer reads are sequential calls.
- `AsyncDisposable` is the v7-mandated lifecycle. There is no synchronous
  `.dispose()` — fill-time flow is always async (CDP call boundary).
- `commitment = sha256(value || nonce)` is computed inside `resolve()`, before
  the value ever leaves the adapter. The covenant body carries the
  commitment; the value Buffer is for the CDP path only.

---

## Pointer URI grammar (BNF per scheme)

```
pointer        ::= op-uri | kc-uri | kc-secure-uri | bw-uri | arg-uri
ident          ::= 1*( ALPHA / DIGIT / "-" / "_" / "." / "+" )
seg            ::= 1*( pchar )            ; RFC 3986 pchar minus "/"
slash          ::= "/"

op-uri         ::= "op://" vault slash item slash field [ slash section ]
vault          ::= seg                    ; 1Password vault name OR uuid
item           ::= seg                    ; item name OR uuid
field          ::= seg                    ; "password" | "username" | custom
section        ::= seg                    ; OPTIONAL section name

kc-uri         ::= "keychain://" service slash account
kc-secure-uri  ::= "keychain-secure://" service slash account
service        ::= seg                    ; macOS keychain "service" attr
account        ::= seg                    ; macOS keychain "account" attr
                                          ; -secure variant prompts Touch ID
                                          ; or Apple-Watch on every read.

bw-uri         ::= "bw://" item-id [ slash field ]
item-id        ::= UUID-v4 / seg          ; Bitwarden item UUID or name
field          ::= "password" | "username" | "totp" | "notes" | custom

arg-uri        ::= "arg://" param-name [ slash sub-path ]
param-name     ::= seg                    ; name of an MCP/CLI argument
sub-path       ::= seg *( slash seg )     ; dotted/slashed JSON path for
                                          ; structured arg values

; Reserved: any value NOT matching <pointer> is treated as cleartext
; (the `arg://` null-store cleartext path — see §arg-semantics below).
```

Worked examples:

- `op://Personal/Twitter/username`
- `op://Shared-Eng/Stripe API/credential/api-token` (section path)
- `keychain://com.unbrowse.session/lewis@unbrowse.ai`
- `keychain-secure://x402.wallet/lewis-prod` (Touch ID gated)
- `bw://9b1f...uuid/password`
- `arg://username` (the MCP caller passed `username: "lewis"` as an arg)
- `arg://payload/headers/Authorization` (JSON sub-path into a structured arg)

---

## Per-adapter spec

### `op` — 1Password CLI

- **Invocation**: `op read --no-newline 'op://Vault/Item/field'`. Returns the
  raw value on stdout, exit 0. Stderr carries auth prompts.
- **Auth model, two paths**:
  1. **Service account** (preferred for headless agents): set
     `OP_SERVICE_ACCOUNT_TOKEN=ops_eyJ...` in the unbrowse process env.
     `op` reads the token and bypasses interactive unlock.
  2. **Biometric/desktop integration** (preferred for laptop dev): `op signin`
     once via the desktop app integration; subsequent `op read` calls
     succeed silently while the agent is unlocked. `ensureReady()` calls
     `op whoami` and throws a typed `AdapterLockedError` if neither path
     is wired, with `next_step: "set OP_SERVICE_ACCOUNT_TOKEN or run op signin"`.
- **Stderr hygiene**: discard stderr unconditionally on success; on non-zero
  exit, scrub stderr through a sanitizer that strips anything resembling a
  vault item value before surfacing the error.
- **Bin discovery**: `which op` at startup; cache the path. v7 will NOT vendor
  the `op` binary — it's a host dependency, documented in README install
  prerequisites.

### `keychain` — macOS Keychain (Generic Password items)

- **Invocation**: `security find-generic-password -s <service> -a <account> -w`.
  The `-w` flag prints only the secret value to stdout. Exit 44 = not found.
- **Platform gate**: macOS-only. On Linux/Windows, `ensureReady()` throws
  `AdapterUnavailableError` with `next_step: "use op:// or bw:// instead"`.
- **`keychain-secure://`** variant: same `security` call, but the underlying
  keychain item is created with ACL requiring user-presence (Touch ID / Apple
  Watch). This is configured at *write* time (out of scope here — Lewis sets
  it up via Keychain Access or a future `unbrowse build value-source` flow);
  the read-side adapter is identical.
- **Stderr hygiene**: `security` echoes `password: 0x...` hex dumps in some
  verbose flag combos — never use `-g`. Stick to `-w`.

### `bw` — Bitwarden CLI

- **Invocation**: `bw get password <item-id-or-name>` for the password field.
  For arbitrary fields: `bw get item <item-id> | jq -r '.<field>'` — BUT this
  passes the secret through `jq`'s argv/stdout. v7 instead parses the JSON
  inside the adapter (zero shell hop after `bw get item`).
- **Auth model**: `BW_SESSION` env var (output of `bw unlock --raw`). The
  session is short-lived; `ensureReady()` calls `bw status` and looks for
  `status: "unlocked"`. If locked, throw `AdapterLockedError` with
  `next_step: "bw unlock --raw then export BW_SESSION=..."`.
- **Stderr hygiene**: bw prints "You are not logged in." to stderr when the
  session expires mid-flight — surface this as `AdapterLockedError`, not a
  generic exec failure.

### `arg` — null-store (tool-call inputs)

- **Invocation**: pure in-process. The MCP tool handler (or CLI flag parser)
  populates a per-call `ArgScope` map; the adapter looks up `param-name` in
  that map. No shell, no fs, no syscall.
- **Sub-path resolution**: `arg://payload/headers/Authorization` walks
  `argScope.payload.headers.Authorization` as a JSON pointer (no string
  interpolation — refuse on missing keys).
- **Auth model**: none. The trust boundary is the MCP transport itself; if
  the caller passed a secret in cleartext, the caller chose to.
- **Why it exists**: the entire CLI/MCP surface is itself the perfect adapter
  — an agent that doesn't want to use a vault still has a uniform pointer to
  pass (`arg://...`), and the fill-time flow is identical. The commitment
  still lands in the ledger; the value still gets zeroed.

---

## Security invariants (apply to ALL adapters)

1. **Never to disk.** No tempfile, no fsync, no `mkstemp`. Adapter binaries
   are spawned with `stdio: ["ignore", "pipe", "pipe"]`; stdout is read into
   a single Buffer, never written through fs.
2. **Never to logs.** A dedicated `secretSafeLog(msg)` helper rejects any
   string that contains a known-resolved value (tracked in a per-process
   WeakSet of `Buffer` identities for the lifetime of the resolution scope).
   Adapter stderr is read fully BEFORE the `resolve()` Promise resolves and
   passes through `scrubAdapterStderr()` which strips anything matching the
   adapter's known-leak patterns (`op`: lines containing "password:",
   "value:"; `bw`: lines containing literal item JSON; `security`: hex dumps).
3. **Never to telemetry.** The unbrowse_reflect / unbrowse_feedback paths
   carry the **pointer** and **commitment** only. The schema in
   `backend/src/types.ts:FeedbackBody` MUST forbid a `value` field on any
   fill-related event. Schema diff enforces it.
4. **Zeroed within 50 ms of use.** The fill-time scope uses
   `await using secret = await registry.resolve(...)`; the
   `Symbol.asyncDispose` callback overwrites the Buffer via the pattern in
   the next paragraph and nulls the reference. The 50 ms budget covers
   the CDP `Input.insertText` round-trip; longer than that = a stuck CDP
   call, which the timeout layer kills.
5. **Buffer-zeroing caveats.** Node Buffers are NOT guaranteed to be the
   *only* copy in memory — V8 may have copied bytes into hidden strings if
   anyone called `.toString()` on them. v7 forbids `.toString()` on a
   resolved value Buffer in the fill path; the linter rule
   `no-tostring-on-secret` enforces it. The zero pattern itself:
   ```ts
   // Preferred: libsodium memzero, which compiles to volatile-write asm.
   sodium.memzero(secret.value);
   // Fallback: best-effort fill-with-zeros, then null the slice.
   secret.value.fill(0);
   ```
   We bundle `sodium-native` (already a transitive dep of x402 signing).
6. **Commitment-bound nonce.** The nonce is 32 bytes from
   `crypto.randomBytes(32)`, generated by the *caller* (the fill primitive),
   bound to the fill-context-hash, and passed INTO `resolve()`. The
   adapter does NOT pick the nonce — that would let a malicious adapter
   replay-commit the same `(value, nonce)` and unmask via a known-value
   dictionary.
7. **Receipt body shape.** The covenant body MUST be:
   ```json
   {
     "kind": "fill" | "type" | "execute" | ...,
     "params": {
       "selector": "#username",
       "pointer": "op://Personal/Twitter/username",
       "commitment": "sha256:abc123...",
       "nonce": "hex:def456...",
       "adapter": "op"
     }
   }
   ```
   No `value`. No `value_length`. No `value_first_chars`. The commitment IS
   the receipt of the value. Anti-stub rule applies: the receipt is not a
   placeholder for a value — it's the value's *cryptographic shadow*.

---

## Fill-time flow (step-by-step)

For an MCP call `unbrowse_fill { selector: "#username", value: "op://Personal/Twitter/username" }`:

1. **MCP boundary** (`src/mcp.ts:2822`): handler receives `value` as a
   string. It does NOT inspect the value — it forwards to the CLI dispatch
   layer along with the full `ArgScope` (every other arg in the call, for
   `arg://` resolution).
2. **CLI dispatch** (`src/cli.ts:cmdFill`, refactored to `breathFill` in v7):
   constructs a fill-context-hash `H = sha256(session_id || selector ||
   url || timestamp_ms)` and a 32-byte nonce `N = crypto.randomBytes(32)`.
3. **Pointer detection**: if `value` matches `<scheme>://...` for a
   registered scheme, treat as pointer; else treat as cleartext (which goes
   through the `arg://` null-store path with a synthesized
   `arg://__inline__` URI, so the receipt shape is uniform).
4. **Registry pick**: `registry.pick("op://...")` returns the `op` adapter.
   `adapter.ensureReady()` runs once per process (cached promise).
5. **Resolve**: `await using secret = await adapter.resolve(pointer, N)`
   shells `op read --no-newline 'op://Personal/Twitter/username'`,
   captures stdout into a Buffer, computes
   `commitment = sha256(buf || N)`.
6. **ZK signer** (sibling subagent's territory — out of scope here):
   produces a signature `S` over `(pointer || N || H || commitment)`.
7. **CDP fill primitive** (sibling subagent's territory — also out of
   scope): receives `secret.value` (Buffer), calls `Input.insertText` with
   the string form (the ONE allowed `.toString()` site, marked with
   `// eslint-disable-next-line no-tostring-on-secret -- CDP boundary`).
8. **Ledger write**: covenant body lands with pointer + commitment + nonce
   + signature. No value.
9. **Scope exit**: `Symbol.asyncDispose` fires; `sodium.memzero(secret.value)`
   zeroes the Buffer; the reference is nulled. Within ~50 ms of step 7.
10. **Stderr drain**: adapter stderr (if any) is scrubbed and discarded;
    never logged, never returned.

If any step fails between 5 and 7 (CDP throws, signer rejects), the
disposal STILL fires (try/finally inside `breathFill`), and a
`fill_failed` covenant lands with the pointer but NO value, NO commitment
(commitment leaks "this exact value was attempted" — refuse to commit on
failure).

---

## CLI tree (three verbs) + 1:1 kind+MCP mapping

```
unbrowse build  <subcmd>      # declare patterns (Father / KindSpec emission)
   skill         <skill-id>      register a skill manifest
   template      <name>          declare a fill/exec template (selectors + pointers)
   value-source  <pointer>       declare a vault item (one-time write to keychain/op)

unbrowse breath <subcmd>      # runtime animation (Spirit / side-effectful verbs)
   go            <url>           navigate
   fill          <selector> <pointer>     dereference + Input.insertText
   type          <selector> <pointer>     dereference + per-char dispatch
   click         <selector>      mouse-click
   press         <key>           keyboard event
   select        <selector> <pointer>     <option> chooser
   scroll        <amount>        scroll
   submit        [selector]      submit form
   execute       <endpoint-id>   run a captured endpoint (headers/body via pointers)
   auth-capture  <domain>        interactive auth flow → vault write
   proxy-rotate                  rotate the residential proxy
   close                         close the browse session

unbrowse eval   <subcmd>      # read-only queries (Son / witness)
   snap                          a11y snapshot of current page
   resolve       <intent>        shortlist of endpoints for an intent
   status                        current session status
   version                       CLI + signed manifest version
   trace         <session-id>    full decision_trace for a session
   markdown                      readable page text
   screenshot                    PNG of current page
   text                          stripped page text
   cookies                       cookie listing (names only, no values)
   stats                         marketplace + earnings stats
   skills                        list skills
   skill         <skill-id>      one skill detail
   sessions                      list browse sessions
   earnings                      x402 earnings summary
   settings                      current config
   feedback                      submit feedback on last execute (commitment-only)
   reflect                       reflect on user-facing outcome
```

### 1:1 mapping table

| CLI subcommand                | MCP tool                        | Covenant kind          | Verb    |
|-------------------------------|---------------------------------|------------------------|---------|
| `build skill`                 | `unbrowse_publish`              | `skill_declare`        | build   |
| `build template`              | `unbrowse_annotate`             | `fill_template_declare`| build   |
| `build value-source`          | (none — local-only)             | `value_source_declare` | build   |
| `breath go`                   | `unbrowse_go`                   | `actuate_navigate`     | breath  |
| `breath fill`                 | `unbrowse_fill`                 | `actuate_fill`         | breath  |
| `breath type`                 | `unbrowse_type`                 | `actuate_type`         | breath  |
| `breath click`                | `unbrowse_click`                | `actuate_click`        | breath  |
| `breath press`                | `unbrowse_press`                | `actuate_press`        | breath  |
| `breath select`               | `unbrowse_select`               | `actuate_select`       | breath  |
| `breath scroll`               | `unbrowse_scroll`               | `actuate_scroll`       | breath  |
| `breath submit`               | `unbrowse_submit`               | `actuate_submit`       | breath  |
| `breath execute`              | `unbrowse_execute`              | `actuate_execute`      | breath  |
| `breath auth-capture`         | `unbrowse_auth_capture`         | `actuate_auth_capture` | breath  |
| `breath proxy-rotate`         | (new MCP: `unbrowse_proxy_rotate`)| `actuate_proxy_rotate`| breath  |
| `breath close`                | `unbrowse_close`                | `actuate_close`        | breath  |
| `eval snap`                   | `unbrowse_snap`                 | `observe_snap`         | eval    |
| `eval resolve`                | `unbrowse_resolve`              | `observe_resolve`      | eval    |
| `eval status`                 | `unbrowse_health`               | `observe_status`       | eval    |
| `eval version`                | (new MCP: `unbrowse_version`)   | `observe_version`      | eval    |
| `eval trace`                  | `unbrowse_trace`                | `observe_trace`        | eval    |
| `eval markdown`               | `unbrowse_markdown`             | `observe_markdown`     | eval    |
| `eval screenshot`             | `unbrowse_screenshot`           | `observe_screenshot`   | eval    |
| `eval text`                   | `unbrowse_text`                 | `observe_text`         | eval    |
| `eval cookies`                | `unbrowse_cookies`              | `observe_cookies`      | eval    |
| `eval stats`                  | `unbrowse_stats`                | `observe_stats`        | eval    |
| `eval skills`                 | `unbrowse_skills`               | `observe_skills`       | eval    |
| `eval skill`                  | `unbrowse_skill`                | `observe_skill`        | eval    |
| `eval sessions`               | `unbrowse_sessions`             | `observe_sessions`     | eval    |
| `eval earnings`               | `unbrowse_earnings`             | `observe_earnings`     | eval    |
| `eval settings`               | `unbrowse_settings`             | `observe_settings`     | eval    |
| `eval feedback`               | `unbrowse_feedback`             | `observe_feedback`     | eval    |
| `eval reflect`                | `unbrowse_reflect`              | `observe_reflect`      | eval    |

Every row: one CLI subcommand ↔ one MCP tool ↔ one covenant kind ↔ one of
three verbs. No exceptions. v7 deprecates anything that doesn't fit this
shape.

---

## v6 → v7 backwards-compat plan

**Recommendation: clean break with migration guide.** No `unbrowse legacy`
alias layer.

Rationale:

1. The v6 CLI surface has ~50 flat subcommands (`go`, `fill`, `resolve`,
   `execute`, `auth`, `wallet`, `dashboard`, `note`, `sandbox-replay`,
   `contract-bridge`, `corpus-test`, …). Aliasing each one into a verb
   doubles the test matrix permanently.
2. v7 is an atomic rip — Kuri is gone, the value-store layer is new, the
   ledger schema changes. A "legacy" alias would pretend v6 semantics
   still hold while the backend rejects them. Worse than the break.
3. The MCP tool names (`unbrowse_go`, `unbrowse_fill`, …) stay STABLE.
   Agents that drive via MCP don't see the CLI restructure. Only humans
   typing `unbrowse <cmd>` at a shell see the change.

Concrete breaks (humans only):

| v6 form                                  | v7 form                          |
|------------------------------------------|----------------------------------|
| `unbrowse go <url>`                      | `unbrowse breath go <url>`       |
| `unbrowse fill <sel> <val>`              | `unbrowse breath fill <sel> <ptr>` |
| `unbrowse resolve <intent>`              | `unbrowse eval resolve <intent>` |
| `unbrowse execute --endpoint <id>`       | `unbrowse breath execute <id>`   |
| `unbrowse health`                        | `unbrowse eval status`           |
| `unbrowse stats`                         | `unbrowse eval stats`            |
| `unbrowse publish`                       | `unbrowse build skill <id>`      |
| `unbrowse auth-capture`                  | `unbrowse breath auth-capture`   |

Migration guide ships in `docs/v6-to-v7-cli-migration.md` alongside the
v7.0.0 tag. The skill manifest (`packages/skill/SKILL.md`) is rewritten in
the same commit to reference v7 commands only.

Out-of-scope-but-named: `unbrowse contract-bridge`, `unbrowse mcp`,
`unbrowse serve` remain top-level (not verb-prefixed) — they are
*meta* commands that LAUNCH the agent surface rather than acting through
it. Same for `unbrowse setup`.

---

## `arg://` + tool-call-as-adapter semantics

Lewis's directive: *"options to fill will always be the input to tool calls
- as a perfect adapter to it"*. Operationally:

1. **Every MCP tool argument is implicitly a pointer.** A caller invoking
   `unbrowse_fill { value: "lewis" }` is semantically equivalent to
   `unbrowse_fill { value: "arg://__inline__", argScope: { __inline__: "lewis" } }`.
   The CLI/MCP layer wraps it; the adapter resolves `arg://__inline__`
   from the synthetic scope; the fill-time flow is byte-identical to the
   `op://` path including the commitment + zero pass.
2. **Cleartext via the same trait.** An agent that doesn't care about
   vaults still gets a uniform receipt shape. The covenant body still
   carries `pointer: "arg://__inline__"` + commitment + nonce. The value
   still zeroes within 50 ms.
3. **Free agent choice.** Three valid call shapes for the same fill:
   ```jsonc
   // (a) cleartext, agent trusts the channel
   { "selector": "#u", "value": "lewis" }
   // (b) op pointer, agent wants vault audit
   { "selector": "#u", "value": "op://Personal/Twitter/username" }
   // (c) explicit arg pointer with structured payload
   { "selector": "#u", "value": "arg://creds/username",
     "creds": { "username": "lewis", "password": "..." } }
   ```
   All three land an identical receipt shape. Only the pointer string
   differs.
4. **Pass-through to children.** A skill (sequence of fills + executes)
   can carry pointers in its template, and the calling agent supplies
   `argScope` once at invocation. Every `arg://` inside the template
   resolves against that scope. No re-prompting mid-flow.
5. **`arg://` is the v7 alternative to "interpolate the agent's string
   into a fill".** It makes the interpolation *explicit*, *typed*, and
   *receipted*. Agents that used to pass `${USERNAME}` template strings
   in v6 should pass `arg://username` in v7.

---

## Open questions

1. **Sodium dep weight.** `sodium-native` is ~2 MB compiled across
   platforms. Worth the cost for `memzero`? Alternative:
   `Uint8Array.fill(0)` + a comment-doc disclaimer that this is
   best-effort under V8. Recommend: ship sodium, the moat is honest
   key handling.
2. **`keychain-secure://` write path.** v7 has no `unbrowse build
   value-source` implementation yet — Lewis writes items via Keychain
   Access UI. Should we ship a write subcommand that creates ACL-
   protected items? Defer to v7.1.
3. **Bitwarden self-host detection.** `bw config server` may point at a
   self-hosted vaultwarden; the adapter is agnostic, but should we
   surface the server URL in the receipt for audit? Probably yes, as
   `adapter_endpoint` sibling field on the receipt.
4. **`op` Connect server.** 1Password also has a self-hosted Connect
   API path (`op://` resolves through Connect instead of CLI). For v7
   we shell `op` exclusively; Connect support is v7.1+.
5. **Adapter timeout policy.** What's the max wall-clock per `resolve()`?
   `op read` can take 1-3 s on cold start; `bw get` similar. Propose
   5 s default, configurable via `UNBROWSE_ADAPTER_TIMEOUT_MS`. Timeout
   = `AdapterTimeoutError`, no commitment, no receipt.
6. **`arg://__inline__` in receipts.** Does landing the literal commitment
   of an inline cleartext value leak too much in the ledger? Commitment
   IS sha256(value || nonce); knowing the nonce + value lets you verify,
   but the nonce is per-call random. Acceptable; document it.
7. **Multi-adapter pointers.** Should `op://...|keychain://...` syntax
   exist for "try op first, fall back to keychain"? Defer to v7.1 —
   v7.0 is one-pointer-per-fill.
8. **Telemetry envelope.** The current `unbrowse_reflect` schema accepts
   `outcome: "success" | "failure" | "partial"` and nothing else. Confirm
   the schema diff catches accidental addition of a `value`-shaped field.
