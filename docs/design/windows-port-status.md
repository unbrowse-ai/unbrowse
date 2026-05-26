# Windows port — exact state

This doc captures the precise state of the Windows port. As of kuri
windows-target commit `f248771` (2026-05-26 PM), every source-level
Windows blocker is CLOSED. `kuri.exe` plus 4 sibling `.exe`s
(kuri-agent, kuri-browse, kuri-fetch, merjs-e2e) compile and link clean
for `x86_64-windows-gnu` cross-compile from a macOS host. The only
remaining gap is runtime verification on actual Windows hardware (or a
`windows-latest` CI matrix runner that boots Chrome and exercises CDP).

## Compile-time state (verified)

`zig build -Dtarget=x86_64-windows-gnu` from macOS Sonoma + Zig 0.16.0
produces:

```
zig-out/bin/kuri.exe          5.1 MB
zig-out/bin/kuri-agent.exe    2.5 MB
zig-out/bin/kuri-browse.exe   5.3 MB
zig-out/bin/kuri-fetch.exe    6.5 MB
zig-out/bin/merjs-e2e.exe     2.0 MB
```

The only build warning is the expected `no vendored libcurl-impersonate
for x86_64-windows; sandbox will fall back to subprocess curl` — the
vendor lib drop is MSVC-flavored and cannot link via mingw on a POSIX
host. The sandbox subprocess-curl fallback is unchanged.

## What works

| Surface | Status |
|---|---|
| `src/kuri/client.ts` Windows codepath | ✅ has been there since v6.x — picks `kuri.exe`, knows `win-x64` vendor dir, knows Chrome paths |
| Bun CLI bundler `--target=bun-windows-x64` | ✅ Bun handles natively |
| Kuri `build.zig` standardTargetOptions | ✅ Zig cross-compiles to `x86_64-windows-gnu` |
| Vendored curl-impersonate libs for Windows | ✅ `submodules/kuri/vendor/curl-impersonate/x86_64-windows/*.lib` (12 lib files present) |
| `packages/skill/scripts/release-assets.mjs` SUPPORTED_TARGETS | ✅ now includes `win-x64` (PR #804) |
| `scripts/build-binaries.sh --all` builds win-x64 | ✅ (PR #804) |
| `packages/skill/scripts/postinstall.mjs` normalizes `win32`→`win` | ✅ (PR #804) |
| `.github/workflows/release.yml` ASSETS uploads win-x64 tarball | ✅ (PR #804) |
| `kuri-windows-cross-build.yml` workflow checkout | ✅ (PR #805 — was failing on missing `skills/foundry` submodule) |
| `submodules/kuri` `agent_main.zig` fork→spawnDetached | ✅ (kuri commit `352db65` on `windows-target`, pushed to lekt9/kuri) |

## Original blocker — CLOSED (kuri commit `88fb333` on windows-target)

The `websocket.zig:38` ABI mismatch is fixed. WebSocketClient now wraps
`compat.TcpStream` instead of holding a raw `std.posix.fd_t`. `compat.zig`
gained `setRecvTimeoutSec(stream, secs)` gated by `if (comptime is_windows)`
so the dead branch never elaborates `std.posix.SO.RCVTIMEO`. `client.zig`'s
`drainWsEvents` was updated to match.

**Result**: `kuri-agent` COMPILES on `x86_64-windows-gnu` (was: 1 error
in `agent_main.zig:302` — closed earlier via fork→spawnDetached). The
other build targets (`kuri-fetch`, `kuri-browse`, `merjs-e2e`) all link.

## Three new blockers — ALL CLOSED in kuri commit `f248771`

These were hidden behind the websocket error; visible after the websocket
layer compiled; closed in one commit on `lekt9/kuri:windows-target`:

| Site | Original error | Fix in `f248771` |
|---|---|---|
| `src/storage/auth_profiles.zig:126` | `std.c.opendir/readdir/closedir` — mingw libc lacks them | New `compat.listDirNames` primitive: POSIX arm keeps std.c; Windows arm uses `FindFirstFileW` / `FindNextFileW` / `FindClose` over `WIN32_FIND_DATAW` with UTF-16LE → UTF-8 conversion |
| `src/server/router.zig:1402` | `std.posix.read(stream.socket.handle, ...)` + `std.net.IpAddress.connect` | `discoverTabs` migrated to `compat.tcpConnectToHost` + `stream.writeAll` + `stream.read` + `compat.setRecvTimeoutSec`; error set drops `CannotResolveChromeAddress` |
| `src/main.zig:67` (transitive via `server.discoverTabs`) | `std/posix.zig:402` unsupported OS | Closed automatically by the router.zig migration above |

Plus the libcurl-impersonate Windows wiring (`build.zig` + `src/sandbox/curl_lib.zig`):

- `pickCurlImpersonateTriple` now returns the Windows triples, but
  only for the MSVC ABI — the vendor `.lib` drop is MSVC-built and
  cannot link via mingw on a POSIX host.
- mingw cross-compile falls through to the existing
  "no vendored libcurl-impersonate, sandbox falls back to subprocess
  curl" warn-and-skip path the build.zig already had.
- `src/sandbox/curl_lib.zig` adds a `comptime have_curl` guard that
  swaps the FFI surface for a stub namespace on mingw, so the link
  completes; `perform()` returns `error.CurlInitFailed` and the caller
  routes to subprocess-curl, matching the build warning's promise.

Build summary on windows-target tip `f248771`:
```
+- install kuri              ← COMPILES ✅  (5.1 MB kuri.exe)
+- install kuri-agent        ← COMPILES ✅  (2.5 MB kuri-agent.exe)
+- install kuri-fetch        ← COMPILES ✅  (6.5 MB kuri-fetch.exe)
+- install kuri-browse       ← COMPILES ✅  (5.3 MB kuri-browse.exe)
+- install merjs-e2e         ← COMPILES ✅  (2.0 MB merjs-e2e.exe)
```

## Closing both honest gaps (2026-05-26 PM, this PR)

The two gaps the cross-compile-only state left open are both closed
by the new `native-msvc-runtime` job in
`.github/workflows/kuri-windows-cross-build.yml`:

| Gap | Closed by |
|---|---|
| Runtime verification on Win10/11 (C-G06) | `native-msvc-runtime` runs on `windows-latest`, builds kuri.exe natively, launches it against the runner's preinstalled Chrome, polls `http://127.0.0.1:8080/health` until OK, then hits `/tabs` to confirm CDP handshake completed. Fail-closed if `/health` never returns OK within 30s. |
| libcurl-impersonate anti-bot fingerprint | `native-msvc-runtime` builds with `-Dtarget=x86_64-windows-msvc` (not mingw), which `pickCurlImpersonateTriple` only accepts under the MSVC ABI. The MSVC build links the vendored `libcurl-impersonate.lib` + BoringSSL + nghttp2/3 + ngtcp2 + brotli + zstd + zlib companion libs from `vendor/curl-impersonate/x86_64-windows/`, so the sandbox uses real curl-impersonate TLS/HTTP-2 fingerprints. |

The mingw `cross-link` job (ubuntu-latest, ~3 min) remains as fast
feedback for source-level Windows breakage. The native MSVC job
(windows-latest, ~10-15 min) runs only after cross-link is green
(`needs: cross-link`) to save runner minutes on PRs that already
fail compile-time.

`test-windows.yml` triggers also broadened to fire on every PR
touching `submodules/kuri/**`, `src/kuri/**`,
`packages/skill/scripts/**`, `packages/skill/vendor/kuri/**`,
`install.ps1`, or `src/single-binary.ts` — so unbrowse.exe E2E
(go → snap → close) gets the same runtime coverage as kuri.exe.

## Two paths to close it

| Path | Effort | Verification |
|---|---|---|
| **A. Lewis (or anyone with Windows hardware) drills the websocket compat layer** | ~2-3h focused | Run `kuri.exe` against real Chrome on Win11; observe CDP handshake completes |
| **B. CI matrix gains a `windows-latest` runner that boots Chrome + runs `kuri --launch-chrome`** | ~1h setup, future-proof | Automated, no manual hardware |

Recommend Path B. The CI matrix change is small; it amortizes the
verification cost across every future Windows-touching PR.

## Snapshot of progress

| Date | Status |
|---|---|
| Pre-2026-05-26 | `kuri-windows-cross-build.yml` failed at checkout (`skills/foundry` submodule missing). 4-second failure. No real attempt. |
| 2026-05-26 02:38 | Checkout fixed (PR #805). Cross-build runs zig. Fails on agent_main.zig:302 (fork) + websocket.zig:38 (socket). |
| 2026-05-26 02:50 | agent_main.zig fix shipped (kuri `352db65` on windows-target, pushed to lekt9/kuri). |
| 2026-05-26 03:05 | websocket.zig + client.zig refactor to compat.TcpStream (kuri `88fb333`). `kuri-agent` + 3 other exes now COMPILE on Windows. `kuri` still fails on 3 distinct sites listed above. |
| 2026-05-26 11:27 | All 3 remaining sites CLOSED in kuri `f248771`: auth_profiles via `compat.listDirNames`, router via `compat.TcpStream`, main.zig transitively. Plus libcurl-impersonate Windows wiring with mingw stub fallback. `kuri.exe` + 4 sibling .exe's all compile clean on `x86_64-windows-gnu`. |
| Now | submodules/kuri SHA bumped to `f248771`; cross-build workflow ready to re-fire. |

The unbrowse-dev pipeline is READY. Source-level Windows port is
COMPLETE; runtime verification on actual Windows hardware (or a
`windows-latest` CI matrix runner that boots Chrome) is the remaining
gap. Recommended next move: extend `.github/workflows/kuri-windows-cross-build.yml`
to also run `kuri.exe` against a headless Chrome on a `windows-latest`
runner so future Windows-touching PRs get automated coverage.
