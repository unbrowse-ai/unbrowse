//! Figures as the screens show them (lib/money.ts): amounts of USDC (fees,
//! deposits, caps, earnings) and of UNB (route coins) with thousands separators,
//! dollars, percentages, "3 min ago", dates and short addresses. Each names
//! its token, so a screen never shows one token's amount as the other's.
//! Each writes into the frame's memory through `c.print`-like allocation.
const std = @import("std");

/// `n` with `decimals` places and commas: 12,345.68.
pub fn fixed(a: std.mem.Allocator, n: f64, decimals: u8) []const u8 {
    const neg = n < 0;
    const raw = std.fmt.allocPrint(a, "{d:.[1]}", .{ @abs(n), decimals }) catch return "";
    const dot = std.mem.indexOfScalar(u8, raw, '.') orelse raw.len;
    const int = raw[0..dot];
    var out: std.ArrayList(u8) = .empty;
    if (neg) out.append(a, '-') catch {};
    for (int, 0..) |ch, i| {
        if (i > 0 and (int.len - i) % 3 == 0) out.append(a, ',') catch {};
        out.append(a, ch) catch {};
    }
    out.appendSlice(a, raw[dot..]) catch {};
    return out.items;
}

/// An amount of USDC: fees, deposits, caps, spend and earnings.
pub fn usdc(a: std.mem.Allocator, n: f64) []const u8 {
    return fixed(a, n, 2);
}

pub fn usdcd(a: std.mem.Allocator, n: f64, decimals: u8) []const u8 {
    return fixed(a, n, decimals);
}

/// An amount of UNB, or of route coins, which are counted as UNB is: a first buy, what coins are worth, a coin count.
pub fn unb(a: std.mem.Allocator, n: f64) []const u8 {
    return fixed(a, n, 2);
}

pub fn unbd(a: std.mem.Allocator, n: f64, decimals: u8) []const u8 {
    return fixed(a, n, decimals);
}

/// Signed: +1.00 or -1.00, of either token.
pub fn signed(a: std.mem.Allocator, n: f64) []const u8 {
    const s = fixed(a, @abs(n), 2);
    return std.fmt.allocPrint(a, "{s}{s}", .{ if (n < 0) "-" else "+", s }) catch "";
}

pub fn usd(a: std.mem.Allocator, n: f64) []const u8 {
    return std.fmt.allocPrint(a, "${s}", .{fixed(a, n, 2)}) catch "";
}

pub fn pct(a: std.mem.Allocator, n: f64, decimals: u8) []const u8 {
    return std.fmt.allocPrint(a, "{s}%", .{fixed(a, n * 100, decimals)}) catch "";
}

pub fn count(a: std.mem.Allocator, n: f64) []const u8 {
    return fixed(a, n, 0);
}

/// "Just now", "3 min ago", "Yesterday" from seconds since the epoch.
pub fn ago(a: std.mem.Allocator, secs: ?f64, now: f64) []const u8 {
    const t = secs orelse return "Never";
    const s = @max(0, @round(now - t));
    if (s < 60) return "Just now";
    const m = @round(s / 60);
    if (m < 60) return std.fmt.allocPrint(a, "{d} min ago", .{m}) catch "";
    const h = @round(m / 60);
    if (h < 24) return std.fmt.allocPrint(a, "{d} h ago", .{h}) catch "";
    const d = @round(h / 24);
    if (d == 1) return "Yesterday";
    return std.fmt.allocPrint(a, "{d} days ago", .{d}) catch "";
}

const months = [_][]const u8{ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

/// The local offset from UTC, in seconds, read once.
var offset: ?i64 = null;
pub fn setOffset(seconds: i64) void {
    offset = seconds;
}

fn civil(secs: f64) struct { y: i64, m: u8, d: u8, hh: u8, mm: u8 } {
    const t: i64 = @as(i64, @intFromFloat(secs)) + (offset orelse 0);
    const days = @divFloor(t, 86400);
    const rem: i64 = t - days * 86400;
    // Howard Hinnant's days-to-civil.
    const z = days + 719468;
    const era = @divFloor(z, 146097);
    const doe = z - era * 146097;
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153);
    const d = doy - @divFloor(153 * mp + 2, 5) + 1;
    const m = if (mp < 10) mp + 3 else mp - 9;
    const y = yoe + era * 400 + @as(i64, if (m <= 2) 1 else 0);
    return .{ .y = y, .m = @intCast(m), .d = @intCast(d), .hh = @intCast(@divFloor(rem, 3600)), .mm = @intCast(@divFloor(@mod(rem, 3600), 60)) };
}

/// "21 Oct 2026".
pub fn date(a: std.mem.Allocator, secs: f64) []const u8 {
    const c = civil(secs);
    return std.fmt.allocPrint(a, "{d} {s} {d}", .{ c.d, months[c.m - 1], c.y }) catch "";
}

/// "21 Oct".
pub fn day(a: std.mem.Allocator, secs: f64) []const u8 {
    const c = civil(secs);
    return std.fmt.allocPrint(a, "{d} {s}", .{ c.d, months[c.m - 1] }) catch "";
}

/// "09:41".
pub fn clock(a: std.mem.Allocator, secs: f64) []const u8 {
    const c = civil(secs);
    return std.fmt.allocPrint(a, "{d:0>2}:{d:0>2}", .{ c.hh, c.mm }) catch "";
}

/// The local midnight before `secs`.
pub fn dayStart(secs: f64) f64 {
    const t: i64 = @as(i64, @intFromFloat(secs)) + (offset orelse 0);
    return @floatFromInt(@divFloor(t, 86400) * 86400 - (offset orelse 0));
}

/// "2 h 5 min" or "5 min".
pub fn duration(a: std.mem.Allocator, secs: f64) []const u8 {
    const s: i64 = @intFromFloat(@max(0, secs));
    const h = @divFloor(s, 3600);
    const m = @divFloor(@mod(s, 3600), 60);
    if (h > 0) return std.fmt.allocPrint(a, "{d} h {d} min", .{ h, m }) catch "";
    return std.fmt.allocPrint(a, "{d} min", .{m}) catch "";
}

/// 0x1234…abcd.
pub fn short(a: std.mem.Allocator, addr: []const u8) []const u8 {
    if (addr.len <= 12) return addr;
    return std.fmt.allocPrint(a, "{s}…{s}", .{ addr[0..6], addr[addr.len - 4 ..] }) catch addr;
}

/// "1 response", "3 responses".
pub fn plural(a: std.mem.Allocator, n: f64, word: []const u8) []const u8 {
    return std.fmt.allocPrint(a, "{d} {s}{s}", .{ n, word, if (n == 1) "" else "s" }) catch "";
}

/// The first letter capitalised (ASCII), as the React screens do for words from the core.
pub fn capital(a: std.mem.Allocator, s: []const u8) []const u8 {
    if (s.len == 0 or !std.ascii.isLower(s[0])) return s;
    const out = a.dupe(u8, s) catch return s;
    out[0] = std.ascii.toUpper(out[0]);
    return out;
}

pub fn lower(a: std.mem.Allocator, s: []const u8) []const u8 {
    if (s.len == 0 or !std.ascii.isUpper(s[0])) return s;
    const out = a.dupe(u8, s) catch return s;
    out[0] = std.ascii.toLower(out[0]);
    return out;
}

test "figures" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("12,345.68", fixed(a, 12345.678, 2));
    try std.testing.expectEqualStrings("-1,000", fixed(a, -1000, 0));
    try std.testing.expectEqualStrings("999", count(a, 999));
    try std.testing.expectEqualStrings("+0.50", signed(a, 0.5));
    try std.testing.expectEqualStrings("$25.00", usd(a, 25));
    try std.testing.expectEqualStrings("3 min ago", ago(a, 1000, 1000 + 180));
    try std.testing.expectEqualStrings("0xabcd…7890", short(a, "0xabcdef1234567890"));
    offset = 0;
    try std.testing.expectEqualStrings("21 Oct 2026", date(a, 1792540800));
    try std.testing.expectEqualStrings("2 h 5 min", duration(a, 7500));
}
