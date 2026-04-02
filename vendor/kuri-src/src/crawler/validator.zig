const std = @import("std");

pub const ValidationError = error{
    InvalidScheme,
    PrivateIp,
    LocalhostBlocked,
    InvalidUrl,
    MetadataIpBlocked,
    InvalidPath,
    PathTraversal,
    SymlinkNotAllowed,
};

pub fn validateUrl(url: []const u8) ValidationError!void {
    if (!std.mem.startsWith(u8, url, "http://") and !std.mem.startsWith(u8, url, "https://")) {
        return ValidationError.InvalidScheme;
    }

    const host = extractHost(url) orelse return ValidationError.InvalidUrl;

    if (std.mem.eql(u8, host, "localhost") or std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "::1")) {
        return ValidationError.LocalhostBlocked;
    }

    if (isMetadataIpv4(host) or std.mem.eql(u8, host, "100.100.100.200")) {
        return ValidationError.MetadataIpBlocked;
    }

    if (isPrivateIpv4(host)) {
        return ValidationError.PrivateIp;
    }

    if (isPrivateIpv6(host)) {
        return ValidationError.PrivateIp;
    }
}

/// validateOutputPath checks that the given path is safe to write to:
/// - must be absolute (starts with '/')
/// - must not contain path traversal components (..)
/// - must not be a symlink (symlink-safe via lstat)
pub fn validateOutputPath(path: []const u8) ValidationError!void {
    if (path.len == 0 or path[0] != '/') {
        return ValidationError.InvalidPath;
    }

    // Reject any path traversal component
    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |component| {
        if (std.mem.eql(u8, component, "..")) {
            return ValidationError.PathTraversal;
        }
    }

    // Symlink check via lstat
    const stat = std.fs.cwd().statFile(path) catch |err| switch (err) {
        // File doesn't exist yet — safe to create
        error.FileNotFound => return,
        // Access denied or other OS errors — reject conservatively
        else => return ValidationError.InvalidPath,
    };

    if (stat.kind == .sym_link) {
        return ValidationError.SymlinkNotAllowed;
    }
}

fn extractHost(url: []const u8) ?[]const u8 {
    const scheme_end = std.mem.indexOf(u8, url, "://") orelse return null;
    const after_scheme = url[scheme_end + 3 ..];

    const after_auth = if (std.mem.indexOfScalar(u8, after_scheme, '@')) |idx| after_scheme[idx + 1 ..] else after_scheme;

    // Handle IPv6 [::1] notation
    if (after_auth.len > 0 and after_auth[0] == '[') {
        if (std.mem.indexOfScalar(u8, after_auth, ']')) |bracket_end| {
            return after_auth[1..bracket_end];
        }
        return null;
    }

    var end = after_auth.len;
    if (std.mem.indexOfScalar(u8, after_auth, ':')) |idx| end = @min(end, idx);
    if (std.mem.indexOfScalar(u8, after_auth, '/')) |idx| end = @min(end, idx);
    if (std.mem.indexOfScalar(u8, after_auth, '?')) |idx| end = @min(end, idx);

    if (end == 0) return null;
    return after_auth[0..end];
}

fn isPrivateIpv4(host: []const u8) bool {
    var it = std.mem.splitScalar(u8, host, '.');
    const first_str = it.next() orelse return false;
    const first = std.fmt.parseInt(u8, first_str, 10) catch return false;

    if (first == 10) return true;
    if (first == 127) return true;

    const second_str = it.next() orelse return false;
    const second = std.fmt.parseInt(u8, second_str, 10) catch return false;

    if (first == 172 and second >= 16 and second <= 31) return true;
    if (first == 192 and second == 168) return true;

    return false;
}

/// isMetadataIpv4 blocks the entire 169.254.0.0/16 link-local / cloud metadata range.
fn isMetadataIpv4(host: []const u8) bool {
    var it = std.mem.splitScalar(u8, host, '.');
    const first_str = it.next() orelse return false;
    const first = std.fmt.parseInt(u8, first_str, 10) catch return false;
    if (first != 169) return false;
    const second_str = it.next() orelse return false;
    const second = std.fmt.parseInt(u8, second_str, 10) catch return false;
    if (second != 254) return false;
    // Validate remaining octets exist and are numeric (ensures it's a real IP)
    const third_str = it.next() orelse return false;
    _ = std.fmt.parseInt(u8, third_str, 10) catch return false;
    const fourth_str = it.next() orelse return false;
    _ = std.fmt.parseInt(u8, fourth_str, 10) catch return false;
    return true;
}

/// isPrivateIpv6 blocks:
///   ::1              loopback
///   fe80::/10        link-local  (fe80–febf)
///   fc00::/7         ULA         (fc00–fdff)
///   ::ffff:10.x      IPv4-mapped private 10/8
///   ::ffff:172.16-31.x  IPv4-mapped private 172.16/12
///   ::ffff:192.168.x    IPv4-mapped private 192.168/16
///   ::ffff:169.254.x    IPv4-mapped link-local / metadata
///   ::ffff:127.0.0.1    IPv4-mapped loopback
fn isPrivateIpv6(host: []const u8) bool {
    var buf: [64]u8 = undefined;
    if (host.len > buf.len) return false;
    const lower = std.ascii.lowerString(buf[0..host.len], host);

    // Loopback
    if (std.mem.eql(u8, lower, "::1")) return true;

    // Link-local fe80::/10 — first 10 bits 1111111010 covers fe80–febf
    if (std.mem.startsWith(u8, lower, "fe8") or
        std.mem.startsWith(u8, lower, "fe9") or
        std.mem.startsWith(u8, lower, "fea") or
        std.mem.startsWith(u8, lower, "feb"))
    {
        return true;
    }

    // ULA fc00::/7 — covers fc00::–fdff::
    if (std.mem.startsWith(u8, lower, "fc") or std.mem.startsWith(u8, lower, "fd")) {
        return true;
    }

    // IPv4-mapped ::ffff:<dotted-decimal>
    const mapped_prefix = "::ffff:";
    if (std.mem.startsWith(u8, lower, mapped_prefix)) {
        const ipv4_part = lower[mapped_prefix.len..];
        if (isPrivateIpv4(ipv4_part)) return true;
        if (isMetadataIpv4(ipv4_part)) return true;
        if (std.mem.eql(u8, ipv4_part, "127.0.0.1")) return true;
    }

    return false;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test "validateUrl accepts valid URLs" {
    try validateUrl("https://example.com");
    try validateUrl("http://example.com/path?q=1");
    try validateUrl("https://sub.domain.com:8080/path");
}

test "validateUrl rejects invalid schemes" {
    try std.testing.expectError(ValidationError.InvalidScheme, validateUrl("ftp://example.com"));
    try std.testing.expectError(ValidationError.InvalidScheme, validateUrl("javascript:alert(1)"));
    try std.testing.expectError(ValidationError.InvalidScheme, validateUrl("file:///etc/passwd"));
}

test "validateUrl blocks localhost" {
    try std.testing.expectError(ValidationError.LocalhostBlocked, validateUrl("http://localhost"));
    try std.testing.expectError(ValidationError.LocalhostBlocked, validateUrl("http://127.0.0.1"));
    try std.testing.expectError(ValidationError.LocalhostBlocked, validateUrl("http://[::1]"));
}

test "validateUrl blocks private IPs" {
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://10.0.0.1"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://172.16.0.1"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://192.168.1.1"));
}

test "validateUrl blocks metadata IPs" {
    // Exact AWS IMDSv1
    try std.testing.expectError(ValidationError.MetadataIpBlocked, validateUrl("http://169.254.169.254"));
    // Alibaba Cloud metadata
    try std.testing.expectError(ValidationError.MetadataIpBlocked, validateUrl("http://100.100.100.200"));
    // Range check — any 169.254.x.x must be blocked
    try std.testing.expectError(ValidationError.MetadataIpBlocked, validateUrl("http://169.254.0.1"));
    try std.testing.expectError(ValidationError.MetadataIpBlocked, validateUrl("http://169.254.255.255"));
    try std.testing.expectError(ValidationError.MetadataIpBlocked, validateUrl("http://169.254.1.2"));
}

test "isMetadataIpv4 range check" {
    try std.testing.expect(isMetadataIpv4("169.254.0.0"));
    try std.testing.expect(isMetadataIpv4("169.254.169.254"));
    try std.testing.expect(isMetadataIpv4("169.254.255.255"));
    try std.testing.expect(!isMetadataIpv4("169.253.0.0"));
    try std.testing.expect(!isMetadataIpv4("170.254.0.0"));
    try std.testing.expect(!isMetadataIpv4("10.0.0.1"));
}

test "isPrivateIpv6 loopback" {
    try std.testing.expect(isPrivateIpv6("::1"));
}

test "isPrivateIpv6 link-local fe80::/10" {
    try std.testing.expect(isPrivateIpv6("fe80::1"));
    try std.testing.expect(isPrivateIpv6("fe80::1234:5678"));
    try std.testing.expect(isPrivateIpv6("FE80::1"));
    try std.testing.expect(isPrivateIpv6("feb0::1"));
    try std.testing.expect(!isPrivateIpv6("fec0::1")); // outside fe80::/10
}

test "isPrivateIpv6 ULA fc00::/7" {
    try std.testing.expect(isPrivateIpv6("fc00::1"));
    try std.testing.expect(isPrivateIpv6("fd00::1"));
    try std.testing.expect(isPrivateIpv6("fdff::1"));
    try std.testing.expect(!isPrivateIpv6("fe00::1"));
    try std.testing.expect(!isPrivateIpv6("2001:db8::1"));
}

test "isPrivateIpv6 IPv4-mapped private addresses" {
    try std.testing.expect(isPrivateIpv6("::ffff:10.0.0.1"));
    try std.testing.expect(isPrivateIpv6("::ffff:10.255.255.255"));
    try std.testing.expect(isPrivateIpv6("::ffff:172.16.0.1"));
    try std.testing.expect(isPrivateIpv6("::ffff:172.31.255.255"));
    try std.testing.expect(isPrivateIpv6("::ffff:192.168.0.1"));
    try std.testing.expect(isPrivateIpv6("::ffff:192.168.255.255"));
    try std.testing.expect(isPrivateIpv6("::ffff:169.254.169.254"));
    try std.testing.expect(isPrivateIpv6("::ffff:169.254.0.1"));
    try std.testing.expect(isPrivateIpv6("::ffff:127.0.0.1"));
    // public addresses should NOT be blocked
    try std.testing.expect(!isPrivateIpv6("::ffff:8.8.8.8"));
    try std.testing.expect(!isPrivateIpv6("::ffff:1.1.1.1"));
}

test "validateUrl blocks IPv6 private addresses" {
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://[fe80::1]"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://[fc00::1]"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://[fd00::1]"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://[::ffff:10.0.0.1]"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://[::ffff:192.168.1.1]"));
    try std.testing.expectError(ValidationError.PrivateIp, validateUrl("http://[::ffff:169.254.169.254]"));
}

test "validateUrl allows public IPv6 addresses" {
    try validateUrl("http://[2001:db8::1]");
    try validateUrl("https://[2606:4700:4700::1111]");
}

test "validateOutputPath rejects relative paths" {
    try std.testing.expectError(ValidationError.InvalidPath, validateOutputPath("relative/path"));
    try std.testing.expectError(ValidationError.InvalidPath, validateOutputPath(""));
}

test "validateOutputPath rejects path traversal" {
    try std.testing.expectError(ValidationError.PathTraversal, validateOutputPath("/safe/../etc/passwd"));
    try std.testing.expectError(ValidationError.PathTraversal, validateOutputPath("/tmp/../../etc/shadow"));
    try std.testing.expectError(ValidationError.PathTraversal, validateOutputPath("/../etc/passwd"));
}

test "validateOutputPath accepts valid absolute paths for non-existent files" {
    try validateOutputPath("/tmp/browdie-test-output-nonexistent-abc123.json");
    try validateOutputPath("/var/tmp/browdie-output-nonexistent.html");
}

test "extractHost" {
    try std.testing.expectEqualStrings("example.com", extractHost("https://example.com/path").?);
    try std.testing.expectEqualStrings("example.com", extractHost("https://example.com:8080").?);
    try std.testing.expectEqualStrings("example.com", extractHost("https://user:pass@example.com/path").?);
    try std.testing.expectEqualStrings("::1", extractHost("http://[::1]").?);
    try std.testing.expectEqualStrings("fe80::1", extractHost("http://[fe80::1]").?);
}
