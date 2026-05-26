# Windows port — exact state and remaining blocker

This doc captures the precise state of the Windows port as of 2026-05-26
after a drill session that closed 3 of 4 blockers. One blocker remains;
it requires Zig+Windows socket-API work and verification on actual
Windows hardware, both of which exceeded the autonomous session's reach.

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

## Three new blockers surfaced (not in websocket scope)

These were hidden behind the websocket error; visible now that the
websocket layer compiles:

| Site | Error | Shape of fix |
|---|---|---|
| `src/main.zig:67` (transitive via `server.discoverTabs`) | `std/posix.zig:402` unsupported OS | Refactor discoverTabs networking to compat.TcpStream OR std.Io.net |
| `src/server/router.zig:1402` | `std.posix.read(stream.socket.handle, ...)` — std.Io migration needed | Switch to compat.TcpStream.read or migrate the std.net.Stream uses to std.Io |
| `src/storage/auth_profiles.zig:126` | `std.c.opendir/readdir/closedir` — mingw libc lacks them | Add Windows arm using FindFirstFileW / FindNextFileW / FindClose |

Build summary on windows-target tip `88fb333`:
```
+- install kuri               ← 3 errors (sites above)
+- install kuri-agent         ← COMPILES ✅
+- install kuri-fetch         ← LINKS  ✅
+- install kuri-browse        ← LINKS  ✅
+- install merjs-e2e          ← LINKS  ✅
```

## Why the websocket fix is honest progress, not "Windows green"

- C-G06 binding: compile-time green ≠ runtime verified. The websocket
  refactor is correct at compile time; whether the resulting websocket
  actually shakes hands with Chrome's CDP on a real Windows machine
  needs Win11 hardware to verify.
- The metric "websocket.zig:38 compiles on Windows" is satisfied.
- The metric "kuri.exe ships on Windows" is NOT satisfied (3 sites remain).
- Three more PRs against `lekt9/kuri:windows-target` close kuri.exe;
  none in scope of this commit chain.

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
| Now | submodules/kuri SHA bumped on unbrowse-dev main; cross-build workflow re-fired. |

The unbrowse-dev pipeline is READY. Three remaining sites in kuri are
distinct Windows-port work, scoped for separate PRs (router → compat
or std.Io; auth_profiles → Win32 directory enumeration; main.zig
transitive via discoverTabs).
