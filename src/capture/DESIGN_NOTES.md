# src/capture — Design Notes

## What lives here

`index.ts` — legacy CDP capture (~3k lines). `engine.ts` — firmament: selects obscura vs CDP, returns intersection (`CapturedRoutes{routes,engine,domain,finalUrl,blocked}`) — neither engine imports the other. `passive-index.ts` — `deferCapturePipeline` + `drainDeferredCaptureWork` (never blocks foreground). `hole-template.ts` + `obfuscate*` + `wallet-bind.ts` — thin-client boundary: secrets → commitments before `reveng-server-first.ts` POSTs structure only.

## The invariant (load-bearing)

**Only structure leaves the machine.** `obfuscate.ts` replaces every secret/PII *value* with a one-way wallet-bound commitment; `reveng-server-first.ts` POSTs `{method, URL shape, param keys, schema}` to `POST /v1/reveng`. Server sees shape, never value. `scripts/thin-client-gate.sh` enforces that no moat module is importable from the public client closure. Credentials never leave as plaintext.

## How to add a capture path

- Adding a new site's capture: add to `src/capture/` then call `passiveIndexFromRequests(requests, pageUrl, {publishAfterIndex: true})` via `src/api/routes.ts`. The heavy reveng→index→publish runs in background (`queueBackgroundIndex`) — do not `await` it from the orchestrator's hot path.
- Adding an obscura feature: branch in `engine.ts`, not inside `capture/index.ts` (signal `tests/obscura-capture-signals.test.ts` asserts `capture/index.ts` stays obscura-free).
- Treat obscura sidecar NDJSON as an untrusted process boundary: `parseObscuraCapture` validates each record structurally and skips malformed records before constructing `RawRequest` values. The Jazzer target in `fuzz/obscura-capture.fuzz.ts` guards totality and determinism.
- Never import `capture/index.ts` into obscura code or vice versa; shared currency is `RawRequest`.

## Gotchas

- `routes: []` is ambiguous — distinguish `error: "origin_down"` vs `blocked: [{url, vendor}]` vs static HTML (no XHR). Measured: obscura vs Chrome can return opposite outcomes for same URL (defillama example in `engine.ts` docs).
- `walker-*` vs `passive-index` are different seams: walker is same-origin link-follow (`maxFollow`), passive-index is current-page XHR observation only.

## Persistence

Auth lives in `~/.unbrowse/obscura/<domain>/cookies.json` — `src/auth/artifact-bridge.ts` seeds it from `findBestBrowserSession(domain)` into `~/.unbrowse/obscura/x.com/cookies.json` (0600 camelCase) and `obscura-index.ts` passes it as `RunObscuraCaptureOptions{storageDir}` (`--storage-dir`). Obscura loads it (`context.rs` `load_from_file` on `storage_dir/cookies.json`) and writes it back; `localStorage/<origin>.json` survives alongside. Next call starts logged in without re-ripping Firefox. Ephemeral `/tmp/unbrowse-jar-*` only when a caller passes an explicit `cookiesDir`.

## Impersonation ladder

The anti-bot fetch ladder is walked in one place (`fetch-ladder.ts:walkFetchLadder`) and
from the orchestrator's rescue paths — the order is intentional: cheapest impersonation
first, most expensive browser last.

| Order | Rung | Helper | Venv | What it clears |
|-------|------|--------|------|----------------|
| 1 | `impersonate-direct` | `scripts/curl-impersonate-fetch.py` (`curl_cffi`) | `scripts/.curl-impersonate-venv` (`pip install curl_cffi`) | TLS-fingerprint-only blocks (e.g. youtube) without proxy |
| 2 | `impersonate-proxy` | same helper via residential proxy | same venv + `UNBROWSE_PROXY_URL` / `IPROYAL_*` | TLS-fingerprint + IP-reputation blocks |
| 3 | `camoufox` | `scripts/camoufox-fetch.py` | `scripts/.camoufox-venv` (`pip install camoufox[geoip] && python -m camoufox fetch`) | Cloudflare / Tencent JS challenges (C++-level fingerprint spoofing, invisible to JS) — **heavy/optional** (~200 MB Firefox) |
| 4 | `patchright-headed` | `scripts/patchright-fetch.py` (headed Chrome) | `scripts/.patchright-venv` (`pip install patchright && patchright install chrome`) | JS-challenge class that survives TLS spoofing (18/100 corpus sites in `bench/sites100/CHALLENGE-RATE-FINDINGS.md`); requires `DISPLAY` or `xvfb-run -a`; never silently falls back to headless (`HeadlessChrome` UA leak) |

**Honest degradation (load-bearing):** every rung is optional. When its venv, helper,
or runtime requirement is absent the TS caller (`tryCurlImpersonateFetch` /
`tryPatchrightFetch` / camoufox equivalent) returns **`null`** and the ladder advances
— never a throw, never a fake result. `patchright-fetch.py` also returns
`{ok:false, error:"no_display_for_headed"}` rather than silently running headless.
Uninstalled = skip, so a fresh checkout with no venvs still works (just without anti-bot egress).

**Provisioning:** `bash scripts/setup-impersonation.sh` provisions all three venvs
idempotently (exists → skip; failures logged not fatal). Flags: `--only RUNG`,
`--force`, `SKIP_CAMOUFOX=1`, `SKIP_PATCHRIGHT=1`, `--help`. Do not provision venvs
implicitly at runtime — provisioning is explicit so the ladder's null-means-skip
contract stays honest and auditable.

