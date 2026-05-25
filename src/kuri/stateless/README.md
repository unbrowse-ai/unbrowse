# src/kuri/stateless — stateless chrome-spoof primitives

Implementation of contract **`8120be81`** — make kuri stateless by /contract-ing
the chrome-spoof primitives. Each layer is its own contract-neuron primitive
with typed inputs and a pointer-shaped output. No shared mutable state between
calls.

| Layer | File | Contract | Status |
|---|---|---|---|
| 1 | `layer1-tls.ts` | `18d1a651` TLS (JA3/JA4, ephemeral per call) | scaffolded |
| 2 | `layer2-http.ts` | `f9ffafc4` HTTP (request/response over TLS-pointer) | scaffolded |
| 3 | `layer3-runtime.ts` | `0af18e9f` Browser-runtime (ephemeral chrome per call) | scaffolded |
| 4 | `layer4-page.ts` | `c9d8f459` Page-control (CDP nav/eval/intercept) | scaffolded |
| 5 | `layer5-capture.ts` | `bbe92ca2` Capture (HAR, fetch/XHR, ws, perf) | scaffolded |
| 6 | `layer6-auth.ts` | `75dd360f` Auth-bridging (cookie SQLite reader) | scaffolded |

## Design law

Pointers over anything (project contract `50d0419e`, clauses `6bae27e0` /
`fe9fcd49` / `6eb9a088`) applied to the browser layer.

Each layer's emitted output is a *pointer* (URL, file-path, sha256, ledger-row
id) — never an in-memory handle that lives in a shared dispatcher. Recompute
is reproducible from the pointer alone.

## Why these layers

The three waves of conductor `unbrowse-100` (2026-05-25) showed:

- **Wave-2** (per-probe `KURI_PORT`): regressed because chrome-spawn-per-probe
  pushed contention from kuri broker into curl_cffi. Lesson: per-probe
  chromes need per-probe everything, not just per-probe ports.
- **Wave-3** (`keepalive: false` + `Connection: close` on Bun fetch): severe
  regression because the native fetch's dispatcher state is too tightly
  coupled — flipping a single knob broke HTTP/2 paths.

The conclusion both waves point at: the *existing* shared infrastructure
(kuri broker, Bun's undici-equivalent dispatcher, single chrome user-data-dir)
isn't tunable into ephemeral-per-call. It has to be *replaced* by primitives
that are ephemeral from the ground up.

That's what this directory holds.

## Validation criteria

Substrate-level criterion (contract `8120be81`):

```
bench-coverage at conc=35 produces >=33/35 PASS deterministically
brokerClients Map removed or per-call-ephemeral
no shared port-7700 in any probe trace
```

Per-layer criteria are in each file's docblock.

## Wiring (future waves)

Each layer is wired into `src/orchestrator/index.ts` as an *opt-in*
replacement of the existing fetch / chrome path, gated by:

```
UNBROWSE_STATELESS_LAYER=1  → wire layer 1 only (TLS)
UNBROWSE_STATELESS_LAYER=2  → layers 1+2 (TLS+HTTP)
...
UNBROWSE_STATELESS_LAYER=6  → all layers (full stateless replacement)
```

Bench-coverage uses `UNBROWSE_STATELESS_LAYER` to A/B against the legacy
path. The legacy path stays the default until ALL six layers' contract
criteria are satisfied.
