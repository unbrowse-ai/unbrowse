//! What the window knows of the node: each resource's last answer, parsed on
//! a background thread into an arena of its own and handed to the main
//! thread whole (`objc.dispatchMain`), which swaps it in and asks for a
//! frame. Nothing polls: resources are fetched when a screen opens and when
//! the node says something changed.
const std = @import("std");
const nanoui = @import("nanoui");
const types = @import("types.zig");
const api = @import("api.zig");
const Res = types.Res;

pub const n_res = @typeInfo(Res).@"enum".field_names.len;

const Slot = struct {
    arena: ?std.heap.ArenaAllocator = null,
    value: ?*const anyopaque = null,
    /// The answer as it came (settings are saved by patching it).
    raw: []const u8 = "",
    /// The last fetch's error, owned by `err_buf`.
    err_buf: [240]u8 = undefined,
    err_len: usize = 0,
    inflight: bool = false,
    dirty: bool = false,
};

/// What an action's answer is for, so the app can take it.
pub const Tag = enum { generic, settings, cash_out, call_route, agent_create, vault_reveal, vault_import, wallet_phrase, wallet_restore, open_link, card_limit, close };

/// An action's name while it runs. Long enough for the labels made of a site and an account.
const Label = struct {
    buf: [96]u8 = undefined,
    len: usize = 0,

    fn of(s: []const u8) Label {
        var l: Label = .{ .len = @min(s.len, 96) };
        @memcpy(l.buf[0..l.len], s[0..l.len]);
        return l;
    }

    fn get(l: *const Label) []const u8 {
        return l.buf[0..l.len];
    }
};

pub const Done = struct {
    tag: Tag,
    label: []const u8,
    /// `Store.stamp` when the action was asked for, so an answer can tell whether the dialog that asked is still the
    /// one on screen. `null`: it is.
    stamp: ?u32 = null,
    ok: bool,
    /// The answer's body on success, the error's message otherwise. Valid
    /// for the call only.
    text: []const u8,
    arena: std.mem.Allocator,
};

pub const Hooks = struct {
    ctx: *anyopaque,
    redraw: *const fn (ctx: *anyopaque) void,
    /// A live event from the node (not open or closed); `data` valid for the call.
    event: *const fn (ctx: *anyopaque, name: []const u8, data: []const u8, a: std.mem.Allocator) void,
    done: *const fn (ctx: *anyopaque, d: Done) void,
    /// The event line opened: everything may be stale.
    opened: *const fn (ctx: *anyopaque) void,
};

pub const Conn = enum { connecting, up, down };

pub const Store = struct {
    gpa: std.mem.Allocator,
    net: ?*api.Net,
    hooks: ?Hooks = null,
    slots: [n_res]Slot = @splat(.{}),
    conn: Conn = .connecting,
    /// The Keychain is locked: key-needing commands wait on the owner.
    keychain: bool = false,
    /// The actions running, by label. Each stays here until its own answer: a chain write can outlive its dialog, and
    /// a second press of it, from wherever, must find it running (`act`).
    running: [16]Label = undefined,
    running_n: usize = 0,
    /// Moved on by each dialog the app opens; every action carries the value it was asked under (`Done.stamp`).
    stamp: u32 = 0,
    /// Settings changes waiting to go, and whether one is on its way. They go one at a time, each on what the node says
    /// now: the window's last read can predate a change made in a shell, and the node saves the whole object it's given.
    pending_arena: ?std.heap.ArenaAllocator = null,
    pending: std.json.ObjectMap = .empty,
    patching: bool = false,
    /// Actions asked for with no node behind the store (tests): "cmd body".
    log: std.ArrayList([]u8) = .empty,

    pub fn deinit(s: *Store) void {
        for (&s.slots) |*sl| if (sl.arena) |*a| a.deinit();
        if (s.pending_arena) |*a| a.deinit();
        for (s.log.items) |l| s.gpa.free(l);
        s.log.deinit(s.gpa);
    }

    fn slot(s: *Store, r: Res) *Slot {
        return &s.slots[@intFromEnum(r)];
    }

    /// The resource's last answer, if there was one.
    pub fn get(s: *Store, comptime r: Res) ?r.Type() {
        const v = s.slot(r).value orelse return null;
        return @as(*const r.Type(), @ptrCast(@alignCast(v))).*;
    }

    /// A slice resource, empty until it loads.
    pub fn list(s: *Store, comptime r: Res) r.Type() {
        return s.get(r) orelse &.{};
    }

    pub fn loaded(s: *Store, r: Res) bool {
        return s.slot(r).value != null;
    }

    pub fn err(s: *Store, r: Res) ?[]const u8 {
        const sl = s.slot(r);
        return if (sl.err_len > 0) sl.err_buf[0..sl.err_len] else null;
    }

    pub fn raw(s: *Store, r: Res) []const u8 {
        return s.slot(r).raw;
    }

    pub fn anyBusy(s: *Store) bool {
        return s.running_n > 0;
    }

    pub fn isBusy(s: *Store, label: []const u8) bool {
        const want = Label.of(label);
        for (s.running[0..s.running_n]) |*l| if (std.mem.eql(u8, l.get(), want.get())) return true;
        return false;
    }

    /// Marks `label` running, or says it can't be: it already is. An action with no label is one of a stream (a click on
    /// the page the owner holds), where each is its own.
    fn begin(s: *Store, label: []const u8) bool {
        if (label.len == 0) return true;
        if (s.isBusy(label) or s.running_n == s.running.len) return false;
        s.running[s.running_n] = Label.of(label);
        s.running_n += 1;
        return true;
    }

    fn end(s: *Store, label: []const u8) void {
        const want = Label.of(label);
        for (s.running[0..s.running_n], 0..) |*l, i| if (std.mem.eql(u8, l.get(), want.get())) {
            s.running[i] = s.running[s.running_n - 1];
            s.running_n -= 1;
            return;
        };
    }

    /// Parses `body` as `r`'s answer and keeps it (tests, and answers that
    /// carry a resource, as save_settings does).
    pub fn put(s: *Store, r: Res, body: []const u8) void {
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        const value = parse(r, arena.allocator(), body) catch {
            arena.deinit();
            return;
        };
        s.swap(r, arena, value, body);
    }

    fn swap(s: *Store, r: Res, arena: std.heap.ArenaAllocator, value: *const anyopaque, body: []const u8) void {
        const sl = s.slot(r);
        if (sl.arena) |*old| old.deinit();
        sl.arena = arena;
        sl.value = value;
        sl.raw = sl.arena.?.allocator().dupe(u8, body) catch "";
        sl.err_len = 0;
    }

    fn setErr(sl: *Slot, msg: []const u8) void {
        sl.err_len = @min(msg.len, sl.err_buf.len);
        @memcpy(sl.err_buf[0..sl.err_len], msg[0..sl.err_len]);
    }

    /// Fetches `r` on a background thread; asked again while one is out, it
    /// fetches once more after.
    pub fn fetch(s: *Store, r: Res) void {
        const net = s.net orelse return;
        const sl = s.slot(r);
        if (sl.inflight) {
            sl.dirty = true;
            return;
        }
        sl.inflight = true;
        sl.dirty = false;
        s.spawn(net, .{ .fetch = r }, @tagName(r), r.body()) catch {
            sl.inflight = false;
        };
    }

    /// Runs a command for an action; its answer goes to `Hooks.done`. An action already running sends nothing: pressing
    /// it again, after its dialog closed or by a double press, is not a second deposit.
    pub fn act(s: *Store, tag: Tag, label: []const u8, cmd: []const u8, body: []const u8) void {
        if (!s.begin(label)) return;
        const net = s.net orelse {
            const line = std.fmt.allocPrint(s.gpa, "{s} {s}", .{ cmd, body }) catch return;
            s.log.append(s.gpa, line) catch s.gpa.free(line);
            return;
        };
        s.spawn(net, .{ .action = .{ .tag = tag, .label = Label.of(label), .stamp = s.stamp } }, cmd, body) catch s.end(label);
    }

    /// Runs the action with its arguments as JSON (`.{ .id = id, .approve = true }`).
    pub fn actWith(s: *Store, tag: Tag, label: []const u8, cmd: []const u8, args: anytype) void {
        const body = std.json.Stringify.valueAlloc(s.gpa, args, .{}) catch return;
        defer {
            std.crypto.secureZero(u8, body);
            s.gpa.free(body);
        }
        s.act(tag, label, cmd, body);
    }

    /// Changes one setting. Changes made while one is on its way go together after it.
    pub fn patchSettings(s: *Store, key: []const u8, value: std.json.Value) void {
        if (s.pending_arena == null) s.pending_arena = .init(s.gpa);
        const a = s.pending_arena.?.allocator();
        const text = std.json.Stringify.valueAlloc(a, value, .{}) catch return;
        const copy = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{ .allocate = .alloc_always }) catch return;
        s.pending.put(a, a.dupe(u8, key) catch return, copy) catch return;
        s.sendPatches();
    }

    fn sendPatches(s: *Store) void {
        if (s.patching or s.pending.count() == 0) return;
        var arena = s.pending_arena.?;
        defer {
            arena.deinit();
            s.pending_arena = null;
            s.pending = .empty;
        }
        const a = arena.allocator();
        const body = std.json.Stringify.valueAlloc(a, std.json.Value{ .object = s.pending }, .{}) catch return;
        const net = s.net orelse {
            const all = merged(a, s.raw(.settings), body) catch return;
            const line = std.fmt.allocPrint(s.gpa, "save_settings {s}", .{all}) catch return;
            s.log.append(s.gpa, line) catch s.gpa.free(line);
            return;
        };
        s.patching = true;
        s.spawn(net, .patch, "save_settings", body) catch {
            s.patching = false;
        };
    }

    /// The last action's line in the test log, if any.
    pub fn lastLog(s: *Store) []const u8 {
        return if (s.log.items.len > 0) s.log.items[s.log.items.len - 1] else "";
    }

    fn spawn(s: *Store, net: *api.Net, kind: Job.Kind, cmd: []const u8, body: []const u8) !void {
        const job = try s.gpa.create(Job);
        job.* = .{ .store = s, .net = net, .arena = .init(s.gpa), .kind = kind };
        const a = job.arena.allocator();
        job.cmd = a.dupe(u8, cmd) catch "";
        job.body = a.dupe(u8, body) catch "";
        const t = std.Thread.spawn(.{ .stack_size = 1 << 20 }, Job.run, .{job}) catch |e| {
            job.arena.deinit();
            s.gpa.destroy(job);
            return e;
        };
        t.detach();
    }

    /// Starts the event line on its own thread.
    pub fn listen(s: *Store) !void {
        const net = s.net orelse return;
        const t = try std.Thread.spawn(.{ .stack_size = 1 << 20 }, api.Net.events, .{ net, @as(*anyopaque, s), onEvent });
        t.detach();
        // 1 MiB as the others: 64 KiB is under Linux's floor once GTK is loaded, and the window aborted as it started
        // (UNB-134, the fix of PR 560, which merged into a feature branch).
        const k = try std.Thread.spawn(.{ .stack_size = 1 << 20 }, ticks, .{s});
        k.detach();
    }

    /// A slow tick: the chain's clock and a site's balance move with no event from the node, so a withdrawal coming due
    /// or a top-up landing would otherwise wait for the next thing that happens.
    fn ticks(s: *Store) void {
        const net = s.net orelse return;
        while (true) {
            net.io.sleep(.fromSeconds(30), .awake) catch {};
            onEvent(s, "tick", "");
        }
    }

    /// On the event thread: copied into a job and sent to the main thread.
    fn onEvent(ctx: *anyopaque, name: []const u8, data: []const u8) void {
        const s: *Store = @ptrCast(@alignCast(ctx));
        const job = s.gpa.create(Job) catch return;
        job.* = .{ .store = s, .net = s.net.?, .arena = .init(s.gpa), .kind = .event };
        const a = job.arena.allocator();
        job.cmd = a.dupe(u8, name) catch "";
        job.body = a.dupe(u8, data) catch "";
        nanoui.App.onMain(job, Job.done);
    }

    /// On the main thread: the job's answer taken in.
    fn finish(s: *Store, job: *Job) void {
        const h = s.hooks;
        switch (job.kind) {
            .event => {
                if (std.mem.eql(u8, job.cmd, "open")) {
                    s.conn = .up;
                    if (h) |hk| hk.opened(hk.ctx);
                } else if (std.mem.eql(u8, job.cmd, "closed")) {
                    s.conn = .down;
                    if (h) |hk| hk.event(hk.ctx, job.cmd, job.body, job.arena.allocator());
                } else if (h) |hk| hk.event(hk.ctx, job.cmd, job.body, job.arena.allocator());
            },
            .fetch => |r| {
                const sl = s.slot(r);
                sl.inflight = false;
                s.note(job.reply);
                if (job.value) |v| {
                    s.swap(r, job.arena, v, job.reply.body);
                    job.arena = .init(s.gpa);
                    if (r == .identity) s.keychain = false;
                } else setErr(sl, api.errorText(job.arena.allocator(), job.reply));
                if (sl.dirty) s.fetch(r);
            },
            .patch => {
                s.patching = false;
                s.note(job.reply);
                const ok = job.reply.status == 200;
                const a = job.arena.allocator();
                if (ok) s.put(.settings, job.reply.body);
                if (h) |hk| hk.done(hk.ctx, .{ .tag = .settings, .label = "settings", .ok = ok, .text = if (ok) job.reply.body else api.errorText(a, job.reply), .arena = a });
                s.sendPatches();
            },
            .action => |ac| {
                s.end(ac.label.get());
                s.note(job.reply);
                const ok = job.reply.status == 200;
                const a = job.arena.allocator();
                if (ok and ac.tag == .settings) s.put(.settings, job.reply.body);
                if (h) |hk| hk.done(hk.ctx, .{ .tag = ac.tag, .label = ac.label.get(), .stamp = ac.stamp, .ok = ok, .text = if (ok) job.reply.body else failed(a, job.reply), .arena = a });
            },
        }
        if (h) |hk| hk.redraw(hk.ctx);
    }

    /// What every answer says about the line and the Keychain.
    fn note(s: *Store, r: api.Reply) void {
        s.conn = connAfter(s.conn, r);
        if (r.status == 503 and std.mem.indexOf(u8, r.body, "Keychain") != null) s.keychain = true;
    }
};

/// `save_settings`'s body: the node's settings as they are now, with `patch` on them. Fields this window doesn't know
/// survive, since nothing here reads them.
fn merged(a: std.mem.Allocator, now: []const u8, patch: []const u8) ![]u8 {
    var v = try std.json.parseFromSliceLeaky(std.json.Value, a, now, .{ .allocate = .alloc_always });
    const p = try std.json.parseFromSliceLeaky(std.json.Value, a, patch, .{ .allocate = .alloc_always });
    if (v != .object or p != .object) return error.NotAnObject;
    var it = p.object.iterator();
    while (it.next()) |e| try v.object.put(a, e.key_ptr.*, e.value_ptr.*);
    return std.json.Stringify.valueAlloc(a, .{ .settings = v }, .{});
}

/// What a failed action says. With no answer at all the window can't know how far it got: a chain write may have gone
/// through before the line dropped, and the owner must look before pressing again.
fn failed(a: std.mem.Allocator, r: api.Reply) []const u8 {
    if (r.status == 0) return "The node stopped answering before it said how this went. It may have gone through: check before you try again.";
    return api.errorText(a, r);
}

/// The line to the node after an answer. An answer that couldn't be read says only that this one went wrong.
fn connAfter(now: Conn, r: api.Reply) Conn {
    if (r.status == 0) return if (r.unread) now else .down;
    return if (now == .down) .connecting else now;
}

fn parse(r: Res, a: std.mem.Allocator, body: []const u8) !*const anyopaque {
    switch (r) {
        inline else => |tag| {
            const T = tag.Type();
            const p = try a.create(T);
            p.* = try std.json.parseFromSliceLeaky(T, a, body, types.parse_options);
            return @ptrCast(p);
        },
    }
}

const Job = struct {
    store: *Store,
    net: *api.Net,
    arena: std.heap.ArenaAllocator,
    kind: Kind,
    cmd: []const u8 = "",
    body: []const u8 = "",
    reply: api.Reply = .{ .status = 0, .body = &.{} },
    value: ?*const anyopaque = null,

    const Kind = union(enum) {
        fetch: Res,
        action: struct { tag: Tag, label: Label, stamp: u32 },
        event,
        patch,
    };

    fn run(job: *Job) void {
        const a = job.arena.allocator();
        job.reply = if (job.kind == .patch) job.savePatch(a) else job.net.post(a, job.cmd, job.body);
        // What was sent may hold a password: gone before the answer is read.
        std.crypto.secureZero(u8, @constCast(job.body));
        if (job.kind == .fetch and job.reply.status == 200) job.value = parse(job.kind.fetch, a, job.reply.body) catch null;
        nanoui.App.onMain(job, done);
    }

    /// Reads the node's settings and saves them with this job's changes on them.
    fn savePatch(job: *Job, a: std.mem.Allocator) api.Reply {
        const now = job.net.post(a, "settings", "{}");
        if (now.status != 200) return now;
        const body = merged(a, now.body, job.body) catch return api.said(a, 500, "{\"error\":\"The node's settings couldn't be read.\"}");
        return job.net.post(a, "save_settings", body);
    }

    fn done(ctx: ?*anyopaque) callconv(.c) void {
        const job: *Job = @ptrCast(@alignCast(ctx));
        const s = job.store;
        s.finish(job);
        // A reply may hold a secret (a revealed password, a setup string).
        if (job.reply.body.len > 0 and job.kind != .event) std.crypto.secureZero(u8, job.reply.body);
        job.arena.deinit();
        s.gpa.destroy(job);
    }
};

test "a settings change lands on what the node says now, not on the window's last read" {
    const a = std.testing.allocator;
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const out = try merged(arena.allocator(), "{\"paused\":false,\"share_routes\":\"off\",\"future\":1}", "{\"paused\":true}");
    try std.testing.expectEqualStrings("{\"settings\":{\"paused\":true,\"share_routes\":\"off\",\"future\":1}}", out);
}

test "two quick settings changes both land" {
    var s: Store = .{ .gpa = std.testing.allocator, .net = null };
    defer s.deinit();
    s.put(.settings, "{\"paused\":false,\"api_port\":7788}");
    // One is on its way: these wait for it, and go together.
    s.patching = true;
    s.patchSettings("paused", .{ .bool = true });
    s.patchSettings("api_port", .{ .integer = 7799 });
    try std.testing.expectEqual(@as(usize, 0), s.log.items.len);
    s.patching = false;
    s.sendPatches();
    try std.testing.expectEqual(@as(usize, 1), s.log.items.len);
    try std.testing.expect(std.mem.indexOf(u8, s.lastLog(), "\"paused\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, s.lastLog(), "\"api_port\":7799") != null);
}

test "a second press of a running action sends nothing, whatever ran since" {
    var s: Store = .{ .gpa = std.testing.allocator, .net = null };
    defer s.deinit();
    s.act(.close, "move", "deposit", "{\"amount\":5}");
    s.act(.generic, "claim", "claim_now", "{}");
    try std.testing.expect(s.isBusy("move"));
    try std.testing.expect(s.isBusy("claim"));
    s.act(.close, "move", "deposit", "{\"amount\":5}");
    try std.testing.expectEqual(@as(usize, 2), s.log.items.len);
    // Its answer frees it, and only it.
    s.end("move");
    try std.testing.expect(!s.isBusy("move"));
    try std.testing.expect(s.isBusy("claim"));
    s.act(.close, "move", "deposit", "{\"amount\":5}");
    try std.testing.expectEqual(@as(usize, 3), s.log.items.len);
}

test "an action the node never answered says it may have gone through" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expect(std.mem.indexOf(u8, failed(a, .{ .status = 0, .body = &.{} }), "may have gone through") != null);
    try std.testing.expectEqualStrings("no", failed(a, .{ .status = 400, .body = @constCast("{\"error\":\"no\"}") }));
}

test "an answer that couldn't be read doesn't say the node is down" {
    try std.testing.expectEqual(Conn.up, connAfter(.up, .{ .status = 0, .unread = true, .body = &.{} }));
    try std.testing.expectEqual(Conn.down, connAfter(.up, .{ .status = 0, .body = &.{} }));
    try std.testing.expectEqual(Conn.connecting, connAfter(.down, .{ .status = 200, .body = &.{} }));
}

test "put and get" {
    var s: Store = .{ .gpa = std.testing.allocator, .net = null };
    defer s.deinit();
    s.put(.agents_list, "[{\"index\":1,\"name\":\"Claude\",\"address\":\"0xa1c7\",\"cap_usdc\":10,\"expires\":300,\"created\":1,\"revoked\":false}]");
    try std.testing.expectEqual(@as(usize, 1), s.list(.agents_list).len);
    try std.testing.expectEqualStrings("Claude", s.list(.agents_list)[0].name);
    s.actWith(.generic, "revoke", "agent_revoke", .{ .index = 1 });
    try std.testing.expectEqualStrings("agent_revoke {\"index\":1}", s.lastLog());
}
