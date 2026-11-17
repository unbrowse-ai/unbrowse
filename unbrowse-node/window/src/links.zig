//! `unbrowse://` links arriving from the system. A Mac sends a link to the app, running or just launched, through
//! `application:openURLs:`. nanoui keeps only file URLs there, so this puts its own in place of that one method: the
//! window opens no files, so nothing is lost. What a link names is the node's to say (`App.openLink`).
const std = @import("std");
const builtin = @import("builtin");
const nanoui = @import("nanoui");
const App = @import("app.zig").App;

const mac = builtin.os.tag == .macos;
const objc = nanoui.objc;

/// What a link can be at most: the node reads it and refuses the rest.
const max_link = 512;

pub fn isLink(s: []const u8) bool {
    const scheme = "unbrowse://";
    return s.len > scheme.len and s.len <= max_link and std.ascii.eqlIgnoreCase(s[0..scheme.len], scheme);
}

var target: ?*App = null;

extern "c" fn object_getClass(obj: objc.Object) objc.Class;
extern "c" fn sel_registerName(name: [*:0]const u8) objc.SEL;
extern "c" fn class_replaceMethod(cls: objc.Class, name: objc.SEL, imp: *const anyopaque, types: [*:0]const u8) ?*const anyopaque;

/// Takes the links the system sends to `app` for `a`. Call before `app.run`, which delivers the one that launched it.
pub fn listen(app: *nanoui.App, a: *App) void {
    if (!mac) return;
    target = a;
    _ = class_replaceMethod(object_getClass(app.delegate), sel_registerName("application:openURLs:"), &openURLs, "v@:@@");
}

fn openURLs(_: objc.Object, _: objc.SEL, _: objc.Object, urls: objc.Object) callconv(.c) void {
    const a = target orelse return;
    const pool = objc.Pool.push();
    defer pool.pop();
    const n = objc.msg(objc.NSUInteger, urls, "count", .{});
    var i: objc.NSUInteger = 0;
    while (i < n) : (i += 1) {
        const url = objc.msg(objc.Object, urls, "objectAtIndex:", .{i});
        const text = objc.fromNSString(objc.msg(?objc.Object, url, "absoluteString", .{}));
        if (isLink(text)) a.openLink(text);
    }
}

test "only an unbrowse link of a sane length is one" {
    try std.testing.expect(isLink("unbrowse://example.com"));
    try std.testing.expect(isLink("UNBROWSE://example.com"));
    try std.testing.expect(!isLink("unbrowse://"));
    try std.testing.expect(!isLink("https://example.com"));
    try std.testing.expect(!isLink("--web"));
    const long: [600]u8 = @splat('a');
    try std.testing.expect(!isLink("unbrowse://" ++ long));
}
