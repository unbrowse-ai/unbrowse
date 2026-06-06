# Rebench on prod — fresh Nebius VM, the published CLI (2026-06-06)

The honest jespa-bench discipline applied to the **production** CLI: not source, not my dev
host (which has Bun), but a clean Ubuntu 24.04 Nebius VM installing `unbrowse` the way a real
new user does. One VM provisioned + torn down (cost discipline).

## The load-bearing finding (a located wall — break at 7)

**`npm install -g unbrowse@latest` (8.2.0) on a fresh Node-only VM: the core CLI does not run.**

QA matrix (`bench/nebius-qa/artifacts/ubqa-20260606-051227/`):

| step | result |
|---|---|
| npm install | ✅ Y |
| `--version` | ✅ Y (8.2.0) |
| `health` | ❌ n |
| `fetch` | ❌ n |
| `search` | ❌ n |

Root cause (verbatim from the VM): **`[unbrowse] this build runs on Bun. Install it from
https://bun.sh, then re-run (or set UNBROWSE_BUN_BIN).`**

## Why (diagnosis, not assumption)

The npm package ships `runtime/cli.js` as a **Bun-target bundle**. `bin/unbrowse-wrapper.mjs`
runs it via the Bun runtime; a self-contained platform binary is used **only** when
explicitly injected (`UNBROWSE_INSTALL_BINARY_PATH`, CI smoke), and `scripts/postinstall.mjs`
states it outright: *"There is NO binary download and no auto-download fallback — the runtime
IS the client."* So on a machine with Node but **no Bun** (every fresh VM, most new-user
laptops), `--version` works (the wrapper is `.mjs`/Node) but every real command fails.

This is **deliberate** (the readable-runtime / auditable-client design), not a regression —
which is why `@latest` fails identically to the prior captured `nebius-qa` run. `@preview`
(8.3.0-preview.0, the head-shipping release) uses the **same** Bun bundle + same postinstall,
so it shares the mechanism; it was not separately re-tested because the failure is mechanistic,
not version-specific. The build *does* produce a self-contained `linux-x64` binary
(`scripts/build-binaries.sh`); npm just does not ship or fetch it.

## Honest consequence for "rebench on prod"

The **LLM/harness benchmarks cannot run on a fresh VM against the published CLI** until this is
resolved — the CLI itself is non-functional there. The wins recorded elsewhere
(`bench/jespa/benchmarks-ledger.jsonl`) are reproduced **from source / on a Bun-equipped host**,
not from `npm i -g unbrowse` on a clean box. The energy head IS verified live in the published
artifact (`registry-live-gate.sh` green), and the CLI works via `npx` **on a host that has Bun**
(`prod-e2e-gate.sh`) — but neither of those is the clean-VM new-user path, which fails.

## Fix direction (author's architectural call — not flipped unilaterally)

To make `npm i -g unbrowse` work on a clean Node-only machine, one of:
1. **Auto-fetch the self-contained binary** in postinstall when Bun is absent (the binary
   already builds for `linux-x64`/`darwin`/`win`), making it a real fallback, not opt-in; or
2. **Install Bun** in postinstall when missing; or
3. **Document Bun as a hard prerequisite** and have the CLI fail fast with that on install.

Reversing the deliberate "runtime IS the client, no binary download" design is Lewis's call;
this note records the wall + the options. The LLM (`aiko`, served OpenAI-compatible on `:8770`)
is ready for the benchmark suite the moment the prod CLI runs on a clean VM.

## The LLM is ready (codegraff/tinytools `aiko`)

`aiko` (Qwen3.5-0.8B Q4_K_M GGUF, `tinytools-agent/models_q35/`) re-served via
`PORT=8770 python3 aiko_serve.py` → `llama-server` OpenAI-compatible on `:8770`; completion
smoke returned exactly `AIKO_OK`. No GPU/training needed (the `codegraff-1780664998` name was a
`/tmp` scratch dir, not a model). codegraff itself is gitea-mirrored (`lekt8/codegraff`).

## UPDATE (2026-06-06) — the wall is FIXED (Bun dropped from the runtime)

Per the steer "probably bun shouldn't be used at all": the published runtime is now built
`--target=node` and the launcher runs it via plain Node — no Bun required. The code was
already runtime-agnostic (`node:sqlite`, koffi FFI fallback, zero `Bun.*` calls), so the
change was the build target + the launcher + a Node>=22.5 guard. Commit `8855380d`.

Witness `bench/prod-cli/node-only-gate.sh` (exit 0): packs the publishable package (prepack
builds the node runtime), installs the tarball with **bun absent from PATH**, and the full
launcher chain runs `fetch` (200 + real content) and `resolve` (route graph / node:sqlite) —
no "this build runs on Bun". Bun stays the builder + dev runner only.

Remaining: this reaches the registry only via a release (the published `@latest`/`@preview`
still carry the old Bun build until re-published). Cutting a preview + re-running `qa.sh`
against it on a fresh VM is the final live proof (expected: install=Y version=Y health=Y
fetch=Y search=Y).
