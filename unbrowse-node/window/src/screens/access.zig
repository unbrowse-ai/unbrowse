//! Agent access: the agents that can reach this node, each key's daily
//! limit and what it spent today (add one, revoke one), and how an agent
//! connects. No call waits on the owner: the node pays a route's fee
//! itself, up to the owner's per-fetch maximum (Settings).
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const App = @import("../app.zig").App;
const wallet = @import("wallet.zig");

pub fn view(a: *App, c: *ui.Context) void {
    {
        const max = if (a.store.get(.settings)) |s| s.max_fetch_usdc else 0.05;
        const pays = if (max > 0) c.print("up to ${d} a fetch", .{max}) else "nothing (free routes only)";
        const h = look.header(c, "Agent access", c.print("Agents reach this node on this machine with their own key, and never wait for you: the node pays another contributor's route fee from your balance itself, {s} (Settings), and each agent stays within its daily limit.", .{pays}));
        h.end();
    }
    const port = a.port();
    const example = c.print(example_fmt, .{port});
    // The keys themselves, with what each spent today: add one, or revoke one.
    wallet.keys(a, c);
    const p = look.panel(c, "How an agent connects", c.print("127.0.0.1:{d}", .{port}));
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.body(c, "The node listens on this machine only. An agent searches for a route, has the node learn one when none fits, and calls it; a listed route's fee goes on the agent's voucher only if the call passes.");
    look.well(c, typed(a, c, example));
    if (look.secondary(c, "Copy example requests", .{})) {
        c.clipboard.write(c.clipboard.ctx, example);
        a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
        a.cheer();
    }
}

/// How an agent connects, for the screen to show and copy: Claude Code starts `unb mcp`, which signs each request with
/// the token, so no example hands the token to an HTTP MCP client (which would send it to whatever answers there).
pub const example_fmt =
    \\# Claude Code: names the agent (its number, or first); let it in once, then add it (you are asked once):
    \\unb grant first
    \\claude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:{d} -- unb mcp --agent first
    \\
    \\# Any agent, or a script (the token is read as the line runs, never written down):
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
    try std.testing.expect(std.mem.indexOf(u8, shown, "-- unb mcp --agent first") != null);
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
