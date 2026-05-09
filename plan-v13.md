# Plan v13: Unlock the 7 BROWSER_BLOCK rows

## State of play (post-plan-v12)

- Released-package bench: 16/17 = 94% on the post-reclass corpus (after Phase A+A.5+C ship)
- Phase B (no-progress soft-deadline) shipped — bestbuy expected to flip on next bench
- **7 rows still excluded as BROWSER_BLOCK**:

| URL | Vendor (signal) | Tier |
|---|---|---|
| indeed.com/jobs | `vendor:cloudflare` | T1+T2A |
| decathlon.fr/search | `vendor:cloudflare` + `challenge_title` | T1+T2A |
| realtor.com/realestateandhomes | `vendor:perimeterx` | T1+T2B |
| footlocker.com/category/men/shoes | `vendor:perimeterx` | T1+T2B |
| canadagoose.com/us/en/shop | `vendor:perimeterx` | T1+T2B |
| hermes.com/us/en/category/men | empty signals (likely Akamai) | T2C |
| nike.com/w/mens-shoes | empty signals (likely Akamai/F5) | T2C+T3 |

Goal: flip these to PASS (or honest BROWSER_BLOCK with diagnostic) without
adding per-domain heuristics. CLAUDE.md ranker philosophy: every unlock must
be generic infrastructure, not site-specific.

## Substrate already shipped (do NOT re-do)

- ✓ libcurl-impersonate Chrome 131 JA4 fingerprint in Kuri sandbox
- ✓ `runBundleReplay` JS-in-sandbox executor (`src/sandbox/bundle-replay-client.ts`)
- ✓ `trySsrFastPathOnBlock` helper with 4 call sites
- ✓ `extractBundleSnapshot` for vendor-specific bundle URL detection (already
  emits CF/PX/Kasada/Akamai vendor codes from `requestUrls`)
- ✓ Residential proxy (IProyal) wired unbrowse-side
- ✓ Kuri Zig CURLOPT_PROXY patch on `feat/sandbox-proxy` branch (commit 894ecb9)
- ✓ Anti-bot visible-browser auto-fallback (`src/execution/index.ts:949`)

## Tier 1: Kuri vendor refresh (1-2 hours, mostly mechanical)

**Predicted unlock: 4-6 sites flip BLOCK→PASS purely from clean residential JA4**

CF + PerimeterX often classify on IP reputation + JA fingerprint. With:
1. Vendored Kuri carrying `CURLOPT_PROXY` patches (commit 894ecb9)
2. `UNBROWSE_PROXY_URL=http://...@geo.iproyal.com:12321` env set
3. Existing libcurl-impersonate Chrome 131 JA4

…many of the BLOCK sites simply pass without any challenge solver work. This
is the highest-leverage cheapest action.

### Surface

`packages/skill/vendor/kuri/manifest.json` (current state):
```json
{
  "branch": "adding-extensions",
  "source_sha": "973c6cf...",   // pre-CURLOPT_PROXY
  "binaries": {
    "darwin-arm64": { "source": "pre-staged", ... },
    "darwin-x64":   { "source": "placeholder", ... },  // FAKE — CI never built
    "linux-arm64":  { "source": "placeholder", ... },  // FAKE
    "linux-x64":    { "source": "placeholder", ... }   // FAKE
  }
}
```

Three of four binaries are placeholder. CI either never built them or the
build pipeline is broken. Fix BOTH problems in one pass.

### Phase A1: CI pipeline that builds patched Kuri for all 4 platforms

Source: `lekt9/kuri` fork, branch `feat/sandbox-proxy`, commit 894ecb9 or
later. Build with `zig build -Doptimize=ReleaseSafe -Dtarget=<triple>`.

GitHub Actions matrix:
- darwin-arm64 (macos-latest with zig)
- darwin-x64 (macos-latest with -Dtarget=x86_64-macos)
- linux-arm64 (ubuntu-latest with -Dtarget=aarch64-linux)
- linux-x64 (ubuntu-latest with -Dtarget=x86_64-linux)

Output: 4 binaries staged into `packages/skill/vendor/kuri/<platform>/kuri`,
`manifest.json` updated with real sha256 from each, source_sha bumped to the
sandbox-proxy HEAD commit.

### Phase A2: Bench harness verifies live IP-rep unlock

Run two-phase bench against the 7 BROWSER_BLOCK rows with
`UNBROWSE_PROXY_URL` set. Compare to the proxy-disabled baseline.

Expected outcome (informed prediction, not a contract):
- indeed, decathlon: CF often passes residential IP without challenge → PASS
- realtor, footlocker: PerimeterX is JA-sensitive but residential helps → 1-2 PASS, 1-2 still BLOCK
- canadagoose: PX with stricter checking → likely still BLOCK, needs Tier 2B
- hermes, nike: empty-signal probably Akamai → still BLOCK, gated on T2C

If 4+ flip: **coverage 16/16 = 100% on the post-reclass corpus** (T1 alone
clears most of the work).

### Falsifier

`tests/kuri-vendor-manifest-fresh.test.sh` (~40 LoC):
- All 4 platforms have `"source"` other than `"placeholder"`
- `source_sha` is on `feat/sandbox-proxy` branch and includes commit 894ecb9
- Each binary file >1MB (placeholders are typically tiny)
- `manifest.json` parses + sha256 of each file matches recorded sha256

### Cost

- ~1 hour CI workflow authoring (extend `release.yml` matrix or new
  `kuri-vendor.yml`)
- ~1 hour to run + commit binaries + manifest update
- ~30 min bench verification
- **Total: ~2.5 hours wall-clock**

---

## Tier 2A: Cloudflare bundle-replay challenge solver (~1 day)

**Predicted unlock when proxy alone insufficient: indeed, decathlon, plus
any future CF site that resists residential routing**

When `extractBundleSnapshot` emits `vendor:cloudflare` with a present
`bundle_url` matching `/cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js`,
the response is a challenge. The bundle JS computes a token, sets the
`cf_clearance` cookie, then re-issues the original request. We replay this
flow in Kuri's sandbox.

### Surface

`src/execution/index.ts:executeEndpoint` — when `classifyExecuteFailure`
returns `{ kind: "vendor_blocked", vendor: "cloudflare" }`, instead of
returning `vendor_blocked` immediately:

1. Fetch the challenge bundle URL (extracted from response body or
   inferred from the `cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js`
   pattern).
2. Build a `SandboxReplayRequest`:
   - `target_origin`: original request origin
   - `bundle_source`: fetched bundle JS verbatim
   - `seed_cookies`: any cookies already collected (incl. `__cf_chl_*`)
   - `proxy`: `UNBROWSE_PROXY_URL`
3. `runBundleReplay` executes the bundle in Kuri's sandbox. Bundle solves
   the JS challenge and writes `cf_clearance` cookie.
4. Read returned cookies from the sandbox; merge `cf_clearance` into the
   request cookie jar.
5. Retry the original `serverFetch` with the now-armed cookie.

### Pseudocode

```ts
if (classifyResult.kind === "vendor_blocked" && classifyResult.vendor === "cloudflare") {
  const bundleUrl = extractCfBundleUrl(responseBody, originalUrl);
  if (bundleUrl) {
    const bundleSource = await fetchBundleSource(bundleUrl, proxyEnv);
    if (bundleSource && bundleSource.length > 1024) {
      const replay = await runBundleReplay({
        targetOrigin: new URL(originalUrl).origin,
        targetHref: originalUrl,
        bundleSource,
        seedCookies: existingCookies,
        proxy: process.env.UNBROWSE_PROXY_URL,
      });
      const cfClearance = replay.cookies?.find((c) => c.name === "cf_clearance");
      if (cfClearance) {
        // Retry original request with cf_clearance armed
        const retried = await serverFetch(originalUrl, {
          ...originalOpts,
          cookies: [...existingCookies, cfClearance],
        });
        if (retried.ok) {
          return { /* success path */ };
        }
      }
    }
  }
  // CF challenge solver couldn't unlock — fall through to vendor_blocked return
}
```

### Detection helper

```ts
export function extractCfBundleUrl(body: string, requestUrl: string): string | null {
  // CF challenge HTML embeds: <script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js">
  const m = body.match(/\/cdn-cgi\/challenge-platform\/h\/[gb]\/scripts\/jsd\/[a-f0-9]+\/main\.js/);
  if (!m) return null;
  return new URL(m[0], requestUrl).toString();
}
```

### Falsifier

`tests/cf-bundle-replay-shape.test.sh` + unit:
- `extractCfBundleUrl` finds bundle URL in CF challenge HTML
- `extractCfBundleUrl` rejects non-CF analytics paths (`/cdn-cgi/scripts/email-decode/...`)
- `runBundleReplay` accepts `bundleSource` from CF and returns `cookies` array
- Catch-block in `executeEndpoint` calls solver only on `vendor:cloudflare`,
  not other vendors
- E2E walk: synthetic `403 + CF challenge body` → solver invoked → cookies
  returned → retry succeeds

### Cost

- ~80 LoC in `src/execution/index.ts` (detector + solver call site)
- ~30 LoC in `src/execution/cf-challenge.ts` (new helper for `extractCfBundleUrl`)
- ~120 LoC tests (8 falsifiers including 1 with real CF challenge fixture)
- **~1 day wall-clock + 1 commit**

---

## Tier 2B: PerimeterX bundle-replay (~1.5 days)

**Predicted unlock: realtor, footlocker, canadagoose**

PerimeterX uses a different bundle URL pattern + different cookie scheme:
- Bundle: `/<UUID>/<UUID>/init.js` (UUID/UUID/init|tl|xhr|ips.js)
- Cookies set: `_pxhd`, `_px3`, `pxsid`
- Sensor data: POST to `/<UUID>/<UUID>/xhr` with collected fingerprint

Pattern same as CF but the bundle URL detection regex is different and the
cookie names differ. Worth a separate Phase to keep diff size manageable.

### Surface

Mirror Tier 2A:
1. `extractPxBundleUrl` regex against PX challenge response
2. Solver call site: `classifyResult.vendor === "perimeterx"`
3. Read `_pxhd` + `_px3` cookies from `runBundleReplay` result
4. Retry with armed cookies

### Risk

PerimeterX is more aggressive than CF about JA fingerprint. Even with
cookies armed, the retry may need `runBundleReplay`'s libcurl-impersonate
proxy path (not direct fetch) — which we have post-Tier 1.

If retry fails despite armed cookies, fall through to `vendor_blocked` with
diagnostic `vendor_blocked: perimeterx — cookies armed but retry failed,
likely fingerprint mismatch`.

### Cost

- ~60 LoC src + ~40 LoC helper + ~100 LoC tests
- **~1.5 days wall-clock + 1 commit**

---

## Tier 2C: Akamai Bot Manager (~2-3 days, deferred)

**Predicted unlock: hermes, target, possibly nike (if Akamai not F5)**

Akamai is significantly harder than CF/PX:
- `_abck` cookie + `bm_sz` + `bm_sv`
- POST `sensor_data` to a randomized path with heavily obfuscated payload
- Sensor data includes mouse movements, key timing, screen metrics
- The sensor_data generator JS rotates and obfuscates per page-load

### Surface (sketch only)

The bundle-replay pattern can theoretically work if Kuri's sandbox runs the
sensor_data generator with realistic inputs (synthetic mouse/keyboard
events). This is significantly more involved than CF/PX.

### Why defer

Cost-benefit: this unlocks at most 2 sites and may need stealth tier
prerequisites (Tier 3). Better ROI to take Tier 1+2A+2B first, observe
which Akamai sites still BLOCK, then decide whether 2-3 days for ≤2 sites is worth it.

### Cost (when revisited)

- ~150 LoC src + ~80 LoC helper + sensor-data generator harness
- **~2-3 days wall-clock + 1-2 commits**

---

## Tier 3: Stealth shimming (~1 week, last-mile)

**Predicted unlock: hermes, nike (empty-signal sites)**

When the vendor isn't even detected (empty `browser_block_signals`), the
site is using a stealth-detection layer that recognizes Kuri's headless
Chrome via:
- `navigator.webdriver === true`
- Absent or anomalous `chrome` global
- WebGL fingerprint mismatch (renderer/vendor strings)
- Audio context fingerprint
- Canvas fingerprint (text rendering pixel-level)
- Plugin/MIME type list anomalies

### Surface

`src/kuri/stealth-shim.ts` (new) — a JS bundle injected via `addInitScript`
before page navigation. Patches:
- `navigator.webdriver = false`
- `window.chrome = { runtime: {}, app: {} }`
- WebGL params spoofed to common Mac/Windows values
- AudioContext base latency randomized within plausible range
- Canvas `toDataURL` adds stable per-session noise
- `navigator.plugins` returns the standard Chrome 131 list

### Risk

- Stealth shimming is an arms race. Vendors update detection; we update
  shimming. Maintenance cost is real.
- Some shims can BREAK legitimate sites (e.g., webgl spoof breaks games).
  Must be opt-out via env flag.

### Cost

- ~300 LoC stealth bundle + ~50 LoC injection wiring + ~100 LoC tests
- Significant time tuning against real targets
- **~1 week wall-clock + 2-3 commits**

---

## Recommended sequence

```
Week 1:
  Day 1   Tier 1 (Kuri vendor refresh + CI)        → +4-6 sites unlock
  Day 2   Bench observation + plan-v14 if needed
  Day 3-4 Tier 2A (CF bundle-replay)                → +remaining CF
  Day 5   Bench rerun → assess T2B necessity

Week 2:
  Day 6-7 Tier 2B (PerimeterX bundle-replay)        → +remaining PX
  Day 8   Bench rerun → assess T2C/T3 necessity

(Reassess after Week 2 — likely 100% on hard-target corpus by then.
Tier 2C and Tier 3 are reach goals, not commitments.)
```

## Coverage milestones

| After | Coverage on hard-target | Sites flipped |
|---|---|---|
| Plan-v12 A+A.5+C (shipped) | 16/17 = 94% | g2, leboncoin, similarweb reclassified |
| Plan-v12 B (shipped) | 17/17 or 16/16 = 100% on post-reclass denom | bestbuy flips |
| Plan-v13 Tier 1 | 20/22 ≈ 91% on full denom (rebuilt) | 4-6 BLOCK→PASS |
| + Tier 2A | 22/24 ≈ 92% | + CF holdouts |
| + Tier 2B | 24/24 = 100% likely | + PX holdouts |
| + Tier 2C | 26/26 = 100% on full corpus | + Akamai |
| + Tier 3 | sustained 100% on broader corpus | empty-signal sites |

(Denom rebuilds because previously-excluded BROWSER_BLOCK rows re-enter the
denom as they become PASS-eligible. The post-reclass 17-row denom was a
floor metric; the real target is the full 27-row corpus from
`scripts/corpus/hard-target-bench.txt`.)

## What this plan does NOT do

- Does not add per-domain heuristics (CLAUDE.md ban)
- Does not depend on any specific vendor's API behavior staying static —
  bundle-replay is structural (run their own JS in our sandbox)
- Does not modify Kuri internals beyond the existing `feat/sandbox-proxy`
  branch — vendor refresh is artifact-only work
- Does not make stealth shimming the default (opt-out via env flag)
- Does not commit to Tier 2C / Tier 3 as part of plan-v13's scope —
  reassess after T1+T2A+T2B based on remaining BLOCK list

## What this plan does NOT touch (separate workstreams)

- Auth-gated sites (tiktok, instagram, youtube — corpus hygiene, plan-v8 Phase C)
- Fundraise / GTM (project plan, not engineering)
- LangChain/CrewAI integrations (already-written, awaiting PR)

## Definition of done

- 1 PR per Tier (T1, T2A, T2B; T2C/T3 deferred)
- Each Tier ships its own falsifiers + bench-replay verification
- Bench coverage at end of plan-v13 sequence: ≥85% on full hard-target corpus
- No new per-domain code (audit grep `host === "<domain>"` in src/ returns 0)
- All cross-platform Kuri binaries are real (not "placeholder" in manifest)

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Kuri vendor build fails for one platform | medium | CI matrix isolates per-platform; ship 3/4 if linux-arm64 fails |
| CF bundle-replay solver fails on real challenge | medium | Falsifier uses real captured CF challenge body; e2e bench validates |
| PerimeterX cookies armed but retry still fails | medium | Diagnostic `vendor_blocked: pcookies_armed_but_blocked` instead of silent failure |
| Stealth shim breaks legitimate site | high | Opt-out via env flag; not default-on |
| Vendor updates challenge protocol mid-deploy | high | Bundle-replay is structural — runs their JS — should survive |

## Re-trigger conditions

- New BROWSER_BLOCK site appears in bench → assess vendor; reuse existing tier
- Existing PASS site flips to BLOCK → vendor changed protocol; reactivate solver
- Coverage on full corpus drops below 80% → run plan-v13 sequence end-to-end
- New vendor not in (CF/PX/Akamai/F5) appears → write Tier 2D for that vendor

## Cost summary

| Tier | LoC | Tests | Time | Predicted unlock |
|---|---|---|---|---|
| T1 (vendor refresh + CI) | 0 product, ~200 CI | 4 | 2-4 hours | +4-6 sites |
| T2A (CF bundle-replay) | ~110 | 8 | 1 day | +remaining CF |
| T2B (PerimeterX) | ~100 | 6 | 1.5 days | +remaining PX |
| T2C (Akamai) [DEFERRED] | ~230 | ~12 | 2-3 days | +1-2 sites |
| T3 (stealth) [DEFERRED] | ~450 | ~15 | 1 week | +empty-signal |
| **Plan-v13 commitment (T1+T2A+T2B)** | **~210 LoC + 200 CI** | **18** | **3-4 days** | **+8-10 sites** |
