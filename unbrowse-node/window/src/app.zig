//! The window's state: what the store holds of the node, which screen is
//! open, the dialogs and their fields, and what arrives live. The node's
//! answers and events land here through the store's hooks, on the main
//! thread, and each asks for one frame.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const types = @import("types.zig");
const store_mod = @import("store.zig");
const live = @import("live.zig");
const burst_mod = @import("burst.zig");
const picture_mod = @import("picture.zig");
const hands_mod = @import("hands.zig");
const move_to_apps = @import("screens/move_to_apps.zig");
const Res = types.Res;

/// The window opens on Agents (screens/access.zig): connecting an agent, on this Mac or on the web, is the first thing an
/// owner does and the thing they come back to.
pub const Screen = enum { access, node, live, hands, routes, wallet, vault, activity, board, settings };
pub const screen_labels = [_][]const u8{ "Agents", "Node", "Live", "Browser", "My routes", "Money", "Vault", "Activity", "Leaderboard", "Settings" };

pub const Dialog = enum { none, run_route, list_route, delete_route, move, new_key, revoke, add_login, remove_login, rotate_login, forget_session, open_link, card_limit, add_card, remove_card, pricing, code_key, restore_key, import_logins, import_session };
pub const Move = enum { faucet, deposit, withdraw };

pub const Text = live.Text;

pub const Run = struct { ok: bool, ms: f64, text: []u8, err: []u8 };

/// What a cash-out did. The node answers the transactions it sent (`collect_earnings`): none when nothing was waiting.
pub fn cashedOut(answer: []const u8) []const u8 {
    const ws = " \t\r\n";
    const t = std.mem.trim(u8, answer, ws);
    const none = t.len >= 2 and t[0] == '[' and t[t.len - 1] == ']' and std.mem.trim(u8, t[1 .. t.len - 1], ws).len == 0;
    return if (none) "Nothing was waiting to cash out." else "Sent.";
}

pub const App = struct {
    gpa: std.mem.Allocator,
    io: ?std.Io,
    store: store_mod.Store,
    window: ?*nanoui.Window = null,
    screen: Screen = .access,
    /// The city's width last frame, in points: it is drawn to it (screens/city.zig).
    city_width: f32 = 720,
    /// Wall-clock seconds, read at the top of each frame.
    now: f64 = 0,
    /// The same in milliseconds, for the Live screen's lanes.
    now_ms: f64 = 0,
    eye: live.Eye,
    calls: live.Calls = .{},
    /// The calls running at once, for the Live screen.
    burst: burst_mod.Burst = .{},
    /// The latest picture of the browser's walk.
    picture: picture_mod.Picture,
    /// Something started while the Live screen was closed: its sidebar item says so.
    live_news: bool = false,
    /// The site whose browser the Browser screen shows, its latest picture, and what the owner does on it.
    hands_site: Text = .{},
    hands_pic: picture_mod.Picture,
    hands: hands_mod.Sender,
    /// The owner gave a page back that they signed in on: the screen offers to keep the login in the vault.
    hands_offer: Text = .{},
    toaster: kit.Toaster,

    dialog: Dialog = .none,
    dialog_open: bool = false,
    /// What the dialog acts on: a route's id, a site and account, a host.
    target: Text = .{},
    target2: Text = .{},
    index: u32 = 0,
    move: Move = .faucet,
    /// The pricing dialog's auto mode, until it is saved.
    auto_fee: bool = false,
    /// The dialog's fields, reused by each dialog.
    fields: [6]ui.TextBuffer = @splat(.{}),
    login_kind: usize = 0,
    /// The last action's error, shown where it was asked for.
    err: Text = .{},
    run: ?Run = null,
    /// Shown once, then wiped: an agent key's setup string.
    setup: ?[]u8 = null,
    /// A setup string that arrived while another dialog was open: shown as soon as that one closes.
    setup_waiting: bool = false,
    /// A remote key's token and the line that adds it to Claude Code, shown once after it is made; wiped on hide.
    remote_token: ?[]u8 = null,
    remote_claude: ?[]u8 = null,
    /// A revealed password and whose it is ("site|account"); wiped on hide.
    revealed: ?[]u8 = null,
    revealed_key: Text = .{},
    /// The recovery phrase while it is shown; wiped on hide, on leaving the screen, and with every dialog's close.
    phrase: ?[]u8 = null,
    /// What the last password import did, as the node answered (counts only, no passwords).
    imported: ?[]u8 = null,
    /// What the link being shown names, as the node answered.
    link: ?[]u8 = null,

    activity_tab: usize = 0,
    /// My routes: what the owner searches them for, and the page of what it finds shown, from 0.
    routes_query: ui.TextBuffer = .{},
    routes_page: usize = 0,
    /// The page Activity, the needs on Overview, the leaderboard, the route entries and the browser tabs show, from 0
    /// (`look.pageRowsBy`).
    activity_page: usize = 0,
    needs_page: usize = 0,
    contributors_page: usize = 0,
    entries_page: usize = 0,
    browsers_page: usize = 0,
    /// Command-F was pressed: the search takes the keys when it is next drawn.
    routes_find: bool = false,
    /// Vault: what the owner searches the logins for, and the page shown of the logins it finds and of the sessions.
    logins_query: ui.TextBuffer = .{},
    logins_page: usize = 0,
    sessions_page: usize = 0,
    /// Vault: the page shown of the cards.
    cards_page: usize = 0,
    /// When something was copied (ms): Uni hops and is happy for a moment, as the landing's Uni cheers a copy.
    cheer_ms: f64 = -1e9,
    /// When Agent access was opened (ms): its example requests type themselves from then.
    typed_from_ms: f64 = 0,
    exclude: ui.TextBuffer = .{},
    port_field: ui.TextBuffer = .{},
    port_seen: Text = .{},
    /// The per-fetch maximum as the owner types it, seeded from the node's settings (`seed`).
    max_fetch_field: ui.TextBuffer = .{},
    max_fetch_seen: Text = .{},
    /// The first buy the node launches the owner's entries' coins with, as the owner types it, seeded from the node's
    /// settings (`seed`).
    dev_buy_field: ui.TextBuffer = .{},
    dev_buy_seen: Text = .{},
    /// The Money screen's Advanced fold, and Settings' Security fold: closed until the owner opens them.
    money_advanced: bool = false,
    security_open: bool = false,
    settings_advanced: bool = false,
    /// "Already have USDC?" opened on the Money screen: the node's address to send it to.
    money_own: bool = false,
    /// The balance last read, and a rise in it ("Funds arrived"): how much and when, shown for a minute.
    money_seen: f64 = -1,
    money_arrived: f64 = 0,
    money_arrived_at: f64 = 0,
    /// The first-run screen: which document it shows, whether it has asked the node for them, and the owner's choice
    /// on the network, none until they make one.
    terms_tab: usize = 0,
    terms_asked: bool = false,
    keep_off: ?bool = null,
    /// First-run sign-in (screens/sign_in.zig): due once a node that had never answered the terms is opened, until the
    /// owner signs in or skips it; whether it has read the node's sign-in yet; the sign-in page when the node couldn't
    /// open the browser itself.
    sign_in_due: bool = false,
    sign_in_asked: bool = false,
    sign_in_page: ?[]u8 = null,

    /// Connect your agents (screens/connect.zig). The clients the owner has unticked, by their place in the node's list.
    connect_off: [32]bool = @splat(false),
    /// What the last `agent_connect` and `agent_connect_undo` answered, kept in an arena of their own so the rows can
    /// keep saying it after the answer's buffer is gone.
    connect_arena: ?std.heap.ArenaAllocator = null,
    connect_results: []const types.ConnectResult = &.{},
    connect_undone: []const types.UndoneClient = &.{},
    /// The owner has been through the Connect screen (Done or Skip). Remembered in a file of the node's folder, read once.
    connect_dismissed: bool = false,
    /// Which step of the first-run Connect screen is open: 0, the agents on this Mac; 1, ChatGPT and Claude on the web.
    connect_step: u8 = 0,
    /// The app whose steps the ChatGPT and Claude panel shows (screens/cloud.zig): 0 Claude, 1 ChatGPT.
    cloud_tab: usize = 0,
    connect_checked: bool = false,
    /// The agent apps the node found (`agent_clients`), in an arena of their own, and whether it has answered yet.
    clients_arena: ?std.heap.ArenaAllocator = null,
    client_list: []const types.AgentClient = &.{},
    clients_known: bool = false,

    /// Where the window's own program runs from, and whether this is a Mac: a window run from the disk image is shown
    /// only the Move to Applications screen (`mustMove`). Tests set `mac` to try it on any machine.
    exe_dir: []const u8 = "",
    mac: bool = @import("builtin").os.tag == .macos,
    /// The copy to Applications is running, and why it failed when it did.
    move_busy: bool = false,
    move_err: Text = .{},

    pub fn init(a: *App, gpa: std.mem.Allocator, io: ?std.Io, net: ?*@import("api.zig").Net) void {
        a.* = .{
            .gpa = gpa,
            .io = io,
            .store = .{ .gpa = gpa, .net = net },
            .eye = .{ .gpa = gpa },
            .picture = .{ .gpa = gpa },
            .hands_pic = .{ .gpa = gpa },
            .hands = undefined,
            .toaster = .{ .gpa = gpa },
            .exe_dir = if (net) |n| n.exe_dir else "",
        };
        // Nothing the window starts may run from a disk image that is about to be ejected.
        if (net) |n| n.hold_node = a.mustMove() != null;
        a.hands = .{ .gpa = gpa, .store = &a.store, .redraw = .{ .ctx = a, .f = redraw } };
        a.store.hooks = .{ .ctx = a, .redraw = redraw, .event = onEvent, .done = onDone, .opened = onOpened };
    }

    pub fn deinit(a: *App) void {
        a.forgetSecrets();
        a.clearRun();
        a.wipe(&a.imported);
        a.wipe(&a.link);
        a.wipe(&a.sign_in_page);
        a.eye.deinit();
        a.picture.deinit();
        a.hands_pic.deinit();
        a.hands.deinit();
        a.toaster.deinit();
        if (a.connect_arena) |*arena| arena.deinit();
        if (a.clients_arena) |*arena| arena.deinit();
        a.store.deinit();
        for (&a.fields) |*f| std.crypto.secureZero(u8, &f.buf);
    }

    // ---- what each screen reads ----

    const always = [_]Res{ .node_info, .identity, .settings, .chain_status };

    fn wants(s: Screen) []const Res {
        return switch (s) {
            .node => &.{ .routes, .sites, .activity, .wallet, .agents_spend, .agents_list, .money, .link_status, .hands },
            .live => &.{.routes},
            .hands => &.{.hands},
            .routes => &.{ .routes, .routes_on_chain, .agents_list, .wallet, .share_status },
            .activity => &.{.activity},
            .access => &.{ .agents_list, .money, .remote_status },
            .wallet => &.{ .money, .wallet, .agents_list, .agents_spend, .link_status, .earnings, .coin_holdings, .owner_nodes, .listings_to_sign },
            .vault => &.{ .sessions, .vault_list, .vault_cards, .card_limits },
            .board => &.{ .board, .entries, .wallet },
            .settings => &.{ .browsers, .update_status, .link_status, .remote_status },
        };
    }

    /// Fetches what the open screen and the frame around it show.
    pub fn refresh(a: *App) void {
        for (always) |r| a.store.fetch(r);
        for (wants(a.screen)) |r| a.store.fetch(r);
    }

    pub fn go(a: *App, s: Screen) void {
        if (a.screen == s) return;
        a.hidePhrase();
        // Leaving the Browser screen stops its picture; a page the owner holds stays theirs.
        if (a.screen == .hands) a.hands.send("hands_stop", struct {}{});
        a.screen = s;
        a.err.len = 0;
        if (s == .access) a.typed_from_ms = a.now_ms;
        for (wants(s)) |r| a.store.fetch(r);
        if (s == .access) a.fetchClients();
        if (s == .live) {
            a.live_news = false;
            a.fetchPicture();
        }
        if (s == .hands and a.hands_site.len > 0) a.watch(a.hands_site.get());
    }

    // ---- the owner's hands on a site's browser ----

    /// Shows `site`'s page on the Browser screen.
    pub fn watch(a: *App, site: []const u8) void {
        a.choose(site);
        if (a.pageless(site)) return;
        a.hands.send("hands_watch", .{ .site = a.hands_site.get() });
    }

    /// Whether `site`'s ask is a route call's payment: there is no page to watch, only the ask to answer.
    pub fn pageless(a: *App, site: []const u8) bool {
        for (a.asks()) |k| if (std.mem.eql(u8, k.site, site)) if (k.pay) |p| if (p.route.len > 0) return true;
        return false;
    }

    /// The Browser screen opened on `site`'s page, from anywhere.
    pub fn show(a: *App, site: []const u8) void {
        if (a.screen == .hands) return a.watch(site);
        a.choose(site);
        a.go(.hands);
    }

    /// `site` is the one the Browser screen shows; another site's picture goes.
    fn choose(a: *App, site: []const u8) void {
        if (std.mem.eql(u8, a.hands_site.get(), site)) return;
        a.hands_pic.deinit();
        a.hands_pic.walk.len = 0;
        a.hands_pic.want.len = 0;
        a.hands_site.set(site);
    }

    /// The asks waiting on the owner.
    pub fn asks(a: *App) []const types.HandsAsk {
        return if (a.store.get(.hands)) |h| h.asks else &.{};
    }

    /// The site of the page the owner holds, if they hold one.
    pub fn holding(a: *App) ?[]const u8 {
        const h = a.store.get(.hands) orelse return null;
        for (h.browsers) |b| if (b.held) return b.site;
        return null;
    }

    /// Gives `site`'s page back: `done` says the owner did what was asked.
    pub fn giveBack(a: *App, site: []const u8, done_it: bool) void {
        const held = if (a.store.get(.hands)) |h| for (h.browsers) |b| {
            if (std.mem.eql(u8, b.site, site)) break b.held;
        } else false else false;
        a.hands.send("hands_give_back", .{ .site = site, .done = done_it });
        // A page the owner worked on and finished: keeping its login in the vault lets agents sign in themselves.
        if (done_it and held) a.hands_offer.set(site) else a.hands_offer.len = 0;
    }

    /// The Browser screen's newest picture, fetched while it is open.
    pub fn fetchHandsPicture(a: *App) void {
        if (a.screen != .hands) return;
        a.hands_pic.fetch(a.store.net, .{ .ctx = a, .f = redraw });
    }

    /// Keeps the login of a page the owner signed in on: the vault's own dialog, with the site filled in.
    pub fn offerLogin(a: *App, site: []const u8) void {
        a.open(.add_login);
        a.login_kind = 1;
        a.fields[0].set(site);
        a.hands_offer.len = 0;
    }

    /// The login an agent asked for (`vault:ask:`): the vault's own dialog, with its site and account filled in and the
    /// password the owner's to type. The node answers the agent once the vault holds it.
    pub fn askedLogin(a: *App, site: []const u8, account: []const u8) void {
        a.open(.add_login);
        a.login_kind = 1;
        a.fields[0].set(site);
        a.fields[1].set(account);
    }

    /// The browser's newest picture, fetched while the Live screen is open.
    pub fn fetchPicture(a: *App) void {
        if (a.screen != .live) return;
        a.picture.fetch(a.store.net, .{ .ctx = a, .f = redraw });
    }

    // ---- dialogs ----

    pub fn open(a: *App, d: Dialog) void {
        a.dialog = d;
        a.dialog_open = true;
        a.err.len = 0;
        a.store.stamp +%= 1;
        // Not an old key's setup screen where a new key's form belongs, unless it is still waiting to be seen.
        if (!a.setup_waiting) a.wipe(&a.setup);
        a.clearRun();
        a.wipe(&a.imported);
        a.wipe(&a.link);
        for (&a.fields) |*f| f.clear();
    }

    /// Forgets a remote key's token once the owner has copied it or moved on: it is shown once.
    pub fn wipeRemoteKey(a: *App) void {
        a.wipe(&a.remote_token);
        a.wipe(&a.remote_claude);
    }

    pub fn wipeLink(a: *App) void {
        a.wipe(&a.link);
    }

    /// Shows what an `unbrowse://` link names. A link can come from any page, so this only ever asks the node what's
    /// there: nothing here calls a route or pays, and what the dialog shows offers neither.
    pub fn openLink(a: *App, link: []const u8) void {
        a.open(.open_link);
        a.target.set(link);
        a.store.actWith(.open_link, "link", "open_link", .{ .link = link });
    }

    pub fn close(a: *App) void {
        a.dialog_open = false;
        a.forgetSecrets();
        a.wipeFields();
    }

    /// Wipes the dialog's fields: they may have held a password, a card or a secret input.
    pub fn wipeFields(a: *App) void {
        for (&a.fields) |*f| {
            // Zero the whole buffer, not just the bytes that were used: a field's used length is gone after
            // clear(), and any bytes past it (leftover or never initialised) must not leak a secret.
            std.crypto.secureZero(u8, &f.buf);
            f.clear();
        }
    }

    pub fn fail(a: *App, msg: []const u8) void {
        a.err.set(msg);
    }

    /// Whether the dialog that asked for `d` is the one on screen, or none is open that it could be mistaken for: a late
    /// answer is for the dialog that asked, never the one that took its place.
    fn answersDialog(a: *App, d: store_mod.Done) bool {
        return (d.stamp orelse a.store.stamp) == a.store.stamp;
    }

    /// Shows a setup string that came while its dialog wasn't there to show it: it is shown once, and the key exists.
    pub fn showWaitingSetup(a: *App) void {
        if (!a.setup_waiting or a.dialog_open) return;
        a.setup_waiting = false;
        a.open_setup();
    }

    fn open_setup(a: *App) void {
        a.dialog = .new_key;
        a.dialog_open = true;
        a.err.len = 0;
        a.store.stamp +%= 1;
    }

    fn clearRun(a: *App) void {
        if (a.run) |r| {
            a.gpa.free(r.text);
            a.gpa.free(r.err);
        }
        a.run = null;
    }

    fn wipe(a: *App, s: *?[]u8) void {
        if (s.*) |v| {
            std.crypto.secureZero(u8, v);
            a.gpa.free(v);
        }
        s.* = null;
    }

    pub fn forgetSecrets(a: *App) void {
        if (!a.setup_waiting) a.wipe(&a.setup);
        a.wipeRemoteKey();
        a.hideReveal();
        a.hidePhrase();
    }

    pub fn hidePhrase(a: *App) void {
        a.wipe(&a.phrase);
    }

    pub fn hideReveal(a: *App) void {
        a.wipe(&a.revealed);
        a.revealed_key.len = 0;
    }

    /// The window brought forward, and the Dock asks for the owner's attention.
    fn forward(a: *App) void {
        const w = a.window orelse return;
        if (w.app.flags.hidden) return;
        if (!w.isVisible()) w.show();
        if (@import("builtin").os.tag != .macos) return;
        const objc = nanoui.objc;
        _ = objc.msg(objc.NSInteger, w.app.nsapp, "requestUserAttention:", .{@as(objc.NSUInteger, 10)});
    }

    // ---- hooks, on the main thread ----

    fn redraw(ctx: *anyopaque) void {
        const a: *App = @ptrCast(@alignCast(ctx));
        if (a.window) |w| w.redraw();
    }

    fn onOpened(ctx: *anyopaque) void {
        const a: *App = @ptrCast(@alignCast(ctx));
        a.refresh();
        // Asks made while the window was away.
        a.store.fetch(.hands);
        a.fetchClients();
        a.terms_asked = false;
        a.sign_in_asked = false;
    }

    fn onEvent(ctx: *anyopaque, name: []const u8, data: []const u8, scratch: std.mem.Allocator) void {
        const a: *App = @ptrCast(@alignCast(ctx));
        a.event(name, data, scratch);
    }

    pub fn event(a: *App, name: []const u8, data: []const u8, scratch: std.mem.Allocator) void {
        const is = struct {
            fn f(x: []const u8, y: []const u8) bool {
                return std.mem.eql(u8, x, y);
            }
        }.f;
        if (is(name, "closed")) {
            a.eye.lineDropped();
        } else if (is(name, "activity") or is(name, "tick")) {
            a.refresh();
        } else if (is(name, "call")) {
            a.calls.apply(scratch, data);
            a.burst.apply(scratch, data);
            if (a.screen != .live and std.mem.indexOf(u8, data, "\"phase\":\"start\"") != null) a.live_news = true;
        } else if (is(name, "eye")) {
            a.eye.apply(scratch, data);
            if (a.screen != .live and std.mem.indexOf(u8, data, "\"kind\":\"started\"") != null) a.live_news = true;
        } else if (is(name, "frame")) {
            a.picture.note(scratch, data);
            a.fetchPicture();
        } else if (is(name, "hands_frame")) {
            a.hands_pic.note(scratch, data);
            a.fetchHandsPicture();
        } else if (is(name, "hands")) {
            a.store.fetch(.hands);
            const ev = std.json.parseFromSliceLeaky(types.HandsEvent, scratch, data, types.parse_options) catch return;
            if (is(ev.kind, "ask")) {
                const why = if (ev.ask) |k| k.why else "";
                const who = if (ev.ask) |k| k.agent else "An agent";
                a.toaster.push(.{ .status = .info, .title = std.fmt.allocPrint(scratch, "{s} needs you on {s}", .{ who, ev.site }) catch "An agent needs you", .message = why, .duration = 10 });
                if (a.screen == .hands) a.watch(ev.site) else a.choose(ev.site);
                a.forward();
            }
        } else if (is(name, "browser")) {
            a.store.fetch(.browsers);
        } else if (is(name, "update")) {
            a.store.fetch(.update_status);
        } else if (is(name, "identity") or is(name, "chain")) {
            for ([_]Res{ .identity, .chain_status, .wallet, .agents_spend, .routes_on_chain, .funding, .link_status }) |r| a.store.fetch(r);
        }
    }

    fn onDone(ctx: *anyopaque, d: store_mod.Done) void {
        const a: *App = @ptrCast(@alignCast(ctx));
        a.done(d);
    }

    pub fn done(a: *App, d: store_mod.Done) void {
        defer a.refresh();
        const mine = a.answersDialog(d);
        // A node that can't list its agents (an older one) simply has no Connect screen: that is no error to show.
        if (!d.ok and d.tag == .agent_clients) return;
        if (!d.ok) {
            // A dialog that took its place isn't told of a failure that isn't its own; the owner still is.
            if (mine or !a.dialog_open) a.fail(d.text) else a.toaster.push(.{ .status = .danger, .title = "That didn't go through", .message = d.text, .duration = 10 });
            return;
        }
        if (mine) a.err.len = 0;
        switch (d.tag) {
            .generic, .settings => {},
            .cash_out => a.toaster.push(.{ .status = .success, .title = cashedOut(d.text), .duration = 4 }),
            .close => if (mine) a.close(),
            .card_limit => {
                if (mine) a.close();
                a.store.fetch(.card_limits);
            },
            .agent_clients => {
                if (a.clients_arena) |*old| old.deinit();
                a.clients_arena = .init(a.gpa);
                const r = std.json.parseFromSliceLeaky(types.AgentClients, a.clients_arena.?.allocator(), d.text, types.parse_options) catch return;
                a.client_list = r.clients;
                a.clients_known = true;
            },
            .agent_connect => {
                const r = a.keepConnectAnswer(types.ConnectAnswer, d.text) orelse return;
                a.connect_results = r.results;
                a.connect_undone = &.{};
                a.fetchClients();
            },
            .agent_undo => {
                const r = a.keepConnectAnswer(types.UndoAnswer, d.text) orelse return;
                a.connect_results = &.{};
                a.connect_undone = r.restored;
                a.fetchClients();
            },
            .call_route => {
                if (!mine) return;
                const r = std.json.parseFromSliceLeaky(types.CallResult, d.arena, d.text, types.parse_options) catch {
                    a.fail("The node's answer couldn't be read.");
                    return;
                };
                a.clearRun();
                const pretty = std.json.Stringify.valueAlloc(d.arena, r.data, .{ .whitespace = .indent_2 }) catch "";
                const cut = pretty[0..@min(pretty.len, 20000)];
                a.run = .{
                    .ok = r.ok,
                    .ms = r.ms,
                    .text = a.gpa.dupe(u8, if (r.data == .null) "" else cut) catch &.{},
                    .err = a.gpa.dupe(u8, r.@"error" orelse "") catch &.{},
                };
            },
            .agent_create => {
                const r = std.json.parseFromSliceLeaky(types.NewAgent, d.arena, d.text, types.parse_options) catch return;
                a.wipe(&a.setup);
                a.setup = a.gpa.dupe(u8, r.setup) catch null;
                std.crypto.secureZero(u8, @constCast(r.setup));
                if (mine and a.dialog_open) return;
                // The owner left the dialog while the key was being made. It exists, and this is the only time its
                // setup is shown.
                a.setup_waiting = true;
                a.showWaitingSetup();
            },
            .remote_key => {
                const k = std.json.parseFromSliceLeaky(types.NewRemoteKey, d.arena, d.text, types.parse_options) catch return;
                a.wipeRemoteKey();
                a.remote_token = a.gpa.dupe(u8, k.token) catch null;
                a.remote_claude = a.gpa.dupe(u8, k.claude) catch null;
                std.crypto.secureZero(u8, @constCast(k.token));
                std.crypto.secureZero(u8, @constCast(k.claude));
                a.store.fetch(.remote_status);
            },
            .vault_reveal => {
                const v = std.json.parseFromSliceLeaky([]const u8, d.arena, d.text, types.parse_options) catch return;
                a.wipe(&a.revealed);
                a.revealed = a.gpa.dupe(u8, v) catch null;
                std.crypto.secureZero(u8, @constCast(v));
            },
            .link_start => {
                const r = std.json.parseFromSliceLeaky(types.LinkStart, d.arena, d.text, types.parse_options) catch return;
                a.wipe(&a.sign_in_page);
                if (!r.opened and r.url.len > 0) a.sign_in_page = a.gpa.dupe(u8, r.url) catch null;
            },
            .open_link => {
                if (!mine) return;
                a.wipe(&a.link);
                a.link = a.gpa.dupe(u8, d.text) catch null;
            },
            .vault_import => {
                a.wipe(&a.imported);
                a.imported = a.gpa.dupe(u8, d.text) catch null;
                a.store.fetch(.vault_list);
            },
            .wallet_phrase => {
                const v = std.json.parseFromSliceLeaky([]const u8, d.arena, d.text, types.parse_options) catch return;
                a.wipe(&a.phrase);
                a.phrase = a.gpa.dupe(u8, v) catch null;
                std.crypto.secureZero(u8, @constCast(v));
            },
            .wallet_restore => {
                const r = std.json.parseFromSliceLeaky(types.Restored, d.arena, d.text, types.parse_options) catch {
                    a.fail("The node's answer couldn't be read.");
                    return;
                };
                if (mine) a.close();
                if (r.previous) |p| {
                    a.toaster.push(.{ .status = .success, .title = std.fmt.allocPrint(d.arena, "Restored {s}", .{r.address}) catch "Restored", .message = std.fmt.allocPrint(d.arena, "The key for {s} is kept in your Keychain.", .{p}) catch "", .duration = 8 });
                } else a.toaster.push(.{ .status = .success, .title = "That's this node's key already", .duration = 4 });
                for ([_]Res{ .identity, .wallet, .agents_list }) |res| a.store.fetch(res);
            },
        }
    }

    // ---- connecting agents ----

    /// Asks the node which agent apps it finds on this Mac. It is not a resource of the store: an older node has no such
    /// command, and its refusal is not an error to show.
    pub fn fetchClients(a: *App) void {
        a.store.actWith(.agent_clients, "agent_clients", "agent_clients", struct {}{});
    }

    /// The agent apps the node found, once it has said.
    pub fn clients(a: *App) ?[]const types.AgentClient {
        return if (a.clients_known) a.client_list else null;
    }

    /// Reads an answer of the connect commands into the arena that outlives it. A new answer replaces the last.
    fn keepConnectAnswer(a: *App, comptime T: type, text: []const u8) ?T {
        if (a.connect_arena) |*old| old.deinit();
        a.connect_arena = .init(a.gpa);
        a.connect_results = &.{};
        a.connect_undone = &.{};
        const r = std.json.parseFromSliceLeaky(T, a.connect_arena.?.allocator(), text, types.parse_options) catch {
            a.fail("The node's answer couldn't be read.");
            return null;
        };
        return r;
    }

    /// The result `agent_connect` gave for client `id`, if the last answer had one.
    pub fn connectResult(a: *App, id: []const u8) ?types.ConnectResult {
        for (a.connect_results) |r| if (std.mem.eql(u8, r.id, id)) return r;
        return null;
    }

    /// Whether the owner still has to say no to connecting `i`th client of the node's list: ticked unless they untick it.
    pub fn connectTicked(a: *App, i: usize) bool {
        return i >= a.connect_off.len or !a.connect_off[i];
    }

    /// A client the owner can connect now: installed, not connected, and not done by the last answer.
    pub fn connectable(a: *App, cl: types.AgentClient) bool {
        if (!cl.found or cl.connected or cl.manual) return false;
        if (a.connectResult(cl.id)) |r| if (r.ok) return false;
        return true;
    }

    /// Sends the ticked clients to `agent_connect`.
    pub fn sendConnect(a: *App) void {
        var ids: [32][]const u8 = undefined;
        var n: usize = 0;
        for (a.client_list, 0..) |cl, i| {
            if (n < ids.len and a.connectable(cl) and a.connectTicked(i)) {
                ids[n] = cl.id;
                n += 1;
            }
        }
        if (n == 0) return;
        a.err.len = 0;
        a.store.actWith(.agent_connect, "agent_connect", "agent_connect", .{ .clients = ids[0..n] });
    }

    /// Puts every client back as it was before the node touched it.
    pub fn undoConnect(a: *App) void {
        a.err.len = 0;
        a.store.actWith(.agent_undo, "agent_connect_undo", "agent_connect_undo", struct {}{});
    }

    /// Whether the Connect screen stands in front of the normal ones: the node's clients are known, none of them is
    /// connected, and the owner hasn't been through it.
    pub fn connectDue(a: *App) bool {
        const cs = a.clients() orelse return false;
        if (a.connectWasDismissed()) return false;
        if (a.connect_step > 0) return true;
        // What the button just did stays on screen until the owner says Done, though the client now counts as connected.
        if (a.connect_results.len > 0) return true;
        for (cs) |cl| if (cl.connected) return false;
        return true;
    }

    fn markerPath(a: *App, buf: []u8) ?[]const u8 {
        const net = a.store.net orelse return null;
        return std.fmt.bufPrint(buf, "{s}/connect-seen", .{net.dir}) catch null;
    }

    fn connectWasDismissed(a: *App) bool {
        if (!a.connect_checked) {
            a.connect_checked = true;
            var buf: [600]u8 = undefined;
            if (a.markerPath(&buf)) |path| {
                if (a.io) |io| {
                    if (std.Io.Dir.cwd().access(io, path, .{})) |_| a.connect_dismissed = true else |_| {}
                }
            }
        }
        return a.connect_dismissed;
    }

    /// Past the agents on this Mac, on the first run: ChatGPT and Claude on the web come next.
    pub fn nextConnectStep(a: *App) void {
        a.connect_step = 1;
        a.err.len = 0;
        a.store.fetch(.remote_status);
    }

    /// The owner is done with the Connect screen: it doesn't come back, whether or not they connected anything.
    pub fn dismissConnect(a: *App) void {
        a.connect_step = 0;
        a.connect_checked = true;
        a.connect_dismissed = true;
        a.connect_results = &.{};
        var buf: [600]u8 = undefined;
        const path = a.markerPath(&buf) orelse return;
        const io = a.io orelse return;
        std.Io.Dir.cwd().createDirPath(io, a.store.net.?.dir) catch {};
        std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = "1\n" }) catch {};
    }

    // ---- moving the app to Applications ----

    /// The `.app` folder to copy to Applications when the window runs from a disk image or a quarantine copy; null on
    /// anything but a Mac, and when it runs from a place that lasts.
    pub fn mustMove(a: *App) ?[]const u8 {
        if (!a.mac) return null;
        return move_to_apps.decide(a.exe_dir);
    }

    /// Copies the app to Applications (to the owner's own Applications folder when that one can't be written), opens
    /// the copy and quits this one. The copy takes a few seconds, so it runs apart from the frame.
    pub fn moveToApplications(a: *App) void {
        if (a.move_busy) return;
        const from = a.mustMove() orelse return;
        const io = a.io orelse return;
        const net = a.store.net orelse return;
        const job = a.gpa.create(MoveJob) catch return;
        job.* = .{ .app = a, .io = io, .from = a.gpa.dupe(u8, from) catch {
            a.gpa.destroy(job);
            return;
        }, .home = a.gpa.dupe(u8, std.fs.path.dirname(net.dir) orelse "") catch "" };
        a.move_busy = true;
        a.move_err.len = 0;
        const t = std.Thread.spawn(.{ .stack_size = 1 << 20 }, MoveJob.run, .{job}) catch {
            a.move_busy = false;
            a.move_err.set("The copy couldn't start. Drag Unbrowse onto Applications yourself, then open it from there.");
            a.gpa.free(job.from);
            a.gpa.destroy(job);
            return;
        };
        t.detach();
    }

    const MoveJob = struct {
        app: *App,
        io: std.Io,
        from: []u8,
        home: []u8,
        failed: bool = false,

        fn run(job: *MoveJob) void {
            job.failed = !job.copyAndOpen();
            nanoui.App.onMain(job, finish);
        }

        fn copyAndOpen(job: *MoveJob) bool {
            const gpa = job.app.gpa;
            var dest: []const u8 = "/Applications/Unbrowse.app";
            var mine: ?[]u8 = null;
            defer if (mine) |m| gpa.free(m);
            if (!job.runs(&.{ "/usr/bin/ditto", job.from, dest })) {
                // /Applications isn't the owner's to write: their own Applications folder takes it.
                const own = std.fmt.allocPrint(gpa, "{s}/Applications/Unbrowse.app", .{job.home}) catch return false;
                mine = own;
                dest = own;
                std.Io.Dir.cwd().createDirPath(job.io, std.fs.path.dirname(own).?) catch return false;
                if (!job.runs(&.{ "/usr/bin/ditto", job.from, dest })) return false;
            }
            // `-n`: a new instance of the copy. Without it macOS sees the same bundle id already running (this window,
            // on the disk image) and only brings it forward, and this window then quits with nothing left open.
            return job.runs(&.{ "/usr/bin/open", "-n", dest });
        }

        fn runs(job: *MoveJob, argv: []const []const u8) bool {
            var child = std.process.spawn(job.io, .{ .argv = argv, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore }) catch return false;
            const term = child.wait(job.io) catch return false;
            return term == .exited and term.exited == 0;
        }

        fn finish(ctx: ?*anyopaque) callconv(.c) void {
            const job: *MoveJob = @ptrCast(@alignCast(ctx));
            const a = job.app;
            a.move_busy = false;
            if (job.failed) {
                a.move_err.set("Unbrowse couldn't copy itself to Applications. Drag it onto Applications yourself, then open it from there.");
                redraw(a);
            } else if (a.window) |w| w.app.quit();
            a.gpa.free(job.from);
            a.gpa.free(job.home);
            a.gpa.destroy(job);
        }
    };

    // ---- what the frame around the screens says ----

    pub fn paused(a: *App) bool {
        return if (a.store.get(.settings)) |s| s.paused else false;
    }

    pub fn nodeName(a: *App) []const u8 {
        return if (a.store.get(.node_info)) |i| i.name else "this node";
    }

    pub fn port(a: *App) u16 {
        if (a.store.get(.node_info)) |i| return i.api_port;
        if (a.store.get(.settings)) |s| return s.api_port;
        return 7788;
    }

    pub fn chainUp(a: *App) bool {
        return if (a.store.get(.chain_status)) |ch| ch.up else false;
    }

    pub fn chainError(a: *App) ?[]const u8 {
        return if (a.store.get(.chain_status)) |ch| ch.@"error" else null;
    }

    /// Whether the node runs on its own devnet: the only chain with a faucet and a "local chain" to speak of.
    pub fn devnet(a: *App) bool {
        return if (a.store.get(.chain_status)) |ch| std.mem.eql(u8, ch.network, "devnet") else false;
    }

    /// The header's word for payments, as the node says they stand (`money::payments`): none while a
    /// live network's payments run.
    pub fn paymentsWord(a: *App) ?[]const u8 {
        const ch = a.store.get(.chain_status) orelse return "Starting";
        const is = struct {
            fn f(x: []const u8, y: []const u8) bool {
                return std.mem.eql(u8, x, y);
            }
        }.f;
        if (is(ch.payments, "open")) return null;
        if (is(ch.payments, "test")) return "Test mode";
        if (is(ch.payments, "not_open")) return "Payments not open yet";
        return if (is(ch.payments, "offline")) "Payments offline" else "Starting";
    }

    /// Why the money isn't up, as the Money and Home screens say it: the devnet's local chain, or a live network's
    /// payments.
    pub fn chainDownWord(a: *App) []const u8 {
        const ch = a.store.get(.chain_status) orelse return "Starting";
        if (a.devnet()) return if (ch.@"error" != null) "The local chain didn't start" else "Starting the local chain…";
        if (ch.settlement_missing) return "Payments aren't open on this network yet";
        return if (ch.@"error" != null) "Payments offline" else "Connecting to the network…";
    }

    /// The node's state in a word, as the sidebar's card says it.
    /// Whether the node is doing something now: a walk under way, or a call not yet answered. Uni moves only then.
    pub fn busy(a: *App) bool {
        if (a.eye.walk) |w| if (w.saved == null and w.failed == null and !w.lost) return true;
        for (a.calls.items[0..a.calls.len]) |call| if (!call.done) return true;
        return false;
    }

    /// Something was copied: Uni cheers.
    pub fn cheer(a: *App) void {
        a.cheer_ms = a.now_ms;
    }

    pub fn stateWord(a: *App) []const u8 {
        if (a.store.conn == .down) return "Not reachable";
        if (a.paused()) return "Paused";
        if (a.chainError() != null) return "Payments offline";
        return "Online";
    }

    /// Whether the owner has yet to answer for the terms this node carries: the first-run screen stands in front of
    /// everything until they have. Not before both answers are in, and never on a node older than the question.
    pub fn termsDue(a: *App) bool {
        const current = (a.store.get(.node_info) orelse return false).terms_version;
        const s = a.store.get(.settings) orelse return false;
        return current.len > 0 and !std.mem.eql(u8, s.terms_accepted orelse "", current);
    }

    /// The choice the first-run screen shows: the owner's, else what they chose before, so an owner already off the
    /// network is never put back on it by a new version of the terms.
    pub fn keepOff(a: *App) bool {
        if (a.keep_off) |k| return k;
        return if (a.store.get(.settings)) |s| !s.peer_network else false;
    }

    pub fn acceptTerms(a: *App) void {
        // A node answering the terms for the first time is a new one: its owner is asked to sign in next.
        if (a.store.get(.settings)) |s| if (s.terms_accepted == null) {
            a.sign_in_due = true;
        };
        a.store.actWith(.settings, "accept_terms", "accept_terms", .{ .keep_off = a.keepOff() });
    }

    /// Whether the first-run sign-in stands in front of the screens: due, the terms answered, and no wallet linked yet.
    /// A wallet linked, here or by the node's own `sign-in`, ends it and says so.
    pub fn signInDue(a: *App) bool {
        if (!a.sign_in_due or a.termsDue()) return false;
        const l = a.store.get(.link_status) orelse return true;
        const owner = l.owner orelse return true;
        a.sign_in_due = false;
        a.wipe(&a.sign_in_page);
        a.toaster.push(.{ .status = .success, .title = "Signed in", .message = owner, .duration = 6 });
        return false;
    }

    /// Opens the sign-in page in the owner's browser; the node waits on it (`link_start`), and opens it anew if asked
    /// again.
    pub fn startSignIn(a: *App) void {
        a.err.len = 0;
        a.store.act(.link_start, "link_start", "link_start", "{}");
    }

    /// Past the first-run sign-in with nothing linked: the window as it is for any node with no wallet of the owner's.
    pub fn skipSignIn(a: *App) void {
        a.sign_in_due = false;
        a.wipe(&a.sign_in_page);
        a.err.len = 0;
        a.screen = .access;
        a.refresh();
    }

    /// Saves one setting (`Store.patchSettings`).
    pub fn saveSetting(a: *App, key: []const u8, value: std.json.Value) void {
        a.store.patchSettings(key, value);
    }

    /// Shows the node's value in a field the owner is typing into only until they change it: what the node says wins
    /// over what the field last showed, what they typed wins over both. `seen` is the value last shown.
    pub fn seed(box: *ui.TextBuffer, seen: *Text, value: []const u8) void {
        if (std.mem.eql(u8, seen.get(), value)) return;
        if (seen.len == 0 or std.mem.eql(u8, box.text(), seen.get())) box.set(value);
        seen.set(value);
    }

    pub fn setPaused(a: *App, on: bool) void {
        a.saveSetting("paused", .{ .bool = on });
    }

    /// The text of field `i`, trimmed.
    pub fn field(a: *App, i: usize) []const u8 {
        return std.mem.trim(u8, a.fields[i].text(), " \t\n");
    }

    pub fn number(a: *App, i: usize) ?f64 {
        const s = a.field(i);
        if (s.len == 0) return null;
        var buf: [64]u8 = undefined;
        var n: usize = 0;
        for (s) |ch| if (ch != ',' and n < buf.len) {
            buf[n] = ch;
            n += 1;
        };
        return std.fmt.parseFloat(f64, buf[0..n]) catch null;
    }
};
