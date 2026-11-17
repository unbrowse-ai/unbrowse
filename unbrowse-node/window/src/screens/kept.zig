//! What the walk came to: the calls the node weighed, their scores as bars
//! that rise once; the one it kept, with why; and, once saved, the route
//! as a card: its method, its path with the caller's values as slots to
//! fill, and its steps.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const motion = ui.motion;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const live = @import("../live.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;

pub fn view(a: *App, c: *ui.Context, w: *live.Walk, width: f32) void {
    if (w.saved != null) return card(a, c, w, width);
    if (w.scored) |sc| weighed(c, w, sc.candidates, sc.exchanges, width);
}

fn weighed(c: *ui.Context, w: *live.Walk, cands: []const types.Scored, exchanges: f64, width: f32) void {
    const x = look.x(c);
    var top: f64 = 1;
    for (cands) |cand| top = @max(top, cand.score);
    const box = ui.div(c).column().wFull().gap(6);
    defer box.end();
    ui.text(c, c.print("Weighed {d} of {d} calls against the goal", .{ cands.len, exchanges }), .{ .size = 12.5, .weight = .medium, .color = x.text2 });
    const bar_w: f32 = @min(160, width * 0.3);
    for (cands[0..@min(cands.len, 4)], 0..) |cand, i| {
        const picked = if (w.picked) |pk| std.mem.eql(u8, pk.host, cand.host) and std.mem.eql(u8, pk.path, cand.path) else false;
        ui.key(c, c.print("cand-{s}-{d}", .{ w.id, i }));
        const f = motion.frame(c, .{ .initial = .{ .y = 6, .opacity = 0 }, .delay = motion.stagger(i, 0.05), .transition = .{ .spring = motion.Spring.snappy } });
        const r = ui.div(c).row().wFull().gap(10).itemsCenter().motion(f);
        defer r.end();
        {
            const track = ui.div(c).w(bar_w).h(8).rounded(4).bg(x.well);
            defer track.end();
            const share: f32 = @floatCast(if (cand.noise) 0 else cand.score / top);
            const grow = motion.frame(c, .{ .initial = .{ .width = 0 }, .target = .{ .width = @max(4, share * bar_w) }, .delay = motion.stagger(i, 0.05), .transition = .{ .tween = .{ .duration = 0.45, .ease = .ease_out } } });
            const b = ui.div(c).h(8).rounded(4).bg(if (picked) x.run else if (cand.noise) x.text3.alpha(0.3) else x.run.alpha(0.35)).motion(grow);
            b.end();
        }
        const n = ui.div(c).w(36);
        ui.text(c, if (cand.noise) "ping" else c.print("{d:.1}", .{cand.score}), .{ .size = 11.5, .mono = true, .color = if (picked) x.run else x.text2 });
        n.end();
        const p = ui.div(c).grow().minW(0).clip();
        ui.text(c, c.print("{s} {s}{s}", .{ cand.method, cand.host, cand.path }), .{ .size = 11.5, .mono = true, .color = if (picked) c.theme.text else if (cand.noise) x.text3 else x.text2 });
        p.end();
    }
    if (w.picked) |pk| reasons(c, pk.by, pk.reasons);
}

fn reasons(c: *ui.Context, by: []const u8, rs: []const []const u8) void {
    const x = look.x(c);
    const fa = c.alloc();
    const box = ui.div(c).column().wFull().gap(3).pt(2);
    defer box.end();
    ui.text(c, c.print("Kept, picked by {s}:", .{by}), .{ .size = 12, .weight = .medium, .color = x.run });
    for (rs[0..@min(rs.len, 3)], 0..) |r, i| {
        ui.key(c, c.print("why-{d}", .{i}));
        ui.text(c, fmt.capital(fa, r), .{ .size = 12, .color = x.text2, .wrap = true });
    }
}

/// The route the walk saved, from the routes list (its path has the slots).
fn routeOf(a: *App, id: []const u8) ?types.Route {
    for (a.store.list(.routes)) |r| if (std.mem.eql(u8, r.id, id)) return r;
    return null;
}

fn card(a: *App, c: *ui.Context, w: *live.Walk, width: f32) void {
    _ = width;
    const x = look.x(c);
    const fa = c.alloc();
    const sv = w.saved.?;
    const route = routeOf(a, w.saved_route);
    const pk = w.picked;
    ui.key(c, c.print("card-{s}", .{w.id}));
    const f = motion.frame(c, .{ .initial = .{ .y = 10, .opacity = 0, .scale = 0.98 }, .transition = .{ .spring = motion.Spring.snappy } });
    const box = ui.div(c).column().wFull().gap(10).p(14).rounded(10).bg(x.run.alpha(0.05)).border(x.run.alpha(0.28)).motion(f);
    defer box.end();
    {
        const r = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer r.end();
        ui.text(c, "Kept as a route", .{ .size = 13, .weight = .semibold });
        ui.spacer(c);
        if (pk) |p| ui.text(c, c.print("picked by {s}", .{p.by}), .{ .size = 12, .color = x.text3 });
    }
    {
        // The call: its method, its site, its path with the caller's values as slots.
        const r = ui.div(c).row().wFull().gap(6).itemsCenter().clip();
        defer r.end();
        const method = if (route) |rt| rt.method else if (pk) |p| p.method else "GET";
        const m = ui.div(c).px(6).py(2).rounded(4).bg(c.theme.text);
        ui.text(c, method, .{ .size = 11, .weight = .semibold, .mono = true, .color = c.theme.surface });
        m.end();
        const host = if (route) |rt| rt.site else if (pk) |p| p.host else "";
        ui.text(c, host, .{ .size = 12.5, .mono = true, .color = x.text3 });
        path(c, if (route) |rt| rt.path else if (pk) |p| p.path else "");
    }
    {
        const ins = std.mem.join(fa, ", ", sv.inputs) catch "";
        const steps = fmt.plural(fa, sv.steps, "step");
        const words = if (ins.len > 0) c.print("{s}; the caller fills {s}. Called from now on with no browser.", .{ steps, ins }) else c.print("{s}, no inputs. Called from now on with no browser.", .{steps});
        ui.text(c, fmt.capital(fa, words), .{ .size = 12.5, .color = x.text2, .wrap = true });
    }
    if (pk) |p| if (p.reasons.len > 0) {
        const why = ui.div(c).column().wFull().gap(2);
        defer why.end();
        for (p.reasons[0..@min(p.reasons.len, 2)], 0..) |rsn, i| {
            ui.key(c, c.print("why-{d}", .{i}));
            ui.text(c, fmt.capital(fa, rsn), .{ .size = 12, .color = x.text3, .wrap = true });
        }
    };
    if (look.secondary(c, "Open my routes", .{ .size = .xs })) a.go(.routes);
}

/// A path with its `{name}` pieces drawn as slots.
fn path(c: *ui.Context, p: []const u8) void {
    const x = look.x(c);
    var rest = p;
    var i: usize = 0;
    while (rest.len > 0) : (i += 1) {
        ui.key(c, c.print("piece-{d}", .{i}));
        const open = std.mem.indexOfScalar(u8, rest, '{') orelse {
            ui.text(c, rest, .{ .size = 12.5, .mono = true });
            return;
        };
        if (open > 0) {
            ui.text(c, rest[0..open], .{ .size = 12.5, .mono = true });
            rest = rest[open..];
            continue;
        }
        const close = std.mem.indexOfScalar(u8, rest, '}') orelse {
            ui.text(c, rest, .{ .size = 12.5, .mono = true });
            return;
        };
        const slot = ui.div(c).px(6).py(1).rounded(5).bg(x.run.alpha(0.12)).border(x.run.alpha(0.45));
        ui.text(c, rest[1..close], .{ .size = 12, .mono = true, .weight = .medium, .color = x.run });
        slot.end();
        rest = rest[close + 1 ..];
    }
}
