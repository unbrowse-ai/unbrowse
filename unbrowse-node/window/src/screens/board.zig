//! Leaderboard: contributors ranked by the paid fetches
//! their routes served, read from the chain's own logs. Stake never appears.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const App = @import("../app.zig").App;

const cols = [_]look.Col{
    .{ .name = "Rank", .w = 44, .end = true },
    .{ .name = "Contributor" },
    .{ .name = "Entries listed", .w = 96, .end = true },
    .{ .name = "Paid fetches", .w = 96, .end = true },
    .{ .name = "Sites", .w = 56, .end = true },
    .{ .name = "Earned", .w = 120, .end = true },
};

pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    {
        const h = look.header(c, "Leaderboard", "Contributors ranked by the paid fetches their routes served, computed from the network's public record, so anyone can recompute it.");
        h.end();
    }
    const rows = a.store.list(.board);
    const me = if (a.store.get(.wallet)) |w| w.address else "";
    {
        const t = look.tableHead(c, "All time", fmt.count(fa, @floatFromInt(rows.len)), &cols);
        defer t.end();
        if (a.store.err(.board)) |e| if (!a.store.loaded(.board)) {
            look.rule(c);
            const d = ui.div(c).wFull().p(16);
            defer d.end();
            look.failText(c, e);
        };
        if (rows.len == 0 and a.store.loaded(.board)) {
            look.rule(c);
            look.empty(c, "No routes listed on this network yet. List a route and it appears here once an agent pays for it.");
        }
        for (rows, 0..) |r, i| {
            const you = me.len > 0 and std.ascii.eqlIgnoreCase(me, r.contributor);
            var tr = look.tableRow(c, r.contributor, false);
            if (you) tr = tr.bg(look.x(c).selected);
            defer tr.end();
            {
                const cell = look.cellBox(c, cols[0]);
                defer cell.end();
                look.figure(c, c.print("{d}", .{i + 1}), false);
            }
            {
                const cell = look.cellBox(c, cols[1]);
                defer cell.end();
                const rr = ui.div(c).row().gap(8).itemsCenter();
                defer rr.end();
                look.mono(c, fmt.short(fa, r.contributor), c.theme.text);
                if (you) {
                    look.chip(c, "You", false);
                    if (look.ghost(c, "Your routes", .{})) a.go(.routes);
                }
            }
            inline for (.{ .{ 2, "entries" }, .{ 3, "lines" }, .{ 4, "sites" } }) |p| {
                const cell = look.cellBox(c, cols[p[0]]);
                defer cell.end();
                look.figure(c, fmt.count(fa, @field(r, p[1])), false);
            }
            const cell = look.cellBox(c, cols[5]);
            defer cell.end();
            look.figure(c, c.print("${s}", .{fmt.usdcd(fa, r.earned, 3)}), false);
        }
    }
    look.small(c, "Past amounts only, never a projection. Ranking counts paid fetches that passed; coin stakes and holdings never enter it.");
    entries(a, c);
}

const entry_cols = [_]look.Col{
    .{ .name = "Route" },
    .{ .name = "Entry", .w = 260 },
    .{ .name = "Contributor", .w = 120 },
    .{ .name = "Counted uses", .w = 96, .end = true },
    .{ .name = "Pass rate", .w = 80, .end = true },
    .{ .name = "Fee", .w = 110, .end = true },
};

/// R3.36: every live entry of every route on the chain, the default first, as the node ranks them from the chain's
/// own record of paid, passed uses. An entry under the evidence floor is tagged unverified; one no node served lately
/// is unavailable and isn't called.
fn entries(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const routes = a.store.list(.entries);
    var n: usize = 0;
    for (routes) |r| n += r.entries.len;
    {
        const t = look.tableHead(c, "Routes on the network", fmt.count(fa, @floatFromInt(n)), &entry_cols);
        defer t.end();
        if (a.store.err(.entries)) |e| if (!a.store.loaded(.entries)) {
            look.rule(c);
            const d = ui.div(c).wFull().p(16);
            defer d.end();
            look.failText(c, e);
        };
        if (routes.len == 0 and a.store.loaded(.entries)) {
            look.rule(c);
            look.empty(c, "No live routes on this network yet.");
        }
        for (routes) |r| {
            for (r.entries, 0..) |e, i| {
                var tr = look.tableRow(c, e.id, false);
                if (e.yours) tr = tr.bg(look.x(c).selected);
                defer tr.end();
                {
                    const cell = look.cellBox(c, entry_cols[0]);
                    defer cell.end();
                    if (i == 0) {
                        look.label(c, r.what);
                        look.small(c, r.site);
                    }
                }
                {
                    const cell = look.cellBox(c, entry_cols[1]);
                    defer cell.end();
                    const rr = ui.div(c).row().gap(6).itemsCenter();
                    defer rr.end();
                    look.mono(c, fmt.short(fa, e.id), c.theme.text);
                    if (e.default) look.chip(c, "Default", false);
                    if (e.unverified) look.chip(c, "Unverified", false);
                    if (e.unavailable) look.chip(c, "Unavailable", true);
                    if (e.yours) look.chip(c, "You", false);
                }
                {
                    const cell = look.cellBox(c, entry_cols[2]);
                    defer cell.end();
                    look.mono(c, fmt.short(fa, e.contributor), c.theme.text);
                }
                {
                    const cell = look.cellBox(c, entry_cols[3]);
                    defer cell.end();
                    look.figure(c, fmt.count(fa, e.counted_uses), false);
                }
                {
                    const cell = look.cellBox(c, entry_cols[4]);
                    defer cell.end();
                    look.figure(c, fmt.pct(fa, e.pass_rate, 0), false);
                }
                const cell = look.cellBox(c, entry_cols[5]);
                defer cell.end();
                look.figure(c, c.print("${s}", .{fmt.usdcd(fa, e.fee, 3)}), false);
            }
        }
    }
    look.small(c, "Each route's default is the entry agents are sent to first: the first to pass 30 counted uses keeps it until another is clearly better. A use counts when it was paid and passed, from a payer with a record that the entry's contributor doesn't fund or hold keys for. Unverified entries still get a small share of picks. Your node computes this from the network's public record itself; stake never enters it.");
}

pub fn dialogs(a: *App, c: *ui.Context) void {
    _ = a;
    _ = c;
}
