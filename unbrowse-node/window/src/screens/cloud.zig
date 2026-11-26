//! ChatGPT and Claude on the web: what an owner who chats with an agent in a browser or on a phone does to have it use
//! this node. The node's own remote MCP address (`remote_set`, `remote.rs`) is turned on here, copied, and added to the
//! app as a custom connector by the steps below; the app's sign-in comes back to the owner as the node's own dialog,
//! and a yes makes the app a remote key of its own. Settings holds the same address with its keys.
//! It is the second step of the first run (screens/connect.zig) and a panel of the home screen (screens/access.zig).
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const App = @import("../app.zig").App;

pub const title = "ChatGPT and Claude on the web";
pub const intro = "If you chat with ChatGPT or Claude in a browser or on your phone, they can use Unbrowse on this Mac too, with your logins. Turn on an address for it at unbrowse.ai, then add it to the app as a custom connector. Unbrowse dials out, so no port opens on this Mac, and an app gets in only when you allow it here.";

/// Each app's steps, in the words its own settings use (claude.ai and chatgpt.com, November 2026).
pub const apps = [_][]const u8{ "Claude", "ChatGPT" };
pub const claude_steps = [_][]const u8{
    "Copy the address above.",
    "In Claude (claude.ai or the Claude app), open Customize, then Connectors.",
    "Click +, then Add custom connector.",
    "Name it Unbrowse, paste the address and click Add.",
    "Claude opens a sign-in: allow it when Unbrowse asks on this Mac.",
    "In a chat, turn on Unbrowse from the tools menu. It works in the Claude phone app too.",
};
pub const claude_note = "A free plan can add one custom connector. On a Team or Enterprise plan, an owner adds it under Organization settings, then each person connects.";
pub const chatgpt_steps = [_][]const u8{
    "Copy the address above.",
    "Open chatgpt.com/plugins in your browser.",
    "Click +, then Add custom MCP server.",
    "Name it Unbrowse, paste the address, choose OAuth, tick the box and click Create.",
    "ChatGPT opens a sign-in: allow it when Unbrowse asks on this Mac.",
    "In a new chat, type @ and pick Unbrowse.",
};
pub const chatgpt_note = "ChatGPT takes custom MCP servers on Business, Enterprise and Edu workspaces, added by an admin, on the web. Other plans may not show the option.";

/// The panel's contents: the address, off or on, and the steps for the app picked.
pub fn view(a: *App, c: *ui.Context) void {
    look.body(c, intro);
    const r = a.store.get(.remote_status) orelse return look.small(c, a.store.err(.remote_status) orelse "Reading…");
    if (r.public) return look.small(c, "This node is a public peer, which answers anyone with calls only: use your own node for ChatGPT and Claude.");
    if (!r.on or r.url == null) {
        ui.key(c, "cloud_on");
        if (look.primary(c, "Turn on the address", .{ .size = .md, .loading = a.store.isBusy("remote_set") })) a.store.actWith(.generic, "remote_set", "remote_set", .{ .on = true });
        return;
    }
    const url = r.url.?;
    look.label(c, "Your Unbrowse address");
    look.well(c, url);
    {
        const row = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer row.end();
        if (look.secondary(c, "Copy address", .{})) {
            c.clipboard.write(c.clipboard.ctx, url);
            a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
            a.cheer();
        }
        // Link this node to the owner's Unbrowse account: ChatGPT and Claude signed in to Unbrowse then reach it with no
        // address to paste. It also lets a sign-in ask, for an app being added by the address now.
        if (look.secondary(c, "Link to my Unbrowse account", .{ .loading = a.store.isBusy("remote_link") })) a.store.actWith(.remote_link, "remote_link", "remote_link", struct {}{});
    }
    _ = kit.tabs(c, &apps, &a.cloud_tab, .{ .variant = .segmented, .size = .sm });
    const steps: []const []const u8 = if (a.cloud_tab == 1) &chatgpt_steps else &claude_steps;
    const list = ui.div(c).column().wFull().gap(6);
    for (steps, 1..) |s, n| {
        ui.key(c, s);
        const row = ui.div(c).row().wFull().gap(8).itemsStart();
        defer row.end();
        ui.text(c, c.print("{d}.", .{n}), .{ .size = 13, .weight = .semibold, .color = look.x(c).text2 });
        const w = ui.div(c).column().grow().minW(0);
        defer w.end();
        look.body(c, s);
    }
    list.end();
    look.small(c, if (a.cloud_tab == 1) chatgpt_note else claude_note);
    look.small(c, "Allow only a sign-in you started yourself, just now. Each app you allow gets a key of its own that spends up to $5 a day and lasts 30 days. Settings lists them and revokes them.");
}

test "every step names a thing to click or do, and no step hands over a key" {
    for (claude_steps ++ chatgpt_steps) |s| {
        try std.testing.expect(s.len < 110);
        try std.testing.expect(std.mem.indexOf(u8, s, "unb_") == null);
        try std.testing.expect(std.mem.indexOf(u8, s, "token") == null);
    }
}
