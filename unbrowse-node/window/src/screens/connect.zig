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
const art = @import("../art.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;
const cloud = @import("cloud.zig");

pub fn view(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    const page = ui.div(c).column().sizeFull().bg(x.canvas).px(32).pt(46).pb(28).itemsCenter();
    defer page.end();
    const col = ui.div(c).column().wFull().maxW(560).grow().gap(16);
    defer col.end();
    {
        const brand = ui.div(c).row().gap(8).itemsCenter();
        defer brand.end();
        art.mark(c, 24);
        ui.text(c, "Unbrowse", .{ .size = 17, .weight = .semibold });
    }
    if (a.connect_step > 0) return webStep(a, c);
    {
        const words = ui.div(c).column().wFull().gap(6);
        defer words.end();
        look.title(c, "Connect your agents");
        look.body(c, "Your agents use Unbrowse through the node on this Mac. Connecting adds it to each one you leave ticked, and Undo puts every file back as it was.");
    }
    {
        const sheet = ui.div(c).column().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(16).shadowMd().clip();
        defer sheet.end();
        list(a, c);
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const r = ui.div(c).row().wFull().gap(12).itemsCenter();
        defer r.end();
        const done = anyConnected(a);
        if (found_n(a) == 0) {
            // Nothing to connect here: ChatGPT and Claude on the web may still be what the owner uses.
            if (look.secondary(c, "Next", .{})) a.nextConnectStep();
        } else if (done) {
            if (look.primary(c, "Next", .{ .size = .md })) a.nextConnectStep();
        } else {
            if (connectButton(a, c)) a.sendConnect();
            // Leaving without connecting is allowed: it can be done later on the Agents screen.
            if (look.secondary(c, "Skip", .{})) a.nextConnectStep();
            look.small(c, "You can connect them later on the Agents screen.");
        }
    }
}

/// The first run's second step: ChatGPT and Claude on the web, for an owner who chats in a browser or on a phone.
fn webStep(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    look.title(c, "Use ChatGPT or Claude on the web?");
    {
        const sheet = ui.div(c).column().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(16).shadowMd().clip();
        defer sheet.end();
        const b = ui.div(c).column().wFull().p(16).gap(10);
        defer b.end();
        cloud.view(a, c);
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    const on = if (a.store.get(.remote_status)) |s| s.on else false;
    if (on) {
        if (look.primary(c, "Done", .{ .size = .md })) a.dismissConnect();
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
    if (look.secondary(c, "Undo", .{ .loading = a.store.isBusy("agent_connect_undo") })) a.undoConnect();
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

/// What a row says on its right, in plain words: what the last answer did for it, else that it is connected already.
fn rowWords(c: *ui.Context, cl: types.AgentClient, result: ?types.ConnectResult) ?[]const u8 {
    if (result) |r| {
        if (!r.ok) return r.@"error" orelse "It didn't work, and nothing was changed.";
        if (r.restart_needed) return c.print("Connected: quit and reopen {s}", .{cl.name});
        return "Connected";
    }
    return if (cl.connected) "Connected" else null;
}
