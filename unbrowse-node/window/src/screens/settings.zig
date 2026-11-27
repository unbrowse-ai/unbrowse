//! Settings: two columns per section, what it is on the left
//! and its controls on the right; in a narrow window, what it is above
//! its controls. Every control saves itself.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const App = @import("../app.zig").App;
const wallet = @import("wallet.zig");

pub fn view(a: *App, c: *ui.Context) void {
    const s = a.store.get(.settings) orelse {
        look.body(c, a.store.err(.settings) orelse "Loading settings…");
        return;
    };
    {
        const h = look.header(c, "Settings", "Changes save as you make them, to ~/.unbrowse/settings.json on this machine.");
        h.end();
    }
    const version = if (a.store.get(.node_info)) |i| i.version else "";
    // Two groups of four, by what a switch touches: the node's part in the network, then this computer.
    {
        const sec = section(c, "Agents and the network", "What your agents may do through this node, and what it does for other nodes and earns from them.");
        defer sec.end();
        toggle(a, c, "Paused", "Agents get a clear refusal while paused", s.paused, "paused");
        toggle(a, c, "Join the peer network", "On: the node joins as soon as it sees this. Off: your routes stay on this computer, from the node's next start; claims and staking on the chain go on.", s.peer_network, "peer_network");
        toggle(a, c, "Serve routes for others", c.print("Keeps up to {d} GB of other nodes' routes and serves them to the agents that ask for them. Serving pays no share of the fee.", .{@as(u64, @intFromFloat(s.storage_gb))}), s.hold_routes, "hold_routes");
        toggle(a, c, "Answer bounties for me", "The node takes the bounty steps, with your agent as the judge: it confirms your open bounty once your agent says an entry answers it and you agree, settles your bounties past their deadline, takes back what is yours, and releases by use the shares of entries you list.", s.bounty_auto, "bounty_auto");
    }
    look.rule(c);
    remote(a, c);
    look.rule(c);
    {
        const sec = section(c, "This computer", c.print("{s}, version {s}: how the node runs here and what its browser keeps.", .{ a.nodeName(), version }));
        defer sec.end();
        toggle(a, c, "Map while browsing", "Walks the node's browser makes can be kept as routes", s.map_while_browsing, "map_while_browsing");
        toggle(a, c, "Reach private networks", "Let calls follow a public name to an address inside this network, for an intranet. Off: such a name is refused.", s.private_network, "private_network");
        toggle(a, c, "Keep up to date", updates(a, c, s.auto_update), s.auto_update, "auto_update");
        App.seed(&a.port_field, &a.port_seen, c.print("{d}", .{s.api_port}));
        const f = kit.field(c, "Agent API port", .{ .hint = "Takes effect the next time the node starts." });
        const r = ui.div(c).row().gap(8).itemsCenter();
        const res = ui.textField(c, &a.port_field, .{ .width = .{ .px = 120 } });
        const p = std.fmt.parseInt(u16, std.mem.trim(u8, a.port_field.text(), " "), 10) catch 0;
        const ok = p > 1023 and p != s.api_port;
        if ((look.secondary(c, "Save port", .{ .disabled = !ok }) or (res.submitted and ok))) a.saveSetting("api_port", .{ .integer = p });
        r.end();
        f.end();
    }
    look.rule(c);
    sharing(a, c, s.share_routes, s.list_per_day);
    look.rule(c);
    paying(a, c, s.max_fetch_usdc);
    look.rule(c);
    cardCodes(a, c, s.keep_card_codes);
    look.rule(c);
    account(a, c);
    look.rule(c);
    security(a, c);
    look.rule(c);
    browser(a, c);
    look.rule(c);
    mapping(a, c, s);
    look.rule(c);
    {
        const sec = section(c, "This window", "What the window shows. The basic screens are Agents, Money, Vault and Settings, and the Browser when a site needs you.");
        defer sec.end();
        toggle(a, c, "Show advanced screens", "Adds the node's map, live walks, your routes, the full activity log and the leaderboard to the sidebar.", a.advanced(), "advanced");
    }
    // Advanced: launching the owner's entries' coins, which spends their UNB by itself.
    look.rule(c);
    {
        const r = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer r.end();
        if (look.ghost(c, if (a.settings_advanced) "Advanced  ▾" else "Advanced  ›", .{})) a.settings_advanced = !a.settings_advanced;
        look.small(c, "Launching your entries' coins, which spends your UNB by itself");
    }
    if (a.settings_advanced) devBuy(a, c, s.coin_dev_buy_bps);
}

/// This node's own remote MCP address (graph `gateway.relay-to-own`): on or off, the URL to copy, and the remote keys
/// that open it. The node dials out to the gateway, so nothing here opens a port, and only a remote key opens it.
fn remote(a: *App, c: *ui.Context) void {
    const sec = section(c, "Use this node from anywhere", "An MCP address for this node at unbrowse.ai, for agents that can only take a URL: a hosted chat, a phone, another computer. They use this node through it, browser and logins included. The node dials out, so no port opens here, and only a remote key you make opens it.");
    defer sec.end();
    const r = a.store.get(.remote_status) orelse return look.body(c, a.store.err(.remote_status) orelse "Reading…");
    if (r.public) return look.body(c, "This node is a public peer: it answers anyone at the gateway's /mcp, calls only. Set it up from its shell (`unbrowse-node remote public`).");
    {
        ui.key(c, "remote_on");
        const row = ui.div(c).row().wFull().gap(16).itemsStart();
        defer row.end();
        const w = ui.div(c).column().grow().gap(2);
        look.label(c, "Remote MCP address");
        look.small(c, if (r.on) "On: the running node stays attached to the gateway." else "Off: nothing reaches this node from outside this computer.");
        w.end();
        var v = r.on;
        if (look.toggle(c, &v)) a.store.actWith(.generic, "remote_set", "remote_set", .{ .on = v });
    }
    if (!r.on) return;
    if (r.url) |url| {
        // The address is long (a peer ID): it wraps in a box of its own, with its button under it, never pushed out.
        look.well(c, url);
        const row = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer row.end();
        if (look.secondary(c, "Copy address", .{})) {
            c.clipboard.write(c.clipboard.ctx, url);
            a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
        }
    }
    if (a.remote_token) |token| {
        look.label(c, "Your new remote key, shown once");
        look.well(c, token);
        if (a.remote_claude) |line| look.small(c, line);
        const row = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer row.end();
        if (look.secondary(c, "Copy key", .{})) {
            c.clipboard.write(c.clipboard.ctx, token);
            a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
        }
        if (a.remote_claude) |line| if (look.secondary(c, "Copy Claude Code line", .{})) {
            c.clipboard.write(c.clipboard.ctx, line);
            a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
        };
        if (look.ghost(c, "Done, hide it", .{})) a.wipeRemoteKey();
    }
    look.small(c, c.print("{d} remote key{s}. Each opens this node only through the gateway, spends up to 5 USDC a day and lasts 30 days.", .{ r.keys.len, if (r.keys.len == 1) "" else "s" }));
    const row = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer row.end();
    if (look.primary(c, "Make a remote key", .{ .loading = a.store.isBusy("remote_key_create") })) a.store.actWith(.remote_key, "remote_key_create", "remote_key_create", .{ .name = "Remote agents" });
    if (r.keys.len > 0 and look.danger(c, "Revoke all remote keys", .{ .loading = a.store.isBusy("remote_revoke") })) a.store.act(.generic, "remote_revoke", "remote_revoke", "{}");
}

/// A linked wallet, which is optional: signed in with email or Google in the browser, linked to this node by one
/// signature. The node needs none: it is on the network with its own wallet (spec §86).
fn account(a: *App, c: *ui.Context) void {
    const sec = section(c, "Your account", "Your node needs no account to run. Sign in with email or Google in your browser and it earns under your account, and withdrawals go there. This node keeps only the signature that links them.");
    defer sec.end();
    const l = a.store.get(.link_status) orelse return look.body(c, "Reading…");
    if (l.owner) |owner| {
        {
            const r = ui.div(c).row().wFull().gap(8).itemsCenter();
            defer r.end();
            look.label(c, "Signed in");
            look.mono(c, c.print("Account {s}", .{@import("../fmt.zig").short(c.alloc(), owner)}), null);
            ui.spacer(c);
            if (look.secondary(c, "Sign out", .{ .loading = a.store.isBusy("unlink") })) a.store.act(.generic, "unlink", "unlink", "{}");
        }
        look.small(c, "Your node lists and earns under this account. Every listing waits for you to approve it, under Money: nothing is shared until you do.");
    } else wallet.signIn(a, c);
}

/// Security: the node's backup key, folded away until the owner opens it.
fn security(a: *App, c: *ui.Context) void {
    const sec = section(c, "Security", "Your node's backup key brings it back on a new computer with everything on it: its balance, earnings and agents. Keep it off this computer.");
    defer sec.end();
    if (look.ghost(c, if (a.security_open) "Backup key  ▾" else "Backup key  ›", .{})) a.security_open = !a.security_open;
    if (a.security_open) wallet.recovery(a, c);
}

/// Sites the node never learns from.
fn mapping(a: *App, c: *ui.Context, s: anytype) void {
    const sec = section(c, "Mapping", "Sites your node never learns from: a walk there is refused before the browser opens.");
    defer sec.end();
    {
        const box = ui.div(c).column().wFull().bg(c.theme.surface).rounded(10).border(look.x(c).frame).clip();
        defer box.end();
        if (s.excluded.len == 0) {
            const d = ui.div(c).p(12);
            defer d.end();
            look.body(c, "No sites excluded.");
        }
        for (s.excluded, 0..) |h, i| {
            if (i > 0) look.rule(c);
            ui.key(c, h);
            const r = ui.div(c).row().wFull().px(12).py(8).itemsCenter();
            defer r.end();
            look.label(c, h);
            ui.spacer(c);
            if (look.ghost(c, c.print("Remove {s}", .{h}), .{})) setExcluded(a, s.excluded, null, h);
        }
    }
    const f = kit.field(c, "Exclude a site", .{});
    defer f.end();
    const r = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer r.end();
    const res = ui.textField(c, &a.exclude, .{ .width = .fill, .placeholder = "www.ocbc.com" });
    const host = hostOf(c, a.exclude.text());
    if ((look.secondary(c, "Exclude", .{ .disabled = host.len == 0, .size = .md }) or res.submitted) and host.len > 0) {
        setExcluded(a, s.excluded, host, null);
        a.exclude.clear();
    }
}

/// What each sharing mode does, in a line.
pub fn shareHint(mode: []const u8) []const u8 {
    if (std.mem.eql(u8, mode, "all")) return "Lists every route you learn, once it has run successfully.";
    if (std.mem.eql(u8, mode, "off")) return "Lists nothing by itself. What is listed stays listed until you delist it.";
    return "Lists the routes your agents keep using, so listing costs stay small.";
}

/// Share routes I learn: which routes the node lists by itself, and delisting them all.
fn sharing(a: *App, c: *ui.Context, mode: []const u8, per_day: ?f64) void {
    const sec = section(c, "Share routes I learn", "Other nodes fetch a route you list and pay its fee; your agents' sessions never go with it. Listing costs you nothing: the node signs each listing, and the first payment for it puts it on the chain. It shares a bounded number a day.");
    defer sec.end();
    {
        const r = ui.div(c).row().gap(4).itemsCenter();
        defer r.end();
        for ([_][2][]const u8{ .{ "used", "Used" }, .{ "all", "All" }, .{ "off", "Off" } }) |m| {
            ui.key(c, m[0]);
            const on = std.mem.eql(u8, mode, m[0]);
            const pressed = if (on) look.primary(c, m[1], .{}) else look.secondary(c, m[1], .{});
            if (pressed and !on) {
                a.saveSetting("share_routes", .{ .string = m[0] });
            }
        }
    }
    const day: f64 = per_day orelse if (std.mem.eql(u8, mode, "all")) 20 else if (std.mem.eql(u8, mode, "off")) 0 else 5;
    look.small(c, if (std.mem.eql(u8, mode, "off")) shareHint(mode) else c.print("{s} At most {d} a day.", .{ shareHint(mode), @as(u64, @intFromFloat(day)) }));
    const r = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer r.end();
    if (look.secondary(c, "Delist every route", .{ .loading = a.store.isBusy("delist_all") })) a.store.act(.generic, "delist_all", "delist_all", "{}");
    // The note takes what is left beside the button and wraps in it.
    const note = ui.div(c).grow().minW(0);
    defer note.end();
    look.small(c, "Turning sharing off delists nothing; this does, and keeps each off until you share it again.");
}

/// The most the node pays to fetch one route another contributor lists. Agents spend up to it on their own: nothing
/// waits on the owner, and a route that costs more is passed over.
fn paying(a: *App, c: *ui.Context, max: f64) void {
    const sec = section(c, "Paying for routes", "Agents never wait for you. When another contributor's route does what an agent asks, the node fetches it and pays its fee itself, once; a route that costs more than this is passed over as if it weren't offered.");
    defer sec.end();
    App.seed(&a.max_fetch_field, &a.max_fetch_seen, c.print("{d}", .{max}));
    const f = kit.field(c, "Most the node pays to fetch one route, $", .{ .hint = "The most your node pays to fetch one route; 0 uses only free and your own routes" });
    defer f.end();
    const r = ui.div(c).row().gap(8).itemsCenter();
    defer r.end();
    const res = ui.textField(c, &a.max_fetch_field, .{ .width = .{ .px = 120 } });
    const n = maxFetch(a.max_fetch_field.text());
    const ok = if (n) |v| v != max else false;
    if ((look.secondary(c, "Save maximum", .{ .disabled = !ok }) or (res.submitted and ok))) a.saveSetting("max_fetch_usdc", .{ .float = n.? });
}

/// Keep card security codes (#185): off by default, as card rules ask. It goes through its own command, never a
/// settings save: turning it on asks the owner in the node's own dialog, and turning it off forgets every kept code.
/// What keeping them costs is said beside the button, on or off.
fn cardCodes(a: *App, c: *ui.Context, on: bool) void {
    const sec = section(c, "Card security codes", "Agents fill your cards from the vault and never see them. A checkout that asks for the card's security code waits for you to type it on the page, unless the vault keeps it.");
    defer sec.end();
    look.label(c, "Keep card security codes");
    look.status(c, if (on) .warn else .idle, if (on) "On: the vault keeps each card's code, added from now on, and agents pay with it without you, within your card limits." else "Off: the vault keeps no code, and you type it at each checkout.");
    look.small(c, codesCost);
    const label = if (on) "Forget every code and stop keeping them" else "Keep the codes";
    if (look.secondary(c, label, .{ .loading = a.store.isBusy("keep_card_codes") })) a.store.actWith(.generic, "keep_card_codes", "keep_card_codes", .{ .on = !on });
}

/// What keeping card security codes costs (the node's `vault::KEEPING_CODES_COSTS`).
pub const codesCost = "Card rules (PCI DSS) forbid keeping a card's security code after a payment is authorised, even encrypted. On, the vault keeps it beside the card so agents can pay where a checkout asks for it without you; off, you type it at each checkout.";

/// The listing's first buy (`coin_dev_buy`): the share of the owner's UNB the node launches the route coin of each entry
/// newly credited to the wallet with, and stakes for the owner. On at 1% by default (the owner's decision,
/// `decide.dev-buy-default-on`); typed and shown as a percent, kept by the node in basis points. Raising it past the
/// default is asked in the node's own dialog, so it goes through its own command, never a settings save.
fn devBuy(a: *App, c: *ui.Context, bps: u32) void {
    const sec = section(c, "Launch my entries' coins", "Each entry you list can have its own route coin. Once it is launched, the entry's share of each paid fetch pays whoever stakes the coin; until then that share is yours. A first buy launches the coin and makes you its first holder.");
    defer sec.end();
    const pct = @as(f64, @floatFromInt(bps)) / 100;
    App.seed(&a.dev_buy_field, &a.dev_buy_seen, c.print("{d}", .{pct}));
    look.status(c, if (bps > 0) .ok else .idle, if (bps > 0) c.print("On: for each entry newly credited to you, the node launches its coin with a first buy of {d}% of the UNB your wallet holds then, and stakes the coins for you, by itself.", .{pct}) else "Off: the node launches no coin by itself.");
    look.small(c, devBuySaid);
    const f = kit.field(c, "First buy when launching my entries' coins, % of your UNB", .{ .hint = "1, the default; 0 launches none." });
    defer f.end();
    const r = ui.div(c).row().gap(8).itemsCenter();
    defer r.end();
    const res = ui.textField(c, &a.dev_buy_field, .{ .width = .{ .px = 120 } });
    const n = sharePct(a.dev_buy_field.text());
    const ok = if (n) |v| v != bps else false;
    if ((look.secondary(c, "Save first buy", .{ .disabled = !ok, .loading = a.store.isBusy("coin_dev_buy") }) or (res.submitted and ok)))
        a.store.actWith(.generic, "coin_dev_buy", "coin_dev_buy", .{ .bps = n.? });
}

/// What the first buy does, said beside it.
pub const devBuySaid = "The node spends that share of your UNB by itself, once for each entry newly credited to you, and stakes the coins it buys for you. With no UNB in the wallet it launches nothing, and the route still lists. Raising it past 1% asks you first.";

/// A share the owner typed as a percent, 0 to 100, in basis points; anything else is none.
pub fn sharePct(text: []const u8) ?u32 {
    const v = std.fmt.parseFloat(f64, std.mem.trim(u8, text, " \t%")) catch return null;
    if (!std.math.isFinite(v) or v < 0 or v > 100) return null;
    return @intFromFloat(@round(v * 100));
}

/// A per-fetch maximum the owner typed: a sum of USDC, zero or more; anything else is none.
pub fn maxFetch(text: []const u8) ?f64 {
    const v = std.fmt.parseFloat(f64, std.mem.trim(u8, text, " \t")) catch return null;
    return if (std.math.isFinite(v) and v >= 0) v else null;
}

/// The browser the node walks and browses in: the Chromium browsers on this Mac, and Chrome for Testing to download.
fn browser(a: *App, c: *ui.Context) void {
    const sec = section(c, "Browser", "The browser the node walks and browses in. Any Chromium browser works: Chrome, Brave, Edge, Arc, Vivaldi. Safari and Firefox can't be driven the way the node records. A new choice applies to the next browser the node starts.");
    defer sec.end();
    const v = a.store.get(.browsers) orelse return look.body(c, a.store.err(.browsers) orelse "Looking for browsers…");
    const busy = a.store.anyBusy();
    if (v.using == null and !v.downloading) look.status(c, .fail, "No browser: agents can't browse until you install Chrome or download Chrome for Testing");
    var has_download = false;
    if (v.found.len > 0) {
        const box = ui.div(c).column().wFull().bg(c.theme.surface).rounded(10).border(look.x(c).frame).clip();
        defer box.end();
        for (v.found, 0..) |f, i| {
            has_download = has_download or f.downloaded;
            if (i > 0) look.rule(c);
            ui.key(c, f.path);
            const r = ui.div(c).row().wFull().px(12).py(8).gap(12).itemsCenter();
            defer r.end();
            {
                const w = ui.div(c).column().grow().minW(0).gap(2);
                defer w.end();
                look.label(c, f.name);
                ui.text(c, f.path, .{ .size = 12, .mono = true, .color = look.x(c).text2, .wrap = true });
            }
            if (same(v.using, f.path)) {
                look.status(c, .ok, if (same(v.chosen, f.path)) "In use, your choice" else "In use");
            } else if (look.secondary(c, c.print("Use {s}", .{f.name}), .{ .size = .xs, .disabled = busy })) {
                a.store.actWith(.generic, "choose", "choose_browser", .{ .path = f.path });
            }
        }
    }
    {
        const r = ui.div(c).row().gap(8).itemsCenter();
        defer r.end();
        if (v.chosen != null and look.ghost(c, "Let the node pick", .{ .size = .sm, .disabled = busy }))
            a.store.actWith(.generic, "choose", "choose_browser", .{ .path = @as(?[]const u8, null) });
        if (v.downloading) {
            look.status(c, .running, "Downloading Chrome for Testing");
        } else if (!has_download and look.secondary(c, "Download Chrome for Testing", .{ .disabled = busy })) {
            a.store.act(.generic, "download", "download_browser", "{}");
        }
    }
    if (v.download_error) |e| look.status(c, .fail, c.print("The download failed: {s}", .{e}));
}

/// Where updates stand, in a line: what the node runs, what it's waiting to run, and what the network takes.
fn updates(a: *App, c: *ui.Context, on: bool) []const u8 {
    const u = a.store.get(.update_status) orelse return "New releases are fetched, checked against Unbrowse's signature and run once no call is under way.";
    if (u.outdated) return c.print("Version {s} is older than the network takes ({s}): the node stays off it until it updates.", .{ u.running, u.min_version orelse "" });
    if (!on) return c.print("Off: the node stays at version {s}.", .{u.running});
    if (!u.enabled) return c.print("Version {s} was built from source, so it doesn't update itself.", .{u.running});
    if (u.ready) |v| return c.print("Version {s} is ready: the node restarts into it once no call is running.", .{v});
    if (u.checking) return "Checking for a newer release…";
    if (u.@"error") |e| return c.print("The last check failed: {s}", .{e});
    if (u.latest) |v| if (!same(u.latest, u.running)) return c.print("Running {s}; {s} is the latest.", .{ u.running, v });
    return c.print("Up to date: version {s}. New releases are checked against Unbrowse's signature before they run.", .{u.running});
}

fn same(a: ?[]const u8, b: []const u8) bool {
    return if (a) |s| std.mem.eql(u8, s, b) else false;
}

/// "https://www.ocbc.com/x" → "www.ocbc.com".
pub fn hostOf(c: *ui.Context, v: []const u8) []const u8 {
    var s = std.mem.trim(u8, v, " \t");
    for ([_][]const u8{ "https://", "http://" }) |p| if (std.ascii.startsWithIgnoreCase(s, p)) {
        s = s[p.len..];
    };
    const end = std.mem.indexOfScalar(u8, s, '/') orelse s.len;
    return std.ascii.allocLowerString(c.alloc(), s[0..end]) catch "";
}

fn setExcluded(a: *App, now: []const []const u8, add: ?[]const u8, remove: ?[]const u8) void {
    var arena: std.heap.ArenaAllocator = .init(a.gpa);
    defer arena.deinit();
    var arr: std.json.Array = .init(arena.allocator());
    for (now) |h| if (remove == null or !std.mem.eql(u8, h, remove.?)) arr.append(.{ .string = h }) catch {};
    if (add) |h| arr.append(.{ .string = h }) catch {};
    a.saveSetting("excluded", .{ .array = arr });
}

fn section(c: *ui.Context, t: []const u8, description: []const u8) Section {
    // Side by side when the window has room; narrower, what it is above its controls, so neither is squeezed.
    const side = look.tableWidth(c) >= 760;
    const r = if (side) ui.div(c).row().wFull().gap(32).py(12).itemsStart() else ui.div(c).column().wFull().gap(12).py(12);
    {
        const l = if (side) ui.div(c).column().w(300).gap(4) else ui.div(c).column().wFull().gap(4);
        defer l.end();
        ui.text(c, t, .{ .size = 15, .weight = .semibold });
        look.body(c, description);
    }
    const controls = ui.div(c).column().grow().minW(0).gap(16).p(16).rounded(12).bg(look.x(c).well);
    if (!side) _ = controls.wFull();
    return .{ .c = c, .row = r };
}

/// A section's open boxes: `end` closes its controls' box, then the row.
const Section = struct {
    c: *ui.Context,
    row: ui.Div,
    fn end(s: Section) void {
        s.c.end();
        s.row.end();
    }
};

fn toggle(a: *App, c: *ui.Context, t: []const u8, hint: []const u8, on: bool, key: []const u8) void {
    ui.key(c, key);
    const r = ui.div(c).row().wFull().gap(16).itemsStart();
    defer r.end();
    const w = ui.div(c).column().grow().gap(2);
    look.label(c, t);
    look.small(c, hint);
    w.end();
    var v = on;
    if (look.toggle(c, &v)) a.saveSetting(key, .{ .bool = v });
}
