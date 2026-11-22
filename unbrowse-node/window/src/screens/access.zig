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

pub fn view(a: *App, c: *ui.Context) void {
    {
        const h = look.header(c, "Agents", "Add Unbrowse to the agents you use: one click for the ones on this Mac, a few steps for ChatGPT and Claude on the web.");
        h.end();
    }
    {
        const found = if (a.clients()) |cs| blk: {
            var n: usize = 0;
            for (cs) |cl| if (cl.found) {
                n += 1;
            };
            break :blk n;
        } else 0;
        const p = look.panel(c, "On this Mac", if (found == 1) "1 agent found" else c.print("{d} agents found", .{found}));
        defer p.end();
        look.panelBody(c);
        const b = look.pad(c);
        defer b.end();
        look.body(c, "Connect adds the node to each agent you leave ticked, and keeps each file as it was beside it: Undo puts them back.");
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
