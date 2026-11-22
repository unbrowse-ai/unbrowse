//! Browser: the node's site browsers, run with no window, shown here as a
//! live picture the owner can use. A click on the picture is a click at the
//! same point on the page; typed keys go to the page. For what only the
//! owner can do (sign in, a two-step code, a check that wants a person),
//! whether an agent asked for it or not. Agents' commands on the site wait
//! while the owner has the page, and never see what was typed.
const std = @import("std");
const builtin = @import("builtin");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const hands = @import("../hands.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;
const live_screen = @import("live.zig");

pub fn view(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    {
        const h = look.header(c, "Browser", "Your node's browsers, one for each site agents use. Click and type on the page to use it yourself: sign in, enter a code, pass a check. Agents wait while you have the page, and never see what you type.");
        h.end();
    }
    const list = a.store.get(.hands);
    const browsers: []const types.HandsBrowser = if (list) |l| l.browsers else &.{};
    pick(a, browsers);
    const site = a.hands_site.get();
    for (a.asks()) |k| if (std.mem.eql(u8, k.site, site)) askCard(a, c, k);
    if (a.pageless(site)) return;
    if (a.hands_offer.len > 0) offer(a, c);
    if (browsers.len > 1) tabs(a, c, browsers);
    const b: ?types.HandsBrowser = for (browsers) |b| {
        if (std.mem.eql(u8, b.site, site)) break b;
    } else null;
    if (b == null and site.len == 0) {
        const p = look.panel(c, "No browser open", "");
        look.panelBody(c);
        look.empty(c, "A site's browser opens when an agent browses it (unbrowse_browse). When a page needs you, the agent asks and it shows here.");
        p.end();
        return;
    }
    page(a, c, site, b orelse .{ .site = site });
    _ = x;
}

/// The site shown: the one already chosen while it's listed, else the one an agent asked about, else the first.
fn pick(a: *App, browsers: []const types.HandsBrowser) void {
    const cur = a.hands_site.get();
    if (cur.len > 0) {
        for (browsers) |b| if (std.mem.eql(u8, b.site, cur)) return;
        for (a.asks()) |k| if (std.mem.eql(u8, k.site, cur)) return;
    }
    const want: []const u8 = if (a.asks().len > 0) a.asks()[0].site else if (browsers.len > 0) browsers[0].site else return;
    a.watch(want);
}

fn askCard(a: *App, c: *ui.Context, k: types.HandsAsk) void {
    const x = look.x(c);
    const left: f64 = @max(0, @round(k.expires_at - a.now));
    c.frameIn(1);
    const card = ui.div(c).column().wFull().p(16).gap(10).rounded(12).bg(x.run.alpha(0.08)).border(x.run.alpha(0.35));
    defer card.end();
    if (k.pay) |p| return payCard(a, c, k, p, left);
    if (k.login) |l| return loginCard(a, c, k, l, left);
    ui.text(c, c.print("{s} asks you to {s}", .{ k.agent, k.why }), .{ .size = 14, .weight = .semibold, .wrap = true });
    look.small(c, c.print("Do it on the page below, then give it back. The agent waits {d}:{d:0>2} more; what you type stays on this machine and is never shown to it.", .{ @as(u64, @intFromFloat(@divFloor(left, 60))), @as(u64, @intFromFloat(@mod(left, 60))) }));
    const r = ui.div(c).row().gap(8);
    defer r.end();
    if (look.primary(c, "Done, give it back", .{ .size = .md })) a.giveBack(k.site, true);
    if (look.secondary(c, "Can't do it", .{ .size = .md })) a.giveBack(k.site, false);
}

/// A payment with a card from the vault, waiting on the owner. The node can't read what a checkout costs, so the
/// card says where to read it: on the page below, or, for a route call, in the values the call sends.
fn payCard(a: *App, c: *ui.Context, k: types.HandsAsk, p: types.HandsPay, left: f64) void {
    const m: u64 = @intFromFloat(@divFloor(left, 60));
    const s: u64 = @intFromFloat(@mod(left, 60));
    ui.text(c, c.print("{s} wants to pay with {s} on {s}", .{ k.agent, p.card, p.merchant }), .{ .size = 14, .weight = .semibold, .wrap = true });
    if (p.route.len > 0) {
        look.small(c, c.print("The call: {s}", .{p.route}));
        for (p.inputs) |i| look.small(c, i);
        look.small(c, c.print("The node can't read what this call costs: approve only if these values are what you mean to buy. This approval is for this one call. The agent waits {d}:{d:0>2} more and never sees the card.", .{ m, s }));
    } else {
        look.small(c, c.print("Check the amount on the page below before you approve. Approving lets the node fill this card on {s} for the next 10 minutes. The agent waits {d}:{d:0>2} more and never sees the card.", .{ p.merchant, m, s }));
    }
    const r = ui.div(c).row().gap(8);
    defer r.end();
    if (look.primary(c, "Approve payment", .{ .size = .md })) a.giveBack(k.site, true);
    if (look.secondary(c, "Decline", .{ .size = .md })) a.giveBack(k.site, false);
}

/// A login an agent asked for (`vault:ask:`): the vault's own Add login form takes the password, on this machine, and
/// the node types it into the page. The agent goes on once the vault holds it, holding only its reference.
fn loginCard(a: *App, c: *ui.Context, k: types.HandsAsk, l: types.HandsLogin, left: f64) void {
    const m: u64 = @intFromFloat(@divFloor(left, 60));
    const s: u64 = @intFromFloat(@mod(left, 60));
    ui.text(c, c.print("{s} needs your login for {s} on {s}", .{ k.agent, l.account, l.site }), .{ .size = 14, .weight = .semibold, .wrap = true });
    look.small(c, c.print("Type its password in the vault, not in the agent's chat. It stays on this machine; the node types it into the page below, and the agent only ever gets vault:{s}:{s}. The agent waits {d}:{d:0>2} more.", .{ l.site, l.account, m, s }));
    const r = ui.div(c).row().gap(8);
    defer r.end();
    if (look.primary(c, "Enter password", .{ .size = .md })) a.askedLogin(l.site, l.account);
    if (look.secondary(c, "Can't do it", .{ .size = .md })) a.giveBack(k.site, false);
}

fn offer(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    const site = a.hands_offer.get();
    const card = ui.div(c).row().wFull().p(12).gap(12).itemsCenter().rounded(10).bg(x.well);
    defer card.end();
    const words = ui.div(c).column().grow().minW(0).gap(2);
    ui.text(c, c.print("Keep this login for {s}?", .{site}), .{ .size = 13.5, .weight = .medium });
    look.small(c, "Saved in the vault, agents sign in by its reference next time, without asking you. The vault never shows them the password.");
    words.end();
    if (look.primary(c, "Save login", .{})) a.offerLogin(site);
    if (look.ghost(c, "Not now", .{})) a.hands_offer.len = 0;
}

fn tabs(a: *App, c: *ui.Context, browsers: []const types.HandsBrowser) void {
    const x = look.x(c);
    const r = ui.div(c).row().wFull().gap(6).itemsCenter();
    defer r.end();
    // Eight to a page: one browser per site agents use, which can be many.
    const shown = look.pageRowsBy(&a.browsers_page, browsers.len, browsers_per_page);
    for (browsers[shown.from..shown.to]) |b| {
        const on = std.mem.eql(u8, b.site, a.hands_site.get());
        ui.key(c, b.site);
        var chip = ui.div(c).row().px(10).h(28).gap(6).itemsCenter().rounded(7).control();
        chip = if (on) chip.bg(x.selected) else chip.hover(c.theme.surface_hover);
        defer chip.end();
        if (chip.clicked() and !on) a.watch(b.site);
        ui.text(c, b.site, .{ .size = 12.5, .weight = if (on) .semibold else .medium });
        if (b.held) look.chip(c, "yours", false);
    }
    if (look.pagesBy(browsers.len, browsers_per_page) > 1) {
        ui.spacer(c);
        ui.key(c, "browsers-pages");
        _ = nanoui.kit.pagination(c, &a.browsers_page, look.pagesBy(browsers.len, browsers_per_page));
    }
}

/// The browser tabs a row shows at a time.
const browsers_per_page = 8;

fn page(a: *App, c: *ui.Context, site: []const u8, b: types.HandsBrowser) void {
    const x = look.x(c);
    const pic = &a.hands_pic;
    const box = ui.div(c).column().wFull().bg(c.theme.surface).border(x.frame).rounded(12).clip();
    defer box.end();
    {
        const head = ui.div(c).row().wFull().px(16).h(44).gap(10).itemsCenter();
        defer head.end();
        ui.text(c, site, .{ .size = 14, .weight = .semibold });
        const words = ui.div(c).row().grow().minW(0);
        look.mono(c, b.url, x.text3);
        words.end();
        if (b.held) look.status(c, .running, "You have the page") else look.status(c, .idle, "Agents have the page");
        if (b.held) {
            var asked = false;
            for (a.asks()) |k| asked = asked or std.mem.eql(u8, k.site, site);
            if (!asked and look.secondary(c, "Give back", .{})) a.giveBack(site, true);
        }
    }
    look.rule(c);
    const body = ui.div(c).column().wFull().p(16).gap(10).itemsCenter();
    defer body.end();
    const tex = pic.texture() orelse {
        const empty = ui.div(c).wFull().h(320).rounded(8).bg(x.well).center().p(20);
        defer empty.end();
        ui.text(c, "Waiting for the page's picture.", .{ .size = 12.5, .color = x.text3 });
        return;
    };
    // As big as the sheet allows, at the page's own shape.
    const ratio: f32 = @as(f32, @floatFromInt(tex.height)) / @as(f32, @floatFromInt(@max(tex.width, 1)));
    const room_w = live_screen.contentW(c) - 32;
    const room_h = @max(240, c.size.h - 330);
    const w = @round(@min(room_w, room_h / ratio));
    const h = @round(w * ratio);
    const frame = ui.div(c).w(w).h(h).rounded(8).clip().control();
    const it = c.interact(frame.index, .{ .focusable = true });
    _ = frame.border(if (it.focused) x.run else x.hair);
    ui.texture(c, .{ .width = .{ .px = w }, .height = .{ .px = h }, .radius = 8 }, tex, .{ 0, 0, 1, 1 }, 1);
    frame.end();
    drive(a, c, site, it);
    const foot = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer foot.end();
    if (a.hands.err.len > 0) look.failText(c, a.hands.err.get()) else look.small(c, if (it.focused)
        "Typing goes to the page. Enter, Tab, Backspace and the arrows too; Command-V pastes."
    else
        "Click the page to use it. Your first click takes it from the agents until you give it back.");
}

/// What the owner does on the picture, passed on to the page.
fn drive(a: *App, c: *ui.Context, site: []const u8, it: ui.Interaction) void {
    const rect = it.rect orelse return;
    if (it.clicked) if (hands.fraction(rect, c.input.mouse)) |f| {
        a.hands.send("hands_input", .{ .site = site, .kind = "click", .x = f[0], .y = f[1], .clicks = @as(u32, if (c.input.click_count >= 2) 2 else 1) });
    };
    if (it.hovered) {
        c.wants_wheel = true;
        if (c.input.scroll.y != 0) if (hands.fraction(rect, c.input.mouse)) |f| {
            // The window's wheel moves the content with the finger; the page's takes a distance down.
            a.hands.send("hands_input", .{ .site = site, .kind = "scroll", .x = f[0], .y = f[1], .dy = -c.input.scroll.y * 2 });
        };
    }
    if (!it.focused) return;
    if (c.shortcut(.{ .key = 'v', .cmd = true })) paste(a, site);
    if (c.input.chars.len > 0) a.hands.send("hands_input", .{ .site = site, .kind = "text", .text = c.input.chars });
    if (c.input.key) |k| if (hands.keyName(k)) |name| a.hands.send("hands_input", .{ .site = site, .kind = "key", .key = name });
}

/// Command-V: the clipboard's text, typed into the page (a password from the owner's password manager).
fn paste(a: *App, site: []const u8) void {
    if (builtin.os.tag != .macos) return;
    const text = nanoui.clipboard.readText(a.gpa) catch return orelse return;
    defer {
        std.crypto.secureZero(u8, text);
        a.gpa.free(text);
    }
    for (text) |*ch| if (ch.* == '\n' or ch.* == '\r' or ch.* == '\t') {
        ch.* = ' ';
    };
    const one = std.mem.trim(u8, text, " ");
    if (one.len > 0 and one.len <= 4096) a.hands.send("hands_input", .{ .site = site, .kind = "text", .text = one });
}
