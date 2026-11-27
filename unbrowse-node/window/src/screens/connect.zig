//! Connect your agents: the agent apps the node found on this Mac, each ticked, and one button that writes the node's
//! `unbrowse` entry into every ticked one; then, as a second step, ChatGPT and Claude on the web (screens/cloud.zig).
//! It stands in front of the normal screens once, after the terms, while no agent is connected, and its list is the
//! Agents screen's too (`list`, `buttons`).
//! The node does the writing (`agent_connect`) and keeps the originals aside (`agent_connect_undo`); this screen only
//! says what it found and what it did, in words an owner who has never opened a terminal can follow.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;
const cloud = @import("cloud.zig");

/// The apps step of setting up (screens/onboarding.zig): the AI apps found on this computer, each ticked, and one button
/// that connects them; with none found, straight on to ChatGPT and Claude on the web.
pub fn appsBody(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    {
        const words = ui.div(c).column().wFull().gap(8);
        defer words.end();
        look.title(c, "Connect your AI apps");
        look.body(c, if (found_n(a) == 0 and a.clients() != null)
            "No AI app was found on this computer. If you use ChatGPT or Claude in a browser or on your phone, that's next."
        else
            "Tick the apps you use. Connecting adds Unbrowse to each one and keeps its settings file as it was, beside it: Undo puts them all back.");
    }
    if (found_n(a) > 0 or a.clients() == null) {
        const sheet = ui.div(c).column().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(14).shadowMd().clip();
        defer sheet.end();
        list(a, c);
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    if (found_n(a) == 0) {
        if (look.primary(c, "Next", .{ .size = .md })) a.nextConnectStep();
    } else if (anyConnected(a)) {
        if (look.primary(c, "Next", .{ .size = .md })) a.nextConnectStep();
    } else {
        if (connectButton(a, c)) a.sendConnect();
        // Leaving without connecting is allowed: the Agents screen keeps the same list.
        if (look.secondary(c, "Skip", .{})) a.nextConnectStep();
        look.small(c, "You can connect them later on the Agents screen.");
    }
}

/// The web step of setting up: ChatGPT and Claude in a browser or on a phone, by this node's address and the owner's
/// Unbrowse account.
pub fn webBody(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    look.title(c, "Use ChatGPT or Claude on the web?");
    {
        const sheet = ui.div(c).column().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(14).shadowMd().clip();
        defer sheet.end();
        const b = ui.div(c).column().wFull().p(16).gap(10);
        defer b.end();
        cloud.view(a, c);
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    if (look.secondary(c, "Back", .{})) a.onboardGo(.back, .web);
    const on = if (a.store.get(.remote_status)) |s| s.on else false;
    if (on) {
        if (look.primary(c, "Next", .{ .size = .md })) a.dismissConnect();
    } else if (look.secondary(c, "Not now", .{})) a.dismissConnect();
    look.small(c, "It stays on the Agents screen for later.");
}

/// Whether the last answer connected something, or something already was.
fn anyConnected(a: *App) bool {
    if (a.clients()) |cs| for (cs) |cl| if (cl.found and cl.connected) return true;
    for (a.connect_results) |r| if (r.ok) return true;
    return false;
}

fn found_n(a: *App) usize {
    var n: usize = 0;
    if (a.clients()) |cs| for (cs) |cl| if (cl.found) {
        n += 1;
    };
    return n;
}

/// The Connect button, pressed or not: disabled while nothing ticked is left to connect, spinning while the node writes.
pub fn connectButton(a: *App, c: *ui.Context) bool {
    var any = false;
    if (a.clients()) |cs| for (cs, 0..) |cl, i| {
        if (a.connectable(cl) and a.connectTicked(i)) any = true;
    };
    return look.primary(c, "Connect", .{ .size = .md, .disabled = !any, .loading = a.store.isBusy("agent_connect") });
}

/// The Connect and Undo buttons of the Agents screen.
pub fn buttons(a: *App, c: *ui.Context) void {
    const r = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer r.end();
    if (connectButton(a, c)) a.sendConnect();
    // Undo puts back what Connect changed: with nothing connected, there is nothing to put back.
    if (look.secondary(c, "Undo", .{ .disabled = !anyConnected(a), .loading = a.store.isBusy("agent_connect_undo") })) a.undoConnect();
    if (a.connect_undone.len > 0) look.small(c, undoneWords(a, c));
}

/// What Undo put back, as a line: "Put back Cursor and Codex."
fn undoneWords(a: *App, c: *ui.Context) []const u8 {
    var line: std.ArrayList(u8) = .empty;
    line.appendSlice(c.alloc(), "Put back ") catch return "Put back.";
    for (a.connect_undone, 0..) |u, i| {
        if (i > 0) line.appendSlice(c.alloc(), if (i + 1 == a.connect_undone.len) " and " else ", ") catch {};
        line.appendSlice(c.alloc(), u.name) catch {};
    }
    line.append(c.alloc(), '.') catch {};
    return line.items;
}

/// One row for each client found on this Mac, and a line saying so when there is none.
pub fn list(a: *App, c: *ui.Context) void {
    const cs = a.clients() orelse {
        look.empty(c, "Looking for agents on this Mac…");
        return;
    };
    var shown: usize = 0;
    for (cs, 0..) |cl, i| {
        if (!cl.found) continue;
        if (shown > 0) look.rule(c);
        shown += 1;
        row(a, c, cl, i);
    }
    if (shown == 0) look.empty(c, "No agent found on this Mac yet.");
}

fn row(a: *App, c: *ui.Context, cl: types.AgentClient, i: usize) void {
    ui.key(c, cl.id);
    const r = ui.div(c).row().wFull().px(16).py(12).gap(12).itemsCenter();
    defer r.end();
    const result = a.connectResult(cl.id);
    {
        const words = ui.div(c).column().grow().minW(0).gap(2);
        defer words.end();
        if (a.connectable(cl)) {
            var on = a.connectTicked(i);
            if (ui.checkbox(c, cl.name, &on) and i < a.connect_off.len) a.connect_off[i] = !on;
        } else ui.text(c, cl.name, .{ .size = 13.5, .weight = .medium });
        if (cl.note) |note| if (note.len > 0) look.small(c, note);
    }
    if (rowWords(c, cl, result)) |w| {
        const failed = if (result) |res| !res.ok else false;
        if (failed) look.failText(c, w) else ui.text(c, w, .{ .size = 13, .color = look.x(c).text2 });
    }
}

/// What a row says on its right, in plain words: what the last answer did for it, else that it is connected, and
/// whether the app has reached Unbrowse since. Connecting writes a file the app reads when it starts: until it has, the
/// owner is told what finishes it.
fn rowWords(c: *ui.Context, cl: types.AgentClient, result: ?types.ConnectResult) ?[]const u8 {
    if (result) |r| if (!r.ok) return r.@"error" orelse "It didn't work, and nothing was changed.";
    const connected = cl.connected or if (result) |r| r.ok else false;
    if (!connected) return null;
    if (cl.heard != null) return "Connected: it reached Unbrowse";
    if (result) |r| if (r.restart_needed) return c.print("Connected: quit and reopen {s}", .{cl.name});
    return c.print("Connected: open {s} to start using it", .{cl.name});
}
