//! The owner's hands on a site's browser: each click, key and scroll on its
//! picture goes to the node in the order it was done, one at a time, so
//! what is typed reaches the page as typed. The queue lives on the main
//! thread; a worker sends one command and hands back for the next. What is
//! sent may be a password's characters: wiped once sent.
const std = @import("std");
const nanoui = @import("nanoui");
const api = @import("api.zig");
const store_mod = @import("store.zig");
const Text = @import("live.zig").Text;

pub const Sender = struct {
    gpa: std.mem.Allocator,
    store: *store_mod.Store,
    queue: std.ArrayList(Item) = .empty,
    inflight: bool = false,
    /// The last command the node refused, said under the picture.
    err: Text = .{},
    redraw: ?Redraw = null,

    const Item = struct { cmd: []const u8, body: []u8 };

    pub fn deinit(s: *Sender) void {
        for (s.queue.items) |it| s.wipe(it.body);
        s.queue.deinit(s.gpa);
    }

    fn wipe(s: *Sender, body: []u8) void {
        std.crypto.secureZero(u8, body);
        s.gpa.free(body);
    }

    /// Sends owner command `cmd` with `args` after everything sent before it.
    /// `cmd` is a literal: it outlives the queue.
    pub fn send(s: *Sender, comptime cmd: []const u8, args: anytype) void {
        const body = std.json.Stringify.valueAlloc(s.gpa, args, .{}) catch return;
        // No node behind the store (tests): the store's log has it.
        if (s.store.net == null) {
            s.store.act(.generic, "", cmd, body);
            s.wipe(body);
            return;
        }
        s.queue.append(s.gpa, .{ .cmd = cmd, .body = body }) catch return s.wipe(body);
        s.next();
    }

    /// How many commands wait to go.
    pub fn pending(s: *const Sender) usize {
        return s.queue.items.len + @intFromBool(s.inflight);
    }

    fn next(s: *Sender) void {
        if (s.inflight or s.queue.items.len == 0) return;
        const net = s.store.net orelse return;
        const it = s.queue.orderedRemove(0);
        const job = s.gpa.create(Job) catch return s.wipe(it.body);
        job.* = .{ .sender = s, .net = net, .item = it };
        s.inflight = true;
        const t = std.Thread.spawn(.{ .stack_size = 1 << 20 }, Job.run, .{job}) catch {
            s.inflight = false;
            s.wipe(it.body);
            s.gpa.destroy(job);
            return;
        };
        t.detach();
    }

    const Job = struct {
        sender: *Sender,
        net: *api.Net,
        item: Item,
        status: u16 = 0,
        err: Text = .{},

        fn run(job: *Job) void {
            var arena: std.heap.ArenaAllocator = .init(job.sender.gpa);
            defer arena.deinit();
            const r = job.net.post(arena.allocator(), job.item.cmd, job.item.body);
            job.status = r.status;
            if (r.status != 200) job.err.set(api.errorText(arena.allocator(), r));
            nanoui.App.onMain(job, done);
        }

        fn done(ctx: ?*anyopaque) callconv(.c) void {
            const job: *Job = @ptrCast(@alignCast(ctx));
            const s = job.sender;
            s.inflight = false;
            s.wipe(job.item.body);
            if (job.status == 200) s.err.len = 0 else s.err = job.err;
            s.gpa.destroy(job);
            s.next();
            if (s.redraw) |r| r.f(r.ctx);
        }
    };
};

pub const Redraw = struct { ctx: *anyopaque, f: *const fn (ctx: *anyopaque) void };

/// Where a click at `mouse` lands on a picture drawn in `rect`: fractions of
/// its width and height from its top left, or null off the picture.
pub fn fraction(rect: anytype, mouse: anytype) ?[2]f64 {
    if (rect.w <= 0 or rect.h <= 0) return null;
    const fx = (mouse.x - rect.x) / rect.w;
    const fy = (mouse.y - rect.y) / rect.h;
    if (!(fx >= 0 and fx <= 1 and fy >= 0 and fy <= 1)) return null;
    return .{ @floatCast(fx), @floatCast(fy) };
}

/// The name the node takes for a key the window passes on.
pub fn keyName(k: anytype) ?[]const u8 {
    return switch (k) {
        .enter => "Enter",
        .tab => "Tab",
        .backspace => "Backspace",
        .delete => "Delete",
        .escape => "Escape",
        .left => "ArrowLeft",
        .right => "ArrowRight",
        .up => "ArrowUp",
        .down => "ArrowDown",
        .home => "Home",
        .end => "End",
        .page_up => "PageUp",
        .page_down => "PageDown",
        else => null,
    };
}

test "a click is the same point on the picture however big it is drawn" {
    const R = struct { x: f32, y: f32, w: f32, h: f32 };
    const P = struct { x: f32, y: f32 };
    // A picture drawn 640 × 320 at (100, 50): its middle is the page's middle.
    const r: R = .{ .x = 100, .y = 50, .w = 640, .h = 320 };
    const mid = fraction(r, P{ .x = 420, .y = 210 }).?;
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), mid[0], 1e-6);
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), mid[1], 1e-6);
    const corner = fraction(r, P{ .x = 740, .y = 370 }).?;
    try std.testing.expectApproxEqAbs(@as(f64, 1), corner[0], 1e-6);
    try std.testing.expectApproxEqAbs(@as(f64, 1), corner[1], 1e-6);
    // The same point on the same picture drawn twice as big.
    const big = fraction(R{ .x = 0, .y = 0, .w = 1280, .h = 640 }, P{ .x = 320, .y = 480 }).?;
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), big[0], 1e-6);
    try std.testing.expectApproxEqAbs(@as(f64, 0.75), big[1], 1e-6);
    // Off the picture, or a picture not laid out yet: nothing is clicked.
    try std.testing.expect(fraction(r, P{ .x = 99, .y = 60 }) == null);
    try std.testing.expect(fraction(r, P{ .x = 500, .y = 371 }) == null);
    try std.testing.expect(fraction(R{ .x = 0, .y = 0, .w = 0, .h = 0 }, P{ .x = 0, .y = 0 }) == null);
}

test "keys that move about a form pass on by name" {
    const K = enum { enter, tab, backspace, delete, escape, left, right, up, down, home, end, page_up, page_down, f1 };
    try std.testing.expectEqualStrings("Enter", keyName(K.enter).?);
    try std.testing.expectEqualStrings("Tab", keyName(K.tab).?);
    try std.testing.expectEqualStrings("Backspace", keyName(K.backspace).?);
    try std.testing.expectEqualStrings("ArrowDown", keyName(K.down).?);
    try std.testing.expect(keyName(K.f1) == null);
}
