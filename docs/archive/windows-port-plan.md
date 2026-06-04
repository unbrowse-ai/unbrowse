# Windows port — Kuri POSIX shims

**Status**: planning. Not started. Estimated effort: 2-3 focused days.

The npm package `unbrowse@6.7.0-preview.0` does not ship a Windows
binary because Kuri uses POSIX-only syscalls in two hot paths:
1. `chrome/launcher.zig:198` — `std.c.fork()` + `compat.execvp()` to
   spawn Chrome
2. (Already solved via libcurl-impersonate FFI:
   `sandbox/network.zig` no longer forks)

Plus a smaller set of POSIX assumptions in `compat.zig`.

## What works as-is on Windows

- **libcurl-impersonate** ships v1.5.6 binaries for `x86_64-win32`,
  `arm64-win32`, `i686-win32` at lexiforest/curl-impersonate releases.
  Same `.a` static-archive shape as macOS/Linux.
- **QuickJS-NG** is portable — no Windows-specific work required.
- **Zig std HTTP server** (used by `server/router.zig`) is portable.
- **CDP client over WebSocket** — `cdp/websocket.zig` uses Zig's
  `std.net` which is cross-platform.
- **`std.c.getenv`** works on MinGW + MSVC. `compat.getenv` should
  compile as-is.

## What needs replacement

### 1. `chrome/launcher.zig:108-211` — Chrome process spawn

Current POSIX flow (lines ~198-211):
```zig
const pid = std.c.fork();
if (pid == 0) {
    const devnull = std.c.open("/dev/null", ...);
    std.c.dup2(devnull, 1);
    std.c.dup2(devnull, 2);
    _ = compat.execvp(argv_z[0].?, @ptrCast(argv_z.ptr));
    std.c.exit(127);
}
self.child_pid = pid;
```

Windows replacement (sketch):
```zig
const PROCESS_INFORMATION = std.os.windows.PROCESS_INFORMATION;
const STARTUPINFOW = std.os.windows.STARTUPINFOW;

var startup: STARTUPINFOW = std.mem.zeroes(STARTUPINFOW);
startup.cb = @sizeOf(STARTUPINFOW);
// hStdOutput / hStdError = NULL device handles
var proc_info: PROCESS_INFORMATION = undefined;
const cmdline = try buildCmdLineW(self.allocator, argv_list.items);
defer self.allocator.free(cmdline);

if (std.os.windows.kernel32.CreateProcessW(
    null,                       // lpApplicationName (use cmdline)
    cmdline.ptr,                // lpCommandLine (mutable!)
    null, null,                 // security attrs
    std.os.windows.FALSE,       // bInheritHandles
    std.os.windows.CREATE_NEW_PROCESS_GROUP | std.os.windows.DETACHED_PROCESS,
    null, null,                 // env, cwd
    &startup,
    &proc_info,
) == 0) {
    return error.CreateProcessFailed;
}
self.child_pid = proc_info.dwProcessId;
self.child_handle = proc_info.hProcess; // NEW field on Windows path
_ = std.os.windows.kernel32.CloseHandle(proc_info.hThread);
```

`buildCmdLineW` needs to:
- Convert each argv arg to UTF-16 (Windows API)
- Quote args with spaces
- Escape backslashes per CommandLineToArgvW rules

This is the bulk of the Windows work. ~200 lines.

### 2. `chrome/launcher.zig` `kill` paths

Current uses `std.c.kill(pid, SIGTERM)`. Windows uses
`TerminateProcess(handle, exitCode)`.

Wrap in a `terminate(self)` method on `Launcher` that picks the right
syscall via `comptime` `if (builtin.os.tag == .windows)`.

### 3. `compat.zig` filesystem helpers

Current uses `std.c.open`, `std.c.read`, `std.c.write`, `std.c.close`
which are POSIX. `compat.zig:130+` already wraps these. On Windows,
`std.c.open` doesn't exist (`_open` instead), but **`std.os.windows`
has Win32 file APIs (`CreateFileW`, `ReadFile`, `WriteFile`)**.

Easier path: switch `compat.zig` to use Zig's `std.fs.File` API which
is already cross-platform. Removed for stdlib reasons earlier; can be
revisited now that we're on 0.16 stable.

### 4. `compat.execvp` declaration (`compat.zig:217`)

```zig
pub extern "c" fn execvp(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) c_int;
```

Doesn't exist on Windows (no exec semantics). Wrap as comptime no-op
on Windows since the launcher uses CreateProcessW path instead.

## libcurl-impersonate Windows vendoring

**STATUS: vendored** at:
```
submodules/kuri/vendor/curl-impersonate/x86_64-windows/   (12 MB)
submodules/kuri/vendor/curl-impersonate/aarch64-windows/  (11 MB)
```

Unlike the macOS/Linux single self-contained `libcurl-impersonate.a`,
the Windows release ships unbundled `.lib` files that need linking
together:

```
libcurl-impersonate.lib       — main HTTP/curl logic
crypto.lib + ssl.lib          — BoringSSL
nghttp2.lib + nghttp3.lib     — HTTP/2 + HTTP/3
ngtcp2.lib + ngtcp2_crypto_boringssl.lib  — QUIC
brotlicommon/brotlidec/brotlienc.lib       — compression
zlib.lib + zstd.lib           — compression
```

Update `submodules/kuri/build.zig` `pickCurlImpersonateTriple`:
```zig
.windows => switch (t.cpu.arch) {
    .x86_64 => "x86_64-windows",
    .aarch64 => "aarch64-windows",
    else => error.UnsupportedTriple,
},
```

Plus update the link block:
```zig
if (target.result.os.tag == .windows) {
    const libs = [_][]const u8{
        "libcurl-impersonate", "crypto", "ssl",
        "nghttp2", "nghttp3", "ngtcp2", "ngtcp2_crypto_boringssl",
        "brotlicommon", "brotlidec", "brotlienc",
        "zlib", "zstd",
    };
    for (libs) |lib| {
        const lib_path = b.path(b.fmt("vendor/curl-impersonate/{s}/{s}.lib", .{ triple, lib }));
        compile_step.root_module.addObjectFile(lib_path);
    }
    // BoringSSL needs these Windows system libs.
    compile_step.root_module.linkSystemLibrary("ws2_32", .{});
    compile_step.root_module.linkSystemLibrary("crypt32", .{});
    compile_step.root_module.linkSystemLibrary("secur32", .{});
    compile_step.root_module.linkSystemLibrary("bcrypt", .{});
    compile_step.root_module.linkSystemLibrary("iphlpapi", .{});
    compile_step.root_module.linkSystemLibrary("userenv", .{});
    compile_step.root_module.linkSystemLibrary("advapi32", .{});
}
```

## CI

After Kuri changes are in:
1. Add `win-x64` and `win-arm64` to `supportedTargets` in
   `packages/skill/scripts/lib/kuri-vendor.mjs`
2. Zig cross-compile from Linux → Windows works out of the box (Zig
   ships MinGW-w64 stubs)
3. No Windows runner needed

## Concrete next steps

1. **Vendor Windows libcurl-impersonate** (~10 min) — download both
   archives, drop into `submodules/kuri/vendor/curl-impersonate/`
2. **Wire `pickCurlImpersonateTriple`** for Windows (~5 lines)
3. **Convert `chrome/launcher.zig` to use a Launcher.spawn helper** that
   dispatches to either fork/exec (POSIX) or CreateProcessW (Windows).
   This is the bulk — ~200 lines, plus building UTF-16 cmdline.
4. **Test cross-compile**: `zig build -Dtarget=x86_64-windows`. Iterate
   on link errors (BoringSSL system lib deps mostly).
5. **Test in Wine** — `wine ./zig-out/bin/kuri.exe --version` for
   smoke. Real validation requires a Windows VM.
6. **Add to `supportedTargets`** + ship.

## What I'd defer

- **Windows Chrome installation detection** — `findChromeBinary()` in
  launcher.zig currently checks macOS + Linux paths. Need to add
  `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` etc. ~30 lines.
- **Windows code-signing for the npm-bundled binary** — Microsoft
  Defender will SmartScreen-block unsigned `.exe` downloads from npm.
  Either we sign (~$300/year EV cert) or document the bypass for now.
- **Windows path normalization in `compat.cwdReadFile` / similar** —
  forward slashes vs backslashes; Zig's std.fs handles this if we
  switch to it.
