//! The Unbrowse window: a native view of the node running on this machine.
//! It talks to the node over 127.0.0.1 with the owner's token, starts the
//! node if nothing answers, and leaves it running when it closes: agents
//! keep working without the window.
const std = @import("std");
const builtin = @import("builtin");
const nanoui = @import("nanoui");
const api = @import("api.zig");
const fmt = @import("fmt.zig");
const App = @import("app.zig").App;
const shell = @import("shell.zig");
const links = @import("links.zig");

/// The window only ever speaks plain HTTP to 127.0.0.1.
pub const std_options: std.Options = .{ .http_disable_tls = true };

const Tm = extern struct {
    sec: c_int,
    min: c_int,
    hour: c_int,
    mday: c_int,
    mon: c_int,
    year: c_int,
    wday: c_int,
    yday: c_int,
    isdst: c_int,
    gmtoff: c_long,
    zone: ?[*:0]const u8,
};
extern "c" fn time(t: ?*c_long) c_long;
extern "c" fn localtime_r(t: *const c_long, out: *Tm) ?*Tm;

const TimeZone = extern struct {
    bias: c_long,
    standard_name: [32]u16,
    standard_date: [8]u16,
    standard_bias: c_long,
    daylight_name: [32]u16,
    daylight_date: [8]u16,
    daylight_bias: c_long,
};
extern "kernel32" fn GetTimeZoneInformation(tz: *TimeZone) callconv(.winapi) u32;

/// Seconds east of UTC, for the local times the screens show.
fn localOffset() i64 {
    if (builtin.os.tag == .windows) {
        var tz: TimeZone = undefined;
        // 2: daylight saving time is in effect. Windows' bias is minutes west.
        const id = GetTimeZoneInformation(&tz);
        if (id == 0xffffffff) return 0;
        const bias: i64 = tz.bias + if (id == 2) tz.daylight_bias else tz.standard_bias;
        return -bias * 60;
    }
    var now = time(null);
    var tm: Tm = undefined;
    _ = localtime_r(&now, &tm) orelse return 0;
    return tm.gmtoff;
}

var state: App = undefined;
var net: api.Net = undefined;

/// The U-magnet in the Dock (app/icons/icon.png). Unbrowse.app names its own icon; a window run from zig-out has no
/// bundle to name one, so it sets it here either way.
fn dockIcon() void {
    if (@import("builtin").os.tag != .macos) return;
    const objc = nanoui.objc;
    const png = @embedFile("app_icon");
    const data = objc.msg(objc.Object, objc.class("NSData"), "dataWithBytes:length:", .{ png.ptr, png.len });
    const image = objc.msg(?objc.Object, objc.alloc("NSImage"), "initWithData:", .{data}) orelse return;
    const nsapp = objc.msg(objc.Object, objc.class("NSApplication"), "sharedApplication", .{});
    objc.msg(void, nsapp, "setApplicationIconImage:", .{image});
    objc.release(image);
}

pub fn main(init: std.process.Init) !void {
    // Jobs may still be out when the window closes: no leak checks at exit.
    const gpa = std.heap.smp_allocator;
    fmt.setOffset(localOffset());
    const home = init.environ_map.get("HOME") orelse init.environ_map.get("USERPROFILE") orelse ".";
    var exe_buf: [1024]u8 = undefined;
    const n = std.process.executableDirPath(init.io, &exe_buf) catch 0;
    try net.init(init.arena.allocator(), init.io, home, try init.arena.allocator().dupe(u8, exe_buf[0..n]));
    net.gpa = gpa;
    net.client.allocator = gpa;

    const app = try nanoui.App.create(init, .{ .name = "Unbrowse", .quit_on_last_window_closed = true });
    defer app.destroy();
    dockIcon();

    const args = try init.minimal.args.toSlice(init.arena.allocator());

    state.init(gpa, init.io, &net);
    defer state.deinit();

    state.window = try app.newWindow(.{
        .title = "Unbrowse",
        .width = 1180,
        .height = 780,
        .min_width = 860,
        .min_height = 560,
        .title_bar = .hidden,
        .content = .{ .view = .init(&state, shell.view) },
    });
    // `--screen=live` opens on that screen (for measuring a screen at rest).
    for (args) |arg| {
        if (std.mem.startsWith(u8, arg, "--screen=")) {
            if (std.meta.stringToEnum(@import("app.zig").Screen, arg["--screen=".len..])) |s| state.go(s);
        }
    }
    try state.store.listen();
    state.refresh();
    links.listen(app, &state);
    // Linux and Windows hand a link to a new process as an argument; a Mac sends it to the running app.
    for (args) |arg| if (links.isLink(arg)) state.openLink(arg);
    try app.run();
}
