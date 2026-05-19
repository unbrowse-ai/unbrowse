# Acceptance criteria for Build Kuri for Windows (x86_64-windows) so unbrowse supports Windows end to end. Kuri is a separately-maintained Zig 0.16.0 submodule (submodules/kuri, mirror justrach/kuri); build.zig already uses b.standardTargetOptions so zig build -Dtarget=x86_64-windows-gnu cross-compiles from macOS with no Windows machine. THE REAL LONG POLE is native vendored static deps for the windows target: vendor/curl-impersonate/x86_64-windows/libcurl-impersonate.a (libcurl+BoringSSL+nghttp2+brotli+zstd+libpsl, today darwin/linux-only) plus quickjs-ng must link for x86_64-windows, then Windows Chrome.exe discovery + CDP transport portability in kuri src (chrome/, cdp/, server/). Constraint: do NOT edit unbrowse src/kuri/client.ts unless explicitly asked; Windows changes land in the kuri submodule + the unbrowse vendor/packaging path (packages/skill assert-kuri-vendor); public unbrowse-ai/unbrowse repo is frozen-by-design. VERIFY GATE (declared): a GitHub Actions windows-latest job that consumes the cross-built kuri.exe artifact, launches headless Chrome, and runs a real unbrowse go/snap/close browse E2E on Windows. FIRST MILESTONE: full browse E2E (kuri.exe links + Chrome launch + CDP + real unbrowse go/snap/close) green on windows-latest. Tracked public gap: issues #76 #52 #109.

_Optional. If this file exists, `verify.sh` will collect per-lane raw evidence
into `lanes.jsonl` and the agent will judge in-thread. If absent, verify is
a single binary pass/fail._

_Borrowed from `/evidence-build` criteria.md shape. Every lane cites at least
one `source_id` that resolves in real evidence (file path, URL, transcript
line, etc.). No uncited criteria. This is one face of the inherited substrate
principle: see `references/SUBSTRATE-PRINCIPLE.md` (emitted into this scaffold)
and the same section in the plan state file. A lane must collect raw evidence
its `bench_command` emits; it must never encode a heuristic verdict._

## Lanes

```yaml
# Each lane: stable id, falsifiable question, a bench_command that emits
# RAW evidence (never a verdict), and the source_id it derives from.
# The agent judges convergence in-thread from lanes.jsonl.

lanes:
  - id: win-curl-impersonate-vendored
    question: "Is a libcurl-impersonate static archive present for the x86_64-windows target (the declared long pole)?"
    bench_command: "ls -la submodules/kuri/vendor/curl-impersonate/x86_64-windows/libcurl-impersonate.a 2>&1 || echo MISSING-windows-curl-impersonate"
    source_id: "code:submodules/kuri/build.zig#L77-L80"

  - id: kuri-exe-cross-links
    question: "Does `zig build -Dtarget=x86_64-windows-gnu` link kuri.exe from this macOS host?"
    bench_command: "cd submodules/kuri && timeout 600 zig build -Dtarget=x86_64-windows-gnu 2>&1 | tail -12; ls -la zig-out/bin/kuri.exe 2>&1 || echo NO-kuri.exe"
    source_id: "plan_text:build-kuri-for-windows-x86-64-windows-so-unbrows"

  - id: windows-e2e-workflow-present
    question: "Does the GitHub Actions windows-latest browse-E2E workflow file exist?"
    bench_command: "test -f .github/workflows/kuri-windows-e2e.yml && echo PRESENT || echo ABSENT"
    source_id: "decision:verify_gate=GitHub Actions windows-latest browse E2E"

  - id: windows-latest-browse-e2e-conclusion
    question: "What is the conclusion of the latest windows-latest run that launches headless Chrome and runs a real unbrowse go/snap/close on Windows? (AUTHORITATIVE milestone gate)"
    bench_command: "command -v gh >/dev/null && gh run list --workflow kuri-windows-e2e.yml --limit 1 --json status,conclusion,url 2>&1 || echo 'gh-or-workflow-absent'"
    source_id: "issue:unbrowse-ai/unbrowse#76,#52,#109"

  - id: kuri-src-windows-portability
    question: "Does kuri src assume POSIX-only sockets/paths anywhere the Windows browse path traverses (AF_UNIX, /tmp, std.posix without a windows arm)?"
    bench_command: "grep -rnE 'AF_UNIX|std\\.posix\\.socket|\"/tmp/' submodules/kuri/src/cdp submodules/kuri/src/server submodules/kuri/src/chrome 2>&1 | head -20 || echo none-found"
    source_id: "plan_text:Windows Chrome.exe discovery + CDP transport portability (chrome/, cdp/, server/)"
```

## How verify.sh treats this

If `criteria.md` exists with a `lanes:` block:

1. For each lane, run `bench_command`, capture stdout to `lanes.jsonl` as one row:
   `{lane_id, ts, exit_code, output_tail}`
2. Emit ONLY the raw `lanes.jsonl` — do not synthesize PASS/FAIL.
3. iterate.sh reads the rows and records per-lane outcomes alongside the iteration row.
4. The agent (you, reading the ledger) judges whether each lane is moving.

## What this does NOT do

- It does not assign a heuristic pass/fail to a lane. Agent judges from evidence.
- It does not invent lanes. Edit this file to add them.
- It does not override `verify_command` in the state file frontmatter — both run.
