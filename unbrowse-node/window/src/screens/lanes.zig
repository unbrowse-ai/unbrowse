//! The walk as a picture: each response a mark in its host's lane, in the
//! order it landed, as tall as it was large, colored by what it is. The
//! site's own hosts come first; trackers and pings fade as they land; once
//! the node has weighed the calls, the ones it weighed stay lit and the
//! rest step back, and the one it kept is marked.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const motion = ui.motion;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const live = @import("../live.zig");

/// Lanes drawn; hosts past them share the last ("other hosts").
const shown = 7;
const lane_h: f32 = 22;
const label_w: f32 = 148;
const mark_w: f32 = 4;
/// The widest step between two responses: fewer, sparser marks; more, packed closer.
const max_step: f32 = 9;

pub fn color(c: *ui.Context, s: live.Sort) ui.Color {
    const x = look.x(c);
    return switch (s) {
        .data => x.run,
        .page => c.theme.text,
        .asset => x.text3.alpha(0.42),
        .gate => ui.Color.hex(0xd99a1e),
        .noise => x.text3,
    };
}

/// A response's height for its size: a ping is a sliver, a large answer fills the lane.
fn height(bytes: f64) f32 {
    const kb: f32 = @floatCast(@log10(bytes / 1024 + 1));
    return std.math.clamp(5 + kb * 7, 5, lane_h - 4);
}

/// Which drawn lane each host goes in: the site's own first, then the others as they came.
fn order(w: *const live.Walk, out: *[live.max_hosts]u8) usize {
    var n: usize = 0;
    var next: u8 = 0;
    for (0..2) |pass| for (w.hosts[0..w.hosts_len], 0..) |h, i| {
        if ((pass == 0) != w.own(h)) continue;
        out[i] = @min(next, shown - 1);
        if (next < shown) next += 1;
        n = @max(n, @as(usize, out[i]) + 1);
    };
    return n;
}

pub fn view(c: *ui.Context, w: *live.Walk, width: f32) void {
    const x = look.x(c);
    const fa = c.alloc();
    var lane_of: [live.max_hosts]u8 = undefined;
    const n_lanes = order(w, &lane_of);
    const track = width - label_w - 10;
    const total: f32 = @floatFromInt(@max(w.marks_len, 1));
    const step = @min(max_step, (track - mark_w) / total);
    const weighed = w.scored != null;
    const box = ui.div(c).column().wFull().gap(2);
    defer box.end();
    for (0..n_lanes) |lane| {
        ui.key(c, c.print("lane-{d}", .{lane}));
        const r = ui.div(c).row().wFull().h(lane_h).gap(10).itemsCenter();
        defer r.end();
        {
            // The lane's name: its host, or how many hosts share the last.
            var host: []const u8 = "";
            var own = false;
            var shared: usize = 0;
            for (w.hosts[0..w.hosts_len], 0..) |h, i| if (lane_of[i] == lane) {
                if (shared == 0) host = h;
                own = own or w.own(h);
                shared += 1;
            };
            const name = ui.div(c).w(label_w).clip();
            defer name.end();
            const bare = if (std.mem.startsWith(u8, host, "www.")) host[4..] else host;
            const label = if (shared > 1) c.print("{d} other hosts", .{shared}) else bare;
            ui.text(c, label, .{ .size = 11.5, .mono = shared <= 1, .weight = if (own) .medium else .regular, .color = if (own) c.theme.text else x.text3 });
        }
        const t = ui.div(c).w(track).h(lane_h).rounded(4).bg(x.well.alpha(0.55));
        defer t.end();
        for (w.marks[0..w.marks_len], 0..) |m, i| {
            if (lane_of[m.host] != lane) continue;
            mark(c, w, m, i, step, weighed);
        }
    }
    legend(c, w, fa);
}

fn mark(c: *ui.Context, w: *live.Walk, m: live.Mark, i: usize, step: f32, weighed: bool) void {
    const x = look.x(c);
    const h = height(m.bytes);
    const kept = if (w.picked) |pk| std.mem.eql(u8, pk.host, w.hosts[m.host]) and std.mem.eql(u8, pk.path, m.path) else false;
    const lit = kept or (weighed and candidate(w, m));
    // Pings and trackers land, then fade; once the calls are weighed, what wasn't weighed steps back.
    const rest: f32 = if (m.sort == .noise) 0.18 else if (weighed and !lit) 0.3 else 1;
    ui.key(c, c.print("m-{d}", .{i}));
    const place = motion.frame(c, .{
        .initial = .{ .y = -8, .opacity = 0 },
        .target = .{ .x = @as(f32, @floatFromInt(i)) * step },
        .transition = .{ .spring = motion.Spring.snappy },
    });
    const top = lane_h - h - 2;
    const p = ui.div(c).absolute().offset(0, top).motion(place);
    defer p.end();
    const fade = motion.frame(c, .{
        .initial = .{ .opacity = 1 },
        .target = .{ .opacity = rest },
        .transition = .{ .tween = .{ .duration = if (m.sort == .noise) 1.4 else 0.4, .ease = .ease_out } },
    });
    if (kept) {
        // The kept call: wider, outlined, with a dot over it.
        const k = ui.div(c).column().itemsCenter().gap(2).offset(-3, -6);
        defer k.end();
        const dot = ui.div(c).w(4).h(4).roundedFull().bg(x.run);
        dot.end();
        const b = ui.div(c).w(mark_w + 6).h(h + 2).rounded(2).bg(x.run).border(c.theme.surface).motion(fade);
        b.end();
        return;
    }
    const b = ui.div(c).w(mark_w).h(h).rounded(1.5).bg(color(c, if (m.status >= 400 and m.sort != .noise) .gate else m.sort)).motion(fade);
    b.end();
}

/// Whether a response is one of the calls the node weighed (not a ping).
fn candidate(w: *const live.Walk, m: live.Mark) bool {
    const sc = w.scored orelse return false;
    for (sc.candidates[0..@min(sc.candidates.len, 6)]) |cand| {
        if (!cand.noise and std.mem.eql(u8, cand.host, w.hosts[m.host]) and std.mem.eql(u8, cand.path, m.path)) return true;
    }
    return false;
}

fn legend(c: *ui.Context, w: *live.Walk, fa: std.mem.Allocator) void {
    const x = look.x(c);
    const r = ui.div(c).row().wFull().gap(14).pt(4).pl(label_w + 10).itemsCenter();
    defer r.end();
    const items = [_]struct { s: live.Sort, word: []const u8 }{
        .{ .s = .data, .word = "with data" },
        .{ .s = .page, .word = "page" },
        .{ .s = .asset, .word = "asset" },
        .{ .s = .noise, .word = "ping" },
        .{ .s = .gate, .word = "gate check" },
    };
    for (items) |it| {
        const n = w.count(it.s);
        if (n == 0 and it.s != .data) continue;
        ui.key(c, it.word);
        const k = ui.div(c).row().gap(5).itemsCenter();
        defer k.end();
        const sw = ui.div(c).w(7).h(7).rounded(2).bg(color(c, it.s)).opacity(if (it.s == .noise) 0.5 else 1);
        sw.end();
        ui.text(c, if (it.s == .data) c.print("{d} {s}", .{ n, it.word }) else fmt.plural(fa, n, it.word), .{ .size = 11.5, .color = x.text2 });
    }
}

test "lanes put the site's own hosts first" {
    var w: live.Walk = .{ .arena = .init(std.testing.allocator), .id = "w", .url = "https://hn.algolia.com/", .goal = "", .agent = "" };
    defer w.arena.deinit();
    w.hosts[0] = "px.ads.net";
    w.hosts[1] = "hn.algolia.com";
    w.hosts_len = 2;
    var out: [live.max_hosts]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 2), order(&w, &out));
    try std.testing.expectEqual(@as(u8, 1), out[0]);
    try std.testing.expectEqual(@as(u8, 0), out[1]);
    try std.testing.expect(height(0) < height(48000));
}
