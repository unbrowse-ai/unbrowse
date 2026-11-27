// Zig 0.17.0's lib/std/Io/Threaded.zig, posixConnect alone (MIT, ziglang/zig), for test_patch_zig_std.py.

fn posixConnect(
    socket_fd: posix.socket_t,
    addr: *const posix.sockaddr,
    addr_len: posix.socklen_t,
) !void {
    const syscall: Syscall = try .start();
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
        .CONNREFUSED => return syscall.fail(error.ConnectionRefused),
        .CONNRESET => return syscall.fail(error.ConnectionResetByPeer),
        .HOSTUNREACH => return syscall.fail(error.HostUnreachable),
        .NETUNREACH => return syscall.fail(error.NetworkUnreachable),
        .TIMEDOUT => return syscall.fail(error.Timeout),
        .ACCES => return syscall.fail(error.AccessDenied),
        .NETDOWN => return syscall.fail(error.NetworkDown),
        .BADF => |err| return syscall.errnoBug(err), // File descriptor used after closed.
        .CONNABORTED => |err| return syscall.errnoBug(err),
        .FAULT => |err| return syscall.errnoBug(err),
        .ISCONN => |err| return syscall.errnoBug(err),
        .NOENT => |err| return syscall.errnoBug(err),
        .NOTSOCK => |err| return syscall.errnoBug(err),
        .PERM => |err| return syscall.errnoBug(err),
        .PROTOTYPE => |err| return syscall.errnoBug(err),
        else => |err| return syscall.unexpectedErrno(err),
    };
}


fn posixConnectUnix() void {}
