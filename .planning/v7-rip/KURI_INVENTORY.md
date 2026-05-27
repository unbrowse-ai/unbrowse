# Kuri rip inventory (v7)

## Summary

- **Total files referencing kuri (whole repo, all surfaces):** 1,109 indexed paths (incl. docs, evidence, frontend caches). Code-surface only (src/, backend/, packages/, tests/, scripts/, .github/workflows/, submodules/openclaw-unbrowse-plugin/): **~100 files** (de-duped after collapsing the `packages/skill/src` and `packages/skill/runtime-src` mirrors of `src/`).
- **Direct src/ importers (will need rewrite):** **14** TypeScript files import from `./kuri/client.js`, `./kuri/spawn.js`, `./kuri/stateless/*`, or `./env/kuri-proxy-bridge.js`.
- **Test files asserting kuri behavior:** **32** test files (`tests/`), of which **22** have `kuri` in the filename; plus 1 in `evals/kuri-capture.test.ts`. ~9 additional tests reference kuri without being kuri-named (e.g. `cookie-injection-at-capture`, `browser-attach-setting`, `headless-default-opt-in-visible`, `auth-interactive-login`, `auth-force-visible-headless-lock`, `browse-session-per-session-kuri`).
- **Vendor/binary surfaces:** **5** packaging scripts (`assert-kuri-vendor.mjs`, `build-kuri-binaries.mjs`, `lib/kuri-vendor.mjs`, `prepare-pack.mjs`, `precommit-kuri-vendor.sh`) + the `packages/skill/vendor/kuri/` baked-binary tree + `submodules/kuri/`.
- **CI surfaces:** **11** GitHub Actions workflows touch kuri; 2 are kuri-dedicated (`kuri-vendor.yml`, `kuri-windows-cross-build.yml`); 9 reference it incidentally.
- **OpenClaw submodule:** depends on `@unbrowse/sdk` v6 (today) and `@unbrowse/client` v7 (in flight) — does **NOT** directly import or spawn kuri. Single doc reference in `CHANGELOG.md` only.
- **SDK package (`packages/sdk/`):** zero direct kuri references. Peer-dep `unbrowse@>=6.15.0` (which today bundles kuri) is the only coupling.
- **Removal blast radius estimate: L (large)** — kuri is the only browser substrate; ripping it leaves 14 src/ importers, 32 tests, and 5 packaging scripts orphaned, plus a 5-binary-per-platform vendor tree to delete. The submodule itself is the only thing whose rip is reversible (gitlink unlinks cleanly).

## (a) `src/kuri/` public surface

| Path | Lines | Role |
|---|---|---|
| `src/kuri/client.ts` | 2,182 | The wrapper. Manages broker lifecycle (spawn, port discovery, restart, kill), broker pool keyed by port, spawn semaphore, CDP attach decisions, tab lifecycle, network/HAR, evaluate/cookies/auth profiles. **89 KB single file.** |
| `src/kuri/spawn.ts` | 73 | `ensureKuriSandboxReachable(kuriBase)` — alt spawn path that hits a sandbox kuri at `127.0.0.1:8080`, used by execution/proxy fastpath. |
| `src/kuri/stateless/layer1-tls.ts` | 106 | Scaffolded TLS-spoof primitive (contract `18d1a651`) — ephemeral per call. |
| `src/kuri/stateless/layer2-http.ts` | 73 | Scaffolded HTTP-over-TLS-pointer (contract `f9ffafc4`). |
| `src/kuri/stateless/layer3-runtime.ts` | 76 | Scaffolded browser-runtime (ephemeral chrome per call, contract `0af18e9f`). |
| `src/kuri/stateless/layer4-page.ts` | 37 | Scaffolded page-control (CDP nav/eval/intercept, contract `c9d8f459`). |
| `src/kuri/stateless/layer5-capture.ts` | 39 | Scaffolded HAR/fetch/XHR/ws/perf capture (contract `bbe92ca2`). |
| `src/kuri/stateless/layer6-auth.ts` | 52 | Scaffolded auth-bridging cookie SQLite reader (contract `75dd360f`). |
| `src/kuri/stateless/README.md` | 71 | Design doc — "make kuri stateless by /contract-ing the chrome-spoof primitives". Status: scaffolded, not wired. Gated by `UNBROWSE_STATELESS_LAYER=1..6`. |

### Exported public surface of `src/kuri/client.ts`

Types: `KuriTab`, `KuriCookie`, `KuriActionType`, `KuriWaitResult`, `KuriDomQueryResult`, `KuriHarEntry`, `KuriPluginRehydrateResult`, `KuriLaunchConfig`, `KuriClient`.

Lifecycle: `start`, `stop`, `getKuriClient`, `resolveKuriLaunchConfig`, `resolveKuriPort`, `reuseHealthyBrokerIfPossible`, `shouldReuseManagedChrome`, `findKuriBinary`, `getKuriBinaryCandidates`, `getKuriSourceCandidates`, `getPort`, `getCdpPort`, `setCdpPortForTests`, `isReady`, `waitForProcessExit`, `_kuriSpawnSemaphoreStateForTests`, `health`.

Tabs/navigation: `discoverTabs`, `getDefaultTab`, `navigate`, `newTab`, `closeTab`, `goBack`, `goForward`, `reload`, `getCurrentUrl`.

Page/eval: `evaluate`, `getKuriErrorMessage`, `getPageHtml`, `getText`, `getMarkdown`, `screenshot`, `snapshot`, `findText`, `getLinks`, `getConsole`, `getErrors`, `getPerfLcp`, `domQuery`, `domHtml`, `domAttributes`, `scriptInject`, `addInitScript`, `injectStealthScript`, `executeInPageFetch`, `extractLoadPlugins`, `extractLoadPluginsFromHtml`, `bestEffortRehydratePlugins`.

Cookies/auth: `getCookies`, `setCookie`, `setCookies`, `setHeaders`, `setCredentials`, `setViewport`, `setUserAgent`, `authProfileSave`, `authProfileLoad`, `authProfileList`, `authProfileDelete`, `sessionSave`, `sessionLoad`, `sessionList`.

Network: `harStart`, `harStop`, `networkEnable`, `interceptStart`, `getNetworkEvents`.

Cloudflare: `hasCloudflareChallenge`, `waitForCloudflare`.

User input: `action`, `click`, `fill`, `select`, `scroll`, `press`, `keyboardType`, `keyboardInsertText`, `keyDown`, `keyUp`, `scrollIntoView`, `drag`, `waitForSelector`, `waitForLoad`.

This is **the surface v7 must reproduce** (likely as raw `chrome-remote-interface` adapters grouped by covenant verbs).

## (b) Direct importers in `src/` (will need rewrite)

All import `./kuri/client.js` (or `../kuri/client.js`) unless noted. Mirror copies under `packages/skill/src/` and `packages/skill/runtime-src/` are auto-generated by `prepare-pack.mjs` (`cpSync src → runtime-src`) — they will rebuild from src/ post-rip.

| Path | Imported | Notes |
|---|---|---|
| `src/server.ts:11,14` | `* as kuri from "./kuri/client.js"`, `bridgeKuriProxyEnv` from `./env/kuri-proxy-bridge.js` | Bootstrap. Calls `bridgeKuriProxyEnv()` before any kuri spawn. |
| `src/cli.ts:12` | `bridgeKuriProxyEnv` | Same proxy bridge wired at CLI entry. |
| `src/api/routes.ts:5-6` | `kuri/client`; also reads `KURI_PORT` env at L79 | HTTP API surface for `/browse/*`. |
| `src/api/browse-index.ts:15` | `kuri/client` | Browse-index DOM-fallback path. |
| `src/api/browse-session.ts:2` | `kuri/client` | Session create/destroy. |
| `src/auth/index.ts:1` | `kuri/client` | Interactive auth + auth-profile lifecycle. |
| `src/browser/index.ts:1-2` | `kuri/client` | High-level browser facade used by capture/orchestrator. |
| `src/capture/index.ts:1` | `kuri/client` | HAR + interceptor capture pipeline. |
| `src/execution/index.ts:3,222,4111,4160` | `kuri/client`, `kuri/spawn` (sandbox path) + `KURI_` env reads | execute() ladder; `proxy-fetch` calls `ensureKuriSandboxReachable`. |
| `src/execution/token-resolver.ts:209,211` | `kuri/client` | Token-source replay. |
| `src/orchestrator/index.ts:11,4959` | `kuri/client` | Resolve/browse-session orchestrator. |
| `src/orchestrator/browser-agent.ts:10-11` | `kuri/client` | Agent-driven browser drive. |
| `src/orchestrator/first-pass-action.ts:1-2` | `kuri/client` | First-pass 8s capture probe. |
| `src/runtime/setup.ts:6` | `kuri/client` | `unbrowse setup` install/bootstrap. |
| `src/contract-fetch.ts:29` | `kuri/stateless/layer*` (covenant-shape fetch impl) | The v7 shape entry that already calls stateless layers. |
| `src/contract-shape/impl/contract-fetch.ts:6` | `kuri/stateless/layer*` | Mirror impl under contract-shape registry. |
| `src/env/kuri-proxy-bridge.ts` | (not an importer — it IS the bridge; configures `KURI_PROXY` / `KURI_DISABLE_CDP_ATTACH` env before spawn) | 134 LOC; per-file docblock explains the bridge is the load-bearing replacement for editing `kuri/client.ts` directly (the wrapper is the "do not edit unless asked" surface). |

**Indirect (consume kuri via the importers above, no direct import):** `src/lib/local-capabilities.ts` (docs the kuri capability), `src/single-binary.ts` (docs the `~/.unbrowse/bin/kuri` install), `src/settings.ts` (browser-attach setting feeds `resolveKuriLaunchConfig`), `src/setup/claude-mcp-register.ts` (env passthrough), `src/runtime/in-process-app.ts`, `src/runtime/local-server.ts`, `src/runtime/browser-host.ts`, `src/mcp.ts`, `src/telemetry.ts`, `src/sandbox/bundle-replay-client.ts`, plus the `execution/*-challenge.ts` family (cf/akamai/kasada/px), `src/execution/drift-page-recovery.ts`, `src/execution/probe.ts`, `src/execution/proxy-fetch.ts`, `src/capture/curl-impersonate-fallback.ts`, `src/capture/ssr-fastpath.ts`, `src/cli-cookies.ts`, `src/client/index.ts`, `src/auth/stale-endpoints.ts`, `src/contract-shape/registry.ts`. These read kuri-shaped state through `./browser/`, `./capture/`, `./orchestrator/` rather than direct imports.

## (c) Test surface (32+ files)

### Kuri-dedicated tests (22)

`tests/kuri-attach-default-off.test.ts`, `kuri-client.test.ts` (81 refs — main wrapper test), `kuri-e2e.test.ts` (66 refs — true e2e), `kuri-evaluate-error-shape.test.ts`, `kuri-execute-in-page-fetch.test.ts`, `kuri-headless-adversarial.test.ts`, `kuri-headless-default.test.ts`, `kuri-port-selection.test.ts`, `kuri-proxy-patch-shape.test.sh`, `kuri-setcookie-no-silent-fallback.test.ts`, `kuri-spawn-env.test.ts`, `kuri-spawn-gate.test.ts`, `kuri-spawn-semaphore.test.ts`, `kuri-stale-recovery.test.ts`, `kuri-stop-waits-for-exit.test.ts`, `kuri-vendor-build.test.ts`, `kuri-vendor-manifest-fresh-meta.test.sh`, `kuri-vendor-manifest-fresh.test.sh`, `kuri-vendor-presence.test.ts`, `kuri-vendor-workflow-shape.test.sh`, `plan-v11-kuri-proxy-doc.test.sh`, `tests/browse-session-per-session-kuri.test.ts`.

### Tests asserting kuri behavior indirectly (≥6 refs each)

`auth-force-visible-headless-lock.test.ts` (19), `auth-hint-login-surfaces.test.ts`, `auth-interactive-login.test.ts` (19), `bench-gate-collector-force-headless.test.ts`, `bench-gate-mcp.test.ts` (10), `bench-gate-skip-empty-snapshot.test.ts`, `browse-close-broker-stop-detached.test.ts` (6), `browse-close-ssr-no-requests.test.ts`, `browse-go-conc-pipeline.test.ts`, `browse-index-dom-fallback-cookies.test.ts`, `browse-index.test.ts`, `browse-session-recovery.test.ts`, `browser-attach-setting.test.ts` (8), `browser-block-signals.test.ts`, `browser-lazy-tab.test.ts`, `capture-lazy-api-wait.test.ts`, `capture-noise-aware-early-exit.test.ts`, `capture-phase-timeout.test.ts`, `cdp-auth-header-capture-replay.test.ts`, `cf-capture-shape-meta.test.sh`, `cli-e2e.test.ts`, `cookie-injection-at-capture.test.ts` (26), `direct-document-fetch.test.ts`, `drift-page-recovery.test.ts`, `execute-page-artifact-http0-ssr-fastpath.test.ts`, `first-pass-action.test.ts` (6), `getpagehtml-retry-on-shell-pin.test.ts`, `github-issue-regressions.test.ts` (13), `har-headers-guard.test.ts`, `harness-visible-step.test.ts`, `headless-default-opt-in-visible.test.ts` (19), `integration-headless-golden.test.ts`, `kasada-challenge-shape.test.sh`, `mcp-handler-timeout.test.ts`, `mcp-snap-detail-levels.test.ts`, `mcp-stale-daemon-probe.test.ts`, `named-session-broker-isolation.test.ts`, `no-match-next-step.test.ts`, `proxy-passthrough.test.ts`, `release-assets.test.ts`, `reverse-engineer-admission.test.ts`, `runtime-paths.test.ts`, `runtime-setup.test.ts`, `session-rehydrate.test.ts`, `shell-only-html-fallback-pin.test.ts`, `skill-package-runtime.test.ts`, `source-skill-id-cross-skill-execute.test.ts`, `ssr-fastpath.test.ts`, `thin-client-foundation.test.ts`, `w-stale-endpoint-page-fallback-wired.test.sh`, `exa-probe-fallback-gate.test.ts`, `d14-token-efficiency.test.ts`, `evals/kuri-capture.test.ts`.

### Backend tests

`backend/tests/contract-routes.test.ts` and `backend/tests/synthetic-fixture.test.ts` reference kuri in strings only (doc / fixture text). **Backend Worker runtime has zero kuri code** — confirmed by `mcp__codedb__codedb_search` returning 0 hits under `backend/src/**`. The Worker never spawns kuri.

## (d) Vendor / packaging surface

| Path | Role | Removal action |
|---|---|---|
| `submodules/kuri/` | Git submodule. **Populated** (not empty). Current SHA `f2487712b` (v0.3.3-32-gf248771), commit `feat(windows): kuri.exe + 4 sibling .exe's link clean on x86_64-windows-gnu`. **NOT on `adding-extensions` branch — detached HEAD on the same upstream branch.** `kuri-vendor.mjs` declares `upstreamBranch = "adding-extensions"` so freshness checks pass against that branch's tip. CLAUDE.md's "is it on adding-extensions" claim holds via `kuri-vendor.mjs` config, not via the submodule's checked-out branch. | `git submodule deinit submodules/kuri && git rm submodules/kuri` + delete `.gitmodules` entry. |
| `packages/skill/vendor/kuri/` | Baked binaries for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, plus `manifest.json` (sha256 per binary + `source_sha`). Shipped to npm. | `rm -rf packages/skill/vendor/kuri` + drop `"vendor/kuri"` from `packages/skill/package.json:files`. |
| `packages/skill/scripts/assert-kuri-vendor.mjs` | Prepack guard — verifies vendored binaries + manifest match `submodules/kuri` HEAD. | Delete; remove from `package.json:prepack` chain. |
| `packages/skill/scripts/build-kuri-binaries.mjs` | Build script — invokes `zig build` 4× for cross-targets, hashes outputs into manifest. | Delete; remove from `prepare-pack.mjs`. |
| `packages/skill/scripts/lib/kuri-vendor.mjs` | Library used by all kuri vendor scripts (`supportedTargets`, `monorepoKuriDir`, `vendoredKuriSourceDir`, `resolveSourceDir`, `detectBrokenMonorepoKuri`, `hashFile`, `readSourceSha`, `shouldRebuildVendoredKuri`). | Delete. |
| `packages/skill/scripts/prepare-pack.mjs` | Calls `detectBrokenMonorepoKuri` + `build-kuri-binaries.mjs`. | Remove the kuri-build invocation; keep the bun-build flow. |
| `packages/skill/package.json:11` | `"files": [..., "vendor/kuri", ...]` | Drop `"vendor/kuri"`. |
| `scripts/precommit-kuri-vendor.sh` | Pre-commit gate — blocks commits that bump `submodules/kuri` without rebuilding `vendor/kuri/manifest.json`. | Delete; remove from `scripts/precommit.sh`. |
| `scripts/precommit.sh` | Invokes `precommit-kuri-vendor.sh`. | Drop that invocation. |
| `scripts/check-packaged-kuri.sh` | Calls `bun test tests/runtime-paths.test.ts tests/runtime-setup.test.ts` + npm pack dry-run + `scripts/build-binaries.sh`. | Delete (or repurpose for v7 chrome-CDP smoke). |
| `scripts/build-binaries.sh` | Single-binary build smoke that exercises the kuri spawn ladder. | Likely rewrite for v7. |
| `scripts/ensure-submodules.sh` | Special-cases `submodules/kuri` (verifies HEAD vs superproject, warns if behind branch tip). | Drop the kuri-specific branch; keep the generic sync. |

## (e) CI surface

| Workflow | Kuri refs | Role |
|---|---|---|
| `.github/workflows/kuri-vendor.yml` | 17 | **Kuri-dedicated.** Native-builder matrix (darwin-arm64, windows-x64). `workflow_dispatch` builds via Zig 0.16.0 against branch `feat/sandbox-proxy` (note: drifted from `adding-extensions` declared in `kuri-vendor.mjs`). |
| `.github/workflows/kuri-windows-cross-build.yml` | 77 | **Kuri-dedicated.** Windows cross-link long-pole tracker. Always runs (deliberately failing) so the gap is visible. |
| `.github/workflows/test-windows.yml` | 32 | Pulls `kuri.exe` artifact from the cross-build, exercises Windows runtime paths. |
| `.github/workflows/release.yml` | 14 | Asserts vendored kuri before pack + publish (`assert-kuri-vendor.mjs`). |
| `.github/workflows/test.yml` | 10 | Tier-1 test suite — includes kuri-named tests. |
| `.github/workflows/deploy.yml` | 3 | Mentions kuri in env-passthrough comments. |
| `.github/workflows/preview.yml` | 1 | Doc reference. |
| `.github/workflows/pr-agent.yml` | 1 | Doc reference. |
| `.github/workflows/post-release-verify.yml` | 1 | Calls `scripts/post-release-verify.sh` (kuri-aware). |
| `.github/workflows/lint.yml` | 1 | Doc reference. |
| `.github/workflows/landing-funnel-optimize.yml` | 1 | Doc reference. |

## (f) Process-spawn surfaces

| Path | What it spawns |
|---|---|
| `src/kuri/client.ts:552-563` (`ensureUserChromeRunning`) | `spawn(chromeBin, [--remote-debugging-port=…, --headless=new, …])` — **direct Chrome spawn fallback** when no kuri/CDP found. |
| `src/kuri/client.ts:858-865` (`startOn`) | `spawn(binary, [], { env })` — spawns the kuri zig binary itself. |
| `src/kuri/client.ts:582-602` (`terminateBrokerOnPort`) | `execFileSync("lsof", ...)` + SIGTERM/SIGKILL to PID owners of the port. |
| `src/kuri/spawn.ts:56-64` | `spawn(kuriBin, [], { env, detached })` — sandbox-mode kuri spawn on `127.0.0.1:8080`. |
| `scripts/turbobox-setup-box.sh:39`, `scripts/turbobox-bench.sh:65` | `nohup /root/.unbrowse/bin/kuri > /dev/null 2>&1 &` — turbobox VM bootstrap. |
| `scripts/agent-experience-test.sh:122` | `os.path.exists('~/.unbrowse/bin/kuri')` — presence probe in remote-runner harness. |
| `submodules/kuri/install.sh` | Upstream install script (out of scope; will go with the submodule). |

## Environment variables (gates + tunables)

All read by `src/kuri/client.ts:resolveKuriLaunchConfig` (L275-336) and `startOn` (L757-863) unless noted.

| Var | Default | Role |
|---|---|---|
| `KURI_HEADLESS`, `HEADLESS` | true (post-Apr 2026 change) | Force-visible only when set to `false`/`0`. |
| `KURI_PORT` | `7700` | Broker listen port. |
| `KURI_EXTERNAL_PORT` | — | External-broker mode (skip spawn). |
| `CDP_URL` | — | Pre-existing CDP attach URL (turbobox mode). |
| `KURI_PROXY` | — | Read by Zig binary (`bridge/config.zig:23`); set by `src/env/kuri-proxy-bridge.ts`. |
| `BROWDIE_PROXY` | — | Alias for `KURI_PROXY` upstream. |
| `KURI_DISABLE_CDP_ATTACH` | — | Force managed Chrome (no attach to user's Chrome). Set by proxy bridge. |
| `KURI_ATTACH_EXISTING_CHROME` | — | Explicit attach override. |
| `KURI_CLEAN_ROOM`, `UNBROWSE_LOCAL_ONLY` | — | Clean-room launcher mode. |
| `UNBROWSE_KURI_TRACE` | off | Verbose kuri-side tracing. |
| `UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS` | `0,150,350` | CDP-resolve retry backoff list. |
| `UNBROWSE_KURI_SOURCE_DIR` | — | Override for `lib/kuri-vendor.mjs` source-dir resolution. |
| `UNBROWSE_REBUILD_KURI` | — | Force rebuild in `shouldRebuildVendoredKuri`. |
| `UNBROWSE_STATELESS_LAYER` | unset | `1..6` — opt-in wiring of `src/kuri/stateless/layer{N}.ts` replacements. **The escape hatch the v7 rip can land behind.** |

## Install-path conventions (per CLAUDE.md pkill set)

- **`~/.unbrowse/bin/kuri`** — canonical install path. Set by `src/single-binary.ts` (line 10 docs it), `src/lib/local-capabilities.ts:25`, and the postinstall (`packages/skill/scripts/postinstall.mjs`). Confirmed at `scripts/agent-experience-test.sh:122` and the evidence ledger. **Active path.**
- **`~/.kuri/bin/kuri`** — **NOT FOUND** in this codebase. The CLAUDE.md pkill set lists it (`pkill -9 -f '/\.kuri/bin/kuri( |$)'`) as a legacy install path likely left over from an older standalone kuri install. **Safe to drop from pkill set during rip.**
- `packages/skill/vendor/kuri/{target}/kuri` — vendored alongside the npm binary. Falls through to `~/.unbrowse/bin/kuri` after first extract.
- `submodules/kuri/zig-out/bin/kuri` — dev-build path used by `tests/kuri-proxy-patch-shape.test.sh:81`.

## OpenClaw plugin (`submodules/openclaw-unbrowse-plugin/`)

- **Does NOT directly import kuri.** Single string reference at `CHANGELOG.md:13` documenting the local/cloud split.
- Wraps `@unbrowse/sdk` v6 (binary-spawn driver `src/driver-sdk.ts`) and `@unbrowse/client` v7 (HTTP-first driver, in-flight). Both deps consume the unbrowse npm package which today bundles kuri; the plugin itself is rip-agnostic.
- Submodule v0.8.0 pinned at SHA in `.gitmodules` — independent release cadence. **No rip work required on the plugin.**

## SDK (`packages/sdk/@unbrowse/sdk`)

- Zero direct kuri references.
- `package.json` declares `peerDependencies.unbrowse: ">=6.15.0"` (optional) — the only kuri-coupling.
- `package.json` is marked `deprecated` in favor of `@unbrowse/client` v7 (HTTP-first).
- **No rip work required on the SDK** beyond pointing peer-dep at v7.

## Removal blast radius — grouped

1. **Tight inner core (must rewrite):** `src/kuri/**` (9 files, ~2.5K LOC) + 14 src/ importers (server, cli, api/routes, capture/index, execution/index, orchestrator/index, browser/index, auth/index, runtime/setup, contract-fetch, contract-shape impl, 3 orchestrator subordinates).
2. **Test surface (must rewrite or delete):** 22 kuri-named tests + ~30 tests asserting kuri behavior indirectly. Many can be deleted outright (vendor/build/spawn tests); browse/auth/capture/cookie tests need v7 replacements.
3. **Vendor/packaging:** 5 scripts + `vendor/kuri/` tree + `submodules/kuri/` + `precommit-kuri-vendor.sh` + the `prepack` hook entry. ~7 file deletions + 3 file edits.
4. **CI:** 2 workflows to delete (`kuri-vendor.yml`, `kuri-windows-cross-build.yml`), 1 to overhaul (`test-windows.yml` if Windows support survives the rip), 1 to trim (`release.yml` drops the `assert-kuri-vendor.mjs` step).
5. **Doc-only refs (do not block the rip):** every README/CHANGELOG/plan-v*.md/audits/.bench-* file. Whitepaper + docs/public/primitives carry kuri narratively — those are post-rip prose updates, not blockers.

## Open questions for the rip

1. **`UNBROWSE_STATELESS_LAYER` escape hatch** — the 6 scaffolded `src/kuri/stateless/layer{N}.ts` files are already plumbed through `src/contract-fetch.ts:29` and `src/contract-shape/impl/contract-fetch.ts:6`. Are these the v7 covenant verbs already (so the rip just renames `src/kuri/` → `src/cdp/` and the layers become the canonical path), or does v7 throw them away too and start from `chrome-remote-interface`?
2. **Chrome spawn fallback in `client.ts:539-580`** — `ensureUserChromeRunning` already shells out to Chrome directly with `--headless=new --remote-debugging-port=…`. Does v7 keep this as its sole launcher, or switch to `puppeteer-core` / `playwright-core` / a thinner `chrome-launcher`?
3. **Kuri-only features that don't have a 1:1 CDP equivalent:** HAR-style aggregated capture (`harStart`/`harStop`), `executeInPageFetch`, auth-profile keychain persistence (`authProfileSave/Load/Delete`), `bestEffortRehydratePlugins` (the WRS-specific rehydrate), `injectStealthScript`. Each needs an explicit v7 owner.
4. **Per-broker spawn semaphore + broker pool (`brokerClients` Map at `client.ts:207`)** — the design law in `stateless/README.md` explicitly calls for removing it. Does v7 keep ANY in-process broker reuse, or is every call a fresh CDP attach?
5. **Windows port status** — `kuri-windows-cross-build.yml` is the deliberately-failing long-pole gate; if the v7 substrate is `chrome-remote-interface` over Node, Windows comes for free. Confirm before deleting `test-windows.yml`.
6. **OpenClaw plugin v7 migration window** — `@unbrowse/sdk` (v6, binary-spawn, deprecated) still ships in `openclaw-unbrowse-plugin@0.8.0`. If the rip lands before the plugin migrates to `@unbrowse/client` v7, plugin users hit a broken binary-spawn. Sequence the plugin v0.9 release before unbrowse v7 GA, or keep `@unbrowse/sdk` shim alive on a v6.x maintenance branch.
7. **Submodule branch drift** — `kuri-vendor.mjs` declares `upstreamBranch = "adding-extensions"` but `kuri-vendor.yml:18` defaults to `feat/sandbox-proxy`. Confirm which branch the live `vendor/kuri/manifest.json` was actually built from before deleting the submodule (so any final pre-rip vendor rebuild lands clean).
8. **`UNBROWSE_KURI_PROXY` egress story** — v7 needs an equivalent path to apply residential proxies to the browser. `chrome-remote-interface` doesn't set `--proxy-server` for you; you launch Chrome with the flag yourself. Decide where the proxy bridge lands in v7 (`src/env/kuri-proxy-bridge.ts` still applies, just renamed).
