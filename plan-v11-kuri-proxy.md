# Plan v11: Kuri Zig PR — wire `CURLOPT_PROXY` into sandbox/curl_lib.zig

**Lives in the Kuri repo, not unbrowse**. This doc is the unbrowse-side spec; the implementation goes in `submodules/kuri/` as a separate Zig PR.

## Why this plan

Plan-v10 Phase A (residential proxy in `runBundleReplay`) is the highest-ROI unlock for the last 11 BLOCKs:

- 4 Cloudflare-fronted (indeed, glassdoor, realtor, similarweb)
- 1 DataDome (leboncoin)
- 3 auth_required pre-empts (canadagoose, decathlon, target — Kasada/Akamai)
- = up to **+8 PASS** if proxy unlocks IP-reputation gate

But unbrowse-side wiring (`SandboxReplayRequest.proxy` field, `runBundleReplay` passthrough) is a no-op until Kuri's libcurl-impersonate sandbox actually CALLS `CURLOPT_PROXY`. Plan-v10 Phase A inventory confirmed:

- `submodules/kuri/src/bridge/config.zig:30` declares `proxy: ?[]const u8` from `KURI_PROXY` env
- **but** `submodules/kuri/src/sandbox/curl_lib.zig` has zero `CURLOPT_PROXY` references
- the field is read from env, never threaded into the libcurl handle

This plan is the Kuri-side gap. Unbrowse-side plan-v10 Phase A wire-up reactivates AS SOON AS this lands.

## Surface (Kuri Zig)

### File 1: `submodules/kuri/src/sandbox/curl_lib.zig`

Add `CURLOPT_PROXY` (and optionally `CURLOPT_PROXYUSERPWD`) constants. Add option-setter calls to the request configuration block where existing setopts run (URL, headers, write callback, etc).

```zig
// Constants — values from curl/curl.h (stable)
const CURLOPT_PROXY: CURLoption = 10004;
const CURLOPT_PROXYUSERPWD: CURLoption = 10006;

// In the request setup block (wherever existing setopts run):
if (config.proxy) |proxy_url| {
    _ = c.curl_easy_setopt(handle, CURLOPT_PROXY, proxy_url.ptr);
    // libcurl parses user:pass from the URL itself if present, but Some
    // proxies require explicit USERPWD — set both for robustness
    if (extractUserPwd(proxy_url)) |userpwd| {
        _ = c.curl_easy_setopt(handle, CURLOPT_PROXYUSERPWD, userpwd.ptr);
    }
}
```

### File 2: `submodules/kuri/src/sandbox/handler.zig` (or wherever request body is parsed)

The HTTP `/v1/sandbox/replay` endpoint accepts a JSON request body. Add an optional `proxy` field that overrides `KURI_PROXY` env per-request.

```zig
// SandboxReplayRequest schema
struct {
    target_origin: []const u8,
    target_href: ?[]const u8,
    bundle_url: ?[]const u8,
    bundle_source: ?[]const u8,
    fingerprint: []const u8 = "chrome_mac_arm",
    impersonate: []const u8 = "chrome131",
    seed_cookies: ?[]Cookie,
    proxy: ?[]const u8,  // NEW — overrides KURI_PROXY for this request
    timeout_ms: u32 = 30000,
}
```

Per-request override is important because:
- Different sites need different country-locks (`_country-us`, `_country-de`, etc.)
- Bench wrapper can rotate proxies per URL
- Production agents pass user-specific proxy creds

### File 3: `submodules/kuri/src/sandbox/network.zig` (cookie jar / network glue)

If the cookie jar is per-handle and the proxy comes from a different layer, ensure the proxy config flows into the curl_easy_setopt call site. Reading the file's structure first determines what changes here.

## Tests (Kuri-side)

`submodules/kuri/src/sandbox/test/proxy_passthrough.zig` (new):

1. **passthrough**: spin up local HTTP proxy on port 9999; sandbox-replay request with `proxy: "http://127.0.0.1:9999"`; assert proxy received the request (proxy logs the path).
2. **auth**: proxy requires basic auth; sandbox-replay request with `proxy: "http://user:pass@..."`; assert proxy returned 200 (auth succeeded).
3. **env fallback**: no per-request proxy; `KURI_PROXY` env set; assert request still goes through proxy.
4. **per-request override**: env says proxy A, request says proxy B; assert request honors B.
5. **invalid proxy**: malformed URL; assert sandbox-replay returns clear error, doesn't crash.

## Smoke (live, before merge)

```bash
# Start Kuri with the IProyal creds
KURI_PROXY="http://pZgLYgbG8xumONBZ:VovZmYSD6xqhG6fE_country-us@geo.iproyal.com:12321" \
  ./zig-out/bin/kuri serve --port 8080

# In another terminal, hit a CF-fronted site through the sandbox
curl -X POST http://127.0.0.1:8080/v1/sandbox/replay \
  -H 'content-type: application/json' \
  -d '{
    "target_origin": "https://www.glassdoor.com",
    "target_href": "https://www.glassdoor.com/Reviews/index.htm",
    "bundle_source": "(() => { const r = __nativeFetch(\"GET\", \"https://www.glassdoor.com/Reviews/index.htm\", {\"Accept\":\"text/html\"}, null); globalThis.r = { status: r.status, body_len: (r.body||\"\").length, has_cf_chal: /cdn-cgi\\/challenge-platform/i.test(r.body||\"\"), title: (r.body||\"\").match(/<title[^>]*>([^<]+)<\\/title>/)?.[1] }; })()",
    "post_eval": "globalThis.r"
  }' | jq
```

### Three outcomes

1. **`status: 200, has_cf_chal: false, title: "Find Jobs..."`** → proxy works; CF unlocked. Ship.
2. **`status: 403, has_cf_chal: true`** → proxy in place but CF still detects fingerprint. Phase D (stealth shimming) becomes the next blocker.
3. **`error: ...`** → proxy not actually wired, or IProyal auth failed. Debug.

## Out of scope

- Stealth shimming (`navigator.webdriver`, canvas noise, audio fingerprint) — separate Kuri PR
- HTTP/2 ALPN renegotiation through proxy — assumed working via libcurl defaults
- WebSocket-over-proxy — sandbox replay is HTTP only
- SOCKS5 vs HTTP proxy auto-detect — libcurl handles via URL scheme (`socks5://...` vs `http://...`)

## Cost

- Curl_lib.zig changes: ~30 LoC + 1 helper for parsing user:pass from URL
- Handler.zig changes: ~10 LoC adding optional field
- Tests: ~80 LoC for 5 assertions
- Smoke: 30 min wall-clock

**Total Kuri PR size**: ~120 LoC + smoke. ~2-3 hr Zig work.

## Order

1. Read `submodules/kuri/src/sandbox/curl_lib.zig` thoroughly — find the existing setopt block.
2. Read `submodules/kuri/src/sandbox/handler.zig` — find the request body parser.
3. Smoke test with `KURI_PROXY` env var FIRST to confirm libcurl works through IProyal.
4. Add per-request `proxy` field as the second commit.
5. Tests last (Zig tests need a local proxy fixture; can use Python `http.server` + a tiny CONNECT proxy, or just verify via E2E smoke).

## Definition of done

- 1-2 commits in `submodules/kuri/`
- Smoke test outcome 1 documented (or outcome 2/3 with next-action)
- `KURI_PROXY=...` env var honored on sandbox-replay path
- Per-request `proxy` field accepted and overrides env
- New version of Kuri tagged + built into unbrowse's vendored binary

## Unbrowse-side reactivation

Once Kuri ships:

1. Unbrowse-side plan-v10 Phase A wire-up: add `proxy` field to `SandboxReplayRequest` (already specced in plan-v10 lines 27-50) — ~30 LoC + 30 LoC tests
2. Re-run the same Phase B smoke from plan-v9 (glassdoor with proxy)
3. Bench against the corpus

Predicted unlock if Kuri PR ships and proxy works:
- indeed, glassdoor, realtor, similarweb (CF) — likely +3-4
- leboncoin (DataDome) — likely +1
- canadagoose, decathlon, target (Kasada/Akamai via Phase B's auth_required reroute, which is already shipped at `e5aabdaf`) — likely +2-3

**Realistic combined unlock: 6-8 sites flipped from BLOCK to PASS.**

## What if Kuri PR doesn't happen

The plan-v10 Phase B code is shipped as a latent unlock (commit `e5aabdaf`). If proxy never lands:

- Phase B's vendor-detection regex still hardens the auth_required path
- Some sites might unlock anyway when their IP-rep occasionally lets libcurl through (DataDome's 1/5 rate from plan-v9 Phase D smoke)
- No regression — auth_required returns as today when SSR fails

Net: even without proxy, the code is harmless. With proxy, it's the unlock.

## Re-trigger conditions

- **This plan revives**: anytime someone is willing to spend 2-3 hr on a Kuri Zig PR
- **High-leverage moment**: customer asks for a CF-fronted site by name → sponsor the work
- **Bundled with**: a Kuri release cycle that's already touching libcurl-impersonate (e.g. fingerprint upgrade) — minimal extra cost
