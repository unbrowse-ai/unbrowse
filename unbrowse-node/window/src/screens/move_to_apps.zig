//! Move to Applications: the one screen shown when the window runs from the disk image it was downloaded in (or from
//! the temporary place macOS runs a quarantined app from). Registering agents, or starting the node, from there would
//! point them at a path that is gone once the disk image is ejected, so nothing else is shown until the app has been
//! copied to Applications and opened from there. The path logic is a pure function so it is tested without a Mac.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const art = @import("../art.zig");
const App = @import("../app.zig").App;

/// The `.app` folder to copy when the program at `exe` (its path, or the folder it is in) runs from a place that does not
/// last: a mounted disk image (`/Volumes/...`) or the read-only copy macOS runs a quarantined app from
/// (`.../AppTranslocation/...`). Null when the path is a lasting one, or holds no `.app` folder to copy.
pub fn decide(exe: []const u8) ?[]const u8 {
    const unstable = std.mem.startsWith(u8, exe, "/Volumes/") or std.mem.indexOf(u8, exe, "/AppTranslocation/") != null;
    if (!unstable) return null;
    return bundleOf(exe);
}

/// The `.app` folder `exe` sits in (`.../Unbrowse.app/Contents/MacOS/unbrowse-window`), if it sits in one.
pub fn bundleOf(exe: []const u8) ?[]const u8 {
    if (std.mem.lastIndexOf(u8, exe, ".app/")) |i| return exe[0 .. i + 4];
    if (std.mem.endsWith(u8, exe, ".app")) return exe;
    return null;
}

test "a window run from the disk image or the quarantine copy must move, one in Applications stays" {
    const t = std.testing;
    try t.expectEqualStrings("/Volumes/Unbrowse/Unbrowse.app", decide("/Volumes/Unbrowse/Unbrowse.app/Contents/MacOS/unbrowse-window").?);
    try t.expectEqualStrings("/private/var/folders/x/AppTranslocation/y/d/Unbrowse.app", decide("/private/var/folders/x/AppTranslocation/y/d/Unbrowse.app/Contents/MacOS/unbrowse-window").?);
    try t.expect(decide("/Applications/Unbrowse.app/Contents/MacOS/unbrowse-window") == null);
    try t.expect(decide("/Users/me/Applications/Unbrowse.app/Contents/MacOS/unbrowse-window") == null);
    // The folder the program is in, which is what the window knows of itself, decides the same way.
    try t.expectEqualStrings("/Volumes/Unbrowse 1/Unbrowse.app", decide("/Volumes/Unbrowse 1/Unbrowse.app/Contents/MacOS").?);
    try t.expect(decide("/Applications/Unbrowse.app/Contents/MacOS") == null);
    // A bare program on the image has no bundle to copy: nothing to offer.
    try t.expect(decide("/Volumes/Unbrowse/unbrowse-window") == null);
}

pub fn view(a: *App, c: *ui.Context) void {
    const x = look.x(c);
    const page = ui.div(c).column().sizeFull().bg(x.canvas).px(32).pt(46).pb(28).itemsCenter().justifyCenter();
    defer page.end();
    const col = ui.div(c).column().wFull().maxW(440).gap(16).itemsCenter();
    defer col.end();
    art.mark(c, 40);
    look.title(c, "Unbrowse");
    look.body(c, "Unbrowse has to live in your Applications folder before it can connect your agents. This copies it there and opens it again.");
    if (a.move_err.len > 0) look.failText(c, a.move_err.get());
    if (look.primary(c, "Move to Applications", .{ .size = .md, .loading = a.move_busy })) a.moveToApplications();
}
