//! Agents, the home screen: the agents on this Mac with one button that connects them, ChatGPT and Claude on the web
//! by this node's address (screens/cloud.zig), the agent keys with each one's daily limit and what it spent today, and
//! how any other agent connects. No call waits on the owner: the node pays a route's fee itself, up to the owner's
//! per-fetch maximum (Settings).
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const App = @import("../app.zig").App;
const wallet = @import("wallet.zig");
const connect = @import("connect.zig");
const cloud = @import("cloud.zig");
const settings = @import("settings.zig");

pub fn view(a: *App, c: *ui.Context) void {
    {
        const h = look.header(c, "Agents", "Add Unbrowse to the agents you use: one click for the ones on this Mac, a few steps for ChatGPT and Claude on the web.");
        h.end();
    }
    setup(a, c);
    {
        const found = if (a.clients()) |cs| blk: {
            var n: usize = 0;
            for (cs) |cl| if (cl.found) {
                n += 1;
            };
            break :blk n;
        } else 0;
        const p = look.panel(c, "On this Mac", if (a.clients() == null) "Looking\u{2026}" else if (found == 1) "1 agent found" else c.print("{d} agents found", .{found}));
        defer p.end();
        look.panelBody(c);
        const b = look.pad(c);
        defer b.end();
        look.body(c, "Connect adds Unbrowse to each app you leave ticked, and keeps its settings file as it was, beside it: Undo puts them back.");
        {
            const sheet = ui.div(c).column().wFull().minW(0).border(look.x(c).hair).rounded(8).clip();
            defer sheet.end();
            connect.list(a, c);
        }
        if (a.err.len > 0) look.failText(c, a.err.get());
        connect.buttons(a, c);
    }
    {
        const on = if (a.store.get(.remote_status)) |r| r.on else false;
        const p = look.panel(c, cloud.title, if (on) "Address on" else "Address off");
        defer p.end();
        look.panelBody(c);
        const b = look.pad(c);
        defer b.end();
        cloud.view(a, c);
    }
    sites(a, c);
    // The keys, what each spent, and how another program connects are the advanced screens' (`App.advanced`); the basic
    // screen says what a call can cost in a line.
    if (!a.advanced()) {
        const max = if (a.store.get(.settings)) |s| s.max_fetch_usdc else 0.05;
        look.small(c, if (max > 0) c.print("Some sites charge for an answer. Unbrowse pays it from your balance, at most ${d} an answer, and each app has a daily limit (Money).", .{max}) else "Unbrowse uses only free answers and your own: paying for an answer is off (Settings).");
        return;
    }
    // The keys themselves, with what each spent today: add one, or revoke one.
    {
        const max = if (a.store.get(.settings)) |s| s.max_fetch_usdc else 0.05;
        const pays = if (max > 0) c.print("up to ${d} a fetch", .{max}) else "nothing (free routes only)";
        look.small(c, c.print("Each agent has its own key and never waits for you: the node pays another contributor's route fee from your balance itself, {s} (Settings), and each agent stays within its daily limit.", .{pays}));
    }
    wallet.keys(a, c);
    const port = a.port();
    const example = c.print(example_fmt, .{port});
    const p = look.panel(c, "Any other agent", c.print("127.0.0.1:{d}", .{port}));
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.body(c, "The node listens on this machine only. An agent searches for a route, has the node learn one when none fits, and calls it; a listed route's fee goes on the agent's voucher only if the call passes. Any other MCP client takes \"unb mcp --agent first\" as its server, and a script can send these requests:");
    look.well(c, typed(a, c, example));
    if (look.secondary(c, "Copy example requests", .{})) {
        c.clipboard.write(c.clipboard.ctx, example);
        a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
        a.cheer();
    }
}

/// The node's setup as one list (`setup_status`), the same an agent reads and acts on with unbrowse_setup: each step done
/// or not, in the node's own words. Shown while setup still needs something, or anything optional is left.
fn setup(a: *App, c: *ui.Context) void {
    const st = a.store.get(.setup_status) orelse return;
    var open: usize = 0;
    for (st.steps) |s| {
        if (!s.done) open += 1;
    }
    if (open == 0) return;
    const p = look.panel(c, "Your setup", if (st.left.len == 0) "Ready: the rest is optional" else c.print("{d} step{s} left", .{ st.left.len, if (st.left.len == 1) "" else "s" }));
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.small(c, "Your agents can do each of these for you too: they ask you here first, and never ask you to type a command.");
    for (st.steps) |s| {
        ui.key(c, s.id);
        const r = ui.div(c).row().wFull().gap(10).itemsStart();
        defer r.end();
        look.status(c, if (s.done) .ok else if (s.optional) .idle else .warn, stepName(s.id));
        const w = ui.div(c).column().grow().minW(0);
        defer w.end();
        look.small(c, s.said);
    }
}

/// A setup step's name, as the owner reads it.
fn stepName(id: []const u8) []const u8 {
    const names = [_][2][]const u8{
        .{ "terms", "Terms" },
        .{ "sign_in", "Signed in" },
        .{ "apps", "Agent apps" },
        .{ "tools", "Skill and commands" },
        .{ "web", "ChatGPT and Claude" },
        .{ "sites", "Sites" },
        .{ "first_call", "First call" },
    };
    for (names) |n| if (std.mem.eql(u8, n[0], id)) return n[1];
    return id;
}

/// Sites your agents can use signed in as you: a site's sign-in taken from your own browser (`import_session`), and the
/// sites the node holds one for (`sessions`).
fn sites(a: *App, c: *ui.Context) void {
    const held = a.store.get(.sessions) orelse &.{};
    const p = look.panel(c, "Sites your agents can use", if (held.len == 1) "1 site" else c.print("{d} sites", .{held.len}));
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.body(c, "Name a site you're signed in to in Chrome, Brave, Edge or another Chromium browser. Unbrowse copies that one site's sign-in, so your agents work there as you.");
    {
        const r = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer r.end();
        const res = ui.textField(c, &a.site_field, .{ .width = .fill, .placeholder = "github.com" });
        const host = settings.hostOf(c, a.site_field.text());
        if ((look.primary(c, "Connect site", .{ .disabled = host.len == 0, .loading = a.store.isBusy("site_connect"), .size = .md }) or res.submitted) and host.len > 0) {
            a.site_sent.set(host);
            a.site_err.len = 0;
            a.store.actWith(.site_connect, "site_connect", "import_session", .{ .host = host });
        }
    }
    if (a.site_err.len > 0) look.failText(c, a.site_err.get());
    if (held.len == 0) return look.small(c, "No site connected yet.");
    var line: std.ArrayList(u8) = .empty;
    for (held, 0..) |s, i| {
        if (i > 0) line.appendSlice(c.alloc(), ", ") catch {};
        line.appendSlice(c.alloc(), s.host) catch {};
    }
    look.small(c, c.print("Connected: {s}", .{line.items}));
}

/// How an agent that isn't in the list connects, for the screen to show and copy: the token is read as the line runs, so
/// no example hands it to an HTTP MCP client (which would send it to whatever answers there). The apps the window can
/// connect itself are the list's, not an example's.
pub const example_fmt =
    \\# Any other agent, or a script, on this machine (127.0.0.1:{d}). The token is read as the line runs, never written down:
    \\export UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
    \\unb do search Hacker News stories --url "https://hn.algolia.com/?q=rust"
    \\unb do search Hacker News stories q=tauri
    \\unb search hn stories
;

test "the window's example never hands an MCP client a bearer token" {
    var buf: [1024]u8 = undefined;
    const shown = try std.fmt.bufPrint(&buf, example_fmt, .{7788});
    try std.testing.expect(std.mem.indexOf(u8, shown, "Bearer") == null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "--transport") == null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "claude mcp add") == null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "127.0.0.1:7788") != null);
    // No token on a command line or in a config: the agent is named, and a shell reads the token as the line runs.
    try std.testing.expect(std.mem.indexOf(u8, shown, "--env UNBROWSE_AGENT_TOKEN") == null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "unb_") == null);
}

/// The example requests typing themselves out once the screen opens, 120 characters a second with a block caret, as
/// the landing's code does; whole at once with reduced motion. What is copied is always the whole of it.
fn typed(a: *App, c: *ui.Context, text: []const u8) []const u8 {
    if (c.reduced_motion or a.io == null) return text;
    const n: usize = @intFromFloat(@max(0, (a.now_ms - a.typed_from_ms) / 1000 * 120));
    if (n >= text.len) return text;
    c.frameIn(1.0 / 30.0);
    var end = n;
    while (end > 0 and text[end] & 0xC0 == 0x80) end -= 1;
    return c.print("{s}\u{2588}", .{text[0..end]});
}
