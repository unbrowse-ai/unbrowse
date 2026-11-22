//! The node at a glance: its name and pause, its city, what
//! it earned, the agent's eye, what it does, what it learned while you
//! browsed, and what needs a look.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const App = @import("../app.zig").App;
const wallet = @import("wallet.zig");
const eye = @import("eye.zig");
const city = @import("city.zig");
const art = @import("../art.zig");
const routes = @import("routes.zig");

pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const s = a.store.get(.settings);
    const rs = a.store.list(.routes);
    const acts = a.store.list(.activity);
    const start = fmt.dayStart(a.now);
    var today: f64 = 0;
    var passed: f64 = 0;
    for (acts) |x| if (std.mem.eql(u8, x.kind, "call") and x.at >= start) {
        today += 1;
        if (std.mem.eql(u8, x.result, "passed")) passed += 1;
    };
    {
        const desc = if (a.paused())
            "Paused: agents' calls are refused until you resume."
        else
            c.print("{s} learned. {s} today, {s} passed. Agents reach this node at 127.0.0.1:{d}.", .{ fmt.plural(fa, @floatFromInt(rs.len), "route"), fmt.plural(fa, today, "call"), fmt.count(fa, passed), a.port() });
        const h = look.header(c, a.nodeName(), desc);
        defer h.end();
        if (look.secondary(c, if (a.paused()) "Resume node" else "Pause node", .{ .disabled = s == null, .size = .md })) a.setPaused(!a.paused());
    }
    notice(a, c);
    startFunds(a, c);
    // A grid of three: the city and what it earned across two; beside them what needs a look, first, then the
    // agent's eye and what the node does; under them what it learned, across the page.
    {
        const row = ui.div(c).row().wFull().gap(16).itemsStretch();
        defer row.end();
        {
            const left = ui.div(c).column().grow().minW(0).gap(16);
            defer left.end();
            city.view(a, c);
            earned(a, c);
        }
        const right = ui.div(c).column().w(340).gap(16);
        defer right.end();
        needs(a, c);
        eye.view(a, c);
        // At rest the eye is short, and what the node does fits under it; a walk takes the column.
        if (a.eye.walk == null) does(a, c);
    }
    if (a.eye.walk != null) {
        const row = ui.div(c).row().wFull().gap(16).itemsStart();
        defer row.end();
        {
            const left = ui.div(c).column().w(340).gap(16);
            defer left.end();
            does(a, c);
        }
        const right = ui.div(c).column().grow().minW(0).gap(16);
        defer right.end();
        learned(a, c);
    } else learned(a, c);
}

fn earned(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const w = a.store.get(.wallet);
    const p = look.panel(c, "Earned", if (a.chainUp()) "From your routes other agents use" else "Waiting for payments");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c).gap(16);
    defer b.end();
    const e = if (w) |x| x.earned else @import("../types.zig").Earned{};
    {
        const r = ui.div(c).row().wFull().gap(16).itemsEnd();
        defer r.end();
        // A new earning counts up to its figure, so the change reads as a change.
        const total = ui.motion.number(c, "earned-total", @floatCast(e.entries), look.change);
        look.stat(c, "", c.print("${s}", .{fmt.usdcd(fa, total, 2)}), "", c.print("Your routes' share of {s} paid uses, all time", .{fmt.count(fa, e.lines)}), true);
        if (e.staking > 0) look.stat(c, "From staking route coins", c.print("${s}", .{fmt.usdcd(fa, e.staking, 2)}), "", "", false);
    }
    if (a.store.err(.wallet)) |msg| if (w == null and !a.store.keychain) look.small(c, msg);
    if (e.by_day.len > 0) {
        const n = @min(e.by_day.len, 14);
        const days = e.by_day[e.by_day.len - n ..];
        const vals = fa.alloc(f64, n) catch return;
        const labels = fa.alloc([]const u8, n) catch return;
        for (days, 0..) |d, i| {
            vals[i] = d[1];
            labels[i] = fmt.day(fa, d[0] * 86400);
        }
        look.bars(c, vals, labels, 110);
    } else look.body(c, c.print("Nothing earned yet. Share the routes your agents learn on My routes: each time another agent pays for a call on one and it passes, you earn {d}% of the fee, unless the route has a coin (Money, Advanced).", .{(if (w) |x| x.split else @import("../types.zig").Split{}).contributor}));
}

fn learned(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const sites = a.store.list(.sites);
    const rs = a.store.list(.routes);
    const p = look.panel(c, "Learned while you browsed", c.print("{s} sites", .{fmt.count(fa, @floatFromInt(sites.len))}));
    defer p.end();
    if (look.ghost(c, "All routes", .{ .size = .sm })) a.go(.routes);
    look.panelBody(c);
    if (sites.len == 0) return look.empty(c, "No sites walked yet. When your agents ask the node to learn a page, its browser walks it and the site shows here.");
    for (sites[0..@min(sites.len, 6)], 0..) |site, i| {
        if (i > 0) look.rule(c);
        var whats: std.ArrayList(u8) = .empty;
        var n: usize = 0;
        var listed = false;
        for (rs) |r| if (std.mem.eql(u8, r.site, site.host) or std.mem.indexOf(u8, r.root, site.host) != null) {
            if (n > 0) whats.appendSlice(fa, ", ") catch {};
            whats.appendSlice(fa, r.what) catch {};
            n += 1;
            if (r.listing) |l| listed = listed or l.live;
        };
        // A listed site wears the mark.
        const r = ui.div(c).row().wFull().itemsCenter().pl(12);
        defer r.end();
        {
            const media = ui.div(c).w(24).center();
            defer media.end();
            if (listed) art.mark(c, 20);
        }
        const it = look.item(c, site.host, site.host, if (n > 0) whats.items else "Pages only so far");
        defer it.end();
        it.right();
        ui.text(c, fmt.ago(fa, site.walked, a.now), .{ .size = 12.5, .color = look.x(c).text3 });
        ui.text(c, if (listed) "Listed" else if (n > 0) c.print("{d} route{s}", .{ n, if (n == 1) "" else "s" }) else "No route yet", .{ .size = 12.5, .color = look.x(c).text3 });
    }
}

fn needs(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const rs = a.store.list(.routes);
    var failing: usize = 0;
    for (rs) |r| failing += @intFromBool(r.broken());
    var near: usize = 0;
    for (a.store.list(.agents_spend)) |x| near += @intFromBool(x.cap > 0 and x.spent / x.cap >= 0.8);
    const chain_err = a.chainError();
    const asks = a.asks();
    const total = asks.len + failing + near + @intFromBool(chain_err != null);
    const p = look.panel(c, "Needs a look", c.print("{d}", .{total}));
    defer p.end();
    look.panelBody(c);
    var first = true;
    const sep = struct {
        fn f(cc: *ui.Context, flag: *bool) void {
            if (!flag.*) look.rule(cc);
            flag.* = false;
        }
    }.f;
    // An agent waiting on the owner comes first: it gives up when its time runs out.
    for (asks) |k| {
        sep(c, &first);
        const left: f64 = @max(0, @round(k.expires_at - a.now));
        const what = if (k.pay) |pay| c.print("{s} wants to pay with {s} on {s}", .{ k.agent, pay.card, pay.merchant }) else c.print("{s} asks you to {s}", .{ k.agent, k.why });
        const it = look.item(c, c.print("ask-{s}", .{k.site}), what, c.print("On {s}. Waits {d}:{d:0>2} more", .{ k.site, @as(u64, @intFromFloat(@divFloor(left, 60))), @as(u64, @intFromFloat(@mod(left, 60))) }));
        defer it.end();
        it.right();
        if (look.primary(c, "Open", .{ .size = .xs })) a.show(k.site);
    }
    if (asks.len > 0) c.frameIn(1);
    // A failed route says why in a line, and offers the next step: call it again with its inputs. Five to a page: a
    // node with many has them a page at a time, its asks always above them.
    const shown = look.pageRowsBy(&a.needs_page, failing, needs_per_page);
    var at: usize = 0;
    for (rs) |r| if (r.broken()) {
        defer at += 1;
        if (at < shown.from or at >= shown.to) continue;
        sep(c, &first);
        const it = look.item(c, r.id, c.print("{s} failed its last call", .{r.what}), look.clipTo(c, r.stats.last_error orelse "", 140));
        defer it.end();
        it.right();
        if (look.secondary(c, "Try it", .{ .size = .xs })) {
            a.go(.routes);
            routes.openRun(a, r);
        }
    };
    for (a.store.list(.agents_spend)) |x| if (x.cap > 0 and x.spent / x.cap >= 0.8) {
        sep(c, &first);
        const it = look.item(c, c.print("cap-{d}", .{x.index}), "An agent is near its daily limit", c.print("${s} of ${s} today", .{ fmt.usdc(fa, x.spent), fmt.usdc(fa, x.cap) }));
        defer it.end();
        it.right();
        if (look.secondary(c, "Open", .{ .size = .xs })) a.go(.wallet);
    };
    if (chain_err) |e| {
        sep(c, &first);
        const it = look.item(c, "chain", a.chainDownWord(), e);
        it.right();
        it.end();
    }
    if (total == 0) look.empty(c, "Nothing needs you right now.");
    if (look.pagesBy(failing, needs_per_page) > 1) {
        look.rule(c);
        const pg = look.pad(c);
        defer pg.end();
        look.pagerBy(c, "needs-pages", &a.needs_page, shown, failing, needs_per_page);
    }
}

/// The failed routes "Needs a look" shows at a time.
const needs_per_page = 5;

/// Once, on the first run with sharing on: the node shares what it learns, and where to turn that off.
fn notice(a: *App, c: *ui.Context) void {
    const s = a.store.get(.settings) orelse return;
    if (s.share_notice_seen or std.mem.eql(u8, s.share_routes, "off")) return;
    const p = look.panel(c, "Sharing is on", "");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    ui.text(c, if (std.mem.eql(u8, s.share_routes, "all"))
        "Each route your node learns is listed on the network once it has run, so other agents can fetch it and you earn its fee. Nothing of your session goes with it."
    else
        "Once your agents keep using a route, your node lists it on the network, so other agents can fetch it and you earn its fee. Nothing of your session goes with it.", .{ .size = 13.5, .wrap = true });
    look.small(c, "Turn it off, or keep one route off, in Settings and Routes.");
    const r = ui.div(c).row().gap(8);
    defer r.end();
    if (look.secondary(c, "Settings", .{})) {
        a.saveSetting("share_notice_seen", .{ .bool = true });
        a.go(.settings);
    }
    if (look.primary(c, "Got it", .{})) a.saveSetting("share_notice_seen", .{ .bool = true });
}

/// Step 2 of two: one amount that starts the node, "Add $X to start" (`money`'s `needed_to_start`), sent to its own
/// wallet. There is no sign-in step: the node is on the network with that wallet (spec §86). The first top-up pays its
/// registration and network fees too, so no breakdown is shown. Someone who already holds USDC gets the node's address
/// behind "Already have USDC?".
fn startFunds(a: *App, c: *ui.Context) void {
    const m = a.store.get(.money) orelse return;
    const need = std.fmt.parseFloat(f64, m.needed_to_start) catch 0;
    if (need <= 0 or m.add_funds_url == null) return;
    const p = look.panel(c, c.print("Add ${s} to start", .{m.needed_to_start}), if (a.devnet()) "Test mode" else "Needed");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.body(c, "By card, Apple Pay or bank. It pays your node's one-time registration and what your agents spend on other people's routes; network fees are included in each price.");
    const r = ui.div(c).row().gap(8).itemsCenter();
    defer r.end();
    if (look.primary(c, "Add funds", .{ .loading = a.store.isBusy("add") })) a.store.act(.generic, "add", "add_funds", "{}");
    if (look.ghost(c, "Already have USDC?", .{})) a.money_own = !a.money_own;
    if (a.money_own) nodeAddress(a, c);
}

/// The node's own address with its Copy button: where to send USDC on Arc.
fn nodeAddress(a: *App, c: *ui.Context) void {
    const me = if (a.store.get(.identity)) |i| i.address else "";
    if (me.len == 0) return;
    ui.key(c, "funds-address");
    const r = ui.div(c).row().gap(8).itemsCenter();
    defer r.end();
    ui.text(c, "Send only USDC on Arc to", .{ .size = 12.5, .weight = .medium });
    look.mono(c, me, null);
    wallet.copyButton(a, c, "Copy", me, "Copied the node's address");
}

fn does(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const s = a.store.get(.settings);
    const p = look.panel(c, "What this node does", "");
    defer p.end();
    look.panelBody(c);
    toggleRow(c, "Serve agents", c.print("Local API on port {d}", .{a.port()}), !(a.paused()), s != null, a, "paused", true);
    look.rule(c);
    toggleRow(c, "Map while browsing", c.print("{s} sites walked so far", .{fmt.count(fa, @floatFromInt(a.store.list(.sites).len))}), if (s) |x| x.map_while_browsing else true, s != null, a, "map_while_browsing", false);
    look.rule(c);
    {
        const it = look.item(c, "claim", "Collect usage", "Automatically, every minute");
        defer it.end();
        it.right();
        ui.text(c, if (a.chainUp()) "On" else "Waiting", .{ .size = 12.5, .color = look.x(c).text2 });
    }
}

/// An item with a switch; `inverted` saves the opposite (Serve agents is "not paused").
pub fn toggleRow(c: *ui.Context, t: []const u8, hint: []const u8, on: bool, enabled: bool, a: *App, setting: []const u8, inverted: bool) void {
    const it = look.item(c, t, t, hint);
    defer it.end();
    it.right();
    var v = on;
    const sw = ui.div(c).opacity(if (enabled) 1 else 0.45);
    defer sw.end();
    if (look.toggle(c, &v) and enabled and setting.len > 0) a.saveSetting(setting, .{ .bool = if (inverted) !v else v });
}
