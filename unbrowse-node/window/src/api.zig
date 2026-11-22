//! The window's line to the node on 127.0.0.1: owner commands as
//! `POST /owner/<command>`, live events from `GET /owner/events`, and the
//! node started when nothing answers. Everything here runs on background
//! threads; nothing is printed of the owner's token or of any answer.
const std = @import("std");

/// A reply the window words itself, owned by `a` like one the node sent: whoever holds a reply wipes its body when done
/// (it may hold a secret), and a body left in the program's constants can't be written.
pub fn said(a: std.mem.Allocator, status: u16, text: []const u8) Reply {
    return .{ .status = status, .body = a.dupe(u8, text) catch &.{} };
}

pub const Reply = struct {
    /// 0 when the node could not be reached, or its answer couldn't be read.
    status: u16,
    body: []u8,
    /// Status 0 with the node reached: it took the request and something went wrong after. Says nothing of the line.
    unread: bool = false,
};

/// How a try at the node's event line ended.
pub const Line = enum {
    /// It opened, and has dropped.
    ended,
    /// Something answered and turned the window away: a token from before a restart, most often. A node is up there, and
    /// another started now would only fight it for the port.
    refused,
    unreached,

    pub fn startsNode(l: Line) bool {
        return l == .unreached;
    }
};

pub const Net = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    client: std.http.Client,
    /// ~/.unbrowse
    dir: []const u8,
    /// Where `unbrowse-node` is looked for first: beside this program.
    exe_dir: []const u8,
    port: std.atomic.Value(u16) = .init(7788),
    /// When the node was last started from here (seconds), so a node that is
    /// slow to come up is not started twice.
    spawned_at: std.atomic.Value(i64) = .init(0),
    /// Whether the node the window reached was one it found running, not
    /// one it started: a service's or a terminal's. Whoever started it brings
    /// it back when it goes; a node started here then would take its port.
    found: std.atomic.Value(bool) = .init(false),
    /// When nothing first answered since the node was last reached (seconds;
    /// 0 while it answers).
    down_since: std.atomic.Value(i64) = .init(0),
    /// The window runs from a place that doesn't last (a disk image): it starts no node from there.
    hold_node: bool = false,

    pub fn init(n: *Net, gpa: std.mem.Allocator, io: std.Io, home: []const u8, exe_dir: []const u8) !void {
        n.* = .{
            .gpa = gpa,
            .io = io,
            .client = .{ .allocator = gpa, .io = io },
            .dir = try std.fs.path.join(gpa, &.{ home, ".unbrowse" }),
            .exe_dir = exe_dir,
        };
        n.readPort();
    }

    /// The port from ~/.unbrowse/settings.json (`api_port`), else 7788.
    pub fn readPort(n: *Net) void {
        var buf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&buf, "{s}/settings.json", .{n.dir}) catch return;
        const bytes = std.Io.Dir.cwd().readFileAlloc(n.io, path, n.gpa, .limited(1 << 20)) catch return;
        defer n.gpa.free(bytes);
        const S = struct { api_port: u16 = 7788 };
        const parsed = std.json.parseFromSlice(S, n.gpa, bytes, .{ .ignore_unknown_fields = true }) catch return;
        defer parsed.deinit();
        n.port.store(parsed.value.api_port, .release);
    }

    /// The owner's token into `buf`, read fresh each time (the node writes a new
    /// token every start), and only once what listens on the port has proved
    /// it is the node holding that token (`proven`). The token itself never
    /// goes over the wire: each request is signed with it (`Signed`), so a
    /// process that took or relays the port keeps nothing it can use again.
    fn owner(n: *Net, buf: []u8) Auth {
        var pbuf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&pbuf, "{s}/owner.token", .{n.dir}) catch return .no_token;
        const raw = std.Io.Dir.cwd().readFile(n.io, path, buf) catch return .no_token;
        const token = std.mem.trim(u8, raw, " \r\n\t");
        if (token.len == 0) return .no_token;
        switch (n.proven(token)) {
            .yes => {},
            .no => return .unproven,
            .unreached => return .unreached,
        }
        return .{ .ok = token };
    }

    /// Asks what listens on the node's port to answer a fresh challenge with
    /// the owner's token (`GET /v1/node/proof`): only the node holding the
    /// token can. The token itself never goes; its key names it.
    fn proven(n: *Net, token: []const u8) Proof {
        var challenge: [32]u8 = undefined;
        // Fresh from the system each time: a challenge anyone could guess, they could have asked the node beforehand.
        n.io.randomSecure(&challenge) catch return .no;
        const port = n.port.load(.acquire);
        var pbuf: [200]u8 = undefined;
        const path = std.fmt.bufPrint(&pbuf, "/v1/node/proof?challenge={s}&key={s}", .{
            std.fmt.bytesToHex(challenge, .lower),
            std.fmt.bytesToHex(tokenKey(token), .lower),
        }) catch return .no;
        var ubuf: [256]u8 = undefined;
        var out: std.Io.Writer.Allocating = .init(n.gpa);
        defer out.deinit();
        // A redirect is never followed: what answers on the node's port proves itself there, or not at all.
        const res = n.client.fetch(.{
            .location = .{ .url = n.url(&ubuf, path) },
            .method = .GET,
            .redirect_behavior = .unhandled,
            .response_writer = &out.writer,
        }) catch |e| return switch (e) {
            error.ConnectionRefused => .unreached,
            else => .no,
        };
        if (res.status != .ok) return .no;
        const want = std.fmt.bytesToHex(nodeProof(token, port, &challenge), .lower);
        return if (answerHolds(n.gpa, out.written(), &want)) .yes else .no;
    }

    fn url(n: *Net, buf: []u8, path: []const u8) []const u8 {
        return std.fmt.bufPrint(buf, "http://127.0.0.1:{d}{s}", .{ n.port.load(.acquire), path }) catch "";
    }

    /// One owner command; the body is the reply's (owned by `a`). A node that
    /// isn't running is started, and the command tried again while it comes up.
    pub fn post(n: *Net, a: std.mem.Allocator, cmd: []const u8, body: []const u8) Reply {
        var tries: u32 = 0;
        while (true) : (tries += 1) {
            const r = n.postOnce(a, cmd, body) catch |e| switch (e) {
                error.Unreachable => {
                    if (tries >= 40) return said(a, 0, "Can't reach the node on this machine.");
                    if (tries == 0) n.readPort();
                    n.startNode();
                    n.io.sleep(.fromMilliseconds(250), .awake) catch {};
                    continue;
                },
                error.Failed => {
                    var r = said(a, 0, "The node's answer couldn't be read.");
                    r.unread = true;
                    return r;
                },
                // Something answered that the node didn't sign: nothing of it reaches the owner.
                error.NotTheNodes => return said(a, 401, unproven_text),
            };
            n.up();
            return r;
        }
    }

    fn postOnce(n: *Net, a: std.mem.Allocator, cmd: []const u8, body: []const u8) error{ Unreachable, Failed, NotTheNodes }!Reply {
        var pbuf: [128]u8 = undefined;
        const path = std.fmt.bufPrint(&pbuf, "/owner/{s}", .{cmd}) catch return error.Failed;
        var tbuf: [256]u8 = undefined;
        defer std.crypto.secureZero(u8, &tbuf);
        const token = switch (n.owner(&tbuf)) {
            .ok => |t| t,
            .no_token, .unreached => return error.Unreachable,
            // Something answers that isn't the node: no command, and nothing of what it says, reaches the owner.
            .unproven => return said(a, 401, unproven_text),
        };
        return n.exchange(a, .POST, path, body, token);
    }

    /// One signed request, and its answer only if the node signed it for this
    /// request. Only a refused connection is `Unreachable`, so the caller tries
    /// again: a command that reached the node (a faucet, a payment) must never
    /// run twice.
    fn exchange(n: *Net, a: std.mem.Allocator, method: std.http.Method, path: []const u8, body: ?[]const u8, token: []const u8) error{ Unreachable, Failed, NotTheNodes }!Reply {
        var ubuf: [256]u8 = undefined;
        const uri = std.Uri.parse(n.url(&ubuf, path)) catch return error.Failed;
        var s: Signed = undefined;
        s.init(n.io, token, @tagName(method), n.port.load(.acquire), path, body orelse "", std.Io.Clock.real.now(n.io).toSeconds());
        const headers = s.headers();
        var req = n.client.request(method, uri, .{
            .keep_alive = false,
            .redirect_behavior = .unhandled,
            .headers = .{ .content_type = if (body != null) .{ .override = "application/json" } else .default, .accept_encoding = .omit },
            .extra_headers = &headers,
        }) catch |e| return switch (e) {
            error.ConnectionRefused => error.Unreachable,
            else => error.Failed,
        };
        defer req.deinit();
        if (body) |b| {
            req.transfer_encoding = .{ .content_length = b.len };
            var bw = req.sendBodyUnflushed(&.{}) catch return error.Failed;
            bw.writer.writeAll(b) catch return error.Failed;
            bw.end() catch return error.Failed;
            req.connection.?.flush() catch return error.Failed;
        } else {
            req.sendBodiless() catch return error.Failed;
        }
        var response = req.receiveHead(&.{}) catch return error.Failed;
        // Read before the body: the head's strings go once its reader starts.
        var theirs: [64]u8 = @splat(0);
        var it = response.head.iterateHeaders();
        while (it.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "x-unbrowse-reply") and h.value.len == 64) @memcpy(&theirs, h.value);
        }
        const status: u16 = @intFromEnum(response.head.status);
        var out: std.Io.Writer.Allocating = .init(a);
        var transfer: [64]u8 = undefined;
        const reader = response.reader(&transfer);
        _ = reader.streamRemaining(&out.writer) catch return error.Failed;
        const got = out.written();
        const hash = bodyHash(got);
        if (!std.crypto.timing_safe.eql([64]u8, replyMac(token, status, &hash, &s.nonce), theirs)) return error.NotTheNodes;
        return .{ .status = status, .body = got };
    }

    /// A GET of `path` (a walk's picture): its body owned by `a`. Never starts
    /// the node; status 0 when it can't be reached, or what answered isn't it.
    pub fn get(n: *Net, a: std.mem.Allocator, path: []const u8) Reply {
        var tbuf: [256]u8 = undefined;
        defer std.crypto.secureZero(u8, &tbuf);
        const token = switch (n.owner(&tbuf)) {
            .ok => |t| t,
            else => return .{ .status = 0, .body = &.{} },
        };
        return n.exchange(a, .GET, path, null, token) catch .{ .status = 0, .body = &.{} };
    }

    /// The node answered: it is up, and, if the window never started one,
    /// it is one the window found running.
    pub fn up(n: *Net) void {
        n.down_since.store(0, .release);
        if (n.spawned_at.load(.acquire) == 0) n.found.store(true, .release);
    }

    /// Starts `unbrowse-node` (beside this program, else on PATH) detached:
    /// it outlives the window. At most once every ten seconds, never for a
    /// node the window found running, and only once nothing has answered for
    /// a few seconds (`mayStart`).
    pub fn startNode(n: *Net) void {
        if (n.hold_node) return;
        const now = std.Io.Clock.real.now(n.io).toSeconds();
        _ = n.down_since.cmpxchgStrong(0, now, .acq_rel, .acquire);
        if (!mayStart(n.found.load(.acquire), now - n.down_since.load(.acquire))) return;
        const last = n.spawned_at.load(.acquire);
        if (now - last < 10) return;
        if (n.spawned_at.cmpxchgStrong(last, now, .acq_rel, .acquire) != null) return;
        const windows = @import("builtin").os.tag == .windows;
        const name = if (windows) "unbrowse-node.exe" else "unbrowse-node";
        var buf: [1024]u8 = undefined;
        const beside = std.fmt.bufPrint(&buf, "{s}/{s}", .{ n.exe_dir, name }) catch return;
        const exe = if (std.Io.Dir.cwd().access(n.io, beside, .{}) catch null) |_| beside else name;
        var lbuf: [600]u8 = undefined;
        const log = std.fmt.bufPrint(&lbuf, "{s}/node.log", .{n.dir}) catch return;
        // A new account has no ~/.unbrowse yet: node.log goes in it, and a shell can't open a file in a folder that
        // isn't there, so the node would never start.
        std.Io.Dir.cwd().createDirPath(n.io, n.dir) catch {};
        if (windows) {
            // A child outlives its parent on Windows; it runs without a console window, this run's output in node.log.
            const f = std.Io.Dir.cwd().createFile(n.io, log, .{}) catch return;
            defer f.close(n.io);
            _ = std.process.spawn(n.io, .{ .argv = &.{exe}, .stdin = .ignore, .stdout = .{ .file = f }, .stderr = .{ .file = f }, .create_no_window = true }) catch return;
            return;
        }
        // The shell starts it in the background and exits at once: the node
        // is the system's child then, not this window's.
        var child = std.process.spawn(n.io, .{
            .argv = &.{ "/bin/sh", "-c", "nohup \"$0\" >>\"$1\" 2>&1 </dev/null &", exe, log },
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
            .pgid = 0,
        }) catch return;
        _ = child.wait(n.io) catch {};
    }

    /// Server-sent events, forever: `on(name, data)` for each, `on("open", "")`
    /// once connected and `on("closed", "")` when the line drops. Reconnects
    /// with backoff, starting the node if it isn't up.
    pub fn events(n: *Net, ctx: *anyopaque, on: *const fn (ctx: *anyopaque, name: []const u8, data: []const u8) void) void {
        var backoff: i64 = 250;
        while (true) {
            n.readPort();
            const line = n.stream(ctx, on) catch Line.unreached;
            if (line == .ended) {
                on(ctx, "closed", "");
                backoff = 250;
            }
            if (line.startsNode()) n.startNode();
            n.io.sleep(.fromMilliseconds(backoff), .awake) catch {};
            backoff = @min(backoff * 2, 5000);
        }
    }

    fn stream(n: *Net, ctx: *anyopaque, on: *const fn (ctx: *anyopaque, name: []const u8, data: []const u8) void) !Line {
        var ubuf: [256]u8 = undefined;
        var tbuf: [256]u8 = undefined;
        defer std.crypto.secureZero(u8, &tbuf);
        const token = switch (n.owner(&tbuf)) {
            .ok => |t| t,
            .no_token, .unreached => return .unreached,
            // Something holds the port and can't prove it is the node: it is never shown, and no node is started to
            // fight it for the port.
            .unproven => return .refused,
        };
        const uri = try std.Uri.parse(n.url(&ubuf, "/owner/events"));
        var s: Signed = undefined;
        s.init(n.io, token, "GET", n.port.load(.acquire), "/owner/events", "", std.Io.Clock.real.now(n.io).toSeconds());
        const signed = s.headers();
        var req = try n.client.request(.GET, uri, .{
            .keep_alive = false,
            .redirect_behavior = .unhandled,
            .headers = .{ .accept_encoding = .omit },
            .extra_headers = &(.{std.http.Header{ .name = "accept", .value = "text/event-stream" }} ++ signed),
        });
        defer req.deinit();
        try req.sendBodiless();
        var response = try req.receiveHead(&.{});
        if (response.head.status != .ok) return .refused;
        var theirs: [64]u8 = @splat(0);
        var it = response.head.iterateHeaders();
        while (it.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "x-unbrowse-reply") and h.value.len == 64) @memcpy(&theirs, h.value);
        }
        // A stream the node didn't open for this request is never shown.
        if (!std.crypto.timing_safe.eql([64]u8, replyMac(token, 200, "event-stream", &s.nonce), theirs)) return .refused;
        n.up();
        on(ctx, "open", "");
        var tb: [64 * 1024]u8 = undefined;
        const r = response.reader(&tb);
        var name: [64]u8 = undefined;
        var name_len: usize = 0;
        var id: [96]u8 = undefined;
        var id_len: usize = 0;
        var seq: u64 = 0;
        var data: std.ArrayList(u8) = .empty;
        defer data.deinit(n.gpa);
        while (true) {
            const raw = (r.takeDelimiter('\n') catch break) orelse break;
            const line = std.mem.trimEnd(u8, raw, "\r");
            if (line.len == 0) {
                if (data.items.len > 0 or name_len > 0) {
                    const event = if (name_len > 0) name[0..name_len] else "message";
                    // Each event says its place and carries the node's signature: one added, moved or changed on the
                    // way ends the stream, and none of it is shown.
                    if (!eventHolds(token, &s.nonce, seq, event, data.items, id[0..id_len])) return .refused;
                    seq += 1;
                    on(ctx, event, data.items);
                }
                data.clearRetainingCapacity();
                name_len = 0;
                id_len = 0;
            } else if (line[0] == ':') {
                // A keep-alive comment.
            } else if (field(line, "event")) |v| {
                name_len = @min(v.len, name.len);
                @memcpy(name[0..name_len], v[0..name_len]);
            } else if (field(line, "data")) |v| {
                if (data.items.len > 0) data.append(n.gpa, '\n') catch {};
                data.appendSlice(n.gpa, v) catch {};
            } else if (field(line, "id")) |v| {
                id_len = @min(v.len, id.len);
                @memcpy(id[0..id_len], v[0..id_len]);
            }
        }
        return .ended;
    }
};

const Auth = union(enum) { ok: []const u8, no_token, unproven, unreached };

/// A request signed with a token that never leaves the window (`unbrowse_core::signed`): the token named by its key,
/// and an HMAC-SHA256 keyed by it over the method, the host and port it is sent to, the path with its query, the body's SHA-256, the time and a fresh
/// nonce. The node takes each nonce once.
const Signed = struct {
    key: [64]u8,
    time: [20]u8,
    time_len: usize,
    nonce: [32]u8,
    sig: [64]u8,

    /// Signed for the authority the window sends to (`url`): 127.0.0.1 at the node's port.
    fn init(s: *Signed, io: std.Io, token: []const u8, method: []const u8, port: u16, target: []const u8, body: []const u8, now: i64) void {
        var raw: [16]u8 = undefined;
        io.randomSecure(&raw) catch io.random(&raw);
        s.nonce = std.fmt.bytesToHex(raw, .lower);
        s.key = std.fmt.bytesToHex(tokenKey(token), .lower);
        s.time_len = (std.fmt.bufPrint(&s.time, "{d}", .{now}) catch unreachable).len;
        var ab: [32]u8 = undefined;
        const authority = std.fmt.bufPrint(&ab, "127.0.0.1:{d}", .{port}) catch unreachable;
        s.sig = requestMac(token, method, authority, target, body, s.time[0..s.time_len], &s.nonce);
    }

    fn headers(s: *const Signed) [4]std.http.Header {
        return .{
            .{ .name = "x-unbrowse-key", .value = &s.key },
            .{ .name = "x-unbrowse-time", .value = s.time[0..s.time_len] },
            .{ .name = "x-unbrowse-nonce", .value = &s.nonce },
            .{ .name = "x-unbrowse-signature", .value = &s.sig },
        };
    }
};

fn mac(token: []const u8, parts: []const []const u8) [64]u8 {
    const H = std.crypto.auth.hmac.sha2.HmacSha256;
    var h = H.init(token);
    for (parts, 0..) |p, i| {
        if (i > 0) h.update("\n");
        h.update(p);
    }
    var out: [H.mac_length]u8 = undefined;
    h.final(&out);
    return std.fmt.bytesToHex(out, .lower);
}

/// SHA-256 of a body, hex: what the signatures carry in its place.
pub fn bodyHash(body: []const u8) [64]u8 {
    var out: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(body, &out, .{});
    return std.fmt.bytesToHex(out, .lower);
}

/// `authority` is the host and port the request goes to, `host:port` in lower case: signed for one, it verifies at no
/// other (`unbrowse_core::signed::request_mac`).
pub fn requestMac(token: []const u8, method: []const u8, authority: []const u8, target: []const u8, body: []const u8, time: []const u8, nonce: []const u8) [64]u8 {
    var up: [16]u8 = undefined;
    const m = std.ascii.upperString(up[0..@min(method.len, up.len)], method[0..@min(method.len, up.len)]);
    return mac(token, &.{ "unbrowse/request/v2", m, authority, target, &bodyHash(body), time, nonce });
}

pub fn replyMac(token: []const u8, status: u16, hash: []const u8, nonce: []const u8) [64]u8 {
    var sb: [8]u8 = undefined;
    return mac(token, &.{ "unbrowse/reply/v1", std.fmt.bufPrint(&sb, "{d}", .{status}) catch unreachable, hash, nonce });
}

pub fn eventMac(token: []const u8, nonce: []const u8, seq: u64, name: []const u8, data: []const u8) [64]u8 {
    var sb: [24]u8 = undefined;
    return mac(token, &.{ "unbrowse/event/v1", nonce, std.fmt.bufPrint(&sb, "{d}", .{seq}) catch unreachable, name, data });
}

/// Whether an event's `id` (`<place>.<signature>`) is the node's for event `seq` of the stream that answered `nonce`.
pub fn eventHolds(token: []const u8, nonce: []const u8, seq: u64, name: []const u8, data: []const u8, id: []const u8) bool {
    const dot = std.mem.indexOfScalar(u8, id, '.') orelse return false;
    const place = std.fmt.parseInt(u64, id[0..dot], 10) catch return false;
    const sig = id[dot + 1 ..];
    if (place != seq or sig.len != 64) return false;
    return std.crypto.timing_safe.eql([64]u8, eventMac(token, nonce, seq, name, data), sig[0..64].*);
}
const Proof = enum { yes, no, unreached };

const unproven_text = "What answers on the node's port couldn't prove it is your node, so the window sent it nothing. Quit whatever else is using that port, then restart Unbrowse.";

/// What the node answers for `token` at `port` to `challenge`:
/// keccak256("unbrowse/node-proof\n" || token || "\n" || port (big endian) || challenge)
/// (`unbrowse_core::node_proof`).
pub fn nodeProof(token: []const u8, port: u16, challenge: *const [32]u8) [32]u8 {
    var h = std.crypto.hash.sha3.Keccak256.init(.{});
    h.update("unbrowse/node-proof\n");
    h.update(token);
    h.update("\n");
    h.update(&[2]u8{ @intCast(port >> 8), @intCast(port & 0xff) });
    h.update(challenge);
    var out: [32]u8 = undefined;
    h.final(&out);
    return out;
}

/// The name the node finds a token by, without the token (`unbrowse_core::token_key`).
pub fn tokenKey(token: []const u8) [32]u8 {
    var h = std.crypto.hash.sha3.Keccak256.init(.{});
    h.update("unbrowse/node-key\n");
    h.update(token);
    var out: [32]u8 = undefined;
    h.final(&out);
    return out;
}

/// Whether a proof answer holds `want` (hex): among the agents' proofs, or as the owner's.
pub fn answerHolds(gpa: std.mem.Allocator, body: []const u8, want: []const u8) bool {
    const P = struct { agents: []const []const u8 = &.{}, owner: ?[]const u8 = null };
    const parsed = std.json.parseFromSlice(P, gpa, body, .{ .ignore_unknown_fields = true }) catch return false;
    defer parsed.deinit();
    if (parsed.value.owner) |o| if (std.ascii.eqlIgnoreCase(o, want)) return true;
    for (parsed.value.agents) |p| if (std.ascii.eqlIgnoreCase(p, want)) return true;
    return false;
}

/// How long nothing must answer before the window starts a node: a service
/// restarting its node has it back within that.
pub const grace_s: i64 = 3;

/// Whether the window may start a node, nothing having answered for
/// `down_for_s`: never when the node it reached was one it found running (a
/// service's or a terminal's; whoever started it brings it back, and a second
/// node would take its port), and only after `grace_s`.
pub fn mayStart(found: bool, down_for_s: i64) bool {
    return !found and down_for_s >= grace_s;
}

fn field(line: []const u8, comptime name: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, line, name ++ ":")) return null;
    const v = line[name.len + 1 ..];
    return if (v.len > 0 and v[0] == ' ') v[1..] else v;
}

/// The message in a node's error answer, `{"error":"…"}`, else the body.
pub fn errorText(a: std.mem.Allocator, r: Reply) []const u8 {
    if (r.status == 0) return r.body;
    const E = struct { @"error": []const u8 = "" };
    if (std.json.parseFromSliceLeaky(E, a, r.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always })) |e| {
        if (e.@"error".len > 0) return e.@"error";
    } else |_| {}
    if (r.body.len > 0) return r.body;
    return std.fmt.allocPrint(a, "The node answered {d}.", .{r.status}) catch "The node refused.";
}

test "a node that turned the window away is never joined by a second" {
    try std.testing.expect(!Line.refused.startsNode());
    try std.testing.expect(!Line.ended.startsNode());
    try std.testing.expect(Line.unreached.startsNode());
}

test "a node the window found running is never started by it" {
    // The window found a node up (a systemd service's), and it went away (`systemctl restart`): the service brings
    // it back. A node started here would take its port, and the service's would crash-loop on "Address in use".
    try std.testing.expect(!mayStart(true, 0));
    try std.testing.expect(!mayStart(true, 3600));
    // Nothing was running when the window came up: it starts one, once nothing has answered for a few seconds.
    try std.testing.expect(!mayStart(false, 0));
    try std.testing.expect(!mayStart(false, grace_s - 1));
    try std.testing.expect(mayStart(false, grace_s));

    var n: Net = undefined;
    n.spawned_at = .init(0);
    n.found = .init(false);
    n.down_since = .init(5);
    n.up();
    try std.testing.expect(n.found.load(.acquire));
    try std.testing.expectEqual(@as(i64, 0), n.down_since.load(.acquire));
    // A node the window started itself is its own to start again.
    n.found = .init(false);
    n.spawned_at = .init(100);
    n.up();
    try std.testing.expect(!n.found.load(.acquire));
}

test "sse fields" {
    try std.testing.expectEqualStrings("eye", field("event: eye", "event").?);
    try std.testing.expectEqualStrings("{}", field("data:{}", "data").?);
    try std.testing.expect(field("id: 1", "data") == null);
}

test "the window refuses a node that cannot prove the owner token" {
    const gpa = std.testing.allocator;
    // The node's own formula, computed with Rust's sha3 Keccak256 (unbrowse_core::node_proof, token_key).
    const zero: [32]u8 = @splat(0);
    try std.testing.expectEqualStrings("1394404167674c857f246c84149229696dc3f4e2d829f893914b4945e032bae9", &std.fmt.bytesToHex(nodeProof("tok", 7788, &zero), .lower));
    try std.testing.expectEqualStrings("0d7754b49bec69cd9f8059ca68ae6ccbe9c94d48193c7563570389509a9a4dd6", &std.fmt.bytesToHex(tokenKey("tok"), .lower));
    const want = std.fmt.bytesToHex(nodeProof("owner", 7788, &zero), .lower);
    var good: [200]u8 = undefined;
    try std.testing.expect(answerHolds(gpa, try std.fmt.bufPrint(&good, "{{\"agents\":[],\"owner\":\"{s}\"}}", .{want}), &want));
    // What a node says to a key it doesn't hold, another port's proof, or anything else: not the node.
    try std.testing.expect(!answerHolds(gpa, "{\"agents\":[]}", &want));
    const other = std.fmt.bytesToHex(nodeProof("owner", 7789, &zero), .lower);
    var bad: [200]u8 = undefined;
    try std.testing.expect(!answerHolds(gpa, try std.fmt.bufPrint(&bad, "{{\"owner\":\"{s}\"}}", .{other}), &want));
    try std.testing.expect(!answerHolds(gpa, "not json", &want));
    try std.testing.expect(!answerHolds(gpa, "{\"agents\":[1]}", &want));
}

test "the window signs as the node checks, and takes only what the node signed" {
    // The node's own vectors (unbrowse_core::signed), worked out apart from this code.
    const t = "unb_000000000000000000000000000000000000000000000000";
    const n = "00112233445566778899aabbccddeeff";
    try std.testing.expectEqualStrings("cdcc36e12c9a4077bb5da315826c623c3c3ca50927b0c6bc4b795ba45c03b767", &requestMac(t, "post", "127.0.0.1:7788", "/v1/do?x=1", "{\"goal\":\"g\"}", "1700000000", n));
    try std.testing.expectEqualStrings("e10b3b799411ad8e80d1811eabe612c092eabc800287749a5f2afbb03b3cb35d", &replyMac(t, 200, &bodyHash("{}"), n));
    const ev = eventMac(t, n, 0, "walk", "{}");
    try std.testing.expectEqualStrings("b6f79d64e0d4bfc35cb04732c0d84ede9d24e945ea2af522a67f11b15128b3fa", &ev);
    var id: [80]u8 = undefined;
    const good = try std.fmt.bufPrint(&id, "0.{s}", .{ev});
    try std.testing.expect(eventHolds(t, n, 0, "walk", "{}", good));
    // Out of place, changed, or not signed: not the node's.
    try std.testing.expect(!eventHolds(t, n, 1, "walk", "{}", good));
    try std.testing.expect(!eventHolds(t, n, 0, "walk", "{\"forged\":1}", good));
    try std.testing.expect(!eventHolds(t, n, 0, "walk", "{}", ""));
    try std.testing.expect(!eventHolds(t, n, 0, "walk", "{}", "0.zz"));
}

/// A fake node for the redirect test: it proves itself to `token` when `prove` (else redirects the proof too), and
/// answers everything else with a 307 to `to`.
const Redirector = struct {
    server: *std.Io.net.Server,
    to: u16,
    port: u16,
    prove: bool,
    token: []const u8,

    fn run(r: *const Redirector) void {
        const io = std.testing.io;
        var served: usize = 0;
        while (served < 2) : (served += 1) {
            const c = r.server.accept(io) catch return;
            defer c.close(io);
            var rb: [8192]u8 = undefined;
            var reader = c.reader(io, &rb);
            const first = (reader.interface.takeDelimiter('\n') catch return) orelse return;
            const line = std.mem.trimEnd(u8, first, "\r");
            while (true) {
                const h = (reader.interface.takeDelimiter('\n') catch break) orelse break;
                if (std.mem.trimEnd(u8, h, "\r").len == 0) break;
            }
            var wb: [512]u8 = undefined;
            var w = c.writer(io, &wb);
            if (r.prove and std.mem.indexOf(u8, line, "/v1/node/proof?challenge=") != null) {
                const at = std.mem.indexOf(u8, line, "challenge=").? + "challenge=".len;
                var challenge: [32]u8 = undefined;
                _ = std.fmt.hexToBytes(&challenge, line[at .. at + 64]) catch return;
                const proof = std.fmt.bytesToHex(nodeProof(r.token, r.port, &challenge), .lower);
                w.interface.print("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n{{\"agents\":[],\"owner\":\"{s}\"}}", .{ proof.len + 24, proof }) catch {};
            } else {
                w.interface.print("HTTP/1.1 307 Temporary Redirect\r\nlocation: http://127.0.0.1:{d}/owner/wallet_send\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", .{r.to}) catch {};
            }
            w.interface.flush() catch {};
        }
    }
};

test "the window never follows a redirect to another address" {
    const io = std.testing.io;
    const gpa = std.testing.allocator;
    const any = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var second = try any.listen(io, .{});
    defer second.deinit(io);
    const there = second.socket.address.getPort();
    var heard = std.atomic.Value(bool).init(false);
    const Listen = struct {
        fn run(s: *std.Io.net.Server, h: *std.atomic.Value(bool)) void {
            const c = s.accept(std.testing.io) catch return;
            h.store(true, .release);
            c.close(std.testing.io);
        }
    };
    const listening = try std.Thread.spawn(.{}, Listen.run, .{ &second, &heard });

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, ".unbrowse");
    try tmp.dir.writeFile(io, .{ .sub_path = ".unbrowse/owner.token", .data = "the-owners-token" });
    var hbuf: [256]u8 = undefined;
    const home = try std.fmt.bufPrint(&hbuf, ".zig-cache/tmp/{s}", .{tmp.sub_path});

    for ([_]bool{ false, true }) |prove| {
        var first = try any.listen(io, .{});
        defer first.deinit(io);
        const here = first.socket.address.getPort();
        const r: Redirector = .{ .server = &first, .to = there, .port = here, .prove = prove, .token = "the-owners-token" };
        const serving = try std.Thread.spawn(.{}, Redirector.run, .{&r});
        var n: Net = undefined;
        try n.init(gpa, io, home, ".");
        defer n.client.deinit();
        defer gpa.free(n.dir);
        n.port.store(here, .release);
        n.spawned_at.store(std.Io.Clock.real.now(io).toSeconds(), .release);
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        // A redirected proof proves nothing; a redirected command is not the node's, and goes nowhere else.
        const reply = n.get(arena.allocator(), "/owner/frame?walk=x");
        try std.testing.expectEqual(@as(u16, 0), reply.status);
        // Let the fake node's loop end.
        if (std.Io.net.IpAddress.parse("127.0.0.1", here)) |a| {
            if (a.connect(io, .{ .mode = .stream })) |c| c.close(io) else |_| {}
        } else |_| {}
        serving.join();
    }
    try std.testing.expect(!heard.load(.acquire));
    if (std.Io.net.IpAddress.parse("127.0.0.1", there)) |a| {
        if (a.connect(io, .{ .mode = .stream })) |c| c.close(io) else |_| {}
    } else |_| {}
    listening.join();
}

test "a reply the window words itself can be wiped like one the node sent" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const r = said(arena.allocator(), 0, "Can't reach the node on this machine.");
    try std.testing.expectEqualStrings("Can't reach the node on this machine.", r.body);
    // What a finished job does to every reply; a body in the program's constants stops the window here.
    std.crypto.secureZero(u8, r.body);
    try std.testing.expect(std.mem.allEqual(u8, r.body, 0));
}
