//! Live: the node's work as it happens, as pictures rather than lines.
//! The browser's own view while it walks a page; the walk's requests
//! landing lane by host, the calls it weighed and the route it kept; and
//! the calls agents make fanning out, each a lane growing until the site
//! answers. Only what changes moves.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const live = @import("../live.zig");
const App = @import("../app.zig").App;
const lanes = @import("lanes.zig");
const kept = @import("kept.zig");
const fanout = @import("fanout.zig");

/// The sheet's content width: the window, less the sidebar and the sheet's padding.
pub fn contentW(c: *ui.Context) f32 {
    return @max(480, c.size.w - 216 - 60);
}

/// The browser's panel beside the walk's when there is room for both.
const side_w: f32 = 380;
const gap: f32 = 16;

pub fn view(a: *App, c: *ui.Context) void {
    {
        const h = look.header(c, "Live", "What this node is learning and calling, as it happens. Pictures come from its own browser while it walks a page; calls go straight to the site, with no browser.");
        h.end();
    }
    const w = contentW(c);
    const wide = w >= 820;
    if (wide) {
        const r = ui.div(c).row().wFull().gap(gap).itemsStart();
        defer r.end();
        browser(a, c, side_w);
        walk(a, c, w - side_w - gap);
    } else {
        browser(a, c, w);
        walk(a, c, w);
    }
    fanout.view(a, c, w);
}

fn browser(a: *App, c: *ui.Context, width: f32) void {
    const x = look.x(c);
    const fa = c.alloc();
    const wk = a.eye.walk;
    const pic = &a.picture;
    const healing = pic.bgra.len > 0 and std.mem.startsWith(u8, pic.walk.get(), "heal-");
    const walking = if (wk) |k| !k.done() else false;
    const box = (if (width >= contentW(c)) ui.div(c).column().wFull() else ui.div(c).column().w(width)).bg(c.theme.surface).border(x.frame).rounded(12).clip();
    defer box.end();
    {
        const head = ui.div(c).row().wFull().px(16).h(44).gap(10).itemsCenter();
        defer head.end();
        ui.text(c, "Browser", .{ .size = 14, .weight = .semibold });
        ui.spacer(c);
        if (walking) look.status(c, .running, "Walking") else if (healing and !pic.settled) look.status(c, .running, "Re-walking") else if (pic.bgra.len > 0) look.status(c, .idle, "Settled") else look.status(c, .idle, "Idle");
    }
    look.rule(c);
    const body = ui.div(c).column().wFull().p(16).gap(10);
    defer body.end();
    // The picture keeps near its own size (640 pixels): a stacked panel doesn't blow it up.
    const inner = @min(width - 32, 560);
    if (pic.texture()) |tex| {
        const ratio: f32 = @as(f32, @floatFromInt(tex.height)) / @as(f32, @floatFromInt(@max(tex.width, 1)));
        const frame = ui.div(c).w(inner).rounded(8).border(x.hair).clip();
        ui.texture(c, .{ .width = .{ .px = inner }, .height = .{ .px = @round(inner * ratio) }, .radius = 8 }, tex, .{ 0, 0, 1, 1 }, 1);
        frame.end();
    } else {
        const empty = ui.div(c).wFull().h(@round(inner * 0.52)).rounded(8).bg(x.well).center().p(20);
        defer empty.end();
        ui.text(c, if (walking) "Waiting for the page's first paint." else "The node's browser shows here while it walks a page.", .{ .size = 12.5, .color = x.text3, .wrap = true });
    }
    if (healing and (wk == null or !walking)) {
        ui.text(c, "Re-walking a route's page: the site changed, so the node traces the call again from its root.", .{ .size = 12, .color = x.text2, .wrap = true });
    } else if (wk) |k| {
        look.mono(c, k.url, x.text2);
        ui.text(c, if (k.done()) "The last picture stays until the next walk." else c.print("{s} so far; a few pictures a second, as the page paints.", .{fmt.plural(fa, k.total, "response")}), .{ .size = 12, .color = x.text3, .wrap = true });
    } else ui.text(c, "Pictures only: nothing of what the browser sends or keeps leaves it.", .{ .size = 12, .color = x.text3, .wrap = true });
}

fn walk(a: *App, c: *ui.Context, width: f32) void {
    const x = look.x(c);
    const fa = c.alloc();
    const w = a.eye.walk;
    const st: look.Status = if (w == null) .idle else if (w.?.failed != null) .fail else if (w.?.saved != null) .ok else .running;
    const word = if (w) |k| (if (k.lost) "Lost sight of this walk" else if (k.failed != null) "Failed" else if (k.saved != null) "Kept a route" else if (k.picked != null) "Keeping" else if (k.scored != null) "Weighing" else "Walking") else "Idle";
    const box = (if (width >= contentW(c)) ui.div(c).column().wFull() else ui.div(c).column().w(width)).bg(c.theme.surface).border(x.frame).rounded(12).clip();
    defer box.end();
    {
        const head = ui.div(c).row().wFull().px(16).h(44).gap(10).itemsCenter();
        defer head.end();
        ui.text(c, "The walk", .{ .size = 14, .weight = .semibold });
        if (w) |k| ui.text(c, c.print("{s} on {s}", .{ fmt.plural(fa, k.total, "response"), live.hostOf(k.url) }), .{ .size = 12.5, .color = x.text3 });
        ui.spacer(c);
        look.status(c, st, word);
    }
    look.rule(c);
    const body = ui.div(c).column().wFull().p(16).gap(14);
    defer body.end();
    const k = w orelse {
        look.body(c, "When an agent asks this node to learn a page, every request the page makes lands here as it happens, in a lane for its host: the site's own calls, its pages and assets, and the trackers that come along.");
        return;
    };
    {
        const head = ui.div(c).column().wFull().gap(3);
        defer head.end();
        ui.text(c, c.print("{s} wants to {s}", .{ k.agent, fmt.lower(fa, k.goal) }), .{ .size = 13.5, .weight = .medium, .wrap = true });
        if (k.failed) |f| ui.text(c, fmt.capital(fa, f), .{ .size = 12.5, .color = x.fail_text, .wrap = true });
    }
    lanes.view(c, k, width - 32);
    kept.view(a, c, k, width - 32);
}
