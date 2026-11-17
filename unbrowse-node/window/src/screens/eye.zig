//! The agent's eye: while an agent's learn runs, each
//! response as it lands, the calls it weighed, the one it kept and why;
//! under it, the calls agents made just now. Only what happened moves: a
//! row slides in once when it arrives.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const motion = ui.motion;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const live = @import("../live.zig");
const App = @import("../app.zig").App;

const sort_words = [_][]const u8{ "page", "data", "asset", "gate", "ping" };

fn host(url: []const u8) []const u8 {
    const after = if (std.mem.indexOf(u8, url, "://")) |i| url[i + 3 ..] else url;
    const end = std.mem.indexOfAny(u8, after, "/?#") orelse after.len;
    return after[0..end];
}

fn size(a: std.mem.Allocator, b: f64) []const u8 {
    if (b >= 1024) return std.fmt.allocPrint(a, "{d} KB", .{@round(b / 1024)}) catch "";
    if (b > 0) return std.fmt.allocPrint(a, "{d} B", .{b}) catch "";
    return "";
}

pub fn view(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    const fa = c.alloc();
    const w = a.eye.walk;
    const st: look.Status = if (w == null) .idle else if (w.?.failed != null) .fail else if (w.?.saved != null) .ok else .running;
    const word = if (w) |k| (if (k.lost) "Lost sight of this walk" else if (k.failed != null) "Failed" else if (k.saved != null) "Kept a route" else if (k.picked != null) "Keeping" else if (k.scored != null) "Weighing" else "Walking") else "Idle";
    // A walk fills the column beside the city; at rest the panel is only as tall as what it says.
    const p = if (w != null) look.panelFill(c, "Agent's eye", "") else look.panel(c, "Agent's eye", "");
    defer p.end();
    look.status(c, st, word);
    if (w != null) look.panelBodyFill(c) else look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    const walk = w orelse {
        look.body(c, "When an agent asks this node to learn a page, you watch its browser here: every response as it lands, the calls it weighed, and the one it kept, with why.");
        return calls(a, c);
    };
    {
        const head = ui.div(c).column().wFull().gap(3);
        defer head.end();
        ui.text(c, c.print("{s} wants to {s}", .{ walk.agent, fmt.lower(fa, walk.goal) }), .{ .size = 13.5, .wrap = true });
        look.mono(c, walk.url, x.text2);
        const summary = if (walk.failed) |f| f else c.print("{s} from {s}: {d} with data, {s}, {s}, {s}{s}", .{
            fmt.plural(fa, walk.total, "response"),
            host(walk.url),
            walk.count(.data),
            fmt.plural(fa, walk.count(.page), "page"),
            fmt.plural(fa, walk.count(.asset), "asset"),
            fmt.plural(fa, walk.count(.noise), "ping"),
            if (walk.count(.gate) > 0) c.print(", {s}", .{fmt.plural(fa, walk.count(.gate), "gate check")}) else "",
        });
        ui.text(c, summary, .{ .size = 12.5, .color = if (walk.failed != null) x.fail_text else x.text2, .wrap = true });
    }
    if (walk.picked) |pk| {
        // The kept call lifts out of the stream: it rises into place once.
        ui.key(c, c.print("kept-{s}", .{walk.id}));
        const f = motion.frame(c, .{ .initial = .{ .y = 10, .opacity = 0 }, .transition = .{ .spring = motion.Spring.snappy } });
        const kept = ui.div(c).column().wFull().gap(6).p(12).rounded(8).bg(x.run.alpha(0.08)).motion(f);
        defer kept.end();
        ui.text(c, c.print("Kept, picked by {s}", .{pk.by}), .{ .size = 12.5, .weight = .semibold, .color = x.run });
        ui.text(c, c.print("{s} {s}{s}", .{ pk.method, pk.host, pk.path }), .{ .size = 12, .mono = true, .wrap = true });
        for (pk.reasons, 0..) |r, i| {
            ui.key(c, c.print("reason-{d}", .{i}));
            ui.text(c, fmt.capital(fa, r), .{ .size = 12, .color = x.text2, .wrap = true });
        }
        if (walk.saved) |sv| {
            const r = ui.div(c).column().wFull().gap(8).pt(2);
            defer r.end();
            const ins = std.mem.join(fa, ", ", sv.inputs) catch "";
            ui.text(c, c.print("Saved as a route: {d} step{s}{s}", .{ sv.steps, if (sv.steps == 1) "" else "s", if (ins.len > 0) c.print(", takes {s}", .{ins}) else "" }), .{ .size = 12.5, .wrap = true });
            if (look.secondary(c, "Open my routes", .{ .size = .xs })) a.go(.routes);
        }
    }
    if (walk.scored) |sc| if (walk.saved == null) {
        const box = ui.div(c).column().wFull().gap(3);
        defer box.end();
        ui.text(c, c.print("Weighed {d} of {d} calls", .{ sc.candidates.len, sc.exchanges }), .{ .size = 12.5, .weight = .medium, .color = x.text2 });
        for (sc.candidates[0..@min(sc.candidates.len, 4)], 0..) |cand, i| {
            ui.key(c, c.print("cand-{d}", .{i}));
            const r = ui.div(c).row().wFull().gap(8);
            defer r.end();
            const n = ui.div(c).w(36).itemsEnd();
            ui.text(c, if (cand.noise) "ping" else c.print("{d:.0}", .{cand.score}), .{ .size = 12, .mono = true });
            n.end();
            ui.text(c, c.print("{s}{s}", .{ cand.host, cand.path }), .{ .size = 12, .mono = true, .color = if (cand.noise) x.text3 else x.text2 });
        }
    };
    {
        const list = ui.div(c).column().wFull().clip();
        defer list.end();
        const n = if (walk.saved != null) @min(walk.seen_len, 4) else walk.seen_len;
        for (walk.seen[0..n]) |s| seenRow(c, s, walk);
    }
    calls(a, c);
}

fn seenRow(c: *ui.Context, s: live.Seen, walk: *live.Walk) void {
    const x = look.x(c);
    const fa = c.alloc();
    // Keyed by the response's number: a new one slides in, the rest stay.
    ui.key(c, c.print("seen-{s}-{d}-{s}{s}", .{ walk.id, s.n, s.host, s.path }));
    const f = motion.frame(c, .{ .initial = .{ .y = -6, .opacity = 0 }, .transition = .{ .tween = .{ .duration = 0.18, .ease = .ease_out } } });
    const lifted = if (walk.picked) |pk| std.mem.eql(u8, pk.host, s.host) and std.mem.eql(u8, pk.path, s.path) else false;
    const r = ui.div(c).row().wFull().gap(8).py(4).itemsCenter().opacity(if (lifted) 0.3 else 1).motion(f);
    defer r.end();
    const col = if (s.sort == .data) c.theme.text else x.text3;
    const m = ui.div(c).w(40);
    ui.text(c, s.method, .{ .size = 11.5, .mono = true, .color = col });
    m.end();
    const path = ui.div(c).w(0).grow().clip();
    ui.text(c, c.print("{s}{s}", .{ s.host, s.path }), .{ .size = 11.5, .mono = true, .color = col });
    path.end();
    ui.text(c, c.print("{d}", .{s.status}), .{ .size = 11.5, .mono = true, .color = if (s.status >= 400) x.fail_text else col });
    const sz = ui.div(c).w(48).itemsEnd();
    defer sz.end();
    const word = if (s.sort == .data) (if (size(fa, s.bytes).len > 0) size(fa, s.bytes) else "data") else sort_words[@intFromEnum(s.sort)];
    ui.text(c, word, .{ .size = 11.5, .mono = true, .color = col });
}

/// Calls agents made just now, newest first: the light leaving and the door answering.
fn calls(a: *App, c: *ui.Context) void {
    if (a.calls.len == 0) return;
    const x = look.x(c);
    const fa = c.alloc();
    look.rule(c);
    ui.text(c, "Calls just now", .{ .size = 12.5, .weight = .medium, .color = x.text2 });
    for (a.calls.items[0..a.calls.len]) |*call| {
        ui.key(c, c.print("call-{d}", .{call.seq}));
        const f = motion.frame(c, .{ .initial = .{ .y = -6, .opacity = 0 }, .transition = .{ .tween = .{ .duration = 0.18, .ease = .ease_out } } });
        const r = ui.div(c).row().wFull().gap(8).itemsCenter().motion(f);
        defer r.end();
        const words = ui.div(c).column().grow().minW(0).gap(1);
        ui.text(c, c.print("{s} on {s}", .{ call.what.get(), call.site.get() }), .{ .size = 12.5, .weight = .medium });
        ui.text(c, c.print("{s}{s}", .{ call.agent.get(), if (call.paid) |pd| c.print(", paid {s} USDC", .{fmt.usdcd(fa, pd, 3)}) else "" }), .{ .size = 11.5, .color = x.text3 });
        words.end();
        if (!call.done) {
            look.status(c, .running, "Calling");
        } else look.status(c, if (call.ok) .ok else .fail, if (call.ok) c.print("{d:.0} ms", .{call.ms}) else "Failed");
    }
}
