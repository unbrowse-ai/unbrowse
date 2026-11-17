//! What the node's browser shows while it walks a page: the latest picture
//! of the walk, fetched when the node says one is ready (a small `frame`
//! event) and decoded off the main thread into pixels the view draws as a
//! texture. One picture is held at a time; the last stays as the walk's
//! poster. Pictures are fetched only while the Live screen is open.
const std = @import("std");
const builtin = @import("builtin");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const api = @import("api.zig");
const types = @import("types.zig");
const Text = @import("live.zig").Text;

pub const Picture = struct {
    gpa: std.mem.Allocator,
    /// The walk shown, and which of its pictures.
    walk: Text = .{},
    seq: f64 = 0,
    settled: bool = false,
    /// Premultiplied BGRA, `w` × `h`.
    bgra: []u8 = &.{},
    w: u32 = 0,
    h: u32 = 0,
    /// The newest picture the node has told of, fetched when it can be.
    want: Text = .{},
    want_seq: f64 = 0,
    want_settled: bool = false,
    inflight: bool = false,

    pub fn deinit(p: *Picture) void {
        if (p.bgra.len > 0) p.gpa.free(p.bgra);
        p.bgra = &.{};
    }

    /// The node has a new picture of a walk.
    pub fn note(p: *Picture, scratch: std.mem.Allocator, data: []const u8) void {
        const n = std.json.parseFromSliceLeaky(types.FrameNote, scratch, data, types.parse_options) catch return;
        p.want.set(n.walk);
        p.want_seq = n.seq;
        p.want_settled = n.settled;
    }

    /// Whether the newest picture told of isn't the one shown.
    pub fn stale(p: *const Picture) bool {
        return p.want.len > 0 and (p.want_seq != p.seq or !std.mem.eql(u8, p.want.get(), p.walk.get()));
    }

    /// Fetches the newest picture on a background thread, if it isn't shown
    /// and none is on its way (a later one is fetched when it lands).
    pub fn fetch(p: *Picture, net: ?*api.Net, redraw: Redraw) void {
        const n = net orelse return;
        if (p.inflight or !p.stale()) return;
        const job = p.gpa.create(Job) catch return;
        job.* = .{ .pic = p, .net = n, .redraw = redraw, .walk = p.want, .seq = p.want_seq, .settled = p.want_settled };
        p.inflight = true;
        const t = std.Thread.spawn(.{ .stack_size = 1 << 20 }, Job.run, .{job}) catch {
            p.inflight = false;
            p.gpa.destroy(job);
            return;
        };
        t.detach();
    }

    /// Takes decoded pixels as the picture of `walk`.
    pub fn put(p: *Picture, walk: []const u8, seq: f64, settled: bool, bgra: []u8, w: u32, h: u32) void {
        p.deinit();
        p.walk.set(walk);
        p.seq = seq;
        p.settled = settled;
        p.bgra = bgra;
        p.w = w;
        p.h = h;
    }

    pub fn texture(p: *const Picture) ?ui.Texture {
        if (p.bgra.len == 0) return null;
        return .{ .width = p.w, .height = p.h, .bgra = p.bgra };
    }

    /// The shown picture is of `walk`.
    pub fn of(p: *const Picture, walk: []const u8) bool {
        return p.bgra.len > 0 and std.mem.eql(u8, p.walk.get(), walk);
    }
};

pub const Redraw = struct { ctx: *anyopaque, f: *const fn (ctx: *anyopaque) void };

const Job = struct {
    pic: *Picture,
    net: *api.Net,
    redraw: Redraw,
    walk: Text,
    seq: f64,
    settled: bool,
    bgra: []u8 = &.{},
    w: u32 = 0,
    h: u32 = 0,

    fn run(job: *Job) void {
        var arena: std.heap.ArenaAllocator = .init(job.pic.gpa);
        defer arena.deinit();
        var pbuf: [160]u8 = undefined;
        const path = std.fmt.bufPrint(&pbuf, "/owner/frame?walk={s}", .{job.walk.get()}) catch "";
        const r = job.net.get(arena.allocator(), path);
        if (r.status == 200) if (decode(job.pic.gpa, r.body)) |d| {
            job.bgra = d.bgra;
            job.w = d.w;
            job.h = d.h;
        } else |_| {};
        nanoui.App.onMain(job, done);
    }

    fn done(ctx: ?*anyopaque) callconv(.c) void {
        const job: *Job = @ptrCast(@alignCast(ctx));
        const p = job.pic;
        p.inflight = false;
        if (job.bgra.len > 0) p.put(job.walk.get(), job.seq, job.settled, job.bgra, job.w, job.h);
        // A newer picture was told of meanwhile: fetch it now.
        if (job.bgra.len > 0) p.fetch(job.net, job.redraw);
        job.redraw.f(job.redraw.ctx);
        p.gpa.destroy(job);
    }
};

// ---- JPEG to pixels, with ImageIO ----

const CFTypeRef = *anyopaque;
const CGRect = extern struct { x: f64, y: f64, w: f64, h: f64 };
extern "c" fn CFDataCreate(alloc: ?*anyopaque, bytes: [*]const u8, len: isize) ?CFTypeRef;
extern "c" fn CFRelease(obj: CFTypeRef) void;
extern "c" fn CGImageSourceCreateWithData(data: CFTypeRef, options: ?*anyopaque) ?CFTypeRef;
extern "c" fn CGImageSourceCreateImageAtIndex(src: CFTypeRef, index: usize, options: ?*anyopaque) ?CFTypeRef;
extern "c" fn CGImageGetWidth(img: CFTypeRef) usize;
extern "c" fn CGImageGetHeight(img: CFTypeRef) usize;
extern "c" fn CGImageRelease(img: CFTypeRef) void;
extern "c" fn CGColorSpaceCreateWithName(name: CFTypeRef) ?CFTypeRef;
extern "c" fn CGColorSpaceRelease(space: CFTypeRef) void;
extern "c" fn CGBitmapContextCreate(data: ?*anyopaque, w: usize, h: usize, bpc: usize, bpr: usize, space: CFTypeRef, info: u32) ?CFTypeRef;
extern "c" fn CGContextRelease(ctx: CFTypeRef) void;
extern "c" fn CGContextDrawImage(ctx: CFTypeRef, rect: CGRect, image: CFTypeRef) void;
extern "c" const kCGColorSpaceSRGB: CFTypeRef;

/// Premultiplied BGRA, as the renderers take it.
const bgra_premultiplied: u32 = 2 | (2 << 12);

pub const Decoded = struct { bgra: []u8, w: u32, h: u32 };

/// A picture as premultiplied BGRA: on the Mac anything ImageIO reads (the
/// node sends JPEG there), elsewhere a PNG, decoded here (png.zig; the node
/// sends PNG there: `screencast::FORMAT`). Pictures over 2048 pixels a
/// side are refused: the node sends at most 1280.
pub fn decode(gpa: std.mem.Allocator, bytes: []const u8) !Decoded {
    if (builtin.os.tag != .macos) {
        const d = try @import("png.zig").decode(gpa, bytes);
        return .{ .bgra = d.bgra, .w = d.w, .h = d.h };
    }
    const data = CFDataCreate(null, bytes.ptr, @intCast(bytes.len)) orelse return error.Data;
    defer CFRelease(data);
    const src = CGImageSourceCreateWithData(data, null) orelse return error.NotImage;
    defer CFRelease(src);
    const img = CGImageSourceCreateImageAtIndex(src, 0, null) orelse return error.NotImage;
    defer CGImageRelease(img);
    const w = CGImageGetWidth(img);
    const h = CGImageGetHeight(img);
    if (w == 0 or h == 0 or w > 2048 or h > 2048) return error.Size;
    const out = try gpa.alloc(u8, w * h * 4);
    errdefer gpa.free(out);
    @memset(out, 0);
    const space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB) orelse return error.ColorSpace;
    defer CGColorSpaceRelease(space);
    const ctx = CGBitmapContextCreate(out.ptr, w, h, 8, w * 4, space, bgra_premultiplied) orelse return error.Context;
    defer CGContextRelease(ctx);
    CGContextDrawImage(ctx, .{ .x = 0, .y = 0, .w = @floatFromInt(w), .h = @floatFromInt(h) }, img);
    return .{ .bgra = out, .w = @intCast(w), .h = @intCast(h) };
}

/// A picture of a page as the node sends it to the window on this machine:
/// a JPEG on the Mac, a PNG elsewhere (both taken from Chrome, 640 wide).
pub const test_frame = if (builtin.os.tag == .macos) @embedFile("testdata/frame.jpg") else @embedFile("testdata/frame.png");

test "a frame decodes to its pixels" {
    const d = try decode(std.testing.allocator, test_frame);
    defer std.testing.allocator.free(d.bgra);
    try std.testing.expectEqual(@as(u32, 640), d.w);
    try std.testing.expectEqual(@as(usize, d.w * d.h * 4), d.bgra.len);
    try std.testing.expectError(error.NotImage, decode(std.testing.allocator, "not a picture"));
}
