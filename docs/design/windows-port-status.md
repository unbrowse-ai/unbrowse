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

## What's left — ONE blocker

**`submodules/kuri/src/cdp/websocket.zig:38`** — direct `std.c.socket()` call returns `c_int` but `std.posix.fd_t` on Windows is `*anyopaque` (Windows HANDLE / SOCKET). The same file calls `std.posix.setsockopt`, `std.posix.SO.RCVTIMEO`, and a `c_connect` extern that all assume POSIX socket semantics. On Windows the equivalents are `WSASocketW`, `WSAConnect`, `closesocket`, and the SO_* constants are different.

Exact zig errors on `-Dtarget=x86_64-windows-gnu`:

```
src/cdp/websocket.zig:38:36: error: expected type '*anyopaque', found 'c_int'
.../std/posix.zig:402:32: error: unsupported OS    (std.posix.SO.RCVTIMEO on Windows)
.../std/posix.zig:1075:9: error: use std.Io instead
```

## What the fix looks like

Two PRs against `lekt9/kuri:windows-target`:

### PR 1 — add socket primitives to `src/compat.zig`

Mirror the existing `spawnDetached / waitProc / killProc` pattern. Add:

```zig
pub const Socket = if (is_windows) win.SOCKET else std.posix.socket_t;

pub fn socketTcp4() !Socket
pub fn socketConnect(sock: Socket, ip: u32, port: u16) !void
pub fn socketSetRecvTimeout(sock: Socket, secs: i32) !void
pub fn socketRead(sock: Socket, buf: []u8) !usize
pub fn socketWrite(sock: Socket, buf: []const u8) !usize
pub fn socketClose(sock: Socket) void
```

Windows branch uses `WSAStartup` (one-time init), `WSASocketW`, `connect`,
`recv`, `send`, `closesocket`. POSIX branch shells out to `std.c.socket` /
`std.posix.setsockopt` / `std.posix.read` / `std.posix.write` / `std.c.close`.

### PR 2 — `src/cdp/websocket.zig` calls the compat layer

Replace direct `std.c.socket(...)`, `c_connect(...)`, `std.posix.setsockopt(...)`
with `compat.socketTcp4()`, `compat.socketConnect(...)`, `compat.socketSetRecvTimeout(...)`,
etc. `WebSocketClient.fd` becomes `compat.Socket`.

Pure mechanical refactor once PR 1's primitives exist.

## Why this didn't ship tonight

- The Windows socket API differs from POSIX in non-trivial ways (init,
  handle type, close function name, sockopt constants). Getting it
  wrong silently breaks at runtime, not at compile time.
- The change cannot be verified from a Mac. C-G06 (verify the served
  surface, not the source) is binding here: a Zig cross-compile that
  passes `zig build` does NOT prove the resulting binary actually
  connects to Chrome's CDP on Windows. Without a Windows machine, we'd
  be claiming green without evidence.

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
| Now | One remaining error: websocket.zig:38. Documented above with exact API surface needed. |

The unbrowse-dev pipeline is READY. The remaining blocker is one
compat-layer extension in the kuri submodule.
