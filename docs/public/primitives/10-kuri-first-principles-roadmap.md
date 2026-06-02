# Kuri first-principles roadmap

## The rule

Unbrowse's critical browser primitives belong inside the Kuri Zig binary, not behind a Chrome process. Each subtask below moves one capability we currently depend on Chrome for into Kuri proper, in priority order by compounding wedge.

## Why

Chrome is heavy, slow to spawn, and limited by its own launch-flag rules (`ERR_NO_SUPPORTED_PROXIES` on auth-in-URL proxy, no per-tab proxy override, no programmatic JA3 spoof). Every workaround we layer (the local auth forwarder, headless extensions, stealth patches) is a tax we pay forever, and the eleventh edge case will still bite us.

Kuri is already a thin Zig binary with `quickjs_ng` integration and a CDP-shaped server. The primitives the runtime actually needs are a small fraction of Chrome's surface. Vendoring those primitives into Kuri lets us control the platform end-to-end.

## The six subtasks, in priority order

### 1. HTTP/2+QUIC stack with JA3/JA4 spoof and auth-aware proxy

**Why first.** Closes the compounding wedge: the local auth forwarder shipped in PR #756 becomes obsolete; the JA3/JA4 spoof we rely on `curl_cffi` for becomes native; auth proxies work without the localhost forwarder hop.

**Surface to vendor.** An HTTP/2 + QUIC client in Zig (likely a fork of `zig-http2`, `zig-tls13`, or a thin wrapper over BoringSSL+nghttp2). API: `connect(host, port, proxy?, fingerprint?)` returns a connection that follows JA3 byte-for-byte. Auth in the proxy URL handled at the TLS handshake layer, never on the wire as a header Chrome can reject.

**Done when.** Kuri's request transport runs without spawning Chrome for HTTP-only sites. The forwarder script can be deleted.

### 2. Cookie store with site partitioning

**Why second.** Auth-gated probes (linkedin, gmail, x.com) need cookies. Today we extract them from real Chrome/Firefox SQLite DBs and inject via CDP `setCookie`. A native cookie store lets us own the schema, the eviction rules, the partitioning model.

**Surface to vendor.** SQLite-shaped store (or a flat JSONL) at `~/.kuri/cookies.jsonl` partitioned by `(scheme, host, top-level-site)`. RFC 6265bis semantics. Read/write API exposed via CDP's `Network.setCookie` + `Network.getCookies` for backwards compat.

**Done when.** Browser cookie injection no longer requires reading user's Chrome SQLite at startup; Kuri's own store is authoritative for the lifetime of an Unbrowse session.

### 3. JS execution for SSR hydration triggers

**Why third.** Captures sometimes need to run a small JS snippet (a window event dispatch, a setTimeout-skipping hack) to trigger lazy hydration. Today this is full Chrome `evaluate`. A `quickjs_ng`-backed eval is enough for the snippets we actually use.

**Surface to vendor.** `kuri eval --tab <id> --js <snippet>` exposes the existing `quickjs_ng` integration. Scope: pure JS, no DOM. Captures that need real DOM still fall through to managed Chrome.

**Done when.** The handful of evaluate snippets in `src/orchestrator/*.ts` and `src/capture/*.ts` can run on Kuri-native eval; the long tail of captures still uses Chrome.

### 4. DOM snapshot via a Zig-native HTML parser

**Why fourth.** Today we ask Chrome to give us serialized DOM. A native parser (port of selectolax or its underlying lexbor) lets us read a fetched HTML response without a browser process at all.

**Surface to vendor.** `kuri parse-html <path-or-url>` returns a tree we can query with CSS selectors. The existing `extractFromDOM` family in `src/extraction/index.ts` already does this kind of work in TypeScript; the Zig version lets the Unbrowse runtime skip Chrome entirely for the read-only DOM cases.

**Done when.** The `direct-document` path can produce a DOM snapshot without a browser tab.

### 5. WebSocket capture

**Why fifth.** Some sites do their interesting traffic over WebSocket (chat, presence, live data). Today we capture this via CDP `Network.webSocketFrame*`. A native WS client in Kuri lets us tap into the traffic without Chrome routing.

**Surface to vendor.** WebSocket frame logger that writes to the same HAR-shaped store our existing CDP capture writes to. Replay semantics identical.

**Done when.** WS-heavy probes (a chat site) capture without Chrome.

### 6. CDP-shaped server interface for backwards compat

**Why last.** Every primitive above can be added to Kuri without breaking the Unbrowse interceptor, but the way back is via Kuri's existing CDP-shaped server. Subtask 6 is the discipline of ensuring every new native primitive exposes a CDP-shaped wrapper so the Unbrowse runtime keeps working without code changes during the migration.

**Surface to vendor.** Maintain the existing CDP server surface; route new native primitives behind matching CDP method names. The Unbrowse client never has to know whether it's talking to Chrome-via-Kuri or Kuri-native.

**Done when.** Switching from Chrome-via-Kuri to Kuri-native is a flag, not a rewrite.

## What this folder is not

This is the roadmap, not the implementation. Each subtask is a multi-week vendor-and-integrate piece of work. The `DEFERRED-KURI-FORK-FIRST-PRINCIPLES` row in the contract ledger tracks the whole arc; subtask-level rows get spawned when each one starts.

## Composition with existing primitives

The forwarder (PR #756, doc 02) is the L0 wedge that lets the Chrome path work today while the Kuri-native path is under construction. The contract platform (referenced from doc 01) is the audit trail for the migration: every subtask ships as its own contract organism with a real verify gate, and the long-term root contract is satisfied only when every subtask is satisfied.

When subtask 1 lands and the forwarder becomes obsolete, the forwarder is removed in the same commit, the doc 02 mechanics are updated to describe the Kuri-native path, and the long-term contract's first child satisfies.
