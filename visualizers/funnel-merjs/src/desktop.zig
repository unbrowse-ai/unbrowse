const std = @import("std");
const mer = @import("mer");

extern fn objc_getClass(name: [*:0]const u8) ?*anyopaque;
extern fn sel_registerName(name: [*:0]const u8) ?*anyopaque;
extern fn objc_msgSend() void;

const Id = ?*anyopaque;
const Sel = ?*anyopaque;
const CGFloat = f64;
const CGPoint = extern struct { x: CGFloat, y: CGFloat };
const CGSize = extern struct { width: CGFloat, height: CGFloat };
const CGRect = extern struct { origin: CGPoint, size: CGSize };
const NSUInteger = c_ulong;
const NSInteger = c_long;
const BOOL = i8;

const NSWindowStyleMaskTitled: NSUInteger = 1;
const NSWindowStyleMaskClosable: NSUInteger = 2;
const NSWindowStyleMaskMiniaturizable: NSUInteger = 4;
const NSWindowStyleMaskResizable: NSUInteger = 8;
const NSWindowStyleMaskFullSizeContentView: NSUInteger = 32768;
const NSBackingStoreBuffered: NSUInteger = 2;
const NSApplicationActivationPolicyRegular: NSInteger = 0;
const NSFloatingWindowLevel: NSInteger = 3;
const YES: BOOL = 1;
const NO: BOOL = 0;

fn cls(name: [*:0]const u8) Id {
    return objc_getClass(name);
}

fn sel(name: [*:0]const u8) Sel {
    return sel_registerName(name);
}

fn send(recv: Id, s: Sel) Id {
    const F = *const fn (Id, Sel) callconv(.c) Id;
    return @as(F, @ptrCast(&objc_msgSend))(recv, s);
}

fn sendv(recv: Id, s: Sel) void {
    const F = *const fn (Id, Sel) callconv(.c) void;
    @as(F, @ptrCast(&objc_msgSend))(recv, s);
}

fn send1(recv: Id, s: Sel, a: Id) Id {
    const F = *const fn (Id, Sel, Id) callconv(.c) Id;
    return @as(F, @ptrCast(&objc_msgSend))(recv, s, a);
}

fn send1v(recv: Id, s: Sel, a: Id) void {
    const F = *const fn (Id, Sel, Id) callconv(.c) void;
    @as(F, @ptrCast(&objc_msgSend))(recv, s, a);
}

fn send2v(recv: Id, s: Sel, a: Id, b: Id) void {
    const F = *const fn (Id, Sel, Id, Id) callconv(.c) void;
    @as(F, @ptrCast(&objc_msgSend))(recv, s, a, b);
}

fn sendStr(recv: Id, s: Sel, str: [*:0]const u8) Id {
    const F = *const fn (Id, Sel, [*:0]const u8) callconv(.c) Id;
    return @as(F, @ptrCast(&objc_msgSend))(recv, s, str);
}

fn sendBool(recv: Id, s: Sel, a: BOOL) Id {
    const F = *const fn (Id, Sel, BOOL) callconv(.c) Id;
    return @as(F, @ptrCast(&objc_msgSend))(recv, s, a);
}

fn sendIntv(recv: Id, s: Sel, a: NSInteger) void {
    const F = *const fn (Id, Sel, NSInteger) callconv(.c) void;
    @as(F, @ptrCast(&objc_msgSend))(recv, s, a);
}

fn sendBoolv(recv: Id, s: Sel, a: BOOL) void {
    const F = *const fn (Id, Sel, BOOL) callconv(.c) void;
    @as(F, @ptrCast(&objc_msgSend))(recv, s, a);
}

fn sendWindowInit(recv: Id, s: Sel, rect: CGRect, style: NSUInteger, backing: NSUInteger, defer_: BOOL) Id {
    const F = *const fn (Id, Sel, CGRect, NSUInteger, NSUInteger, BOOL) callconv(.c) Id;
    return @as(F, @ptrCast(&objc_msgSend))(recv, s, rect, style, backing, defer_);
}

fn sendWebViewInit(recv: Id, s: Sel, frame: CGRect, config: Id) Id {
    const F = *const fn (Id, Sel, CGRect, Id) callconv(.c) Id;
    return @as(F, @ptrCast(&objc_msgSend))(recv, s, frame, config);
}

const ServerCtx = struct {
    ready: mer.ServerReady = .{},
    allocator: std.mem.Allocator,
};

const DesktopConfig = struct {
    path: []const u8 = "/json-render",
    transparent: bool = false,
    always_on_top: bool = false,
};

fn runServer(ctx: *ServerCtx) void {
    var router = mer.Router.fromGenerated(ctx.allocator, @import("routes"));
    defer router.deinit();

    var server = mer.Server.init(ctx.allocator, .{
        .host = "127.0.0.1",
        .port = 0,
        .dev = false,
        .ready = &ctx.ready,
    }, &router, null);

    server.listen() catch |err| {
        std.log.err("desktop server failed: {}", .{err});
        ctx.ready.event.set();
    };
}

pub fn main() !void {
    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .{};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    mer.loadDotenv(allocator);
    const desktop = try parseDesktopConfig(allocator);

    const ctx = try allocator.create(ServerCtx);
    ctx.* = .{ .allocator = allocator };

    const thread = try std.Thread.spawn(.{}, runServer, .{ctx});
    thread.detach();

    ctx.ready.event.wait();
    const port = ctx.ready.port;
    if (port == 0) return error.ServerFailed;

    var url_buf: [512]u8 = undefined;
    const url_str = try std.fmt.bufPrintZ(&url_buf, "http://127.0.0.1:{d}{s}", .{ port, desktop.path });

    const app = send(cls("NSApplication"), sel("sharedApplication"));
    sendIntv(app, sel("setActivationPolicy:"), NSApplicationActivationPolicyRegular);

    const frame = CGRect{
        .origin = .{ .x = 0, .y = 0 },
        .size = .{ .width = 1440, .height = 960 },
    };
    const style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
        NSWindowStyleMaskFullSizeContentView;
    const window = sendWindowInit(
        send(cls("NSWindow"), sel("alloc")),
        sel("initWithContentRect:styleMask:backing:defer:"),
        frame,
        style,
        NSBackingStoreBuffered,
        NO,
    );
    const title = sendStr(cls("NSString"), sel("stringWithUTF8String:"), "Unbrowse Visual Lab");
    send1v(window, sel("setTitle:"), title);
    sendBoolv(window, sel("setTitlebarAppearsTransparent:"), YES);
    sendBoolv(window, sel("setMovableByWindowBackground:"), YES);
    sendIntv(window, sel("setTitleVisibility:"), 1);

    if (desktop.transparent) {
        const clear = send(cls("NSColor"), sel("clearColor"));
        sendBoolv(window, sel("setOpaque:"), NO);
        send1v(window, sel("setBackgroundColor:"), clear);
    }
    if (desktop.always_on_top) {
        sendIntv(window, sel("setLevel:"), NSFloatingWindowLevel);
    }

    const wkconfig = send(
        send(cls("WKWebViewConfiguration"), sel("alloc")),
        sel("init"),
    );
    const webview = sendWebViewInit(
        send(cls("WKWebView"), sel("alloc")),
        sel("initWithFrame:configuration:"),
        frame,
        wkconfig,
    );

    if (desktop.transparent) {
        const clear = send(cls("NSColor"), sel("clearColor"));
        const no_value = sendBool(cls("NSNumber"), sel("numberWithBool:"), NO);
        const draws_background = sendStr(cls("NSString"), sel("stringWithUTF8String:"), "drawsBackground");
        sendBoolv(webview, sel("setOpaque:"), NO);
        send1v(webview, sel("setBackgroundColor:"), clear);
        send2v(webview, sel("setValue:forKey:"), no_value, draws_background);
    }
    send1v(window, sel("setContentView:"), webview);

    const ns_url_str = sendStr(cls("NSString"), sel("stringWithUTF8String:"), url_str.ptr);
    const url = send1(cls("NSURL"), sel("URLWithString:"), ns_url_str);
    const request = send1(cls("NSURLRequest"), sel("requestWithURL:"), url);
    _ = send1(webview, sel("loadRequest:"), request);

    send1v(window, sel("makeKeyAndOrderFront:"), null);
    sendBoolv(app, sel("activateIgnoringOtherApps:"), YES);
    sendv(app, sel("run"));
}

fn parseDesktopConfig(allocator: std.mem.Allocator) !DesktopConfig {
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    var config: DesktopConfig = .{};
    if (mer.env("UNBROWSE_VISUAL_PATH")) |path| {
        config.path = path;
    }
    if (mer.env("UNBROWSE_VISUAL_TRANSPARENT")) |flag| {
        config.transparent = eqlTrue(flag);
    }
    if (mer.env("UNBROWSE_VISUAL_ALWAYS_ON_TOP")) |flag| {
        config.always_on_top = eqlTrue(flag);
    }

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--path") and i + 1 < args.len) {
            config.path = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--session-id") and i + 1 < args.len) {
            config.path = try std.fmt.allocPrint(allocator, "/viz?id={s}", .{args[i + 1]});
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--overlay") and i + 1 < args.len) {
            config.path = try std.fmt.allocPrint(allocator, "/viz?id={s}&overlay=1", .{args[i + 1]});
            config.transparent = true;
            config.always_on_top = true;
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--transparent")) {
            config.transparent = true;
        } else if (std.mem.eql(u8, args[i], "--always-on-top")) {
            config.always_on_top = true;
        }
    }

    return config;
}

fn eqlTrue(value: []const u8) bool {
    return std.mem.eql(u8, value, "1") or
        std.ascii.eqlIgnoreCase(value, "true") or
        std.ascii.eqlIgnoreCase(value, "yes");
}
