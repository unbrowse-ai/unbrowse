//! Activity: everything the node did, newest first, by kind,
//! with an export to CSV. The list is virtual: only rows in view are built.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;

const View = enum { all, calls, money, node };

fn in(v: View, kind: []const u8) bool {
    const eq = std.mem.eql;
    return switch (v) {
        .all => true,
        // "approval" lines are from before the node paid route fees by itself; they stay readable in the log.
        .calls => eq(u8, kind, "call") or eq(u8, kind, "approval"),
        // "bond" and "pledge" lines are from before route coins (the node still files its second look at a write it
        // sent as "bond"); they stay readable in the log.
        .money => for ([_][]const u8{ "deposit", "withdraw", "coin", "bounty", "bond", "pledge", "claim", "list", "body", "network" }) |k| {
            if (eq(u8, kind, k)) break true;
        } else false,
        .node => for ([_][]const u8{ "learn", "key", "vault" }) |k| {
            if (eq(u8, kind, k)) break true;
        } else false,
    };
}

fn kindWord(kind: []const u8) []const u8 {
    const words = [_][2][]const u8{
        .{ "call", "Route call" },  .{ "approval", "Approval" },  .{ "deposit", "Balance" },       .{ "withdraw", "Withdrawal" },
        .{ "bond", "Network record" }, .{ "pledge", "Network record" }, .{ "claim", "Usage collected" }, .{ "list", "Listing" },
        .{ "coin", "Route coin" },  .{ "bounty", "Bounty" },      .{ "learn", "Learning" },        .{ "key", "Agent key" },
        .{ "vault", "Vault" },
    };
    for (words) |w| if (std.mem.eql(u8, w[0], kind)) return w[1];
    return kind;
}

/// The token a line's amount is in. The node calls the field `unb` from before fees were USDC: every amount in it is
/// USDC (fees, deposits, claims), except a route coin's and a bounty's, and a bond line's from before route coins, which
/// are UNB (a coin claim's USDC is in its note).
pub fn unitOf(kind: []const u8) []const u8 {
    for ([_][]const u8{ "coin", "bounty", "bond", "pledge" }) |k| if (std.mem.eql(u8, kind, k)) return "UNB";
    return "USDC";
}

fn resultStatus(r: []const u8) look.Status {
    const eq = std.mem.eql;
    if (eq(u8, r, "failed") or eq(u8, r, "declined")) return .fail;
    if (eq(u8, r, "passed") or eq(u8, r, "done")) return .ok;
    return .idle;
}

const cols = [_]look.Col{
    .{ .name = "When", .w = 84, .end = true },
    .{ .name = "What" },
    .{ .name = "Kind", .w = 96 },
    .{ .name = "Amount", .w = 104, .end = true },
    .{ .name = "Result", .w = 96 },
    .{ .name = "Time", .w = 64, .end = true },
};

const row_h: f32 = 58;
/// Lines a page of Activity shows: more than a table's, since its rows are short and it scrolls them itself.
const per_page = 50;

pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const x = look.x(c);
    const all = a.store.list(.activity);
    const v: View = @enumFromInt(a.activity_tab);
    var rows: std.ArrayList(types.Activity) = .empty;
    var counts = [_]usize{ 0, 0, 0, 0 };
    for (all) |r| {
        for (0..4) |i| counts[i] += @intFromBool(in(@enumFromInt(i), r.kind));
        if (in(v, r.kind)) rows.append(fa, r) catch {};
    }
    {
        const h = look.header(c, "Activity", "Everything this node did: route calls with how they went, money that moved with its reference, what it learned. A call that failed is never charged.");
        defer h.end();
        if (look.secondary(c, "Export CSV", .{ .size = .md, .disabled = rows.items.len == 0 })) exportCsv(a, rows.items, v);
    }
    const names = [_][]const u8{
        c.print("All  {d}", .{counts[0]}),   c.print("Calls  {d}", .{counts[1]}),
        c.print("Money  {d}", .{counts[2]}), c.print("Node  {d}", .{counts[3]}),
    };
    if (kit.tabs(c, &names, &a.activity_tab, .{ .variant = .underline, .size = .sm })) a.activity_page = 0;
    // Fifty to a page, newest first; the pager sits under the list.
    const page = look.pageRowsBy(&a.activity_page, rows.items.len, per_page);
    defer look.pagerBy(c, "activity-pages", &a.activity_page, page, rows.items.len, per_page);
    const t = ui.div(c).column().wFull().grow().minW(0).bg(c.theme.surface).border(x.frame).rounded(12).clip();
    defer t.end();
    {
        const hd = ui.div(c).row().wFull().px(16).h(44).gap(8).itemsCenter();
        defer hd.end();
        ui.text(c, "Newest first", .{ .size = 14, .weight = .semibold });
        ui.text(c, fmt.count(fa, @floatFromInt(rows.items.len)), .{ .size = 12.5, .color = x.text3 });
    }
    look.rule(c);
    {
        const r = ui.div(c).row().wFull().px(16).py(8).gap(12).bg(x.well.alpha(0.6));
        defer r.end();
        for (cols) |col| {
            const cell = look.cellBox(c, col);
            defer cell.end();
            ui.text(c, col.name, .{ .size = 12, .weight = .medium, .color = x.text2 });
        }
    }
    if (rows.items.len == 0) {
        look.rule(c);
        return look.empty(c, "Nothing here yet.");
    }
    const shown = rows.items[page.from..page.to];
    var list = ui.list(c, .{ .count = shown.len, .row_height = row_h });
    while (list.next()) |i| row(a, c, shown[i]);
    list.end();
}

fn row(a: *App, c: *ui.Context, r: types.Activity) void {
    _ = a;
    const fa = c.alloc();
    const x = look.x(c);
    const failed = std.mem.eql(u8, r.result, "failed");
    var tr = ui.div(c).column().wFull().h(row_h);
    if (failed) tr = tr.bg(c.theme.danger.alpha(0.05));
    defer tr.end();
    look.rule(c);
    const inner = ui.div(c).row().wFull().px(16).py(8).gap(12).itemsStart().clip();
    defer inner.end();
    {
        const cell = look.cellBox(c, cols[0]);
        defer cell.end();
        look.figure(c, fmt.clock(fa, r.at), false);
        ui.text(c, fmt.date(fa, r.at), .{ .size = 11.5, .color = x.text3 });
    }
    {
        const cell = look.cellBox(c, cols[1]);
        defer cell.end();
        ui.text(c, r.what, .{ .size = 13, .weight = .medium });
        ui.text(c, c.print("{s} on {s}{s}{s}", .{ r.who, r.site, if (r.tx != null) " Ref. " else "", if (r.tx) |tx| fmt.short(fa, tx) else "" }), .{ .size = 11.5, .color = x.text3 });
        if (r.note) |n| ui.text(c, n, .{ .size = 11.5, .color = x.text2 });
    }
    {
        const cell = look.cellBox(c, cols[2]);
        defer cell.end();
        ui.text(c, kindWord(r.kind), .{ .size = 12.5, .color = x.text2 });
    }
    {
        const cell = look.cellBox(c, cols[3]);
        defer cell.end();
        if (r.unb) |u| look.figure(c, c.print("{s} {s}", .{ fmt.signed(fa, u), unitOf(r.kind) }), false) else look.figure(c, "None", true);
    }
    {
        const cell = look.cellBox(c, cols[4]);
        defer cell.end();
        look.status(c, resultStatus(r.result), fmt.capital(fa, r.result));
    }
    const cell = look.cellBox(c, cols[5]);
    defer cell.end();
    if (r.ms) |ms| look.figure(c, c.print("{s} ms", .{fmt.count(fa, ms)}), false) else look.figure(c, "None", true);
}

/// Writes the rows in view to a file the owner picks.
fn exportCsv(a: *App, rows: []const types.Activity, v: View) void {
    const io = a.io orelse return;
    const w = a.window orelse return;
    if (w.app.flags.hidden) return;
    const path = (nanoui.dialog.save(a.gpa, .{ .title = "Export activity", .name = @tagName(v), .extensions = &.{"csv"} }) catch return) orelse return;
    defer a.gpa.free(path);
    var out: std.Io.Writer.Allocating = .init(a.gpa);
    defer out.deinit();
    const wr = &out.writer;
    wr.writeAll("time,who,site,what,kind,result,ms,amount,unit,tx,note\n") catch return;
    for (rows) |r| {
        wr.print("{d},", .{r.at}) catch {};
        for ([_][]const u8{ r.who, r.site, r.what, r.kind, r.result }) |f| quote(wr, f);
        if (r.ms) |ms| wr.print("{d}", .{ms}) catch {};
        wr.writeByte(',') catch {};
        if (r.unb) |u| wr.print("{d}", .{u}) catch {};
        wr.writeByte(',') catch {};
        if (r.unb != null) wr.writeAll(unitOf(r.kind)) catch {};
        wr.writeByte(',') catch {};
        quote(wr, r.tx orelse "");
        wr.writeByte('"') catch {};
        for (r.note orelse "") |ch| (if (ch == '"') wr.writeAll("\"\"") else wr.writeByte(ch)) catch {};
        wr.writeAll("\"\n") catch {};
    }
    std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = out.written() }) catch {
        a.toaster.push(.{ .status = .danger, .title = "Couldn't write the file" });
        return;
    };
    a.toaster.push(.{ .status = .success, .title = "Exported", .message = std.fs.path.basename(path) });
}


fn quote(wr: *std.Io.Writer, s: []const u8) void {
    wr.writeByte('"') catch {};
    for (s) |ch| (if (ch == '"') wr.writeAll("\"\"") else wr.writeByte(ch)) catch {};
    wr.writeAll("\",") catch {};
}
