//! Handing work to the main thread: a node's answer, an event, a picture, a dialog to open after the frame. Every
//! hand-over in the window goes through `toMain`, so each is taken in the same way.
//!
//! On a Mac it is a run-loop timer due now, in every mode, and a wake of the main run loop: not GCD's main queue alone
//! (`nanoui.App.onMain`). Measured on 22 November 2026 (macOS 26.3.1, the first run's terms): the node answered
//! `accept_terms` within 20 ms of the click, and the main thread took the answer in 62 s later. In between it drew
//! display-link frames (the button's spinner turned) and ran nothing from the main queue: the answer and two ticks
//! queued behind it went in together, when something else woke the process. A timer the run loop holds fires on the
//! loop's own clock, whatever the queue's wake-up did.
const std = @import("std");
const builtin = @import("builtin");
const nanoui = @import("nanoui");

pub const Fn = *const fn (?*anyopaque) callconv(.c) void;

/// From any thread: calls `func(ctx)` on the main thread soon, whatever the main thread is doing and in whatever mode
/// its run loop runs.
pub fn toMain(ctx: ?*anyopaque, func: Fn) void {
    if (builtin.os.tag != .macos) return nanoui.App.onMain(ctx, func);
    const job = std.heap.c_allocator.create(Job) catch return nanoui.App.onMain(ctx, func);
    job.* = .{ .ctx = ctx, .func = func };
    var tctx: cf.Context = .{ .info = job };
    const main = cf.CFRunLoopGetMain();
    const t = cf.CFRunLoopTimerCreate(null, cf.CFAbsoluteTimeGetCurrent(), 0, 0, 0, fire, &tctx);
    cf.CFRunLoopAddTimer(main, t, cf.kCFRunLoopCommonModes);
    cf.CFRunLoopWakeUp(main);
}

const Job = struct { ctx: ?*anyopaque, func: Fn };

/// On the main thread, once: the work, and the timer let go (the run loop's hold ends at invalidation, ours here).
fn fire(timer: *anyopaque, info: ?*anyopaque) callconv(.c) void {
    const j: *Job = @ptrCast(@alignCast(info));
    const f = j.func;
    const c = j.ctx;
    std.heap.c_allocator.destroy(j);
    cf.CFRunLoopTimerInvalidate(timer);
    cf.CFRelease(timer);
    f(c);
}

const cf = struct {
    const Context = extern struct { version: isize = 0, info: ?*anyopaque, retain: ?*const anyopaque = null, release: ?*const anyopaque = null, copyDescription: ?*const anyopaque = null };
    extern "c" fn CFRunLoopTimerCreate(a: ?*anyopaque, fire: f64, interval: f64, flags: usize, order: isize, callout: *const fn (*anyopaque, ?*anyopaque) callconv(.c) void, ctx: *Context) *anyopaque;
    extern "c" fn CFRunLoopAddTimer(rl: *anyopaque, t: *anyopaque, mode: *anyopaque) void;
    extern "c" fn CFRunLoopTimerInvalidate(t: *anyopaque) void;
    extern "c" fn CFRelease(p: *anyopaque) void;
    extern "c" fn CFRunLoopGetMain() *anyopaque;
    extern "c" fn CFRunLoopWakeUp(rl: *anyopaque) void;
    extern "c" fn CFAbsoluteTimeGetCurrent() f64;
    extern "c" fn CFRunLoopRunInMode(mode: *anyopaque, seconds: f64, return_after: bool) i32;
    extern "c" const kCFRunLoopCommonModes: *anyopaque;
    extern "c" const kCFRunLoopDefaultMode: *anyopaque;
};

extern "c" fn pthread_main_np() c_int;

const Seen = struct {
    ran: std.atomic.Value(bool) = .init(false),
    on_main: std.atomic.Value(bool) = .init(false),

    fn note(ctx: ?*anyopaque) callconv(.c) void {
        const s: *Seen = @ptrCast(@alignCast(ctx));
        s.on_main.store(pthread_main_np() != 0, .release);
        s.ran.store(true, .release);
    }
};

fn handFrom(seen: *Seen) void {
    toMain(seen, Seen.note);
}

test "work handed over from another thread runs on the main thread, without the main queue" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    // The test runs on the main thread: its run loop, run here for a while, is the window's.
    try std.testing.expect(pthread_main_np() != 0);
    var seen: Seen = .{};
    const t = try std.Thread.spawn(.{}, handFrom, .{&seen});
    t.join();
    var waited: usize = 0;
    while (!seen.ran.load(.acquire) and waited < 50) : (waited += 1) _ = cf.CFRunLoopRunInMode(cf.kCFRunLoopDefaultMode, 0.02, true);
    try std.testing.expect(seen.ran.load(.acquire));
    try std.testing.expect(seen.on_main.load(.acquire));
}
