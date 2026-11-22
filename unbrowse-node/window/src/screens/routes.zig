//! My routes: what agents learned, how each call went, and listing on the
//! chain; a route can be tried with its inputs, priced, held, delisted or
//! deleted. A search narrows them, and they show a page at a time.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;

/// The table's columns at three widths, so the route's own name always keeps room: all six when the window is wide;
/// the last call folded under the calls and the buttons stacked when it is narrower; and sharing folded under the
/// state too when it is narrow.
const Fit = enum { wide, mid, narrow };

const cols_wide = [_]look.Col{
    .{ .name = "Route" },
    .{ .name = "Calls", .w = 84, .end = true },
    .{ .name = "Last call", .w = 84, .end = true },
    .{ .name = "State", .w = 144 },
    .{ .name = "Sharing", .w = 168 },
    .{ .name = "", .w = 152, .end = true },
};
const cols_mid = [_]look.Col{
    .{ .name = "Route" },
    .{ .name = "Calls", .w = 96, .end = true },
    .{ .name = "State", .w = 144 },
    .{ .name = "Sharing", .w = 150 },
    .{ .name = "", .w = 76, .end = true },
};
const cols_narrow = [_]look.Col{
    .{ .name = "Route" },
    .{ .name = "Calls", .w = 84, .end = true },
    .{ .name = "State", .w = 160 },
    .{ .name = "", .w = 76, .end = true },
};

/// Which columns fit the table's width (look.tableWidth).
fn fit(c: *ui.Context) Fit {
    const w = look.tableWidth(c);
    return if (w >= 952) .wide else if (w >= 722) .mid else .narrow;
}

fn colsOf(f: Fit) []const look.Col {
    return switch (f) {
        .wide => &cols_wide,
        .mid => &cols_mid,
        .narrow => &cols_narrow,
    };
}

/// Whether the owner's search `query` finds `r`: every word of it, in any case, somewhere in what the route does, its
/// site, its method and path, an input's name or its id. A search of no words finds every route.
pub fn matches(r: types.Route, query: []const u8) bool {
    var words = std.mem.tokenizeAny(u8, query, " \t\r\n");
    while (words.next()) |w| {
        var found = look.findsAll(&.{ r.what, r.site, r.method, r.path, r.id }, w);
        for (r.inputs) |in| found = found or look.findsAll(&.{in.name}, w);
        if (!found) return false;
    }
    return true;
}

fn find(a: *App, id: []const u8) ?types.Route {
    for (a.store.list(.routes)) |r| if (std.mem.eql(u8, r.id, id)) return r;
    return null;
}

fn chainOf(a: *App, id: []const u8) ?types.RouteChain {
    for (a.store.list(.routes_on_chain)) |r| if (std.mem.eql(u8, r.id, id)) return r;
    return null;
}

pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const list = a.store.list(.routes);
    var live: usize = 0;
    for (list) |r| live += @intFromBool(if (chainOf(a, r.id)) |ch| ch.live else false);
    {
        const h = look.header(c, "My routes", if (list.len == 0) "No routes yet. Connect an agent: it learns the routes it needs as it works." else c.print("{d} route{s} learned, {d} listed for other agents to pay for.", .{ list.len, if (list.len == 1) "" else "s", live }));
        h.end();
    }
    howRoutesArrive(a, c);
    waitingToShare(a, c);
    if (list.len > 0) look.search(c, "routes-search", &a.routes_query, &a.routes_page, "Search by what a route does, its site, path or inputs", &a.routes_find);
    const query = std.mem.trim(u8, a.routes_query.text(), " \t\r\n");
    var found: std.ArrayList(types.Route) = .empty;
    for (list) |r| if (matches(r, query)) found.append(fa, r) catch {};
    const shown = found.items;
    const rows = look.pageRows(&a.routes_page, shown.len);
    {
        const t = look.tableHead(c, "Routes", look.countOf(c, shown.len, list.len, query.len > 0), colsOf(fit(c)));
        defer t.end();
        if (a.store.err(.routes)) |e| if (!a.store.loaded(.routes)) {
            look.rule(c);
            const d = ui.div(c).wFull().p(16);
            defer d.end();
            return look.failText(c, e);
        };
        if (list.len == 0) {
            look.rule(c);
            return look.empty(c, "Nothing learned yet.");
        }
        if (shown.len == 0) {
            look.rule(c);
            return look.empty(c, c.print("No route matches \u{201C}{s}\u{201D}.", .{query}));
        }
        for (shown[rows.from..rows.to]) |r| row(a, c, r);
    }
    look.pager(c, "routes-pages", &a.routes_page, rows, shown.len);
}

fn row(a: *App, c: *ui.Context, r: types.Route) void {
    const fa = c.alloc();
    const x = look.x(c);
    const ch = chainOf(a, r.id);
    const f = fit(c);
    const cols = colsOf(f);
    var at: usize = 0;
    const next = struct {
        fn cell(cc: *ui.Context, cs: []const look.Col, i: *usize) ui.Div {
            defer i.* += 1;
            return look.cellBox(cc, cs[i.*]);
        }
    }.cell;
    const tr = look.tableRow(c, r.id, r.broken());
    defer tr.end();
    {
        const cell = next(c, cols, &at);
        defer cell.end();
        ui.text(c, r.what, .{ .size = 13.5, .weight = .medium, .wrap = true });
        // Where it calls: the site, then the request, so a long site never pushes the name out of its column.
        ui.text(c, c.print("{s}  {s} {s}", .{ r.site, r.method, r.path }), .{ .size = 12, .mono = true, .wrap = true, .color = x.text3 });
        var ins: std.ArrayList(u8) = .empty;
        for (r.inputs, 0..) |in, i| {
            if (i > 0) ins.appendSlice(fa, ", ") catch {};
            ins.appendSlice(fa, in.name) catch {};
        }
        ui.text(c, c.print("{s}{s}{s}", .{
            if (r.inputs.len > 0) c.print("Inputs: {s}", .{ins.items}) else "No inputs",
            if (r.browser_assisted) ", one step in the browser" else "",
            if (r.provisional) ", one sighting so far" else "",
        }), .{ .size = 11.5, .color = x.text3, .wrap = true });
        // Why the last call failed, in a line: Try it calls it again with its inputs.
        if (r.broken()) ui.text(c, look.clipTo(c, r.stats.last_error orelse "", 160), .{ .size = 11.5, .color = x.fail_text, .wrap = true });
    }
    {
        // How many calls, and what share passed: one figure and its rate under it; narrower, the last call too.
        const cell = next(c, cols, &at);
        defer cell.end();
        look.figure(c, fmt.count(fa, r.stats.calls), false);
        ui.text(c, if (r.stats.calls > 0) c.print("{s} passed", .{fmt.pct(fa, r.stats.passed / r.stats.calls, 0)}) else "None yet", .{ .size = 11.5, .color = x.text3 });
        if (f != .wide) if (r.stats.last_ms) |ms| ui.text(c, c.print("{s} ms, {s}", .{ fmt.count(fa, ms), fmt.ago(fa, r.stats.last_at, a.now) }), .{ .size = 11.5, .color = x.text3, .wrap = true });
    }
    if (f == .wide) {
        const cell = next(c, cols, &at);
        defer cell.end();
        if (r.stats.last_ms) |ms| {
            look.figure(c, c.print("{s} ms", .{fmt.count(fa, ms)}), false);
            ui.text(c, fmt.ago(fa, r.stats.last_at, a.now), .{ .size = 11.5, .color = x.text3 });
        } else look.figure(c, "Never", true);
    }
    {
        // Where it stands, and its fee once it is listed; narrow, whether it is shared under it.
        const cell = next(c, cols, &at);
        defer cell.end();
        if (r.broken()) look.status(c, .fail, "Last call failed") //
        else if (ch != null and ch.?.live) look.status(c, .ok, if (ch.?.held) "Listed, held here" else "Listed") //
        else if (ch != null and ch.?.listed) look.status(c, .idle, "Delisted") //
        else if (r.yours) look.status(c, .idle, "Acts as you") //
        else look.status(c, .idle, "Yours only");
        if (ch != null and ch.?.live) ui.text(c, c.print("${s} a fetch", .{fmt.usdcd(fa, ch.?.fee, 3)}), .{ .size = 11.5, .color = x.text3 });
        if (f == .narrow) {
            const gap = ui.div(c).h(6);
            gap.end();
            sharing(a, c, r.id);
        }
    }
    if (f != .narrow) {
        const cell = next(c, cols, &at);
        defer cell.end();
        sharing(a, c, r.id);
    }
    const cell = next(c, cols, &at);
    defer cell.end();
    // Side by side when there is room, else one above the other.
    const btns = if (f == .wide) ui.div(c).row().gap(4) else ui.div(c).column().gap(4).itemsEnd();
    defer btns.end();
    if (look.secondary(c, "Try it", .{ .size = .xs })) openRun(a, r);
    // A route learned from the owner's own browsing acts as them: it isn't offered to list by hand. One the node listed
    // by itself is still theirs to delist, here.
    const live = ch != null and ch.?.live;
    if ((!r.yours or live) and look.secondary(c, if (live) "Manage" else "List", .{ .size = .xs, .disabled = !a.chainUp() })) {
        a.open(.list_route);
        a.target.set(r.id);
    }
    if (look.ghost(c, "Delete", .{})) {
        a.open(.delete_route);
        a.target.set(r.id);
    }
}

fn shareOf(a: *App, id: []const u8) ?types.ShareRoute {
    const s = a.store.get(.share_status) orelse return null;
    for (s.routes) |r| if (std.mem.eql(u8, r.id, id)) return r;
    return null;
}

/// Whether the route is shared, why it waits if it isn't yet, and a toggle to share it or keep it off.
fn sharing(a: *App, c: *ui.Context, id: []const u8) void {
    const r = shareOf(a, id) orelse return look.figure(c, "Reading\u{2026}", true);
    const w = struct {
        status: look.Status,
        word: []const u8,
        note: []const u8 = "",
    };
    const is = struct {
        fn f(x: []const u8, y: []const u8) bool {
            return std.mem.eql(u8, x, y);
        }
    }.f;
    const s: w = if (is(r.why, "listed")) .{ .status = .ok, .word = "Shared", .note = "On the network until you delist it, under Manage" } //
        else if (is(r.why, "preview")) .{ .status = .idle, .word = "Will be shared", .note = "Within a day, unless you keep it off" } //
        else if (is(r.why, "local")) .{ .status = .idle, .word = "On this computer", .note = "Learned before this node joined the network, so it stays here" } //
        else if (is(r.why, "queued")) .{ .status = .running, .word = "Listing next" } //
        else if (is(r.why, "unsigned")) .{ .status = .warn, .word = "Waiting", .note = "Listed under your account, and waiting for you to approve it under Money before anyone can find it" } //
        else if (is(r.why, "unspread")) .{ .status = .warn, .word = "Waiting", .note = if (r.poster) "Listed, and waiting for the reserve's next root before anyone can find it" else "Listed, and needs a few cents for network fees to post its root before anyone can find it" } //
        else if (is(r.why, "below_threshold")) .{ .status = .idle, .word = "Not yet", .note = c.print("Shared once used on {d} days or {d} times: {s}, {s} so far", .{ @as(u64, @intFromFloat(r.days_needed)), @as(u64, @intFromFloat(r.runs_needed)), fmt.plural(c.alloc(), @floor(r.days), "day"), fmt.plural(c.alloc(), @floor(r.runs), "run") }) } //
        else if (is(r.why, "not_run_yet")) .{ .status = .idle, .word = "Not yet", .note = "Shared once it has run successfully" } //
        else if (is(r.why, "cap_reached")) .{ .status = .warn, .word = "Waiting", .note = c.print("Today's {d} listings are made; it goes tomorrow", .{@as(u64, @intFromFloat(r.per_day))}) } //
        else if (is(r.why, "blocked")) .{ .status = .warn, .word = "Waiting", .note = "The node can't list now: it needs a few cents for network fees (add funds on Money), or payments aren't open on this network yet" } //
        else if (is(r.why, "failed")) .{ .status = .warn, .word = "Waiting", .note = r.@"error" } //
        else if (is(r.why, "off")) .{ .status = .idle, .word = "Not shared", .note = "Sharing is off in Settings" } //
        else if (is(r.why, "opted_out")) .{ .status = .idle, .word = "Kept off" } //
        else if (is(r.why, "excluded")) .{ .status = .idle, .word = "Not shared", .note = c.print("{s} is excluded", .{r.host}) } //
        else .{ .status = .idle, .word = "Can't be shared", .note = if (r.reason == .string) r.reason.string else "" };
    look.status(c, s.status, s.word);
    if (s.note.len > 0) ui.text(c, s.note, .{ .size = 11.5, .color = look.x(c).text3, .wrap = true });
    // A listed route stays listed whatever is said of it here (R2.16): the only way off is its signed delist, under
    // Manage, so no button here promises one.
    if (is(r.why, "not_shareable") or is(r.why, "excluded") or is(r.why, "local") or is(r.why, "listed")) return;
    const shared = !(is(r.why, "off") or is(r.why, "opted_out"));
    const label = c.print("share-{s}", .{id});
    if (look.ghost(c, if (shared) "Keep off the network" else "Share it", .{})) a.store.actWith(.generic, label, "share_route", .{ .id = id, .on = !shared });
}

/// The routes waiting on the owner's look: they go by themselves within a day, or now if the owner says so. Opening
/// this screen says nothing either way.
fn waitingToShare(a: *App, c: *ui.Context) void {
    const s = a.store.get(.share_status) orelse return;
    var n: usize = 0;
    for (s.routes) |r| n += @intFromBool(std.mem.eql(u8, r.why, "preview"));
    if (n == 0) return;
    const row_ = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer row_.end();
    {
        const w = ui.div(c).grow().minW(0);
        defer w.end();
        look.body(c, c.print("{d} route{s} will be shared within a day. Keep any of them off below, or share them now.", .{ n, if (n == 1) "" else "s" }));
    }
    if (look.secondary(c, "Share them now", .{ .loading = a.store.isBusy("share_approve") })) a.store.act(.generic, "share_approve", "share_approve", "{}");
}

pub fn openRun(a: *App, r: types.Route) void {
    a.open(.run_route);
    a.target.set(r.id);
    for (r.inputs[0..@min(r.inputs.len, a.fields.len)], 0..) |in, i| a.fields[i].set(in.default orelse "");
}

/// Routes arrive from agents: how to connect one, not a form to fill.
fn howRoutesArrive(a: *App, c: *ui.Context) void {
    var live: usize = 0;
    for (a.store.list(.agents_list)) |ag| live += @intFromBool(!ag.revoked);
    const p = look.panel(c, "Your agents learn routes", if (live > 0) c.print("{d} agent{s} connected", .{ live, if (live == 1) "" else "s" }) else "No agent connected yet");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    ui.text(c, "An agent says what it wants. When no route does it, the node's browser walks a page that does, keeps the call that answers, and every call after goes straight to the site with no browser.", .{ .size = 13.5, .wrap = true });
    look.well(c,
        \\unbrowse_do      goal: search Hacker News stories   url: https://hn.algolia.com/?q=rust
        \\unbrowse_do      goal: search Hacker News stories   inputs: { "q": "tauri" }
        \\unbrowse_browse  for a page that needs clicks or typing
    );
    look.small(c, c.print("Tools on this node's MCP server at http://127.0.0.1:{d}/mcp, or the same through the unb command and the HTTP API. {s}", .{ a.port(), if (live > 0) "" else "Add an agent on Money to get the setup." }));
}

pub fn dialogs(a: *App, c: *ui.Context) void {
    const r = find(a, a.target.get()) orelse return;
    switch (a.dialog) {
        .run_route => runDialog(a, c, r),
        .list_route => listDialog(a, c, r),
        .delete_route => deleteDialog(a, c, r),
        else => {},
    }
}

fn runDialog(a: *App, c: *ui.Context, r: types.Route) void {
    const fa = c.alloc();
    const x = look.x(c);
    const d = kit.dialog(c, "run", &a.dialog_open, .{ .title = r.what, .description = c.print("{s} {s}{s}", .{ r.method, r.site, r.path }), .ok = "", .cancel = "", .width = 560 }) orelse return;
    if (r.inputs.len == 0) look.body(c, "This route takes no inputs.");
    for (r.inputs[0..@min(r.inputs.len, a.fields.len)], 0..) |in, i| {
        ui.key(c, c.print("in-{d}", .{i}));
        const f = look.field(c, in.name, .{});
        _ = ui.textField(c, &a.fields[i], .{ .width = .fill, .password = in.secret });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    if (a.run) |res| {
        const st = ui.div(c).row().gap(12).itemsCenter();
        look.status(c, if (res.ok) .ok else .fail, if (res.ok) "Passed" else "Failed");
        ui.text(c, c.print("{s} ms, no browser", .{fmt.count(fa, res.ms)}), .{ .size = 12.5, .color = x.text2 });
        st.end();
        if (res.err.len > 0) look.failText(c, res.err);
        if (res.text.len > 0) {
            const sc = ui.div(c).wFull().maxH(320).scrollY().p(12).rounded(8).bg(x.well);
            defer sc.end();
            ui.text(c, res.text, .{ .size = 11.5, .mono = true, .wrap = true });
        }
    }
    {
        const f = ui.div(c).row().wFull().gap(8).justifyEnd().pt(4);
        defer f.end();
        if (look.secondary(c, "Close", .{ .size = .md })) a.close();
        if (look.primary(c, if (a.store.isBusy("run")) "Calling" else "Call the route", .{ .size = .md, .loading = a.store.isBusy("run") })) {
            var m: std.json.ObjectMap = .empty;
            for (r.inputs[0..@min(r.inputs.len, a.fields.len)], 0..) |in, i| m.put(fa, in.name, .{ .string = a.fields[i].text() }) catch {};
            a.err.len = 0;
            a.store.actWith(.call_route, "run", "call_route", .{ .id = r.id, .inputs = std.json.Value{ .object = m } });
        }
    }
    _ = d.end();
}

fn listDialog(a: *App, c: *ui.Context, r: types.Route) void {
    const fa = c.alloc();
    const ch = chainOf(a, r.id);
    const live = ch != null and ch.?.live;
    const wallet = a.store.get(.wallet) orelse types.Wallet{};
    const split = wallet.split;
    const d = kit.dialog(c, "list", &a.dialog_open, .{
        .title = if (live) r.what else c.print("List {s}", .{r.what}),
        .description = if (live) c.print("Agents pay your node's fee per detail fetch that passes. {d}% goes to the route's coin, or to you while it has none, and {d}% to the site.", .{ split.contributor, split.site }) else "Listing lets other agents find this route, fetch its recipe and pay your node's fee for it. You put nothing in up front.",
        .ok = "",
        .cancel = "",
        .width = 500,
    }) orelse return;
    const n = wallet.fee;
    {
        const row_ = ui.div(c).row().wFull().gap(16).itemsCenter();
        defer row_.end();
        const col = ui.div(c).column().grow().gap(2);
        look.label(c, if (n > 0) c.print("${s} a fetch, your node's fee", .{fmt.usdcd(fa, n, 3)}) else "Your node has no fee yet");
        look.small(c, if (n > 0) c.print("Every route you list is priced the same{s}. ${s} of it goes to the route's coin each time an agent's fetch passes, or to you while it has none; a failed call is never charged.", .{ if (wallet.pricing.auto) ", following demand" else "", fmt.usdcd(fa, n * split.contributor / 100, 4) }) else "Set one on Money, under Advanced; it prices every route you list.");
        col.end();
        if (look.secondary(c, "Change on Money", .{})) {
            a.close();
            a.go(.wallet);
        }
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    if (a.devnet()) look.chip(c, "Test mode", false);
    {
        const f = ui.div(c).row().wFull().gap(8).justifyEnd().pt(4);
        defer f.end();
        if (live and look.danger(c, "Delist", .{ .loading = a.store.isBusy("delist") })) a.store.actWith(.close, "delist", "delist_route", .{ .id = r.id });
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        if (!live and look.primary(c, "List it", .{ .size = .md, .disabled = !(n > 0), .loading = a.store.isBusy("save") }))
            a.store.actWith(.close, "save", "list_route", .{ .id = r.id });
    }
    _ = d.end();
}

/// Whether a route may go from this node. A listed one must be delisted first, or other nodes keep fetching a body that
/// is gone. What the chain says is a copy, and missing while the chain loads or fails, so the route's own record counts
/// too, and with no copy at all a route that was ever listed waits.
pub fn mayDelete(listing: ?types.Listing, chain_live: bool, chain_read: bool) bool {
    if (chain_live) return false;
    const l = listing orelse return true;
    return !l.live and chain_read;
}

fn deleteDialog(a: *App, c: *ui.Context, r: types.Route) void {
    const ch = chainOf(a, r.id);
    const may = mayDelete(r.listing, ch != null and ch.?.live, a.store.loaded(.routes_on_chain) and a.store.err(.routes_on_chain) == null);
    const d = kit.dialog(c, "delete", &a.dialog_open, .{ .title = c.print("Delete {s}?", .{r.what}), .description = "The route is removed from this node. If it is listed, delist it first so other nodes stop fetching it.", .ok = "", .cancel = "" }) orelse return;
    if (!may) look.status(c, .warn, "Listed, or its listing can't be read right now: delist it first, or try again once payments are up.");
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = ui.div(c).row().wFull().gap(8).justifyEnd().pt(4);
        defer f.end();
        if (look.secondary(c, "Keep it", .{ .size = .md })) a.close();
        if (look.danger(c, c.print("Delete {s}", .{r.what}), .{ .disabled = !may, .loading = a.store.isBusy("delete") })) a.store.actWith(.close, "delete", "delete_route", .{ .id = r.id });
    }
    _ = d.end();
}
