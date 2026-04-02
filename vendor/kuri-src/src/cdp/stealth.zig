const std = @import("std");

/// Stealth JS script embedded at comptime.
pub const stealth_script = @embedFile("js/stealth.js");

/// User agents for rotation.
pub const user_agents = [_][]const u8{
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
};

/// Get a pseudo-random user agent based on timestamp.
pub fn randomUserAgent() []const u8 {
    const ts: u64 = @intCast(std.time.timestamp());
    return user_agents[ts % user_agents.len];
}

test "stealth script loads" {
    try std.testing.expect(stealth_script.len > 0);
}

test "randomUserAgent returns valid UA" {
    const ua = randomUserAgent();
    try std.testing.expect(ua.len > 0);
    try std.testing.expect(std.mem.indexOf(u8, ua, "Mozilla") != null);
}
