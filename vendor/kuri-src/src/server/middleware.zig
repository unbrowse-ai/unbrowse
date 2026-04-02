const std = @import("std");
const Config = @import("../bridge/config.zig").Config;

/// Check auth header against configured secret.
/// Returns true if no secret is configured or if the header matches.
pub fn checkAuth(request: *std.http.Server.Request, cfg: Config) bool {
    const secret = cfg.auth_secret orelse return true;

    // Iterate headers to find Authorization
    var it = request.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "authorization")) {
            return constantTimeEql(header.value, secret);
        }
    }
    return false;
}

/// Constant-time string comparison to prevent timing attacks.
fn constantTimeEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, b) |ca, cb| {
        diff |= ca ^ cb;
    }
    return diff == 0;
}

test "constantTimeEql" {
    try std.testing.expect(constantTimeEql("secret123", "secret123"));
    try std.testing.expect(!constantTimeEql("secret123", "secret456"));
    try std.testing.expect(!constantTimeEql("short", "longer"));
}

/// Generate a request ID as a 16-char hex string from 8 random bytes.
/// Caller owns the returned slice.
pub fn generateRequestId(allocator: std.mem.Allocator) ![]u8 {
    var rng = std.Random.DefaultPrng.init(@as(u64, @intCast(@abs(std.time.nanoTimestamp()))));
    var bytes: [8]u8 = undefined;
    rng.random().bytes(&bytes);
    const hex = std.fmt.bytesToHex(bytes, .lower);
    return allocator.dupe(u8, &hex);
}

/// High-resolution timer for measuring request duration.
pub const RequestTimer = struct {
    start_ns: i128,

    pub fn start() RequestTimer {
        return .{ .start_ns = std.time.nanoTimestamp() };
    }

    pub fn elapsed(self: RequestTimer) u64 {
        const diff = std.time.nanoTimestamp() - self.start_ns;
        return if (diff > 0) @as(u64, @intCast(diff)) else 0;
    }
};

/// Emit a structured key=value log line to stderr.
pub fn logRequest(
    method: []const u8,
    path: []const u8,
    status: u16,
    duration_ns: u64,
    request_id: []const u8,
) void {
    std.debug.print(
        "method={s} path={s} status={d} duration_ns={d} request_id={s}\n",
        .{ method, path, status, duration_ns, request_id },
    );
}

test "generateRequestId produces 16-char hex string" {
    const allocator = std.testing.allocator;
    const id = try generateRequestId(allocator);
    defer allocator.free(id);
    try std.testing.expectEqual(@as(usize, 16), id.len);
    for (id) |c| {
        const valid = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f');
        try std.testing.expect(valid);
    }
}

test "RequestTimer elapsed is non-negative and monotonic" {
    const t = RequestTimer.start();
    const e1 = t.elapsed();
    // small busy loop — just burn a few nanoseconds
    std.atomic.spinLoopHint();
    const e2 = t.elapsed();
    try std.testing.expect(e2 >= e1);
}

test "logRequest does not crash" {
    logRequest("GET", "/health", 200, 123456, "deadbeefcafe0011");
}
