//! The frame every screen sits in: the sidebar with
//! the areas and the node's card, the top bar with where you are and the
//! chain, and the white sheet the work sits on. No agent's call waits on the
//! owner: the node pays a route's fee itself, up to the owner's maximum.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("look.zig");
const art = @import("art.zig");
const app_mod = @import("app.zig");
const App = app_mod.App;

const overview = @import("screens/overview.zig");
const routes = @import("screens/routes.zig");
const activity = @import("screens/activity.zig");
const access = @import("screens/access.zig");
const wallet = @import("screens/wallet.zig");
const vault = @import("screens/vault.zig");
const links = @import("screens/links.zig");
const settings = @import("screens/settings.zig");
const board = @import("screens/board.zig");
const live_screen = @import("screens/live.zig");
const hands_screen = @import("screens/hands.zig");
const onboarding = @import("screens/onboarding.zig");
const move_to_apps = @import("screens/move_to_apps.zig");

/// What stands in front of the normal screens, in the order it is asked: the move to Applications while the window runs
/// from a disk image, then setting up (screens/onboarding.zig): Welcome (a new node only), the terms, signing in (a new
/// node only, skippable), the AI apps and ChatGPT and Claude until they have been through, and You're set.
pub const Front = enum { none, move, welcome, terms, sign_in, connect, done };

pub fn front(a: *App) Front {
    if (a.mustMove() != null) return .move;
    a.noteNewNode();
    if (a.termsDue()) return if (a.welcomeDue()) .welcome else .terms;
    if (a.signInDue()) return .sign_in;
    if (a.connectDue()) return .connect;
    if (a.finish_due) return .done;
    return .none;
}

pub fn view(a: *App, c: *ui.Context) void {
    look.apply(c);
    look.newFrame();
    if (a.io) |io| {
        const t = std.Io.Clock.real.now(io);
        a.now = @floatFromInt(t.toSeconds());
        a.now_ms = @floatFromInt(t.toMilliseconds());
    }
    const stands = front(a);
    if (stands != .none) {
        switch (stands) {
            .move => move_to_apps.view(a, c),
            .welcome => onboarding.view(a, c, .welcome),
            .terms => onboarding.view(a, c, .terms),
            .sign_in => onboarding.view(a, c, .sign_in),
            .connect => onboarding.view(a, c, if (a.connect_step > 0) .web else .apps),
            .done => onboarding.view(a, c, .done),
            .none => {},
        }
        a.toaster.view(c);
        return;
    }
    shortcuts(a, c);
    const x = look.x(c);
    const root = ui.div(c).row().sizeFull().bg(x.canvas);
    {
        defer root.end();
        sidebar(a, c);
        const main = ui.div(c).column().grow().hFull().minW(0);
        defer main.end();
        topbar(a, c);
        const sheet = ui.div(c).column().grow().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(10).clip();
        defer sheet.end();
        // Activity scrolls its own list, and Browser's wheel goes to the page it shows; the rest scroll the page.
        if (a.screen == .activity or a.screen == .hands) {
            const page = ui.div(c).column().sizeFull().px(28).pt(24).gap(18);
            defer page.end();
            banners(a, c);
            if (a.screen == .activity) activity.view(a, c) else hands_screen.view(a, c);
        } else {
            // Keyed by the screen, so each screen's boxes are its own: a screen opened rises in whole, never taking the
            // place of one the screen before had at the same spot in its layout (`look.rise`).
            ui.key(c, @tagName(a.screen));
            const sc = ui.div(c).column().sizeFull().scrollY().px(28).py(24).gap(18);
            defer sc.end();
            banners(a, c);
            switch (a.screen) {
                .node => overview.view(a, c),
                .live => live_screen.view(a, c),
                .routes => routes.view(a, c),
                .wallet => wallet.view(a, c),
                .vault => vault.view(a, c),
                .access => access.view(a, c),
                .board => board.view(a, c),
                .settings => settings.view(a, c),
                .activity, .hands => {},
            }
        }
    }
    a.showWaitingSetup();
    routes.dialogs(a, c);
    wallet.dialogs(a, c);
    vault.dialogs(a, c);
    links.dialogs(a, c);
    a.toaster.view(c);
}

/// How far Uni rises this frame, on the film's clock: twelve drawings a second, as its linework moves. It hops while
/// an agent waits on the owner and when something is copied, breathes while the node is busy, and stands still at
/// rest, so an open window draws nothing when nothing happens.
fn uniLift(a: *App, c: *ui.Context, waiting: bool, cheering: bool) f32 {
    if (c.reduced_motion or a.io == null) return 0;
    const t = @floor(a.now_ms / 1000 * 12) / 12;
    if (cheering or waiting) {
        c.frameIn(1.0 / 12.0);
        // A hop of 0.38 s, every 2 s while waiting, once for a cheer: up 10 points and down, a parabola.
        const since = if (cheering) (a.now_ms - a.cheer_ms) / 1000 else @mod(t, 2.0);
        if (since >= 0.38) return 0;
        const u: f32 = @floatCast(since / 0.38);
        return -40 * u * (1 - u);
    }
    if (a.busy()) {
        c.frameIn(1.0 / 12.0);
        return @floatCast(-2 + 2 * @cos(t * std.math.pi * 2 / 5));
    }
    return 0;
}

/// The keys a developer reaches for: Command (Control off a Mac) with 1 to 9 and 0 for the screens in the sidebar's
/// order, F to find a route, R to read everything again. An open dialog keeps the keys to itself.
fn shortcuts(a: *App, c: *ui.Context) void {
    if (a.dialog_open) return;
    for (0..app_mod.screen_labels.len) |i| {
        if (c.shortcut(.{ .key = screenKey(i), .cmd = true })) a.go(@enumFromInt(i));
    }
    if (c.shortcut(.{ .key = 'f', .cmd = true })) {
        a.go(.routes);
        a.routes_find = true;
    }
    if (c.shortcut(.{ .key = 'r', .cmd = true })) a.refresh();
}

/// The digit that opens the `i`th screen: 1 to 9, then 0.
fn screenKey(i: usize) u21 {
    return if (i == 9) '0' else @intCast('1' + i);
}

fn sidebar(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    const side = ui.div(c).column().w(216).hFull().pt(46).px(12).pb(16).gap(2);
    defer side.end();
    {
        const brand = ui.div(c).row().gap(8).itemsCenter().px(8).pb(18);
        defer brand.end();
        art.mark(c, 24);
        ui.text(c, "Unbrowse", .{ .size = 17, .weight = .semibold });
    }
    for (app_mod.screen_labels, 0..) |label, i| {
        const s: app_mod.Screen = @enumFromInt(i);
        if (!a.listed(s)) continue;
        const on = a.screen == s;
        ui.key(c, label);
        var item = ui.div(c).row().wFull().h(32).px(8).gap(8).itemsCenter().rounded(7).control();
        item = if (on) item.bg(x.selected) else item.hover(c.theme.surface_hover);
        defer item.end();
        if (item.clicked()) a.go(s);
        ui.text(c, label, .{ .size = 13.5, .weight = if (on) .semibold else .medium, .color = if (on) c.theme.text else x.text2 });
        ui.spacer(c);
        // Its shortcut, while the pointer is on it: there when looked for, quiet otherwise.
        if (item.hovered()) ui.text(c, c.print("{s}{u}", .{ if (@import("builtin").os.tag == .macos) "\u{2318}" else "Ctrl+", screenKey(i) }), .{ .size = 11.5, .color = x.text3 });
        if (s == .hands and a.asks().len > 0) look.chip(c, c.print("{d}", .{a.asks().len}), true);
        // Something started while Live was closed: a quiet dot, no motion.
        if (s == .live and !on and a.live_news) {
            const dot = ui.div(c).w(7).h(7).roundedFull().bg(x.run);
            dot.end();
        }
    }
    // The basic screens: the rest one click away, and Settings turns them off again.
    if (!a.advanced()) {
        ui.key(c, "more-screens");
        if (look.ghost(c, "More screens", .{ .size = .sm })) a.saveSetting("advanced", .{ .bool = true });
    }
    ui.spacer(c);
    // The node's card: Uni showing what the node is doing, then the state in a word, its name, its version.
    const card = ui.div(c).row().wFull().px(8).gap(12).itemsEnd();
    defer card.end();
    // An agent waiting on the owner surprises Uni, and its word is one click to the page.
    const waiting = a.asks().len > 0;
    const cheering = a.now_ms - a.cheer_ms < 1400;
    const mood: art.Mood = if (cheering) .happy else if (waiting) .surprised else if (a.paused()) .sleepy else if (a.store.conn == .down or a.chainError() != null) .nervous else .neutral;
    {
        const u = ui.div(c).offset(0, uniLift(a, c, waiting, cheering));
        defer u.end();
        art.uni(c, mood, 56);
    }
    const words = ui.div(c).column().grow().minW(0).gap(3).pb(4);
    defer words.end();
    if (waiting) {
        const w = ui.div(c).control();
        ui.text(c, "Waiting on you", .{ .size = 13, .weight = .medium, .color = x.run });
        if (w.clicked()) a.show(a.asks()[0].site);
        w.end();
    } else ui.text(c, a.stateWord(), .{ .size = 13, .weight = .medium });
    look.mono(c, a.nodeName(), null);
    // The wallet's address is the advanced screens'; Money names it.
    if (a.advanced()) wallet.shortAddress(a, c);
    const version = if (a.store.get(.node_info)) |i| i.version else "";
    if (version.len > 0) ui.text(c, c.print("Version {s}", .{version}), .{ .size = 11.5, .color = x.text3 });
}

fn topbar(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    const bar = ui.div(c).row().wFull().h(48).pt(4).pr(12).gap(8).itemsCenter();
    defer bar.end();
    ui.text(c, a.nodeName(), .{ .size = 13, .color = x.text3 });
    ui.text(c, "/", .{ .size = 13, .color = x.text3 });
    ui.text(c, app_mod.screen_labels[@intFromEnum(a.screen)], .{ .size = 13, .weight = .medium });
    ui.spacer(c);
    // What the node can spend, on every screen, and the way to raise it: one control, as Money's Add funds.
    if (a.store.get(.money)) |m| {
        if (look.creditBadge(c, c.print("${s}", .{m.balance}), m.add_funds_url != null)) a.store.act(.generic, "add", "add_funds", "{}");
    }
    if (a.paymentsWord()) |word| look.chip(c, word, a.chainError() != null);
    // An agent waits on the owner for a page, or the owner holds one: one click to it from anywhere.
    if (a.screen != .hands) {
        const asks = a.asks();
        if (asks.len > 0) {
            if (look.primary(c, c.print("{s} needs you on {s}", .{ asks[0].agent, asks[0].site }), .{})) a.show(asks[0].site);
        } else if (a.holding()) |site| {
            if (look.secondary(c, c.print("You have {s}'s page", .{site}), .{})) a.show(site);
        }
    }
}

fn banners(a: *App, c: *ui.Context) void {
    if (a.store.conn == .down) {
        const found = if (a.store.net) |n| n.found.load(.acquire) else false;
        const how = if (found) "This window found the node already running, so it waits for it to come back rather than start a second one" else "The window started unbrowse-node and keeps trying";
        _ = kit.alert(c, .{ .status = .warning, .title = "Unbrowse isn't answering on this Mac", .description = c.print("Nothing answers on 127.0.0.1:{d}. {s}; agents need it running.", .{ a.port(), how }) });
    } else if (a.store.keychain) {
        _ = kit.alert(c, .{ .status = .info, .title = "Waiting for Keychain access: allow Unbrowse in the macOS dialog.", .description = "The node needs its key for the wallet, agent keys and passwords. Routes, activity and settings work meanwhile." });
    }
    // The last action's failure, on whichever screen pressed it. A dialog shows its own.
    if (a.err.len > 0 and !a.dialog_open) look.failText(c, a.err.get());
}
