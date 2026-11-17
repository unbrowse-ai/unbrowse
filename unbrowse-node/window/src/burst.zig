//! Calls fanning out: the calls agents make at once, as the call events
//! tell them, kept as one burst for the Live screen's lanes. A burst starts
//! with the first call after a quiet spell and ends when it's replaced;
//! each call is paired with its answer by the node's id for it.
const std = @import("std");
const types = @import("types.zig");
const Text = @import("live.zig").Text;

/// Calls a burst keeps; past it they are only counted.
pub const max = 48;
/// Routes a burst groups its calls by; past it they share the last group.
pub const max_groups = 8;
/// A quiet spell this long (no call in flight) ends a burst.
pub const quiet_ms = 2500;
/// A call with no answer after this long is shown as lost, not running.
pub const lost_ms = 120_000;

pub const Lane = struct {
    id: f64,
    group: u8,
    start: f64,
    /// When it answered (0 while running).
    end: f64 = 0,
    ok: bool = false,
    ms: f64 = 0,
    seq: u64,
};

pub const Group = struct { route: Text = .{}, what: Text = .{}, site: Text = .{}, calls: u32 = 0 };

pub const Burst = struct {
    lanes: [max]Lane = undefined,
    len: usize = 0,
    groups: [max_groups]Group = undefined,
    groups_len: usize = 0,
    /// Calls past `max`, counted but not drawn.
    more: u32 = 0,
    more_done: u32 = 0,
    more_ms: f64 = 0,
    /// When the last of them left: past `lost_ms` the ones unanswered stop counting, as a lane's do.
    more_at: f64 = 0,
    /// When the burst's first call left, and its last answer came (ms).
    t0: f64 = 0,
    last_end: f64 = 0,
    /// Bumps per burst, keying its lanes.
    gen: u64 = 0,
    seq: u64 = 0,

    pub fn apply(b: *Burst, scratch: std.mem.Allocator, data: []const u8) void {
        const ev = std.json.parseFromSliceLeaky(types.CallEvent, scratch, data, types.parse_options) catch return;
        const at = if (ev.at_ms > 0) ev.at_ms else ev.at * 1000;
        const end = std.mem.eql(u8, ev.phase, "end");
        if (end) {
            for (b.lanes[0..b.len]) |*l| if (l.end == 0 and l.id == ev.id and ev.id != 0) {
                l.end = @max(at, l.start);
                l.ok = ev.ok orelse false;
                l.ms = ev.ms orelse (l.end - l.start);
                b.last_end = @max(b.last_end, l.end);
                return;
            };
        }
        // A new call (or an answer to one this window never saw leave).
        const start = if (end) at - (ev.ms orelse 0) else at;
        if (b.len + b.more == 0 or (b.inFlight(at) == 0 and at - b.last_end > quiet_ms)) b.reset(start);
        if (b.len == max) {
            // An end here answers a start counted here, unless every one of those is answered: then it's a call this
            // window never saw leave, a start and an end in one.
            if (!end or b.more == b.more_done) b.more += 1;
            b.more_at = at;
            if (end) {
                b.more_done += 1;
                b.more_ms += ev.ms orelse 0;
                b.last_end = @max(b.last_end, at);
            }
            return;
        }
        b.seq += 1;
        var l: Lane = .{ .id = ev.id, .group = b.group(ev), .start = start, .seq = b.seq };
        if (end) {
            l.end = at;
            l.ok = ev.ok orelse false;
            l.ms = ev.ms orelse 0;
            b.last_end = @max(b.last_end, at);
        }
        b.groups[l.group].calls += 1;
        b.t0 = @min(b.t0, start);
        b.lanes[b.len] = l;
        b.len += 1;
    }

    fn reset(b: *Burst, t0: f64) void {
        b.* = .{ .gen = b.gen + 1, .t0 = t0, .last_end = t0 };
    }

    fn group(b: *Burst, ev: types.CallEvent) u8 {
        for (b.groups[0..b.groups_len], 0..) |g, i| if (std.mem.eql(u8, g.route.get(), ev.route)) return @intCast(i);
        if (b.groups_len == max_groups) return max_groups - 1;
        var g: Group = .{};
        g.route.set(ev.route);
        g.what.set(ev.what);
        g.site.set(ev.site);
        b.groups[b.groups_len] = g;
        b.groups_len += 1;
        return @intCast(b.groups_len - 1);
    }

    pub fn running(l: Lane, now: f64) bool {
        return l.end == 0 and now - l.start < lost_ms;
    }

    pub fn inFlight(b: *const Burst, now: f64) usize {
        var n: usize = 0;
        for (b.lanes[0..b.len]) |l| if (running(l, now)) {
            n += 1;
        };
        return n + if (now - b.more_at < lost_ms) b.more - b.more_done else 0;
    }

    pub fn done(b: *const Burst) usize {
        var n: usize = 0;
        for (b.lanes[0..b.len]) |l| if (l.end != 0) {
            n += 1;
        };
        return n + b.more_done;
    }

    pub fn failed(b: *const Burst) usize {
        var n: usize = 0;
        for (b.lanes[0..b.len]) |l| if (l.end != 0 and !l.ok) {
            n += 1;
        };
        return n;
    }

    /// The calls' own time added up (ms): what one call after another would take.
    pub fn sum(b: *const Burst) f64 {
        var s: f64 = b.more_ms;
        for (b.lanes[0..b.len]) |l| if (l.end != 0) {
            s += l.ms;
        };
        return s;
    }

    /// From the first call leaving to the last answer, or to now while calls run (ms).
    pub fn wall(b: *const Burst, now: f64) f64 {
        const until = if (b.inFlight(now) > 0) @max(now, b.last_end) else b.last_end;
        return @max(0, until - b.t0);
    }

    pub fn empty(b: *const Burst) bool {
        return b.len + b.more == 0;
    }
};

test "a burst past the lanes drawn ends when its calls are answered" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var b: Burst = .{};
    var buf: [256]u8 = undefined;
    for (0..max + 3) |i| b.apply(a, try std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"start\",\"route\":\"r\",\"at_ms\":1000}}", .{i + 1}));
    try std.testing.expectEqual(@as(usize, max + 3), b.inFlight(1100));
    for (0..max + 3) |i| b.apply(a, try std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"end\",\"route\":\"r\",\"ok\":true,\"ms\":500,\"at_ms\":1500}}", .{i + 1}));
    try std.testing.expectEqual(@as(usize, 0), b.inFlight(2000));
    // So the next call after a quiet spell starts a new burst.
    const gen = b.gen;
    b.apply(a, "{\"id\":99,\"phase\":\"start\",\"route\":\"r\",\"at_ms\":9000}");
    try std.testing.expectEqual(gen + 1, b.gen);
}

test "calls past the lanes that are never answered stop counting as in flight" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var b: Burst = .{};
    var buf: [256]u8 = undefined;
    for (0..max + 3) |i| b.apply(a, try std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"start\",\"route\":\"r\",\"at_ms\":1000}}", .{i + 1}));
    try std.testing.expectEqual(@as(usize, 0), b.inFlight(1000 + lost_ms));
}

test "a burst of calls at once: in flight, done, wall time against the sum" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var b: Burst = .{};
    var buf: [256]u8 = undefined;
    for (0..4) |i| b.apply(a, try std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"start\",\"route\":\"r{d}\",\"what\":\"w\",\"site\":\"s\",\"agent\":\"A\",\"at_ms\":{d}}}", .{ i + 1, i % 2, 1000 + i * 10 }));
    try std.testing.expectEqual(@as(usize, 4), b.inFlight(1100));
    try std.testing.expectEqual(@as(usize, 2), b.groups_len);
    for (0..4) |i| b.apply(a, try std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"end\",\"route\":\"r{d}\",\"ok\":{s},\"ms\":500,\"at_ms\":{d}}}", .{ i + 1, i % 2, if (i == 3) "false" else "true", 1500 + i * 10 }));
    try std.testing.expectEqual(@as(usize, 0), b.inFlight(2000));
    try std.testing.expectEqual(@as(usize, 4), b.done());
    try std.testing.expectEqual(@as(usize, 1), b.failed());
    try std.testing.expectEqual(@as(f64, 2000), b.sum());
    try std.testing.expectEqual(@as(f64, 530), b.wall(5000));
    // After a quiet spell, the next call starts a new burst.
    const gen = b.gen;
    b.apply(a, "{\"id\":9,\"phase\":\"start\",\"route\":\"r0\",\"at_ms\":9000}");
    try std.testing.expectEqual(gen + 1, b.gen);
    try std.testing.expectEqual(@as(usize, 1), b.len);
    // A call never answered stops counting as in flight.
    try std.testing.expectEqual(@as(usize, 0), b.inFlight(9000 + lost_ms));
}
