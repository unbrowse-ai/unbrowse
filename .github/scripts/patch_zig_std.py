#!/usr/bin/env python3
"""Patches the Zig standard library the window builds with, in place, so a connect a signal interrupted never aborts.

Zig 0.17's `Io.Threaded.posixConnect` asks `connect` again after EINTR. A connect a signal interrupted goes on in the
kernel (POSIX), so asking again answers EALREADY while it does and EISCONN once it has; Zig reads EISCONN as a
programmer's bug and panics ("programmer bug caused syscall error: ISCONN"), which killed the window in a QA run
(PR #843, run 45040934221). Zig 0.17.1 and master read it the same way (2026-11-23). As Rust's std does, after an
interrupted connect the patched function waits for it to settle and reads its outcome from SO_ERROR: macOS can answer
EISCONN for a connect that was refused.

Usage: patch_zig_std.py [LIB_DIR]  (default: `zig env`'s lib_dir). Idempotent: a patched library is left as it is.
Fails, naming the function, when the source isn't the one this patch was written for.
"""
import pathlib
import re
import subprocess
import sys

MARK = "// unbrowse: an interrupted connect settles"

ORIGINAL = """    const syscall: Syscall = try .start();
    while (true) switch (posix.errno(posix.system.connect(socket_fd, addr, addr_len))) {
        .SUCCESS => {
            syscall.finish();
            return;
        },
        .INTR => {
            try syscall.checkCancel();
            continue;
        },
        .ADDRNOTAVAIL => return syscall.fail(error.AddressUnavailable),
        .AFNOSUPPORT => return syscall.fail(error.AddressFamilyUnsupported),
        .AGAIN, .INPROGRESS => return syscall.fail(error.WouldBlock),
        .ALREADY => return syscall.fail(error.ConnectionPending),
"""

PATCHED = """    const syscall: Syscall = try .start();
    // unbrowse: an interrupted connect settles (.github/scripts/patch_zig_std.py). A connect a signal interrupted goes
    // on in the kernel: asked again it answers EALREADY while it does and EISCONN once it has, so after EINTR either
    // one waits for it to settle and reads its outcome from SO_ERROR (macOS answers EISCONN for a refused one too).
    var interrupted = false;
    while (true) switch (posix.errno(posix.system.connect(socket_fd, addr, addr_len))) {
        .SUCCESS => {
            syscall.finish();
            return;
        },
        .INTR => {
            try syscall.checkCancel();
            interrupted = true;
            continue;
        },
        .ALREADY, .ISCONN => |err| {
            if (!interrupted) return if (err == .ISCONN) syscall.errnoBug(err) else syscall.fail(error.ConnectionPending);
            var pfd = [1]posix.pollfd{.{ .fd = socket_fd, .events = posix.POLL.OUT, .revents = 0 }};
            while (true) switch (posix.errno(posix.system.poll(&pfd, 1, -1))) {
                .SUCCESS => break,
                .INTR => continue,
                else => |e| return syscall.unexpectedErrno(e),
            };
            var so_error: i32 = 0;
            var len: posix.socklen_t = @sizeOf(i32);
            switch (posix.errno(posix.system.getsockopt(socket_fd, posix.SOL.SOCKET, posix.SO.ERROR, @ptrCast(&so_error), &len))) {
                .SUCCESS => {},
                else => |e| return syscall.unexpectedErrno(e),
            }
            if (so_error == 0) {
                syscall.finish();
                return;
            }
            return switch (@as(posix.E, @enumFromInt(so_error))) {
                .CONNREFUSED => syscall.fail(error.ConnectionRefused),
                .CONNRESET => syscall.fail(error.ConnectionResetByPeer),
                .HOSTUNREACH => syscall.fail(error.HostUnreachable),
                .NETUNREACH => syscall.fail(error.NetworkUnreachable),
                .TIMEDOUT => syscall.fail(error.Timeout),
                .ADDRNOTAVAIL => syscall.fail(error.AddressUnavailable),
                .ACCES => syscall.fail(error.AccessDenied),
                .NETDOWN => syscall.fail(error.NetworkDown),
                else => |e| syscall.unexpectedErrno(e),
            };
        },
        .ADDRNOTAVAIL => return syscall.fail(error.AddressUnavailable),
        .AFNOSUPPORT => return syscall.fail(error.AddressFamilyUnsupported),
        .AGAIN, .INPROGRESS => return syscall.fail(error.WouldBlock),
"""

GONE = "        .ISCONN => |err| return syscall.errnoBug(err),\n"


def function_of(text: str) -> tuple[int, int]:
    start = text.index("\nfn posixConnect(\n")
    end = text.index("\n}\n", start) + 3
    return start, end


def patch(source: str) -> str:
    """`source` (lib/std/Io/Threaded.zig) with `posixConnect` patched; as it is when it already was."""
    if MARK in source:
        return source
    start, end = function_of(source)
    body = source[start:end]
    if body.count(ORIGINAL) != 1 or body.count(GONE) != 1:
        raise SystemExit("patch_zig_std: posixConnect isn't the Zig 0.17 function this patch was written for; read it and update the patch")
    body = body.replace(ORIGINAL, PATCHED).replace(GONE, "")
    return source[:start] + body + source[end:]


def lib_dir() -> pathlib.Path:
    """The library `zig` on PATH builds with: `zig env` says it, as ZON (0.17) or JSON (older)."""
    env = subprocess.run(["zig", "env"], check=True, capture_output=True, text=True).stdout
    found = re.search(r'\.?"?lib_dir"?\s*[=:]\s*"([^"]+)"', env)
    if not found:
        raise SystemExit(f"patch_zig_std: `zig env` names no lib_dir: {env[:200]}")
    return pathlib.Path(found.group(1))


def main(argv: list[str]) -> int:
    lib = pathlib.Path(argv[1]) if len(argv) > 1 else lib_dir()
    target = lib / "std" / "Io" / "Threaded.zig"
    source = target.read_text()
    patched = patch(source)
    if patched == source:
        print(f"ZIG_STD_PATCHED already: {target}")
        return 0
    target.write_text(patched)
    print(f"ZIG_STD_PATCHED {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
