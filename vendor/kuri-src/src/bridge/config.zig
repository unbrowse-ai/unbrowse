const std = @import("std");

pub const Config = struct {
    host: []const u8,
    port: u16,
    cdp_url: ?[]const u8,
    auth_secret: ?[]const u8,
    state_dir: []const u8,
    stale_tab_interval_s: u32,
    request_timeout_ms: u32,
    navigate_timeout_ms: u32,
    extensions: ?[]const u8,
};

pub fn load() Config {
    return .{
        .host = std.posix.getenv("HOST") orelse "127.0.0.1",
        .port = parsePort() orelse 8080,
        .cdp_url = std.posix.getenv("CDP_URL"),
        .auth_secret = std.posix.getenv("BROWDIE_SECRET"),
        .state_dir = std.posix.getenv("STATE_DIR") orelse ".browdie",
        .stale_tab_interval_s = parseU32("STALE_TAB_INTERVAL_S") orelse 30,
        .request_timeout_ms = parseU32("REQUEST_TIMEOUT_MS") orelse 30_000,
        .navigate_timeout_ms = parseU32("NAVIGATE_TIMEOUT_MS") orelse 30_000,
        .extensions = std.posix.getenv("BROWDIE_EXTENSIONS"),
    };
}

fn parsePort() ?u16 {
    const val = std.posix.getenv("PORT") orelse return null;
    return std.fmt.parseInt(u16, val, 10) catch null;
}

fn parseU32(name: []const u8) ?u32 {
    const val = std.posix.getenv(name) orelse return null;
    return std.fmt.parseInt(u32, val, 10) catch null;
}

test "load returns defaults" {
    const cfg = load();
    try std.testing.expectEqualStrings("127.0.0.1", cfg.host);
    try std.testing.expectEqual(@as(u16, 8080), cfg.port);
    try std.testing.expectEqual(@as(?[]const u8, null), cfg.cdp_url);
    try std.testing.expectEqual(@as(u32, 30), cfg.stale_tab_interval_s);
    try std.testing.expectEqual(@as(?[]const u8, null), cfg.extensions);
}
