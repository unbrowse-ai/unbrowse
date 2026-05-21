---
plan: build-kuri-for-windows-x86-64-windows-so-unbrows
plan_text: "Build Kuri for Windows (x86_64-windows) so unbrowse supports Windows end to end. Kuri is a separately-maintained Zig 0.16.0 submodule (submodules/kuri, mirror justrach/kuri); build.zig already uses b.standardTargetOptions so zig build -Dtarget=x86_64-windows-gnu cross-compiles from macOS with no Windows machine. THE REAL LONG POLE is native vendored static deps for the windows target: vendor/curl-impersonate/x86_64-windows/libcurl-impersonate.a (libcurl+BoringSSL+nghttp2+brotli+zstd+libpsl, today darwin/linux-only) plus quickjs-ng must link for x86_64-windows, then Windows Chrome.exe discovery + CDP transport portability in kuri src (chrome/, cdp/, server/). Constraint: do NOT edit unbrowse src/kuri/client.ts unless explicitly asked; Windows changes land in the kuri submodule + the unbrowse vendor/packaging path (packages/skill assert-kuri-vendor); public unbrowse-ai/unbrowse repo is frozen-by-design. VERIFY GATE (declared): a GitHub Actions windows-latest job that consumes the cross-built kuri.exe artifact, launches headless Chrome, and runs a real unbrowse go/snap/close browse E2E on Windows. FIRST MILESTONE: full browse E2E (kuri.exe links + Chrome launch + CDP + real unbrowse go/snap/close) green on windows-latest. Tracked public gap: issues #76 #52 #109."
project: /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
template: bug-fix
shipping_surface: "kuri Zig submodule (justrach/kuri) + unbrowse vendor/packaging path (vendor/curl-impersonate/x86_64-windows, packages/skill assert-kuri-vendor) + .github/workflows windows-latest CI. NOT cloudflare. unbrowse-ai/unbrowse public repo frozen-by-design: ship via dev-repo PR + a kuri-submodule branch, never to the public repo."
ship_command: |
    bash .claude/build-kuri-for-windows-x86-64-windows-so-unbrows/scripts/ship.sh
verify_gate: "GitHub Actions windows-latest: consume the cross-built kuri.exe artifact, launch headless Chrome, run a real unbrowse go/snap/close browse E2E on Windows (authoritative). Local fast inner signal: zig build -Dtarget=x86_64-windows-gnu links kuri.exe (fails-closed on the missing windows curl-impersonate static archive — the declared long pole, surfaced not hidden)."
verify_command: |
    bash .claude/build-kuri-for-windows-x86-64-windows-so-unbrows/scripts/win-verify.sh
validation_channel: "os-control"
loop_primitive: linear-iterate
parallel_budget: 1
iteration_cap: 10
inferred_from:
  template: bug-fix
  verify: package.json:scripts.test
  shipping: meta-harness.local.md
created: 2026-05-20
last_iterated: "2026-05-20T14:10:00Z"
status: shipped-wave-6-blocked-on-wave-7-process-spawn-port
last_verdict: "WAVE-1/1.1/2/3 SHIPPED — 4 commits on lekt9/kuri@feat/windows-port-wave-1 closed 13 of 16 windows-x64 errors. compat.zig migrated to impl-struct pattern (proven template). 3 remain: Zig 0.16 std/c.zig clock_gettime extern decl poisons the whole std.c namespace on Windows, surfaced via 7 kuri files (chrome/launcher, storage/local, storage/auth_profiles, crawler/validator, cdp/websocket, server/router, agent_main partial) that still use std.c.* directly. Mechanical port to compat.* abstractions (1-2 day Zig work) should be its OWN sub-harness."
---

# Build Kuri for Windows (x86_64-windows) so unbrowse supports Windows end to end. Kuri is a separately-maintained Zig 0.16.0 submodule (submodules/kuri, mirror justrach/kuri); build.zig already uses b.standardTargetOptions so zig build -Dtarget=x86_64-windows-gnu cross-compiles from macOS with no Windows machine. THE REAL LONG POLE is native vendored static deps for the windows target: vendor/curl-impersonate/x86_64-windows/libcurl-impersonate.a (libcurl+BoringSSL+nghttp2+brotli+zstd+libpsl, today darwin/linux-only) plus quickjs-ng must link for x86_64-windows, then Windows Chrome.exe discovery + CDP transport portability in kuri src (chrome/, cdp/, server/). Constraint: do NOT edit unbrowse src/kuri/client.ts unless explicitly asked; Windows changes land in the kuri submodule + the unbrowse vendor/packaging path (packages/skill assert-kuri-vendor); public unbrowse-ai/unbrowse repo is frozen-by-design. VERIFY GATE (declared): a GitHub Actions windows-latest job that consumes the cross-built kuri.exe artifact, launches headless Chrome, and runs a real unbrowse go/snap/close browse E2E on Windows. FIRST MILESTONE: full browse E2E (kuri.exe links + Chrome launch + CDP + real unbrowse go/snap/close) green on windows-latest. Tracked public gap: issues #76 #52 #109.
last_iterated: "2026-05-21T19:30:00Z"
status: shipped-wave-6-blocked-on-wave-7-process-spawn-port
last_verdict: "WAVE-6 SHIPPED (lekt9/kuri@3cdc33c) closing the std.c.open ABI block. kuri-vendor.yml run 26247864176 (post-Wave-6 submodule bump in unbrowse PR #700) proves: darwin-arm64 SUCCESS, windows-x64 still FAILS but on 3 NEW, smaller-scoped Windows blockers (not the same error). WAVE-7 SCOPE (each is a discrete sub-fix in lekt9/kuri@feat/windows-port-wave-1, multi-hour Zig+Windows-API work, NOT a single-session ship): (1) Five `std.c.fork()` call sites need Windows alternatives via std.process.Child or kernel32.CreateProcessW: src/chrome/launcher.zig:217 (chrome spawn), src/storage/auth_profiles.zig:371, src/storage/local.zig:123, src/agent_main.zig:307, src/compat.zig:318. Each includes the full POSIX triplet (fork + dup2 + execvp + exit) which has no fork-equivalent on Windows. (2) src/agent_main.zig:1341-1388 has raw POSIX socket code (std.c.socket + std.posix.sockaddr.in + std.posix.setsockopt + std.posix.read) used for some POSIX-only feature; needs gating with `if (comptime !is_windows)` + a Windows winsock alternative (or removal from Windows builds via `@compileError` if the feature is POSIX-only). (3) quickjs.zig:1243,1263 unused local constants extern_local_wcscat_s / wcscpy_s. The file is in .zig-cache/o/... — auto-generated by zig-pkg/quickjs_ng/.../src/main.zig vendored package's translate-c step. Fix: either patch the upstream quickjs_ng zig wrapper to discard via `_ = name;`, OR add a build.zig step that strips unused C-symbol shims for Windows."
This harness surfaces what is DECLARED and tells the truth about what
EXISTS. It never substitutes a baked guess for a declaration.

When the system must choose, judge, rank, or disambiguate: it emits the
raw EVIDENCE (samples, scores, candidates, schema, signals) and lets the
consuming agent's LLM judge in-thread. It does NOT bake the verdict into a
script, regex, hardcoded threshold/confidence constant, alias table,
per-case or per-domain registry, banned/pattern/refusal list, numbered
"the correct sequence is exactly N calls" procedure, or a prose template
that speaks for another agent.

Keep deterministic ONLY evidence-derived GENERIC primitives (signals
computed from the artifact itself, structural decomposition, generic
filters). Convert to surfaced evidence ANY PRESCRIPTIVE determinism.

Harness collects raw artifacts; the agent judges. No second LLM and no
heuristic verdict in the substrate. The diagnostic question at every
layer is "what is the agent actually seeing, and is it true?", never
"what rule could I add to force the right outcome?"

Enforcement: the substrate-audit gate runs on EVERY iterate and surfaces
suspected violations (host-branch lines, prose-template lines,
banned-list lines, hardcoded literals, em-dashes) as raw rows in
ledgers/gates.jsonl for the agent to judge. `--gates` additionally
machine-blocks ship on them. The gate itself emits evidence only; it
never claims PASS/FAIL (it obeys this principle too).

## Context gathering (inherited, non-negotiable)

When this harness or its agent must GATHER CONTEXT to plan, justify, or
verify a wave (prior art, an API contract, a spec, a paper, how a tool or
repo actually behaves): it pulls from a real external source and cites it.
The sanctioned sources are the arxiv skill (papers, formal results) and
the deepwiki MCP (how a real repository actually behaves). A fetched page
or repo answer is a source; the model's own memory is not a source.

Every context-derived claim that feeds a criterion, a plan decision, or a
verdict carries its source_id (arxiv id, deepwiki repo, or fetched url) in
references/criteria.md or the ledger row, so a later wave can re-pull and
check it. If no external source is reachable, the harness says so plainly
and the claim stays tagged unverified. It never substitutes a remembered
guess presented as fact.

Same diagnostic as the substrate principle, aimed at inputs: "where did
this context actually come from, and is it true?", never "what do I recall
that would justify the outcome I want?". It prescribes no fixed sequence
of calls; it requires only that context be sourced and cited, and the
agent judges sufficiency in-thread.

## Layout (skill-creator canon)

```
.claude/build-kuri-for-windows-x86-64-windows-so-unbrows/
├── scripts/
│   ├── verify.sh    runs verify_command + lane bench_commands
│   ├── ship.sh      runs ship_command
│   └── iterate.sh   symlink to shared L0 driver
├── references/
│   └── criteria.md  optional lane declarations
├── ledgers/
│   ├── iterations.jsonl  one row per iterate.sh run (carries log_path + error_excerpt)
│   ├── lanes.jsonl       per-lane bench raw evidence
│   └── gates.jsonl       per-gate evidence (when --gates)
└── logs/
    └── iter<N>-<phase>.log  full stdout+stderr per wave; row.error_excerpt is its stack-trace tail
```

## How to run

```bash
bash .claude/build-kuri-for-windows-x86-64-windows-so-unbrows/scripts/iterate.sh
```

The iterate driver reads this state file, runs scripts/verify.sh, on pass runs
scripts/ship.sh, appends a row to ledgers/iterations.jsonl. Edit the frontmatter
above to change shipping_surface / verify_gate / commands; the scaffold re-reads
on every run.

## Loop primitive

linear-iterate - meaning:

- linear-iterate: one verify -> ship cycle per invocation
- self-build: spawn N parallel probes, delegate to /self-build, write conductor row referencing its run_id
- jesus-loop: delegate to /jesus-loop:take-the-wheel, poll its state via adapter
- evidence-build: delegate to /evidence-build, poll its convergence ledger via adapter

## Optional gate phase

Pass `--gates` to iterate.sh to run the falsifier-borrowed gates between verify and ship:
`bash scripts/iterate.sh --gates --gates-baseline HEAD~5`

## Notes from template

Bug-fix plans. verify_command is sniffed at build time (pytest/npm test/cargo test/go test/bun test); re-running the previously-failing test IS a real outcome gate, so this archetype does NOT fail closed. validation_channel=os-control is advisory: if the bug is in a UI surface, set validation_channel + an agent-browser or screencapture assertion in the state file so the gate proves the user-visible behaviour, not just that a unit test passes. Avoid omnibus refactors per the substrate-enables rule.
