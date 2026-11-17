//! This node as the film's city: every site an agent has walked
//! is a building, every route a door on it with the chalk U beside it, lit
//! in Uni's blue once it is listed. Nothing moves on its own. When an agent
//! calls a route a light leaves that agent for that door, and the door
//! answers with the call's status and time.
//!
//! Drawn in units of its own (a 1000-wide street) and scaled to
//! the panel, from boxes: nanoui has no paths, so a line is a thin box and a
//! dotted arc is dots set along the same curve.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const art = @import("../art.zig");
const fmt = @import("../fmt.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;

const W: f32 = 1000;
const H: f32 = 380;
const GROUND: f32 = 322;
const STREET_FROM: f32 = 236;
const STREET_TO: f32 = 984;
const MAX_BUILDINGS = 7;
const MAX_DOORS = 4;
const FLIGHT_S: f64 = 0.9;
const ANSWER_S: f64 = 3.2;

/// The agent cyan, run blue and fail marks of Quartz's tokens (hue-1, hue-3, fail).
const cyan = ui.Color.hex(0x3ee0f2);
const blue = ui.Color.hex(0x7ea4ff);
const red = ui.Color.hex(0xf94341);

const Building = struct { host: []const u8, routes: []const types.Route, x: f32, w: f32, h: f32, roof: u32 };
const Figure = struct { name: []const u8, x: f32 };
const Door = struct { x: f32, y: f32, w: f32, h: f32 };

/// The site a route's page is on, without `www.`: its door goes on that building.
fn rootHost(r: types.Route) []const u8 {
    const host = if (std.mem.indexOf(u8, r.root, "://")) |i| blk: {
        const rest = r.root[i + 3 ..];
        break :blk rest[0 .. std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len];
    } else r.site;
    return bare(host);
}

fn bare(host: []const u8) []const u8 {
    return if (std.mem.startsWith(u8, host, "www.")) host[4..] else host;
}

const Street = struct { buildings: []Building, more: usize };

/// The buildings on the street: the sites with the most doors first, centred, at most seven.
fn layout(fa: std.mem.Allocator, sites: []const types.Site, routes: []const types.Route) Street {
    const Host = struct { host: []const u8, routes: std.ArrayList(types.Route) = .empty };
    var hosts: std.ArrayList(Host) = .empty;
    const find = struct {
        fn f(hs: []Host, h: []const u8) ?usize {
            for (hs, 0..) |x, i| if (std.mem.eql(u8, x.host, h)) return i;
            return null;
        }
    }.f;
    for (sites) |s| if (find(hosts.items, bare(s.host)) == null) hosts.append(fa, .{ .host = bare(s.host) }) catch {};
    for (routes) |r| {
        const h = rootHost(r);
        const i = find(hosts.items, h) orelse blk: {
            hosts.append(fa, .{ .host = h }) catch return .{ .buildings = &.{}, .more = 0 };
            break :blk hosts.items.len - 1;
        };
        hosts.items[i].routes.append(fa, r) catch {};
    }
    std.mem.sort(Host, hosts.items, {}, struct {
        fn lt(_: void, a: Host, b: Host) bool {
            if (a.routes.items.len != b.routes.items.len) return a.routes.items.len > b.routes.items.len;
            return std.mem.lessThan(u8, a.host, b.host);
        }
    }.lt);
    const n = @min(hosts.items.len, MAX_BUILDINGS);
    const out = fa.alloc(Building, n) catch return .{ .buildings = &.{}, .more = 0 };
    const gap: f32 = 18;
    const span = STREET_TO - STREET_FROM;
    const nf: f32 = @floatFromInt(@max(n, 1));
    const w = @min(150, (span - gap * (nf - 1)) / nf);
    const used = @as(f32, @floatFromInt(n)) * w + @as(f32, @floatFromInt(n -| 1)) * gap;
    const start = STREET_FROM + (span - used) / 2;
    for (hosts.items[0..n], 0..) |h, i| {
        const seed = std.hash.Fnv1a_32.hash(h.host);
        const doors: f32 = @floatFromInt(@min(h.routes.items.len, 4));
        out[i] = .{
            .host = h.host,
            .routes = h.routes.items,
            .x = start + @as(f32, @floatFromInt(i)) * (w + gap),
            .w = w,
            .h = 118 + doors * 34 + @as(f32, @floatFromInt(seed % 46)),
            .roof = seed % 3,
        };
    }
    return .{ .buildings = out, .more = hosts.items.len - n };
}

fn doorAt(b: Building, i: usize) Door {
    const n: f32 = @floatFromInt(@max(@min(b.routes.len, MAX_DOORS), 1));
    const dw: f32 = 22;
    const pitch = @min(40, (b.w - 16) / n);
    const x = b.x + b.w / 2 - ((n - 1) * pitch) / 2 + @as(f32, @floatFromInt(i)) * pitch - dw / 2;
    return .{ .x = x, .y = GROUND - 40, .w = dw, .h = 40 };
}

/// The door of `route`, if it is drawn.
fn doorOf(buildings: []const Building, route: []const u8) ?Door {
    for (buildings) |b| for (b.routes[0..@min(b.routes.len, MAX_DOORS)], 0..) |r, i| {
        if (std.mem.eql(u8, r.id, route)) return doorAt(b, i);
    };
    return null;
}

/// The arc a call flies along, up out of the agent's hands, over the street, down onto the door: a cubic Bézier, as
/// an SVG path draws it.
const Arc = struct {
    p: [4][2]f32,
    fn of(fig: Figure, d: Door) Arc {
        const ax = fig.x + 30;
        const ay = GROUND - 62;
        const dx = d.x + d.w / 2;
        const dy = d.y - 4;
        const lift = 120 + @abs(dx - ax) * 0.12;
        return .{ .p = .{ .{ ax, ay }, .{ ax + 40, ay - lift }, .{ dx - 30, dy - lift }, .{ dx, dy } } };
    }
    fn at(a: Arc, t: f32) [2]f32 {
        const u = 1 - t;
        const k = [4]f32{ u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t };
        var out = [2]f32{ 0, 0 };
        for (a.p, k) |p, w| {
            out[0] += p[0] * w;
            out[1] += p[1] * w;
        }
        return out;
    }
};

/// What is drawn into: the street's units scaled to the box, from `top` down.
const Pen = struct {
    c: *ui.Context,
    k: f32,
    top: f32,

    fn box(p: Pen, x: f32, y: f32, w: f32, h: f32) ui.Div {
        return ui.div(p.c).absolute().offset(@round(x * p.k), @round((y - p.top) * p.k)).w(@max(1, w * p.k)).h(@max(1, h * p.k));
    }
    /// A rectangle: filled, outlined, or both.
    fn rect(p: Pen, x: f32, y: f32, w: f32, h: f32, fill: ?ui.Color, line: ?ui.Color, width: f32, radius: f32) void {
        var d = p.box(x, y, w, h).rounded(radius * p.k);
        if (fill) |f| d = d.bg(f);
        if (line) |l| d = d.border(l).borderW(@max(1, width * p.k));
        d.end();
    }
    /// A straight stroke between two points on one axis.
    fn hline(p: Pen, x0: f32, x1: f32, y: f32, color: ui.Color, width: f32) void {
        p.rect(x0, y - width / 2, x1 - x0, width, color, null, 0, width / 2);
    }
    fn vline(p: Pen, x: f32, y0: f32, y1: f32, color: ui.Color, width: f32) void {
        p.rect(x - width / 2, y0, width, y1 - y0, color, null, 0, width / 2);
    }
    fn dot(p: Pen, x: f32, y: f32, r: f32, fill: ui.Color, line: ?ui.Color) void {
        var d = p.box(x - r, y - r, r * 2, r * 2).roundedFull().bg(fill);
        if (line) |l| d = d.border(l).borderW(@max(1, 1.6 * p.k));
        d.end();
    }
    /// A short label centred on `x`, in the street's units like the rest: it shrinks with the city, so neighbours never
    /// overlap, but never below 10 px, the smallest the window draws text at that must be read.
    fn label(p: Pen, x: f32, y: f32, s: []const u8, color: ui.Color, size: f32) void {
        const half: f32 = 80;
        const d = p.box(x - half, y - 14, half * 2, 18).center();
        defer d.end();
        ui.text(p.c, s, .{ .size = @max(10, size * p.k * 1.15), .color = color });
    }
};

pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const x = look.x(c);
    const ink = c.theme.text;
    const paper = c.theme.surface;
    const faint = x.frame;
    const routes = a.store.list(.routes);
    const street = layout(fa, a.store.list(.sites), routes);
    var listed: usize = 0;
    for (routes) |r| listed += @intFromBool(r.listing != null and r.listing.?.live);

    const p = look.panel(c, "This node's city", c.print("{s} doors, {s} lit", .{ fmt.count(fa, @floatFromInt(routes.len)), fmt.count(fa, @floatFromInt(listed)) }));
    defer p.end();
    look.panelBody(c);
    if (street.buildings.len == 0) {
        const d = ui.div(c).wFull().px(12).pt(12);
        defer d.end();
        look.body(c, "No doors yet. When an agent has the node learn a page, the site goes up here as a building, and the call it kept becomes a door with the chalk U beside it.");
    }

    // Figures on the left: the agents that hold keys, then anyone else a call came from (you, trying a route).
    var names: std.ArrayList([]const u8) = .empty;
    for (a.store.list(.agents_list)) |ag| if (!ag.revoked and ag.expires > a.now and names.items.len < 3) names.append(fa, ag.name) catch {};
    const calls = a.calls.items[0..a.calls.len];
    for (calls) |*call| {
        const who = call.agent.get();
        if (names.items.len >= 3 or who.len == 0) break;
        var known = false;
        for (names.items) |n| known = known or std.mem.eql(u8, n, who);
        if (!known) names.append(fa, who) catch {};
    }
    const figures = fa.alloc(Figure, names.items.len) catch return;
    for (names.items, 0..) |n, i| figures[i] = .{ .name = n, .x = 22 + @as(f32, @floatFromInt(i)) * 68 };

    // The sky ends just above the tallest thing drawn: a building's roof or a call's arc.
    var top: f32 = GROUND - 230;
    for (street.buildings) |b| top = @min(top, GROUND - b.h - 44);
    top = @max(0, top);

    // Scaled to the box's width last frame; a new width draws once more.
    const k = a.city_width / W;
    const area = ui.div(c).wFull().h(@round((H - top) * k) + 16).p(8);
    defer area.end();
    if (area.interaction().rect) |r| if (@abs(r.w - 16 - a.city_width) > 0.5) {
        a.city_width = @max(320, r.w - 16);
        c.frameIn(0);
    };
    const pen: Pen = .{ .c = c, .k = k, .top = top };

    // The street, and the chalk line along it.
    pen.hline(8, W - 8, GROUND, ink, 2.5);
    var dash: f32 = 8;
    while (dash < W - 8) : (dash += 32) pen.hline(dash, @min(dash + 18, W - 8), GROUND + 14, faint, 1.2);

    // The routes each agent has used, from the activity log: faint dotted arcs from the agent to the door.
    for (figures) |fig| for (street.buildings) |b| for (b.routes[0..@min(b.routes.len, MAX_DOORS)], 0..) |r, i| {
        if (!usedBy(a, fig.name, r)) continue;
        const arc = Arc.of(fig, doorAt(b, i));
        var t: f32 = 0;
        while (t <= 1) : (t += 0.02) {
            const q = arc.at(t);
            pen.dot(q[0], q[1], 1, faint, null);
        }
    };

    for (street.buildings) |b| building(pen, b, ink, paper, faint);

    // The doors, each with its knob and the chalk U; a door lit once listed, and answering a call for a moment.
    var busy = false;
    for (street.buildings) |b| for (b.routes[0..@min(b.routes.len, MAX_DOORS)], 0..) |r, i| {
        const d = doorAt(b, i);
        const answer = answerFor(a, r.id);
        if (answer != null) busy = true;
        const lit = r.listing != null and r.listing.?.live;
        const fill = if (answer) |ans| (if (ans.ok) cyan else red) else if (lit) blue else paper;
        pen.rect(d.x, d.y, d.w, d.h, fill, ink, 2.2, 2);
        pen.dot(d.x + d.w - 6, d.y + d.h / 2 + 2, 1.6, ink, null);
        chalkU(pen, d.x + d.w + 6, d.y + 6, if (lit) blue else ink, paper);
        if (answer) |ans| pen.label(d.x + d.w / 2, d.y - 6, if (ans.ok) c.print("{d:.0} ms", .{ans.ms}) else "Failed", if (ans.ok) ink else x.fail_text, 11);
    };

    for (street.buildings) |b| {
        const more = if (b.routes.len > MAX_DOORS) c.print(" +{d}", .{b.routes.len - MAX_DOORS}) else "";
        const host = if (b.host.len > 22) c.print("{s}…", .{b.host[0..20]}) else b.host;
        pen.label(b.x + b.w / 2, GROUND + 36, c.print("{s}{s}", .{ host, more }), x.text2, 10.5);
    }

    for (figures) |fig| {
        {
            const d = pen.box(fig.x, GROUND - 72, 60, 72).itemsEnd().justifyCenter();
            defer d.end();
            art.uni(c, moodOf(a, fig.name), 60 * k);
        }
        const name = if (fig.name.len > 11) c.print("{s}…", .{fig.name[0..10]}) else fig.name;
        pen.label(fig.x + 30, GROUND + 36, name, x.text2, 10.5);
    }

    // Calls in the air: a light rides the arc from the agent to the door.
    for (calls) |*call| {
        const since = a.now_ms / 1000 - call.at;
        if (call.done and since > FLIGHT_S + 0.26) continue;
        const fig = for (figures) |f| {
            if (std.mem.eql(u8, f.name, call.agent.get())) break f;
        } else continue;
        const door = doorOf(street.buildings, call.route.get()) orelse continue;
        busy = true;
        const t: f32 = @floatCast(@min(1, @max(0, since / FLIGHT_S)));
        const e = 1 - std.math.pow(f32, 1 - t, 3);
        const arc = Arc.of(fig, door);
        var s: f32 = 0;
        while (s <= e) : (s += 0.01) {
            const q = arc.at(s);
            pen.dot(q[0], q[1], 1.2, cyan, null);
        }
        const head = arc.at(e);
        pen.dot(head[0], head[1], 6, cyan, ink);
    }
    // A frame clock only while something is in the air or a door is still answering; at rest nothing runs.
    if (busy) c.frameIn(1.0 / 60.0);
}

/// One building in the film's line: a body, a roof that differs by site, rows of windows. A site with no route yet
/// is drawn faint.
fn building(pen: Pen, b: Building, ink: ui.Color, paper: ui.Color, faint: ui.Color) void {
    const top = GROUND - b.h;
    const line = if (b.routes.len == 0) faint else ink;
    switch (b.roof) {
        0 => {
            pen.hline(b.x + 6, b.x + b.w - 6, top - 7, line, 2);
            pen.vline(b.x + b.w - 6, top - 7, top, line, 2);
        },
        1 => pen.rect(b.x + b.w * 0.2, top - 14, b.w * 0.4, 16, paper, line, 2, 0),
        else => {
            pen.vline(b.x + b.w * 0.68, top - 10, top, line, 2);
            pen.vline(b.x + b.w * 0.84, top - 10, top, line, 2);
            pen.rect(b.x + b.w * 0.62, top - 30, b.w * 0.28, 20, paper, line, 2, 0);
        },
    }
    pen.rect(b.x, top, b.w, b.h, paper, line, 2.4, 0);
    if (b.roof == 0) pen.hline(b.x - 4, b.x + b.w + 4, top, line, 2);
    const cols: usize = @intFromFloat(@max(2, @floor((b.w - 20) / 22)));
    const rows: usize = @intFromFloat(@max(1, @floor((b.h - 78) / 28)));
    const colsf: f32 = @floatFromInt(cols);
    for (0..rows) |r| for (0..cols) |c| {
        const wx = b.x + 12 + @as(f32, @floatFromInt(c)) * ((b.w - 24) / colsf) + 3;
        const wy = top + 18 + @as(f32, @floatFromInt(r)) * 28;
        pen.rect(wx, wy, 10, 14, null, faint, 1.3, 1);
    };
}

/// The chalk U beside a door, from (x, y): two strokes down and the bottom of a ring between them.
fn chalkU(pen: Pen, x: f32, y: f32, color: ui.Color, paper: ui.Color) void {
    const w: f32 = 2.6;
    pen.rect(x - w / 2, y + 3.5, 11 + w, 11 + w, null, color, w, 6.8);
    // The ring's top half is covered; the strokes come down over it.
    pen.rect(x - w, y + 2, 11 + w * 2, 7.6, paper, null, 0, 0);
    pen.vline(x, y, y + 9, color, w);
    pen.vline(x + 11, y, y + 9, color, w);
}

/// Whether the activity log has `who` calling route `r`.
fn usedBy(a: *App, who: []const u8, r: types.Route) bool {
    for (a.store.list(.activity)) |act| {
        if (std.mem.eql(u8, act.kind, "call") and std.mem.eql(u8, act.who, who) and std.mem.eql(u8, act.what, r.what) and
            (std.mem.eql(u8, act.site, r.site) or std.mem.eql(u8, bare(act.site), rootHost(r)))) return true;
    }
    return false;
}

const Answer = struct { ok: bool, ms: f64 };

/// The answer a door is still showing: the latest call to `route` that came back in the last few seconds.
fn answerFor(a: *App, route: []const u8) ?Answer {
    for (a.calls.items[0..a.calls.len]) |*call| {
        if (!call.done or !std.mem.eql(u8, call.route.get(), route)) continue;
        const back = call.at + call.ms / 1000;
        if (a.now_ms / 1000 - back < ANSWER_S) return .{ .ok = call.ok, .ms = call.ms };
        return null;
    }
    return null;
}

/// Uni's face for an agent: set on its way, then glad or worried by the answer, then calm again.
fn moodOf(a: *App, who: []const u8) art.Mood {
    for (a.calls.items[0..a.calls.len]) |*call| {
        if (!std.mem.eql(u8, call.agent.get(), who)) continue;
        if (!call.done) return .determined;
        if (a.now_ms / 1000 - (call.at + call.ms / 1000) > ANSWER_S) return .neutral;
        return if (call.ok) .happy else .nervous;
    }
    return .neutral;
}
