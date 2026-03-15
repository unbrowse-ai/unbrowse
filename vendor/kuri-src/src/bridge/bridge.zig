const std = @import("std");
const CdpClient = @import("../cdp/client.zig").CdpClient;
const HarRecorder = @import("../cdp/har.zig").HarRecorder;
const A11yNode = @import("../snapshot/a11y.zig").A11yNode;

pub const TabEntry = struct {
    id: []const u8,
    url: []const u8,
    title: []const u8,
    ws_url: []const u8,
    created_at: i64,
    last_accessed: i64,
};

pub const RefCache = struct {
    refs: std.StringHashMap(u32),
    node_count: usize,

    pub fn init(allocator: std.mem.Allocator) RefCache {
        return .{
            .refs = std.StringHashMap(u32).init(allocator),
            .node_count = 0,
        };
    }

    pub fn deinit(self: *RefCache) void {
        self.refs.deinit();
    }
};

pub const Bridge = struct {
    allocator: std.mem.Allocator,
    tabs: std.StringHashMap(TabEntry),
    snapshots: std.StringHashMap(RefCache),
    prev_snapshots: std.StringHashMap([]const A11yNode),
    cdp_clients: std.StringHashMap(CdpClient),
    har_recorders: std.StringHashMap(HarRecorder),
    mu: std.Thread.RwLock,

    pub fn init(allocator: std.mem.Allocator) Bridge {
        return .{
            .allocator = allocator,
            .tabs = std.StringHashMap(TabEntry).init(allocator),
            .snapshots = std.StringHashMap(RefCache).init(allocator),
            .prev_snapshots = std.StringHashMap([]const A11yNode).init(allocator),
            .cdp_clients = std.StringHashMap(CdpClient).init(allocator),
            .har_recorders = std.StringHashMap(HarRecorder).init(allocator),
            .mu = .{},
        };
    }

    pub fn deinit(self: *Bridge) void {
        var har_it = self.har_recorders.valueIterator();
        while (har_it.next()) |rec| {
            rec.deinit();
        }
        self.har_recorders.deinit();

        var cdp_it = self.cdp_clients.valueIterator();
        while (cdp_it.next()) |client| {
            client.deinit();
        }
        self.cdp_clients.deinit();

        self.prev_snapshots.deinit();

        var snap_it = self.snapshots.valueIterator();
        while (snap_it.next()) |cache| {
            cache.deinit();
        }
        self.snapshots.deinit();

        var tab_it = self.tabs.valueIterator();
        while (tab_it.next()) |tab| {
            self.allocator.free(tab.id);
            self.allocator.free(tab.url);
            self.allocator.free(tab.title);
            self.allocator.free(tab.ws_url);
        }
        self.tabs.deinit();
    }

    pub fn tabCount(self: *Bridge) usize {
        self.mu.lockShared();
        defer self.mu.unlockShared();
        return self.tabs.count();
    }

    pub fn getTab(self: *Bridge, tab_id: []const u8) ?TabEntry {
        self.mu.lockShared();
        defer self.mu.unlockShared();
        return self.tabs.get(tab_id);
    }

    pub fn putTab(self: *Bridge, entry: TabEntry) !void {
        self.mu.lock();
        defer self.mu.unlock();

        // Dupe all strings into bridge allocator for ownership
        const owned = TabEntry{
            .id = try self.allocator.dupe(u8, entry.id),
            .url = try self.allocator.dupe(u8, entry.url),
            .title = try self.allocator.dupe(u8, entry.title),
            .ws_url = try self.allocator.dupe(u8, entry.ws_url),
            .created_at = entry.created_at,
            .last_accessed = entry.last_accessed,
        };
        errdefer {
            self.allocator.free(owned.id);
            self.allocator.free(owned.url);
            self.allocator.free(owned.title);
            self.allocator.free(owned.ws_url);
        }

        // Remove old entry first (frees old key from map)
        if (self.tabs.fetchRemove(entry.id)) |old_kv| {
            self.allocator.free(old_kv.key);
            self.allocator.free(old_kv.value.url);
            self.allocator.free(old_kv.value.title);
            self.allocator.free(old_kv.value.ws_url);
            // old_kv.key == old_kv.value.id, already freed above
        }

        try self.tabs.put(owned.id, owned);
    }

    pub fn removeTab(self: *Bridge, tab_id: []const u8) void {
        self.mu.lock();
        defer self.mu.unlock();

        // Grab owned strings before removing from map
        const tab = self.tabs.get(tab_id) orelse {
            if (self.snapshots.getPtr(tab_id)) |cache| cache.deinit();
            _ = self.snapshots.remove(tab_id);
            _ = self.prev_snapshots.remove(tab_id);
            if (self.cdp_clients.getPtr(tab_id)) |client| client.deinit();
            _ = self.cdp_clients.remove(tab_id);
            if (self.har_recorders.getPtr(tab_id)) |rec| rec.deinit();
            _ = self.har_recorders.remove(tab_id);
            return;
        };

        _ = self.tabs.remove(tab_id);

        self.allocator.free(tab.id);
        self.allocator.free(tab.url);
        self.allocator.free(tab.title);
        self.allocator.free(tab.ws_url);

        if (self.snapshots.getPtr(tab_id)) |cache| cache.deinit();
        _ = self.snapshots.remove(tab_id);
        _ = self.prev_snapshots.remove(tab_id);
        if (self.cdp_clients.getPtr(tab_id)) |client| client.deinit();
        _ = self.cdp_clients.remove(tab_id);
        if (self.har_recorders.getPtr(tab_id)) |rec| rec.deinit();
        _ = self.har_recorders.remove(tab_id);
    }

    pub fn listTabs(self: *Bridge, allocator: std.mem.Allocator) ![]TabEntry {
        self.mu.lockShared();
        defer self.mu.unlockShared();

        var list: std.ArrayList(TabEntry) = .empty;
        var it = self.tabs.valueIterator();
        while (it.next()) |entry| {
            try list.append(allocator, entry.*);
        }
        return list.toOwnedSlice(allocator);
    }

    /// Get or create a CDP client for a tab.
    pub fn getCdpClient(self: *Bridge, tab_id: []const u8) ?*CdpClient {
        self.mu.lock();
        defer self.mu.unlock();

        if (self.cdp_clients.getPtr(tab_id)) |client| {
            return client;
        }

        const tab = self.tabs.get(tab_id) orelse return null;
        if (tab.ws_url.len == 0) return null;

        const client = CdpClient.init(self.allocator, tab.ws_url);
        self.cdp_clients.put(tab_id, client) catch return null;
        return self.cdp_clients.getPtr(tab_id);
    }

    pub fn exportState(self: *Bridge, allocator: std.mem.Allocator) ![]const u8 {
        self.mu.lockShared();
        defer self.mu.unlockShared();

        var json_buf: std.ArrayList(u8) = .empty;
        const writer = json_buf.writer(allocator);
        try writer.writeAll("[");
        var it = self.tabs.valueIterator();
        var first = true;
        while (it.next()) |tab| {
            if (!first) try writer.writeAll(",");
            first = false;
            try writer.print("{{\"id\":\"{s}\",\"url\":\"{s}\",\"title\":\"{s}\",\"ws_url\":\"{s}\"}}", .{ tab.id, tab.url, tab.title, tab.ws_url });
        }
        try writer.writeAll("]");
        return json_buf.toOwnedSlice(allocator);
    }

    pub fn importState(self: *Bridge, json: []const u8, allocator: std.mem.Allocator) !usize {
        _ = allocator;
        var count: usize = 0;
        var pos: usize = 0;

        while (pos < json.len) {
            const obj_start = std.mem.indexOfScalarPos(u8, json, pos, '{') orelse break;
            const obj_end = std.mem.indexOfScalarPos(u8, json, obj_start, '}') orelse break;
            const obj = json[obj_start .. obj_end + 1];

            const id = extractField(obj, "\"id\"") orelse {
                pos = obj_end + 1;
                continue;
            };
            const url = extractField(obj, "\"url\"") orelse "";
            const title = extractField(obj, "\"title\"") orelse "";
            const ws_url = extractField(obj, "\"ws_url\"") orelse "";

            try self.putTab(.{
                .id = id,
                .url = url,
                .title = title,
                .ws_url = ws_url,
                .created_at = std.time.timestamp(),
                .last_accessed = std.time.timestamp(),
            });
            count += 1;
            pos = obj_end + 1;
        }
        return count;
    }

    fn extractField(json: []const u8, field: []const u8) ?[]const u8 {
        const field_pos = std.mem.indexOf(u8, json, field) orelse return null;
        const colon = std.mem.indexOfScalarPos(u8, json, field_pos + field.len, ':') orelse return null;
        var i = colon + 1;
        while (i < json.len and (json[i] == ' ' or json[i] == '"')) : (i += 1) {}
        if (i == 0) return null;
        const val_start = i;
        const val_end = std.mem.indexOfScalarPos(u8, json, val_start, '"') orelse return null;
        return json[val_start..val_end];
    }

    /// Get or create a HAR recorder for a tab.
    pub fn getHarRecorder(self: *Bridge, tab_id: []const u8) ?*HarRecorder {
        self.mu.lock();
        defer self.mu.unlock();

        if (self.har_recorders.getPtr(tab_id)) |rec| {
            return rec;
        }

        const rec = HarRecorder.init(self.allocator);
        self.har_recorders.put(tab_id, rec) catch return null;
        return self.har_recorders.getPtr(tab_id);
    }
};

test "bridge init/deinit" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();
    try std.testing.expectEqual(@as(usize, 0), bridge.tabCount());
}

test "exportState empty bridge" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();
    const json = try bridge.exportState(std.testing.allocator);
    defer std.testing.allocator.free(json);
    try std.testing.expectEqualStrings("[]", json);
}

test "exportState with one tab" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();
    try bridge.putTab(.{
        .id = "t1",
        .url = "https://example.com",
        .title = "Example",
        .ws_url = "ws://localhost:9222/t1",
        .created_at = 1000,
        .last_accessed = 1000,
    });
    const json = try bridge.exportState(std.testing.allocator);
    defer std.testing.allocator.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "https://example.com") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":\"t1\"") != null);
}

test "importState round-trip" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();
    const input = "[{\"id\":\"a1\",\"url\":\"https://a.com\",\"title\":\"A\",\"ws_url\":\"ws://x\"},{\"id\":\"b2\",\"url\":\"https://b.com\",\"title\":\"B\",\"ws_url\":\"\"}]";
    const count = try bridge.importState(input, std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 2), count);
    try std.testing.expectEqual(@as(usize, 2), bridge.tabCount());
    const tab = bridge.getTab("a1");
    try std.testing.expect(tab != null);
    try std.testing.expectEqualStrings("https://a.com", tab.?.url);
}

test "bridge tab CRUD" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    const entry = TabEntry{
        .id = "tab-1",
        .url = "https://example.com",
        .title = "Example",
        .ws_url = "",
        .created_at = 1000,
        .last_accessed = 1000,
    };
    try bridge.putTab(entry);
    try std.testing.expectEqual(@as(usize, 1), bridge.tabCount());

    const got = bridge.getTab("tab-1");
    try std.testing.expect(got != null);
    try std.testing.expectEqualStrings("https://example.com", got.?.url);

    bridge.removeTab("tab-1");
    try std.testing.expectEqual(@as(usize, 0), bridge.tabCount());
}
