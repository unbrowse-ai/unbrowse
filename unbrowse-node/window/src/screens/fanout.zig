//! Calls fanning out: what agents call at once, each call a lane on one
//! clock, growing while the site hasn't answered and ending green or red
//! with its time, grouped by route. Above them, the burst in numbers: how
//! many are out, how many are back, and the wall time against what the
//! same calls would take one after another.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const motion = ui.motion;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const burst = @import("../burst.zig");
const App = @import("../app.zig").App;

/// Lanes drawn; past them the rest are counted.
const shown = 24;
const ms_w: f32 = 64;
const group_w: f32 = 176;

fn seconds(a: std.mem.Allocator, ms: f64) []const u8 {
    if (ms < 1000) return std.fmt.allocPrint(a, "{d:.0} ms", .{ms}) catch "";
    return std.fmt.allocPrint(a, "{d:.1} s", .{ms / 1000}) catch "";
}

pub fn view(a: *App, c: *ui.Context, width: f32) void {
    const x = look.x(c);
    const fa = c.alloc();
    const b = &a.burst;
    const now = a.now_ms;
    const out = b.inFlight(now);
    const box = ui.div(c).column().wFull().bg(c.theme.surface).border(x.frame).rounded(12).clip();
    defer box.end();
    {
        const head = ui.div(c).row().wFull().px(16).h(44).gap(10).itemsCenter();
        defer head.end();
        ui.text(c, "Calls", .{ .size = 14, .weight = .semibold });
        ui.text(c, "Straight to the site's own API, many at once", .{ .size = 12.5, .color = x.text3 });
        ui.spacer(c);
        if (out > 0) look.status(c, .running, c.print("{d} in flight", .{out})) else if (!b.empty()) look.status(c, if (b.failed() > 0) .warn else .ok, "Answered") else look.status(c, .idle, "Idle");
    }
    look.rule(c);
    const body = ui.div(c).column().wFull().p(16).gap(14);
    defer body.end();
    if (b.empty()) {
        look.body(c, "When agents call routes, each call runs here as a lane: many at once, each answered in about half a second, with no browser.");
        return;
    }
    numbers(c, b, now, fa);
    const track = width - 32 - group_w - ms_w - 20;
    const span = @max(1000, b.wall(now));
    var drawn: usize = 0;
    for (b.groups[0..b.groups_len], 0..) |*g, gi| {
        if (drawn >= shown) break;
        ui.key(c, c.print("g-{d}-{d}", .{ b.gen, gi }));
        const r = ui.div(c).row().wFull().gap(10).itemsStart();
        defer r.end();
        {
            const name = ui.div(c).column().w(group_w).gap(1).clip();
            defer name.end();
            ui.text(c, g.what.get(), .{ .size = 12.5, .weight = .medium });
            ui.text(c, c.print("{s}, {s}", .{ g.site.get(), fmt.plural(fa, @floatFromInt(g.calls), "call") }), .{ .size = 11.5, .color = x.text3 });
        }
        const col = ui.div(c).column().grow().minW(0).gap(4).pt(3);
        defer col.end();
        for (b.lanes[0..b.len]) |l| {
            if (l.group != gi or drawn >= shown) continue;
            drawn += 1;
            lane(c, b, l, now, span, track, fa);
        }
    }
    const more = b.len - @min(b.len, drawn) + b.more;
    if (more > 0) ui.text(c, c.print("And {s} more in this burst.", .{fmt.plural(fa, @floatFromInt(more), "call")}), .{ .size = 12, .color = x.text3 });
    // Lanes grow while calls are out: frames only then, fewer when motion is reduced.
    if (out > 0) {
        if (c.reduced_motion) c.frameIn(0.25) else c.frameIn(1.0 / 30.0);
    }
}

fn numbers(c: *ui.Context, b: *const burst.Burst, now: f64, fa: std.mem.Allocator) void {
    const x = look.x(c);
    const out = b.inFlight(now);
    const done = b.done();
    const wall = b.wall(now);
    const sum = b.sum();
    const r = ui.div(c).row().wFull().gap(24).itemsEnd();
    defer r.end();
    figure(c, "In flight", c.print("{d}", .{out}), out > 0);
    figure(c, "Answered", c.print("{d}", .{done}), false);
    figure(c, "Wall time", seconds(fa, wall), false);
    figure(c, "One after another", seconds(fa, sum), false);
    ui.spacer(c);
    if (done > 1 and wall > 0 and sum > wall * 1.2) {
        const words = ui.div(c).column().itemsEnd().gap(1);
        defer words.end();
        ui.text(c, c.print("{d:.1}× faster at once", .{sum / wall}), .{ .size = 13, .weight = .semibold, .color = x.run });
        ui.text(c, if (b.failed() > 0) c.print("{d} failed", .{b.failed()}) else "No browser in any of them", .{ .size = 11.5, .color = if (b.failed() > 0) x.fail_text else x.text3 });
    } else if (b.failed() > 0) ui.text(c, c.print("{d} failed", .{b.failed()}), .{ .size = 12, .color = x.fail_text });
}

fn figure(c: *ui.Context, label: []const u8, value: []const u8, live: bool) void {
    const x = look.x(c);
    const d = ui.div(c).column().gap(2);
    defer d.end();
    ui.text(c, label, .{ .size = 11.5, .weight = .medium, .color = x.text3 });
    ui.text(c, value, .{ .size = 20, .weight = .semibold, .mono = true, .color = if (live) x.run else c.theme.text });
}

fn lane(c: *ui.Context, b: *const burst.Burst, l: burst.Lane, now: f64, span: f64, track: f32, fa: std.mem.Allocator) void {
    const x = look.x(c);
    const running = burst.Burst.running(l, now);
    const lost = l.end == 0 and !running;
    const end = if (l.end != 0) l.end else @min(now, l.start + burst.lost_ms);
    const x0: f32 = @floatCast((l.start - b.t0) / span * track);
    const len: f32 = @floatCast(@max(0, end - l.start) / span * track);
    ui.key(c, c.print("l-{d}-{d}", .{ b.gen, l.seq }));
    const f = motion.frame(c, .{ .initial = .{ .opacity = 0 }, .transition = .{ .tween = .{ .duration = 0.2, .ease = .ease_out } } });
    const r = ui.div(c).row().wFull().h(12).gap(10).itemsCenter().motion(f);
    defer r.end();
    {
        const t = ui.div(c).w(track).h(12);
        defer t.end();
        const col = if (running) x.run else if (lost) x.text3 else if (l.ok) c.theme.success else c.theme.danger;
        const bar = ui.div(c).absolute().offset(@min(x0, track - 4), 2).w(@max(4, @min(len, track - x0))).h(8).rounded(4).bg(if (running) col.alpha(0.75) else col);
        bar.end();
    }
    const m = ui.div(c).w(ms_w).itemsEnd();
    defer m.end();
    const word = if (running) seconds(fa, now - l.start) else if (lost) "no answer" else seconds(fa, l.ms);
    ui.text(c, word, .{ .size = 11.5, .mono = true, .color = if (running) x.run else if (l.ok) x.text2 else x.fail_text });
}
