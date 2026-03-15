const std = @import("std");
const net = std.net;

/// Test harness for agent-led browser automation testing.
/// Provides helpers to launch Chrome, start Browdie, and hit API endpoints.
///
/// Inspired by vercel-labs/agent-browser's testing patterns:
/// - Snapshot diffing for verifying action effects
/// - Headless Chrome integration tests
/// - @eN ref system for deterministic element targeting
pub const TestHarness = struct {
    allocator: std.mem.Allocator,
    browdie_port: u16,

    pub fn init(allocator: std.mem.Allocator) TestHarness {
        return .{
            .allocator = allocator,
            .browdie_port = 8080,
        };
    }

    /// Send an HTTP GET request to Browdie and return the response body.
    pub fn get(self: *TestHarness, path: []const u8) ![]const u8 {
        const address = try net.Address.parseIp4("127.0.0.1", self.browdie_port);
        const stream = try net.tcpConnectToAddress(address);
        defer stream.close();

        // Set read timeout
        const timeout = std.posix.timeval{ .sec = 10, .usec = 0 };
        std.posix.setsockopt(stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout)) catch {};

        const req = try std.fmt.allocPrint(self.allocator, "GET {s} HTTP/1.1\r\nHost: 127.0.0.1:{d}\r\nConnection: close\r\n\r\n", .{ path, self.browdie_port });
        defer self.allocator.free(req);

        try stream.writeAll(req);

        // Read response
        var buf: [256 * 1024]u8 = undefined;
        var total: usize = 0;
        while (total < buf.len) {
            const n = stream.read(buf[total..]) catch break;
            if (n == 0) break;
            total += n;
        }

        if (total == 0) return error.ConnectionRefused;

        const raw = buf[0..total];
        const body_start = (std.mem.indexOf(u8, raw, "\r\n\r\n") orelse return error.InvalidCharacter) + 4;
        return try self.allocator.dupe(u8, raw[body_start..total]);
    }

    /// Assert that a JSON response body contains a specific string.
    pub fn assertContains(body: []const u8, needle: []const u8) !void {
        if (std.mem.indexOf(u8, body, needle) == null) {
            std.log.err("assertion failed: response does not contain \"{s}\"", .{needle});
            std.log.err("response body: {s}", .{body[0..@min(body.len, 500)]});
            return error.TestExpectedEqual;
        }
    }

    /// Assert JSON response body does NOT contain a string.
    pub fn assertNotContains(body: []const u8, needle: []const u8) !void {
        if (std.mem.indexOf(u8, body, needle) != null) {
            std.log.err("assertion failed: response should not contain \"{s}\"", .{needle});
            return error.TestExpectedEqual;
        }
    }

    /// Count occurrences of a pattern in response body (useful for counting snapshot refs).
    pub fn countOccurrences(body: []const u8, pattern: []const u8) usize {
        var count: usize = 0;
        var pos: usize = 0;
        while (std.mem.indexOfPos(u8, body, pos, pattern)) |found| {
            count += 1;
            pos = found + pattern.len;
        }
        return count;
    }

    /// Parse a snapshot response and return the number of interactive elements.
    pub fn snapshotElementCount(body: []const u8) usize {
        return countOccurrences(body, "\"ref\"");
    }

    /// Verify snapshot-action-snapshot cycle:
    /// 1. Take snapshot (before)
    /// 2. Perform action
    /// 3. Take snapshot (after)
    /// 4. Compare element counts changed
    pub fn verifyActionEffect(
        self: *TestHarness,
        tab_id: []const u8,
        action_path: []const u8,
    ) !struct { before: usize, after: usize } {
        // Before snapshot
        const snap_path = try std.fmt.allocPrint(self.allocator, "/snapshot?tab_id={s}&filter=interactive", .{tab_id});
        defer self.allocator.free(snap_path);

        const before = try self.get(snap_path);
        defer self.allocator.free(before);
        const before_count = snapshotElementCount(before);

        // Perform action
        const action_result = try self.get(action_path);
        defer self.allocator.free(action_result);

        // Wait for page to settle
        std.Thread.sleep(500 * std.time.ns_per_ms);

        // After snapshot
        const after = try self.get(snap_path);
        defer self.allocator.free(after);
        const after_count = snapshotElementCount(after);

        return .{ .before = before_count, .after = after_count };
    }
};

// --- Agent test patterns ---

/// Snapshot-Assert: Navigate to URL, snapshot, assert expected elements exist.
pub fn assertPageHasElements(
    harness: *TestHarness,
    tab_id: []const u8,
    expected_roles: []const []const u8,
) !void {
    const path = try std.fmt.allocPrint(harness.allocator, "/snapshot?tab_id={s}&filter=interactive", .{tab_id});
    defer harness.allocator.free(path);

    const body = try harness.get(path);
    defer harness.allocator.free(body);

    for (expected_roles) |role| {
        try TestHarness.assertContains(body, role);
    }
}

/// Text-Assert: Get page text, verify it contains expected content.
pub fn assertPageText(
    harness: *TestHarness,
    tab_id: []const u8,
    expected_texts: []const []const u8,
) !void {
    const path = try std.fmt.allocPrint(harness.allocator, "/text?tab_id={s}", .{tab_id});
    defer harness.allocator.free(path);

    const body = try harness.get(path);
    defer harness.allocator.free(body);

    for (expected_texts) |text| {
        try TestHarness.assertContains(body, text);
    }
}

test "TestHarness countOccurrences" {
    try std.testing.expectEqual(@as(usize, 3), TestHarness.countOccurrences("abc abc abc", "abc"));
    try std.testing.expectEqual(@as(usize, 0), TestHarness.countOccurrences("hello world", "xyz"));
    try std.testing.expectEqual(@as(usize, 2), TestHarness.countOccurrences("[{\"ref\":\"e0\"},{\"ref\":\"e1\"}]", "\"ref\""));
}

test "TestHarness snapshotElementCount" {
    const snapshot = "[{\"ref\":\"e0\",\"role\":\"button\"},{\"ref\":\"e1\",\"role\":\"link\"},{\"ref\":\"e2\",\"role\":\"textbox\"}]";
    try std.testing.expectEqual(@as(usize, 3), TestHarness.snapshotElementCount(snapshot));
}

test "assertContains passes" {
    try TestHarness.assertContains("{\"ok\":true}", "ok");
}

test "assertNotContains passes" {
    try TestHarness.assertNotContains("{\"ok\":true}", "error");
}
