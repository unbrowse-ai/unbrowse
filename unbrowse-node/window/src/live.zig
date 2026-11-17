//! What arrives live from the node: the agent's eye (a learn walk's
//! responses as they land, the calls it weighed, the one it kept) and the
//! calls agents make. Each event is copied in on the main thread.
const std = @import("std");
const types = @import("types.zig");

pub const shown = 8;

pub const Sort = enum { page, data, asset, gate, noise };

pub const Seen = struct { n: f64, method: []const u8, host: []const u8, path: []const u8, status: f64, bytes: f64, sort: Sort };

/// Every response of a walk, for the Live screen's lanes: at most `max_marks`.
pub const max_marks = 400;
/// Hosts get a lane each; past `max_hosts` they share the last.
pub const max_hosts = 16;
pub const Mark = struct { n: f64, host: u8, sort: Sort, bytes: f64, status: f64, path: []const u8 };

/// The site a host belongs to, as the node's `site_suffix` reads it: the last two labels, or three under a
/// two-letter country code with a short second label (`carousell.com.sg`, `bbc.co.uk`).
pub fn siteOf(host: []const u8) []const u8 {
    var dots: [3]usize = .{ 0, 0, 0 };
    var n: usize = 0;
    var i = host.len;
    while (i > 0) : (i -= 1) if (host[i - 1] == '.') {
        if (n < 3) dots[n] = i;
        n += 1;
    };
    if (n < 2) return host;
    const tld = host[dots[0]..];
    const second = host[dots[1] .. dots[0] - 1];
    if (tld.len == 2 and second.len <= 3) return if (n >= 3) host[dots[2]..] else host;
    return host[dots[1]..];
}

/// The host of a URL.
pub fn hostOf(url: []const u8) []const u8 {
    const after = if (std.mem.indexOf(u8, url, "://")) |i| url[i + 3 ..] else url;
    const end = std.mem.indexOfAny(u8, after, "/?#:") orelse after.len;
    return after[0..end];
}

pub const Walk = struct {
    arena: std.heap.ArenaAllocator,
    id: []const u8,
    url: []const u8,
    goal: []const u8,
    agent: []const u8,
    /// Newest first, at most `shown`.
    seen: [shown]Seen = undefined,
    seen_len: usize = 0,
    total: f64 = 0,
    sorts: [5]f64 = .{ 0, 0, 0, 0, 0 },
    scored: ?struct { exchanges: f64, candidates: []const types.Scored } = null,
    picked: ?struct { method: []const u8, host: []const u8, path: []const u8, by: []const u8, reasons: []const []const u8 } = null,
    saved: ?struct { steps: f64, inputs: []const []const u8 } = null,
    failed: ?[]const u8 = null,
    /// The line to the node dropped with the walk under way: how it went wasn't seen. Any event of it clears this.
    lost: bool = false,
    /// Bumped on each change, keying the rows that slide in.
    rev: u64 = 0,
    marks: [max_marks]Mark = undefined,
    marks_len: usize = 0,
    hosts: [max_hosts][]const u8 = undefined,
    host_count: [max_hosts]u32 = @splat(0),
    hosts_len: usize = 0,
    /// The route the walk saved, by id (its path is read from the routes list).
    saved_route: []const u8 = "",

    pub fn count(w: *const Walk, s: Sort) f64 {
        return w.sorts[@intFromEnum(s)];
    }

    /// Whether `host` is the walked site's own.
    pub fn own(w: *const Walk, host: []const u8) bool {
        return std.mem.eql(u8, siteOf(host), siteOf(hostOf(w.url)));
    }

    pub fn done(w: *const Walk) bool {
        return w.saved != null or w.failed != null or w.lost;
    }

    fn lane(w: *Walk, host: []const u8) u8 {
        for (w.hosts[0..w.hosts_len], 0..) |h, i| if (std.mem.eql(u8, h, host)) return @intCast(i);
        if (w.hosts_len == max_hosts) return max_hosts - 1;
        w.hosts[w.hosts_len] = w.arena.allocator().dupe(u8, host) catch "";
        w.hosts_len += 1;
        return @intCast(w.hosts_len - 1);
    }

    fn mark(w: *Walk, row: Seen) void {
        const h = w.lane(row.host);
        w.host_count[h] += 1;
        if (w.marks_len == max_marks) return;
        w.marks[w.marks_len] = .{ .n = row.n, .host = h, .sort = row.sort, .bytes = row.bytes, .status = row.status, .path = row.path };
        w.marks_len += 1;
    }
};

pub const Eye = struct {
    gpa: std.mem.Allocator,
    walk: ?*Walk = null,

    pub fn deinit(e: *Eye) void {
        if (e.walk) |w| {
            w.arena.deinit();
            e.gpa.destroy(w);
        }
        e.walk = null;
    }

    /// The line to the node dropped: what a walk under way does next, this window won't hear.
    pub fn lineDropped(e: *Eye) void {
        const w = e.walk orelse return;
        if (!w.done()) w.lost = true;
    }

    /// Takes one eye event (its JSON).
    pub fn apply(e: *Eye, scratch: std.mem.Allocator, data: []const u8) void {
        const ev = std.json.parseFromSliceLeaky(types.Eye, scratch, data, types.parse_options) catch return;
        if (std.mem.eql(u8, ev.kind, "started")) {
            e.deinit();
            const w = e.gpa.create(Walk) catch return;
            w.* = .{ .arena = .init(e.gpa), .id = "", .url = "", .goal = "", .agent = "" };
            const a = w.arena.allocator();
            w.id = a.dupe(u8, ev.walk) catch "";
            w.url = a.dupe(u8, ev.url) catch "";
            w.goal = a.dupe(u8, ev.goal) catch "";
            w.agent = a.dupe(u8, ev.agent) catch "";
            e.walk = w;
            return;
        }
        const w = e.walk orelse return;
        if (!std.mem.eql(u8, w.id, ev.walk)) return;
        const a = w.arena.allocator();
        w.rev += 1;
        w.lost = false;
        if (std.mem.eql(u8, ev.kind, "seen")) {
            const sort = std.meta.stringToEnum(Sort, ev.sort) orelse .noise;
            const row: Seen = .{
                .n = ev.n,
                .method = a.dupe(u8, ev.method) catch "",
                .host = a.dupe(u8, ev.host) catch "",
                .path = a.dupe(u8, ev.path) catch "",
                .status = ev.status,
                .bytes = ev.bytes,
                .sort = sort,
            };
            const keep: usize = @min(w.seen_len, shown - 1);
            std.mem.copyBackwards(Seen, w.seen[1 .. keep + 1], w.seen[0..keep]);
            w.seen[0] = row;
            w.seen_len = keep + 1;
            w.total += 1;
            w.sorts[@intFromEnum(sort)] += 1;
            w.mark(row);
        } else if (std.mem.eql(u8, ev.kind, "scored")) {
            const cs = a.alloc(types.Scored, ev.candidates.len) catch return;
            for (ev.candidates, cs) |src, *dst| {
                dst.* = src;
                dst.host = a.dupe(u8, src.host) catch "";
                dst.path = a.dupe(u8, src.path) catch "";
                dst.method = a.dupe(u8, src.method) catch "";
            }
            w.scored = .{ .exchanges = ev.exchanges, .candidates = cs };
        } else if (std.mem.eql(u8, ev.kind, "picked")) {
            const rs = a.alloc([]const u8, ev.reasons.len) catch return;
            for (ev.reasons, rs) |src, *dst| dst.* = a.dupe(u8, src) catch "";
            w.picked = .{ .method = a.dupe(u8, ev.method) catch "", .host = a.dupe(u8, ev.host) catch "", .path = a.dupe(u8, ev.path) catch "", .by = a.dupe(u8, ev.by) catch "", .reasons = rs };
        } else if (std.mem.eql(u8, ev.kind, "saved")) {
            const ins = a.alloc([]const u8, ev.inputs.len) catch return;
            for (ev.inputs, ins) |src, *dst| dst.* = a.dupe(u8, src) catch "";
            w.saved = .{ .steps = ev.steps, .inputs = ins };
            w.saved_route = a.dupe(u8, ev.route) catch "";
        } else if (std.mem.eql(u8, ev.kind, "failed")) {
            w.failed = a.dupe(u8, ev.@"error") catch "";
        }
    }
};

/// A call agents made, as the call events tell it: started, then answered.
pub const Call = struct {
    /// The node's id for the call (0 from an older node).
    id: f64 = 0,
    route: Text = .{},
    what: Text = .{},
    site: Text = .{},
    agent: Text = .{},
    done: bool = false,
    ok: bool = false,
    ms: f64 = 0,
    paid: ?f64 = null,
    at: f64 = 0,
    /// Unique per call, for its row's key.
    seq: u64 = 0,
};

/// A short string kept in place (no allocation per event).
pub const Text = struct {
    buf: [256]u8 = undefined,
    len: usize = 0,
    pub fn set(t: *Text, s: []const u8) void {
        t.len = @min(s.len, t.buf.len);
        @memcpy(t.buf[0..t.len], s[0..t.len]);
    }
    pub fn get(t: *const Text) []const u8 {
        return t.buf[0..t.len];
    }
};

pub const Calls = struct {
    pub const max = 6;
    /// Newest first.
    items: [max]Call = undefined,
    len: usize = 0,
    seq: u64 = 0,

    pub fn apply(cs: *Calls, scratch: std.mem.Allocator, data: []const u8) void {
        const ev = std.json.parseFromSliceLeaky(types.CallEvent, scratch, data, types.parse_options) catch return;
        if (std.mem.eql(u8, ev.phase, "end")) {
            // The newest started call to this route takes the answer.
            for (cs.items[0..cs.len]) |*c| {
                const same = if (ev.id != 0) c.id == ev.id else std.mem.eql(u8, c.route.get(), ev.route) and std.mem.eql(u8, c.agent.get(), ev.agent);
                if (!c.done and same) {
                    c.done = true;
                    c.ok = ev.ok orelse false;
                    c.ms = ev.ms orelse 0;
                    c.paid = ev.paid_usdc;
                    return;
                }
            }
        }
        const keep: usize = @min(cs.len, max - 1);
        std.mem.copyBackwards(Call, cs.items[1 .. keep + 1], cs.items[0..keep]);
        cs.seq += 1;
        var c: Call = .{ .id = ev.id, .at = ev.at, .seq = cs.seq };
        c.route.set(ev.route);
        c.what.set(ev.what);
        c.site.set(ev.site);
        c.agent.set(ev.agent);
        if (std.mem.eql(u8, ev.phase, "end")) {
            c.done = true;
            c.ok = ev.ok orelse false;
            c.ms = ev.ms orelse 0;
            c.paid = ev.paid_usdc;
        }
        cs.items[0] = c;
        cs.len = keep + 1;
    }
};

test "a walk and its calls" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var e: Eye = .{ .gpa = std.testing.allocator };
    defer e.deinit();
    e.apply(a, "{\"kind\":\"started\",\"walk\":\"w1\",\"url\":\"https://hn.algolia.com/?q=rust\",\"goal\":\"Search stories\",\"agent\":\"Claude\"}");
    for (0..10) |i| e.apply(a, if (i % 2 == 0) "{\"kind\":\"seen\",\"walk\":\"w1\",\"n\":1,\"method\":\"GET\",\"host\":\"h\",\"path\":\"/a\",\"status\":200,\"bytes\":2048,\"sort\":\"data\"}" else "{\"kind\":\"seen\",\"walk\":\"w1\",\"n\":2,\"method\":\"GET\",\"host\":\"h\",\"path\":\"/b\",\"status\":200,\"bytes\":0,\"sort\":\"asset\"}");
    try std.testing.expectEqual(@as(usize, shown), e.walk.?.seen_len);
    try std.testing.expectEqual(@as(f64, 5), e.walk.?.count(.data));
    e.apply(a, "{\"kind\":\"picked\",\"walk\":\"w1\",\"index\":0,\"method\":\"GET\",\"host\":\"h\",\"path\":\"/a\",\"by\":\"score\",\"reasons\":[\"has the query\"]}");
    try std.testing.expectEqualStrings("score", e.walk.?.picked.?.by);

    var cs: Calls = .{};
    cs.apply(a, "{\"phase\":\"start\",\"route\":\"r\",\"site\":\"s\",\"what\":\"w\",\"agent\":\"A\",\"at\":1}");
    cs.apply(a, "{\"phase\":\"end\",\"route\":\"r\",\"site\":\"s\",\"what\":\"w\",\"agent\":\"A\",\"ok\":true,\"ms\":40,\"at\":2}");
    try std.testing.expectEqual(@as(usize, 1), cs.len);
    try std.testing.expect(cs.items[0].ok);
}

test "lanes by host, the site's own told apart" {
    try std.testing.expectEqualStrings("algolia.com", siteOf("hn.algolia.com"));
    try std.testing.expectEqualStrings("carousell.com.sg", siteOf("www.carousell.com.sg"));
    try std.testing.expectEqualStrings("bbc.co.uk", siteOf("bbc.co.uk"));
    try std.testing.expectEqualStrings("localhost", siteOf("localhost"));
    try std.testing.expectEqualStrings("hn.algolia.com", hostOf("https://hn.algolia.com/?q=rust"));
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var e: Eye = .{ .gpa = std.testing.allocator };
    defer e.deinit();
    e.apply(arena.allocator(), "{\"kind\":\"started\",\"walk\":\"w\",\"url\":\"https://hn.algolia.com/?q=rust\",\"goal\":\"g\",\"agent\":\"A\"}");
    for (0..40) |i| {
        var buf: [200]u8 = undefined;
        const ev = try std.fmt.bufPrint(&buf, "{{\"kind\":\"seen\",\"walk\":\"w\",\"n\":{d},\"method\":\"GET\",\"host\":\"h{d}.example\",\"path\":\"/\",\"status\":200,\"bytes\":10,\"sort\":\"asset\"}}", .{ i + 1, i % 20 });
        e.apply(arena.allocator(), ev);
    }
    const w = e.walk.?;
    try std.testing.expectEqual(@as(usize, max_hosts), w.hosts_len);
    try std.testing.expectEqual(@as(usize, 40), w.marks_len);
    try std.testing.expect(w.own("uj5.algolia.com") and !w.own("algolia.net"));
}

test "calls running at once pair by id" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var cs: Calls = .{};
    cs.apply(a, "{\"id\":1,\"phase\":\"start\",\"route\":\"r\",\"agent\":\"A\"}");
    cs.apply(a, "{\"id\":2,\"phase\":\"start\",\"route\":\"r\",\"agent\":\"A\"}");
    cs.apply(a, "{\"id\":1,\"phase\":\"end\",\"route\":\"r\",\"agent\":\"A\",\"ok\":true,\"ms\":300}");
    try std.testing.expect(cs.items[1].done and !cs.items[0].done);
}
