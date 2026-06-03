#!/usr/bin/env bash
# zk-gate — the witness for moving the whitepaper's [proposed] ZK-credential-binding
# frontier (*Internal APIs Were Not All You Needed*) from runnable REFERENCE
# (paper/reference/*.py) into real PRODUCTION code, one node at a time, never
# fabricated-green.
#
# It is a CHECKLIST gate (like the original backlog gate): each node is a real
# production test that must exist AND pass. Nodes whose test file is absent are
# UNBUILT — the gate fails and points at the next one to build. The gate exits 0
# only when every autonomously-shippable ZK node is real + tested AND the paper
# stays honest (paper-gate: [shipped] -> code anchor, no moat leak).
#
# Scope note (honest): some paper [proposed] items need on-chain / kernel / hardware
# (ERC-8004 registry, FDRY slashing, signed OS/kernel descent to the packet) and are
# NOT autonomously completable here; they are out of this gate's checklist by design.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

# node-name : production test file (the witness that the node is real)
NODES=(
  # --- primitives (reference -> production) ---
  "sealed-unless-revealed:tests/wallet-seal.test.ts"     # AES-GCM seal under the wallet key
  "commit-reveal:tests/sealed-cache.test.ts"             # hash commitment, prove-without-revealing
  "zk-credential-binding:tests/zk-binding.test.ts"       # Schnorr NIZK: credential bound, never revealed
  "signed-layer-descent:tests/signed-descent.test.ts"    # hash-chained per-layer signatures, one wallet root
  "sealed-ledger:tests/sealed-ledger.test.ts"            # content-addressed, sealed, hash-chained ledger rows
  # --- integration: the backend harness surfaces only holes; values ZK'd to the wallet ---
  "sealed-hole-fill:tests/sealed-fill.test.ts"           # hole fills sealed to the wallet, revealed locally by the holder only
  "zk-bound-hole:tests/zk-bound-hole.test.ts"            # a secret hole carries a real ZK binding; backend verifies bound w/o the secret
  # --- superpattern surface + vertical wallet ownership (CLI exposes only its holes; each layer's wallet owned by its parent) ---
  "superpattern-cli-surface:tests/cli-surface.test.ts"   # the CLI shaped to the atoms; every command exposes only holes + auth, no internal
  "wallet-hierarchy:tests/wallet-hierarchy.test.ts"      # every layer has a wallet PARENT that owns it + covenants it vertically
  "layer-wallet-descent:tests/layer-wallet-descent.test.ts" # each layer SIGNS with its own parent-owned wallet (hierarchy ∘ descent)
  # --- the backend IS the harness: obfuscated API surfaces only holes; values ZK'd to the wallet; layered KV-cached fallback pipe ---
  "backend-reveng-endpoint:tests/backend-reveng-endpoint.test.ts" # end-to-end: client obfuscates+audits → backend returns ONLY {skeleton,holes} (no secret/engine on the wire) → client fills sealed-to-wallet locally → round-trips the exact request; bound holes verify attested w/o the secret
  "kv-fallback-pipe:tests/kv-fallback-pipe.test.ts"      # the descent ladder walked highest-capable-first, each layer content-addressed/cached, falling through to the next on miss — "everything is a fallback kv-cached to a pipe"
  "resolution-ledger:tests/resolution-ledger.test.ts"    # signatures as kv-cache → pointers that resolve on truth resolution, recomputable like a docker layer, recorded in an append-only hash-chained ledger of resolutions (covenant putBlob/resolvePointer)
  "cached-resolution:tests/cached-resolution.test.ts"    # the reusable one-call resolution cache (fs-backed, TTL'd, clean-results-only, off under stateless) — wired into search/resolve so a repeated query replays the pointer instead of re-paying enrichment
  "r2-blob-store:tests/r2-blob-store.test.ts"            # the kv-cache tier backed by Cloudflare R2 (S3 API; EmergentDB later) — content-addressed AsyncBlobStore, hermetically tested with a stub client
  "iq-ledger:tests/iq-ledger.test.ts"                   # the ledger-of-resolutions backed by IQLabs on-chain signed table rows — append-only, hash-chained, preserves git-style signed history of past values
  "standards-registry:tests/standards-registry.test.ts" # unbrowse as the kv-cache layer in front of every agent standard (MCP/MCP-registry, ACP, A2A, OpenAI/Anthropic tools, skills.sh) — pluggable cached registry layers, failure-isolated
  "live-registry-adapters:tests/live-registry-adapters.test.ts" # the standards layers wired to the REAL endpoints (official MCP registry verified live; A2A/x402-bazaar/skills.sh/agentskills.dev), fetch-injected + failure-isolated
  "resolution-tier:tests/resolution-tier.test.ts"      # tier selection — resolution cache routes to the R2+IQ remote tier when creds present, local fs otherwise; uncacheable never persisted
  "surface-projector:tests/surface-projector.test.ts"  # the CLI surface is a CONTEXT PROJECTION of the superpattern verb tree — expose only the verbs+holes the moment needs (LLM fills them), lossless in union, minimal per phase
  "search-with-standards:tests/search-with-standards.test.ts" # unified find-anything — route-graph search merged with the standards-registry (MCP/A2A/skills), standards-half cached + failure-isolated
  "async-resolution:tests/async-resolution.test.ts"   # the remote-tier core (resolveAsync + content-addressing + ttl + docker-rebuild) tested directly, not just via the R2/IQ adapters
)

todo=0; done=0; pending_tests=()
for entry in "${NODES[@]}"; do
  name="${entry%%:*}"; test="${entry#*:}"
  if [ -f "$test" ]; then
    echo "  built  [$name] -> $test"; done=$((done+1)); pending_tests+=("$test")
  else
    echo "  TODO   [$name] -> $test (build it next)"; todo=$((todo+1))
  fi
done
echo "  nodes: $done built / $todo unbuilt"

# Every built node's test must be GREEN.
if [ "${#pending_tests[@]}" -gt 0 ]; then
  echo "=== running ${#pending_tests[@]} built-node test(s) ==="
  if ! bun test "${pending_tests[@]}"; then
    echo "[zk-gate] FAIL — a built ZK node's test is red"; exit 1
  fi
fi

# Paper must stay honest regardless.
echo "=== paper honesty (no fabricated green; [shipped] -> code; no moat leak) ==="
if ! bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex; then
  echo "[zk-gate] FAIL — paper-gate red"; exit 1
fi

if [ "$todo" -gt 0 ]; then
  echo "[zk-gate] NOT YET — $todo ZK node(s) still unbuilt; built nodes + paper are green. Keep walking."
  exit 1
fi
echo "[zk-gate] PASS — every autonomously-shippable ZK node is real + tested + paper-honest"
