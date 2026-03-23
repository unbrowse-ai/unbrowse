const std = @import("std");
const protocol = @import("protocol.zig");
const WebSocketClient = @import("websocket.zig").WebSocketClient;

pub const EventBuffer = struct {
    items: [32]?[]const u8,
    len: usize,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) EventBuffer {
        return .{
            .items = .{null} ** 32,
            .len = 0,
            .allocator = allocator,
        };
    }

    pub fn push(self: *EventBuffer, event: []const u8) void {
        const owned = self.allocator.dupe(u8, event) catch return;
        if (self.len < 32) {
            self.items[self.len] = owned;
            self.len += 1;
        } else {
            // Ring buffer: overwrite oldest
            self.allocator.free(self.items[0].?);
            var i: usize = 0;
            while (i < 31) : (i += 1) {
                self.items[i] = self.items[i + 1];
            }
            self.items[31] = owned;
        }
    }

    /// Check if any buffered event matches a method name.
    pub fn hasEvent(self: *EventBuffer, method: []const u8) bool {
        for (self.items[0..self.len]) |item| {
            if (item) |ev| {
                if (std.mem.indexOf(u8, ev, method) != null) return true;
            }
        }
        return false;
    }

    /// Drain all events, freeing memory.
    pub fn drain(self: *EventBuffer) void {
        for (self.items[0..self.len]) |item| {
            if (item) |ev| self.allocator.free(ev);
        }
        self.len = 0;
    }

    pub fn deinit(self: *EventBuffer) void {
        self.drain();
    }
};

/// 🧁 she's not just a bro, not just a baddie — she's a browdie.
/// CDP WebSocket client that talks to Chrome DevTools Protocol.
pub const CdpClient = struct {
    allocator: std.mem.Allocator,
    cdp_url: []const u8,
    next_id: std.atomic.Value(u32),
    ws: ?WebSocketClient,
    connected: bool,

    // Owned buffers for WebSocket I/O
    ws_read_buf: [512 * 1024]u8,
    ws_write_buf: [8192]u8,

    event_buf: EventBuffer,

    pub fn init(allocator: std.mem.Allocator, cdp_url: []const u8) CdpClient {
        return .{
            .allocator = allocator,
            .cdp_url = cdp_url,
            .next_id = std.atomic.Value(u32).init(1),
            .ws = null,
            .connected = false,
            .ws_read_buf = undefined,
            .ws_write_buf = undefined,
            .event_buf = EventBuffer.init(allocator),
        };
    }

    pub fn nextId(self: *CdpClient) u32 {
        return self.next_id.fetchAdd(1, .monotonic);
    }

    /// Connect to Chrome CDP WebSocket endpoint.
    pub fn connectWs(self: *CdpClient) !void {
        if (self.connected) return;
        self.ws = WebSocketClient.connect(
            self.allocator,
            self.cdp_url,
            &self.ws_read_buf,
            &self.ws_write_buf,
        ) catch return error.ConnectionRefused;
        self.connected = true;
    }

    /// Send a CDP command and receive the response. Allocates result.
    /// Send a CDP command and receive the matching response. Allocates result.
    /// Skips CDP events (messages without matching id) and correlates by command ID.
    pub fn send(self: *CdpClient, allocator: std.mem.Allocator, method: []const u8, params_json: ?[]const u8) ![]const u8 {
        if (!self.connected) try self.connectWs();

        var ws = &(self.ws orelse return error.ConnectionRefused);

        const msg = try self.buildMessage(allocator, method, params_json);
        const sent_id = self.next_id.load(.monotonic) - 1; // ID we just used
        defer allocator.free(msg);

        ws.sendText(msg) catch return error.ConnectionRefused;

        // Read responses, buffer events, max 100 attempts
        // (needs headroom for event-heavy operations like cookies/network)
        var attempts: u32 = 0;
        while (attempts < 100) : (attempts += 1) {
            const response = ws.receiveMessageAlloc(allocator, 2 * 1024 * 1024) catch |err| switch (err) {
                error.ConnectionClosed => return error.ConnectionRefused,
                else => return error.ConnectionRefused,
            };

            if (matchesResponseId(response, sent_id)) {
                return response;
            }

            // Buffer event instead of discarding
            self.event_buf.push(response);
        }

        return error.ConnectionRefused;
    }

    /// Check if a JSON response contains "id":N matching our sent command ID.
    pub fn matchesResponseId(json: []const u8, expected_id: u32) bool {
        // Look for "id": pattern near the start of the message
        const id_pos = std.mem.indexOf(u8, json, "\"id\"") orelse return false;
        // Only check first 50 chars — CDP response "id" is always near the top
        if (id_pos > 50) return false;
        const colon = std.mem.indexOfScalarPos(u8, json, id_pos + 3, ':') orelse return false;
        // Skip whitespace after colon
        var i = colon + 1;
        while (i < json.len and json[i] == ' ') : (i += 1) {}
        // Parse the number
        var end = i;
        while (end < json.len and json[end] >= '0' and json[end] <= '9') : (end += 1) {}
        if (end == i) return false;
        const parsed_id = std.fmt.parseInt(u32, json[i..end], 10) catch return false;
        return parsed_id == expected_id;
    }

    /// Build a JSON-RPC message for a CDP command.
    pub fn buildMessage(self: *CdpClient, allocator: std.mem.Allocator, method: []const u8, params_json: ?[]const u8) ![]const u8 {
        const id = self.nextId();
        if (params_json) |p| {
            return std.fmt.allocPrint(allocator, "{{\"id\":{d},\"method\":\"{s}\",\"params\":{s}}}", .{ id, method, p });
        } else {
            return std.fmt.allocPrint(allocator, "{{\"id\":{d},\"method\":\"{s}\"}}", .{ id, method });
        }
    }

    pub fn disconnect(self: *CdpClient) void {
        if (self.ws) |*ws| {
            ws.close();
            self.ws = null;
        }
        self.connected = false;
    }

    /// Wait for a specific CDP event by polling buffered events and reading new ones.
    /// Returns true if the event was seen within max_attempts reads.
    pub fn waitForEvent(self: *CdpClient, allocator: std.mem.Allocator, method: []const u8, max_attempts: u32) bool {
        // Check buffered events first
        if (self.event_buf.hasEvent(method)) return true;

        var ws = &(self.ws orelse return false);
        var attempts: u32 = 0;
        while (attempts < max_attempts) : (attempts += 1) {
            const response = ws.receiveMessageAlloc(allocator, 2 * 1024 * 1024) catch return false;
            if (std.mem.indexOf(u8, response, method) != null) {
                allocator.free(response);
                return true;
            }
            self.event_buf.push(response);
        }
        return false;
    }

    pub fn deinit(self: *CdpClient) void {
        self.event_buf.deinit();
        self.disconnect();
    }
};

test "CdpClient message building" {
    var client = CdpClient.init(std.testing.allocator, "ws://localhost:9222");
    defer client.deinit();

    const msg = try client.buildMessage(std.testing.allocator, "Page.navigate", "{\"url\":\"https://example.com\"}");
    defer std.testing.allocator.free(msg);

    try std.testing.expect(std.mem.indexOf(u8, msg, "Page.navigate") != null);
    try std.testing.expect(std.mem.indexOf(u8, msg, "https://example.com") != null);
}

test "CdpClient id increments" {
    var client = CdpClient.init(std.testing.allocator, "ws://localhost:9222");
    defer client.deinit();

    const id1 = client.nextId();
    const id2 = client.nextId();
    try std.testing.expect(id2 == id1 + 1);
}

test "matchesResponseId" {
    // Matches exact id
    try std.testing.expect(CdpClient.matchesResponseId("{\"id\":5,\"result\":{}}", 5));
    try std.testing.expect(CdpClient.matchesResponseId("{\"id\":42,\"result\":{}}", 42));
    // Doesn't match wrong id
    try std.testing.expect(!CdpClient.matchesResponseId("{\"id\":5,\"result\":{}}", 6));
    // Doesn't match events (no id field at start)
    try std.testing.expect(!CdpClient.matchesResponseId("{\"method\":\"Page.loadEventFired\",\"params\":{}}", 1));
    // Handles id with spaces
    try std.testing.expect(CdpClient.matchesResponseId("{\"id\": 10, \"result\":{}}", 10));
}

test "EventBuffer push and hasEvent" {
    var buf = EventBuffer.init(std.testing.allocator);
    defer buf.deinit();

    buf.push("{\"method\":\"Page.loadEventFired\",\"params\":{}}");
    try std.testing.expectEqual(@as(usize, 1), buf.len);
    try std.testing.expect(buf.hasEvent("Page.loadEventFired"));
    try std.testing.expect(!buf.hasEvent("Network.responseReceived"));
}

test "EventBuffer drain frees all" {
    var buf = EventBuffer.init(std.testing.allocator);
    defer buf.deinit();

    buf.push("event1");
    buf.push("event2");
    try std.testing.expectEqual(@as(usize, 2), buf.len);
    buf.drain();
    try std.testing.expectEqual(@as(usize, 0), buf.len);
}
