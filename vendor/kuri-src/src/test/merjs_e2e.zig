/// merjs E2E test suite — run via `zig build merjs-e2e`
///
/// Requires three things to be live before running:
///   1. merjs server on MERJS_PORT (default 3000)
///   2. Chrome with --remote-debugging-port=9222
///   3. agentic-browdie on BROWDIE_PORT (default 8080) with CDP_URL set
///
/// Exit 0 = all pass.  Exit 1 = any failure.

const std = @import("std");
const net = std.net;

const BROWDIE_PORT: u16 = 8080;
const MERJS_PORT: u16 = 3000;
const MERJS_HOST: []const u8 = "http://localhost:3000";
const NAV_SETTLE_MS: u64 = 1_500;

// ── HTTP helpers ─────────────────────────────────────────────────────────────

fn httpGet(allocator: std.mem.Allocator, port: u16, path: []const u8) ![]const u8 {
    const addr = try net.Address.parseIp4("127.0.0.1", port);
    const stream = try net.tcpConnectToAddress(addr);
    defer stream.close();

    const timeout = std.posix.timeval{ .sec = 10, .usec = 0 };
    std.posix.setsockopt(stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout)) catch {};

    const req = try std.fmt.allocPrint(allocator, "GET {s} HTTP/1.1\r\nHost: 127.0.0.1:{d}\r\nConnection: close\r\n\r\n", .{ path, port });
    defer allocator.free(req);
    try stream.writeAll(req);

    var buf: [256 * 1024]u8 = undefined;
    var total: usize = 0;
    while (total < buf.len) {
        const n = stream.read(buf[total..]) catch break;
        if (n == 0) break;
        total += n;
    }
    if (total == 0) return error.NoResponse;
    const raw = buf[0..total];
    const body_start = (std.mem.indexOf(u8, raw, "\r\n\r\n") orelse return error.InvalidResponse) + 4;
    return allocator.dupe(u8, raw[body_start..]);
}

fn contains(haystack: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, haystack, needle) != null;
}

// ── Test runner ──────────────────────────────────────────────────────────────

const Suite = struct {
    passed: usize = 0,
    failed: usize = 0,

    fn ok(s: *Suite, label: []const u8) void {
        s.passed += 1;
        std.debug.print("  \x1b[32m✓\x1b[0m {s}\n", .{label});
    }

    fn fail(s: *Suite, label: []const u8, detail: []const u8) void {
        s.failed += 1;
        std.debug.print("  \x1b[31m✗\x1b[0m {s} — {s}\n", .{ label, detail });
    }

    fn expect(s: *Suite, val: bool, label: []const u8) void {
        if (val) s.ok(label) else s.fail(label, "assertion false");
    }

    fn expectContains(s: *Suite, body: []const u8, needle: []const u8, label: []const u8) void {
        if (contains(body, needle)) {
            s.ok(label);
        } else {
            s.fail(label, needle);
        }
    }
};

// ── Browdie page helpers ─────────────────────────────────────────────────────

/// Navigate Chrome to a merjs URL and return the page text (via browdie /text).
fn pageText(a: std.mem.Allocator, tab_id: []const u8, path: []const u8) ![]const u8 {
    const url = try std.fmt.allocPrint(a, MERJS_HOST ++ "{s}", .{path});
    const nav = try std.fmt.allocPrint(a, "/navigate?url={s}&tab_id={s}", .{ url, tab_id });
    _ = try httpGet(a, BROWDIE_PORT, nav);
    std.Thread.sleep(NAV_SETTLE_MS * std.time.ns_per_ms);
    const text_path = try std.fmt.allocPrint(a, "/text?tab_id={s}", .{tab_id});
    return httpGet(a, BROWDIE_PORT, text_path);
}

/// Navigate Chrome to a merjs URL and return the interactive snapshot (via browdie /snapshot).
fn pageSnap(a: std.mem.Allocator, tab_id: []const u8, path: []const u8) ![]const u8 {
    const url = try std.fmt.allocPrint(a, MERJS_HOST ++ "{s}", .{path});
    const nav = try std.fmt.allocPrint(a, "/navigate?url={s}&tab_id={s}", .{ url, tab_id });
    _ = try httpGet(a, BROWDIE_PORT, nav);
    std.Thread.sleep(NAV_SETTLE_MS * std.time.ns_per_ms);
    const snap_path = try std.fmt.allocPrint(a, "/snapshot?tab_id={s}&filter=interactive&format=text", .{tab_id});
    return httpGet(a, BROWDIE_PORT, snap_path);
}

// ── main ─────────────────────────────────────────────────────────────────────

pub fn main() !void {
    var gpa_impl: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa_impl.deinit();
    var arena_impl: std.heap.ArenaAllocator = .init(gpa_impl.allocator());
    defer arena_impl.deinit();
    const a = arena_impl.allocator();

    var s: Suite = .{};

    std.debug.print("\n\x1b[1mmerjs E2E — via agentic-browdie\x1b[0m\n\n", .{});

    // ── Step 1: discover Chrome tabs via browdie ──────────────────────────
    std.debug.print("discover\n", .{});
    const discover = httpGet(a, BROWDIE_PORT, "/discover") catch |err| {
        std.debug.print("\x1b[31mERROR: browdie not reachable on port {d}: {s}\x1b[0m\n", .{ BROWDIE_PORT, @errorName(err) });
        std.process.exit(1);
    };
    s.expectContains(discover, "\"discovered\"", "browdie /discover OK");

    const tabs = try httpGet(a, BROWDIE_PORT, "/tabs");
    const id_key = "\"id\":\"";
    const id_pos = std.mem.indexOf(u8, tabs, id_key) orelse {
        std.debug.print("\x1b[31mERROR: no tabs found — is Chrome running?\x1b[0m\n", .{});
        std.process.exit(1);
    };
    const id_start = id_pos + id_key.len;
    const id_end = std.mem.indexOfScalarPos(u8, tabs, id_start, '"') orelse return error.NoTabFound;
    const tab_id = tabs[id_start..id_end];
    std.debug.print("  tab_id = {s}\n\n", .{tab_id});

    // ── Page: / ──────────────────────────────────────────────────────────
    std.debug.print("GET /\n", .{});
    {
        const text = try pageText(a, tab_id, "/");
        s.expectContains(text, "merjs", "/ — contains 'merjs'");
        s.expectContains(text, "Next.js", "/ — benchmark comparison present");
        s.expectContains(text, "node_modules", "/ — mentions node_modules");

        const snap = try pageSnap(a, tab_id, "/");
        s.expectContains(snap, "Dashboard", "/ — nav has Dashboard link");
        s.expectContains(snap, "Weather", "/ — nav has Weather link");
        s.expectContains(snap, "Users", "/ — nav has Users link");
        s.expectContains(snap, "Counter", "/ — nav has Counter link");
        s.expectContains(snap, "About", "/ — nav has About link");
    }

    // ── Page: /about ──────────────────────────────────────────────────────
    std.debug.print("\nGET /about\n", .{});
    {
        const text = try pageText(a, tab_id, "/about");
        s.expectContains(text, "merjs", "/about — mentions merjs");
        s.expectContains(text, "Zig", "/about — mentions Zig");
    }

    // ── Page: /dashboard ─────────────────────────────────────────────────
    std.debug.print("\nGET /dashboard\n", .{});
    {
        const text = try pageText(a, tab_id, "/dashboard");
        s.expectContains(text, "Dashboard", "/dashboard — heading present");
    }

    // ── Page: /users ──────────────────────────────────────────────────────
    std.debug.print("\nGET /users\n", .{});
    {
        const text = try pageText(a, tab_id, "/users");
        s.expectContains(text, "Users", "/users — heading present");

        const snap = try pageSnap(a, tab_id, "/users");
        s.expect(contains(snap, "[e"), "/users — has interactive elements");
    }

    // ── Page: /weather ────────────────────────────────────────────────────
    std.debug.print("\nGET /weather\n", .{});
    {
        const text = try pageText(a, tab_id, "/weather");
        s.expect(
            contains(text, "Weather") or contains(text, "weather") or contains(text, "temperature"),
            "/weather — weather content present",
        );
    }

    // ── Page: /counter ────────────────────────────────────────────────────
    std.debug.print("\nGET /counter\n", .{});
    {
        const snap = try pageSnap(a, tab_id, "/counter");
        s.expect(contains(snap, "button") or contains(snap, "Button"), "/counter — has button elements");
    }

    // ── Page: /login ──────────────────────────────────────────────────────
    std.debug.print("\nGET /login\n", .{});
    {
        const snap = try pageSnap(a, tab_id, "/login");
        s.expect(
            contains(snap, "textbox") or contains(snap, "button") or contains(snap, "combobox"),
            "/login — has form elements",
        );
    }

    // ── Page: 404 ────────────────────────────────────────────────────────
    std.debug.print("\nGET /nonexistent → 404\n", .{});
    {
        const text = try pageText(a, tab_id, "/nonexistent-route-xyz");
        s.expect(
            contains(text, "404") or contains(text, "Not Found") or contains(text, "not found"),
            "404 — renders not-found page",
        );
    }

    // ── API: /api/hello ───────────────────────────────────────────────────
    std.debug.print("\nGET /api/hello (direct)\n", .{});
    {
        const body = try httpGet(a, MERJS_PORT, "/api/hello");
        s.expectContains(body, "\"message\"", "/api/hello — has message field");
        s.expectContains(body, "merjs", "/api/hello — framework is merjs");
        s.expectContains(body, "\"node_modules\":0", "/api/hello — 0 node_modules");
        s.expectContains(body, "\"zig_version\"", "/api/hello — has zig_version");
    }

    // ── API: /api/time ────────────────────────────────────────────────────
    std.debug.print("\nGET /api/time (direct)\n", .{});
    {
        const body = try httpGet(a, MERJS_PORT, "/api/time");
        s.expectContains(body, "\"timestamp\"", "/api/time — has timestamp field");
        s.expectContains(body, "\"unit\":\"unix_seconds\"", "/api/time — unit is unix_seconds");
        s.expectContains(body, "\"iso\"", "/api/time — has iso field");
    }

    // ── API: /api/users ───────────────────────────────────────────────────
    std.debug.print("\nGET /api/users (direct)\n", .{});
    {
        const body = try httpGet(a, MERJS_PORT, "/api/users");
        s.expectContains(body, "\"name\"", "/api/users — has name field");
        s.expectContains(body, "\"email\"", "/api/users — has email field");
        s.expectContains(body, "Alice", "/api/users — returns Alice");
        s.expectContains(body, "alice@example.com", "/api/users — correct email");
        s.expectContains(body, "\"status\":\"active\"", "/api/users — status is active");
    }

    // ── Summary ───────────────────────────────────────────────────────────
    std.debug.print("\n\x1b[1m{d} passed, {d} failed\x1b[0m\n\n", .{ s.passed, s.failed });
    if (s.failed > 0) std.process.exit(1);
}
