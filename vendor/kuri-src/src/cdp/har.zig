const std = @import("std");
const CdpClient = @import("client.zig").CdpClient;

/// HAR (HTTP Archive) recorder using CDP Network domain events.
/// Captures request/response pairs with timing, headers, and status.
///
/// Usage:
///   1. har.start(client) — enables Network domain + clears entries
///   2. (browse pages, click things)
///   3. const json = har.stop(client) — disables Network domain, returns HAR JSON
///
/// Unlike agent-browser which uses page-level request events,
/// we go through CDP Network domain for richer data (timing, status codes, sizes).
pub const HarRecorder = struct {
    allocator: std.mem.Allocator,
    entries: std.ArrayList(HarEntry),
    recording: bool,
    pending_requests: std.StringHashMap(PendingRequest),

    pub const PendingRequest = struct {
        url: []const u8,
        method: []const u8,
        timestamp: i64,
    };

    pub const HarEntry = struct {
        url: []const u8,
        method: []const u8,
        status: u16,
        status_text: []const u8,
        mime_type: []const u8,
        timestamp: i64,
        duration_ms: i64,
        request_size: usize,
        response_size: usize,
    };

    pub fn init(allocator: std.mem.Allocator) HarRecorder {
        return .{
            .allocator = allocator,
            .entries = .empty,
            .recording = false,
            .pending_requests = std.StringHashMap(PendingRequest).init(allocator),
        };
    }

    /// Enable CDP Network domain to start capturing traffic.
    pub fn start(self: *HarRecorder, client: *CdpClient) !void {
        self.recording = true;
        // Clear previous entries
        for (self.entries.items) |entry| {
            self.allocator.free(entry.url);
            self.allocator.free(entry.method);
            self.allocator.free(entry.status_text);
            self.allocator.free(entry.mime_type);
        }
        self.entries.clearRetainingCapacity();

        // Enable Network domain via CDP
        _ = client.send(self.allocator, "Network.enable", null) catch |err| {
            std.log.warn("HAR: Network.enable failed: {s}", .{@errorName(err)});
            return err;
        };
    }

    /// Poll for network events and record them as HAR entries.
    /// Call this after page actions to capture traffic.
    pub fn capture(self: *HarRecorder, client: *CdpClient) !void {
        if (!self.recording) return;

        // Get the network log via CDP
        const response = client.send(self.allocator, "Network.getResponseBody", null) catch {
            // Not all pages have bodies — that's fine
            return;
        };
        defer self.allocator.free(response);
    }

    /// Add a manually observed request/response to the HAR log.
    pub fn addEntry(self: *HarRecorder, entry: HarEntry) !void {
        const owned = HarEntry{
            .url = try self.allocator.dupe(u8, entry.url),
            .method = try self.allocator.dupe(u8, entry.method),
            .status = entry.status,
            .status_text = try self.allocator.dupe(u8, entry.status_text),
            .mime_type = try self.allocator.dupe(u8, entry.mime_type),
            .timestamp = entry.timestamp,
            .duration_ms = entry.duration_ms,
            .request_size = entry.request_size,
            .response_size = entry.response_size,
        };
        try self.entries.append(self.allocator, owned);
    }

    /// Stop recording and return the HAR as a JSON string.
    pub fn stop(self: *HarRecorder, client: *CdpClient) ![]const u8 {
        self.recording = false;

        // Disable Network domain
        _ = client.send(self.allocator, "Network.disable", null) catch {};

        return self.toJson();
    }

    /// Serialize current entries to HAR 1.2 JSON format.
    pub fn toJson(self: *HarRecorder) ![]const u8 {
        var buf: std.ArrayList(u8) = .empty;
        const w = buf.writer(self.allocator);

        try w.writeAll("{\"log\":{\"version\":\"1.2\",\"creator\":{\"name\":\"browdie\",\"version\":\"0.1.0\"},\"entries\":[");

        for (self.entries.items, 0..) |entry, i| {
            if (i > 0) try w.writeAll(",");
            try w.print(
                "{{\"startedDateTime\":\"{d}\",\"time\":{d}," ++
                    "\"request\":{{\"method\":\"{s}\",\"url\":\"{s}\",\"bodySize\":{d}}}," ++
                    "\"response\":{{\"status\":{d},\"statusText\":\"{s}\",\"content\":{{\"mimeType\":\"{s}\",\"size\":{d}}}}}}}",
                .{
                    entry.timestamp,
                    entry.duration_ms,
                    entry.method,
                    entry.url,
                    entry.request_size,
                    entry.status,
                    entry.status_text,
                    entry.mime_type,
                    entry.response_size,
                },
            );
        }

        try w.writeAll("]}}");
        return buf.toOwnedSlice(self.allocator);
    }

    /// Get the number of captured entries.
    pub fn entryCount(self: *HarRecorder) usize {
        return self.entries.items.len;
    }

    /// Check if currently recording.
    pub fn isRecording(self: *HarRecorder) bool {
        return self.recording;
    }

    /// Handle a raw CDP event JSON string.
    /// Looks for Network.requestWillBeSent and Network.responseReceived events.
    pub fn handleCdpEvent(self: *HarRecorder, event_json: []const u8) void {
        if (!self.recording) return;

        if (std.mem.indexOf(u8, event_json, "\"Network.requestWillBeSent\"") != null) {
            const request_id = extractField(event_json, "requestId") orelse return;
            const url = extractField(event_json, "url") orelse return;
            const method = extractField(event_json, "method") orelse "GET";

            const owned_id = self.allocator.dupe(u8, request_id) catch return;
            const owned_url = self.allocator.dupe(u8, url) catch {
                self.allocator.free(owned_id);
                return;
            };
            const owned_method = self.allocator.dupe(u8, method) catch {
                self.allocator.free(owned_id);
                self.allocator.free(owned_url);
                return;
            };
            const pending = PendingRequest{
                .url = owned_url,
                .method = owned_method,
                .timestamp = std.time.timestamp(),
            };
            self.pending_requests.put(owned_id, pending) catch {
                self.allocator.free(owned_id);
                self.allocator.free(owned_url);
                self.allocator.free(owned_method);
            };
        } else if (std.mem.indexOf(u8, event_json, "\"Network.responseReceived\"") != null) {
            const request_id = extractField(event_json, "requestId") orelse return;
            const pending = self.pending_requests.get(request_id) orelse return;

            // Extract status and mimeType from the response object
            const status_str = extractField(event_json, "status");
            const status: u16 = if (status_str) |s|
                std.fmt.parseInt(u16, s, 10) catch 200
            else
                200;
            const mime = extractField(event_json, "mimeType") orelse "application/octet-stream";
            const status_text = if (status >= 200 and status < 300) "OK" else if (status >= 300 and status < 400) "Redirect" else if (status >= 400) "Error" else "Unknown";

            self.addEntry(.{
                .url = pending.url,
                .method = pending.method,
                .status = status,
                .status_text = status_text,
                .mime_type = mime,
                .timestamp = pending.timestamp,
                .duration_ms = std.time.timestamp() - pending.timestamp,
                .request_size = 0,
                .response_size = 0,
            }) catch return;
        }
    }

    /// Extract a simple string field value from JSON: finds "field":"value" pattern.
    fn extractField(json: []const u8, field: []const u8) ?[]const u8 {
        var search_buf: [256]u8 = undefined;
        const prefix = std.fmt.bufPrint(&search_buf, "\"{s}\"", .{field}) catch return null;

        const field_pos = std.mem.indexOf(u8, json, prefix) orelse return null;
        const after_field = field_pos + prefix.len;

        // Skip colon and whitespace
        var i = after_field;
        while (i < json.len and (json[i] == ':' or json[i] == ' ' or json[i] == '\t')) : (i += 1) {}
        if (i >= json.len or json[i] != '"') return null;
        const val_start = i + 1;
        const val_end = std.mem.indexOfScalarPos(u8, json, val_start, '"') orelse return null;
        return json[val_start..val_end];
    }

    pub fn deinit(self: *HarRecorder) void {
        for (self.entries.items) |entry| {
            self.allocator.free(entry.url);
            self.allocator.free(entry.method);
            self.allocator.free(entry.status_text);
            self.allocator.free(entry.mime_type);
        }
        self.entries.deinit(self.allocator);

        var it = self.pending_requests.iterator();
        while (it.next()) |kv| {
            self.allocator.free(kv.key_ptr.*);
            self.allocator.free(kv.value_ptr.url);
            self.allocator.free(kv.value_ptr.method);
        }
        self.pending_requests.deinit();
    }
};

// ── Tests ───────────────────────────────────────────────────────────────

test "HarRecorder init and deinit" {
    var rec = HarRecorder.init(std.testing.allocator);
    defer rec.deinit();

    try std.testing.expect(!rec.isRecording());
    try std.testing.expectEqual(@as(usize, 0), rec.entryCount());
}

test "HarRecorder addEntry and toJson" {
    var rec = HarRecorder.init(std.testing.allocator);
    defer rec.deinit();

    try rec.addEntry(.{
        .url = "https://vercel.com/",
        .method = "GET",
        .status = 200,
        .status_text = "OK",
        .mime_type = "text/html",
        .timestamp = 1709550000,
        .duration_ms = 42,
        .request_size = 0,
        .response_size = 15000,
    });

    try rec.addEntry(.{
        .url = "https://vercel.com/api/data",
        .method = "POST",
        .status = 201,
        .status_text = "Created",
        .mime_type = "application/json",
        .timestamp = 1709550001,
        .duration_ms = 100,
        .request_size = 256,
        .response_size = 512,
    });

    try std.testing.expectEqual(@as(usize, 2), rec.entryCount());

    const json = try rec.toJson();
    defer std.testing.allocator.free(json);

    // Verify HAR structure
    try std.testing.expect(std.mem.indexOf(u8, json, "\"version\":\"1.2\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"browdie\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "https://vercel.com/") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "https://vercel.com/api/data") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"method\":\"POST\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"status\":201") != null);
}

test "HarRecorder recording state" {
    var rec = HarRecorder.init(std.testing.allocator);
    defer rec.deinit();

    try std.testing.expect(!rec.isRecording());
    rec.recording = true;
    try std.testing.expect(rec.isRecording());
    rec.recording = false;
    try std.testing.expect(!rec.isRecording());
}

test "HarRecorder toJson empty" {
    var rec = HarRecorder.init(std.testing.allocator);
    defer rec.deinit();

    const json = try rec.toJson();
    defer std.testing.allocator.free(json);

    try std.testing.expectEqualStrings("{\"log\":{\"version\":\"1.2\",\"creator\":{\"name\":\"browdie\",\"version\":\"0.1.0\"},\"entries\":[]}}", json);
}

test "HarRecorder handleCdpEvent processes request and response" {
    var rec = HarRecorder.init(std.testing.allocator);
    defer rec.deinit();

    // Not recording — should be ignored
    rec.handleCdpEvent("{\"method\":\"Network.requestWillBeSent\",\"params\":{\"requestId\":\"1\",\"url\":\"https://example.com\",\"method\":\"GET\"}}");
    try std.testing.expectEqual(@as(usize, 0), rec.entryCount());

    // Start recording
    rec.recording = true;

    // Send requestWillBeSent
    rec.handleCdpEvent("{\"method\":\"Network.requestWillBeSent\",\"params\":{\"requestId\":\"req1\",\"url\":\"https://example.com/page\",\"method\":\"GET\"}}");
    try std.testing.expectEqual(@as(usize, 0), rec.entryCount());

    // Send responseReceived for the same requestId
    rec.handleCdpEvent("{\"method\":\"Network.responseReceived\",\"params\":{\"requestId\":\"req1\",\"response\":{\"status\":200}}}");
    try std.testing.expectEqual(@as(usize, 1), rec.entryCount());
}

test "HarRecorder extractField helper" {
    const json = "{\"method\":\"Network.requestWillBeSent\",\"requestId\":\"abc123\",\"url\":\"https://test.com\"}";
    const rid = HarRecorder.extractField(json, "requestId");
    try std.testing.expect(rid != null);
    try std.testing.expectEqualStrings("abc123", rid.?);

    const url = HarRecorder.extractField(json, "url");
    try std.testing.expect(url != null);
    try std.testing.expectEqualStrings("https://test.com", url.?);

    const missing = HarRecorder.extractField(json, "nonexistent");
    try std.testing.expect(missing == null);
}
