//! What an `unbrowse://` link names (`App.openLink`). A link can come from any page, so this shows and offers nothing
//! to press but Close: an agent or the owner calls a route on purpose, not by following a link.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;

pub fn dialogs(a: *App, c: *ui.Context) void {
    if (a.dialog == .open_link) linkDialog(a, c);
}

fn linkDialog(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const x = look.x(c);
    const preview: ?types.LinkPreview = if (a.link) |text| std.json.parseFromSliceLeaky(types.LinkPreview, fa, text, types.parse_options) catch null else null;
    const d = kit.dialog(c, "open-link", &a.dialog_open, .{ .title = if (preview) |p| p.site else "Unbrowse link", .description = "Nothing has been called or paid.", .ok = "", .cancel = "" }) orelse return;
    if (a.err.len > 0) look.failText(c, a.err.get());
    if (preview) |p| {
        if (p.unavailable) |why| look.failText(c, c.print("This node can't prove other nodes' routes: {s}", .{why}));
        if (p.routes.len == 0 and p.unavailable == null) look.body(c, "No route on the network matches this link.");
        for (p.routes, 0..) |r, i| {
            ui.key(c, c.print("route-{d}", .{i}));
            const row = ui.div(c).column().wFull().gap(2);
            defer row.end();
            look.body(c, if (r.remote) r.listed_as.what else r.what);
            ui.text(c, if (r.remote) c.print("{s} USDC to fetch, listed by {s}. In the lister's words, unchecked.", .{ fmt.usdc(fa, r.fee), r.contributor }) else "Your route", .{ .size = 11.5, .color = x.text2, .wrap = true });
        }
    } else if (a.err.len == 0) look.small(c, "Looking on the network");
    ui.text(c, a.target.get(), .{ .size = 11.5, .mono = true, .wrap = true, .color = x.text2 });
    {
        const f = ui.div(c).row().wFull().gap(8).justifyEnd().pt(4);
        defer f.end();
        if (look.secondary(c, "Close", .{ .size = .md })) a.close();
    }
    _ = d.end();
}
