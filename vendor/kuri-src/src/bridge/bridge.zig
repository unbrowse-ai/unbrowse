const std = @import("std");
const CdpClient = @import("../cdp/client.zig").CdpClient;
const HarRecorder = @import("../cdp/har.zig").HarRecorder;
const A11yNode = @import("../snapshot/a11y.zig").A11yNode;

fn traceTabsEnabled() bool {
    return std.posix.getenv("KURI_TRACE_TABS") != null;
}

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
    cdp_clients: std.StringHashMap(*CdpClient),
    har_recorders: std.StringHashMap(*HarRecorder),
    mu: std.Thread.RwLock,

    pub fn init(allocator: std.mem.Allocator) Bridge {
        return .{
            .allocator = allocator,
            .tabs = std.StringHashMap(TabEntry).init(allocator),
            .snapshots = std.StringHashMap(RefCache).init(allocator),
            .prev_snapshots = std.StringHashMap([]const A11yNode).init(allocator),
            .cdp_clients = std.StringHashMap(*CdpClient).init(allocator),
            .har_recorders = std.StringHashMap(*HarRecorder).init(allocator),
            .mu = .{},
        };
    }

    pub fn deinit(self: *Bridge) void {
        var har_it = self.har_recorders.iterator();
        while (har_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.*.deinit();
            self.allocator.destroy(entry.value_ptr.*);
        }
        self.har_recorders.deinit();

        var cdp_it = self.cdp_clients.iterator();
        while (cdp_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.*.deinit();
            self.allocator.destroy(entry.value_ptr.*);
        }
        self.cdp_clients.deinit();

        var prev_it = self.prev_snapshots.iterator();
        while (prev_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.prev_snapshots.deinit();

        var snap_it = self.snapshots.iterator();
        while (snap_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.*.deinit();
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
        if (traceTabsEnabled()) {
            std.log.info("trace.tabs put id={s} url={s} title={s} ws={s} count={d}", .{
                owned.id,
                owned.url,
                owned.title,
                if (owned.ws_url.len > 0) "yes" else "no",
                self.tabs.count(),
            });
        }
    }

    pub fn removeTab(self: *Bridge, tab_id: []const u8) void {
        self.mu.lock();
        defer self.mu.unlock();

        // Grab owned strings before removing from map
        const tab = self.tabs.get(tab_id) orelse {
            if (traceTabsEnabled()) {
                std.log.info("trace.tabs remove-miss id={s} snapshots={s} prev={s} client={s} har={s} count={d}", .{
                    tab_id,
                    if (self.snapshots.contains(tab_id)) "yes" else "no",
                    if (self.prev_snapshots.contains(tab_id)) "yes" else "no",
                    if (self.cdp_clients.contains(tab_id)) "yes" else "no",
                    if (self.har_recorders.contains(tab_id)) "yes" else "no",
                    self.tabs.count(),
                });
            }
            if (self.snapshots.fetchRemove(tab_id)) |kv| {
                self.allocator.free(kv.key);
                var cache = kv.value;
                cache.deinit();
            }
            if (self.prev_snapshots.fetchRemove(tab_id)) |kv| {
                self.allocator.free(kv.key);
            }
            if (self.cdp_clients.fetchRemove(tab_id)) |kv| {
                self.allocator.free(kv.key);
                kv.value.deinit();
                self.allocator.destroy(kv.value);
            }
            if (self.har_recorders.fetchRemove(tab_id)) |kv| {
                self.allocator.free(kv.key);
                kv.value.deinit();
                self.allocator.destroy(kv.value);
            }
            return;
        };

        if (traceTabsEnabled()) {
            std.log.info("trace.tabs remove id={s} url={s} client={s} har={s} count_before={d}", .{
                tab_id,
                tab.url,
                if (self.cdp_clients.contains(tab_id)) "yes" else "no",
                if (self.har_recorders.contains(tab_id)) "yes" else "no",
                self.tabs.count(),
            });
        }

        _ = self.tabs.remove(tab_id);

        self.allocator.free(tab.id);
        self.allocator.free(tab.url);
        self.allocator.free(tab.title);
        self.allocator.free(tab.ws_url);

        if (self.snapshots.fetchRemove(tab_id)) |kv| {
            self.allocator.free(kv.key);
            var cache = kv.value;
            cache.deinit();
        }
        if (self.prev_snapshots.fetchRemove(tab_id)) |kv| {
            self.allocator.free(kv.key);
        }
        if (self.cdp_clients.fetchRemove(tab_id)) |kv| {
            self.allocator.free(kv.key);
            kv.value.deinit();
            self.allocator.destroy(kv.value);
        }
        if (self.har_recorders.fetchRemove(tab_id)) |kv| {
            self.allocator.free(kv.key);
            kv.value.deinit();
            self.allocator.destroy(kv.value);
        }
        if (traceTabsEnabled()) {
            std.log.info("trace.tabs remove-done id={s} count_after={d}", .{ tab_id, self.tabs.count() });
        }
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
    /// Returns a stable heap-allocated pointer that survives HashMap resizes.
    pub fn getCdpClient(self: *Bridge, tab_id: []const u8) ?*CdpClient {
        self.mu.lock();
        defer self.mu.unlock();

        if (self.cdp_clients.get(tab_id)) |client| {
            if (traceTabsEnabled()) {
                std.log.info("trace.tabs cdp-hit id={s}", .{tab_id});
            }
            return client;
        }

        const tab = self.tabs.get(tab_id) orelse {
            if (traceTabsEnabled()) {
                std.log.info("trace.tabs cdp-miss id={s} reason=no-tab count={d}", .{ tab_id, self.tabs.count() });
            }
            return null;
        };
        if (tab.ws_url.len == 0) {
            if (traceTabsEnabled()) {
                std.log.info("trace.tabs cdp-miss id={s} reason=no-ws url={s}", .{ tab_id, tab.url });
            }
            return null;
        }

        const client = self.allocator.create(CdpClient) catch return null;
        client.* = CdpClient.init(self.allocator, tab.ws_url);
        const owned_key = self.allocator.dupe(u8, tab.id) catch {
            self.allocator.destroy(client);
            return null;
        };
        errdefer self.allocator.free(owned_key);
        self.cdp_clients.put(owned_key, client) catch {
            self.allocator.destroy(client);
            return null;
        };
        if (traceTabsEnabled()) {
            std.log.info("trace.tabs cdp-create id={s} ws={s}", .{ tab_id, tab.ws_url });
        }
        return client;
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
    /// Returns a stable heap-allocated pointer that survives HashMap resizes.
    pub fn getHarRecorder(self: *Bridge, tab_id: []const u8) ?*HarRecorder {
        self.mu.lock();
        defer self.mu.unlock();

        if (self.har_recorders.get(tab_id)) |rec| {
            return rec;
        }

        const tab = self.tabs.get(tab_id) orelse return null;
        const rec = self.allocator.create(HarRecorder) catch return null;
        rec.* = HarRecorder.init(self.allocator);
        const owned_key = self.allocator.dupe(u8, tab.id) catch {
            self.allocator.destroy(rec);
            return null;
        };
        errdefer self.allocator.free(owned_key);
        self.har_recorders.put(owned_key, rec) catch {
            self.allocator.destroy(rec);
            return null;
        };
        return rec;
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

test "bridge owns cdp and har map keys" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    try bridge.putTab(.{
        .id = "tab-1",
        .url = "https://example.com",
        .title = "Example",
        .ws_url = "ws://localhost:9222/devtools/page/tab-1",
        .created_at = 1000,
        .last_accessed = 1000,
    });

    const transient = try std.testing.allocator.dupe(u8, "tab-1");
    defer std.testing.allocator.free(transient);

    const first_client = bridge.getCdpClient(transient) orelse return error.TestUnexpectedResult;
    const first_recorder = bridge.getHarRecorder(transient) orelse return error.TestUnexpectedResult;

    @memset(transient, 'x');

    const second_client = bridge.getCdpClient("tab-1") orelse return error.TestUnexpectedResult;
    const second_recorder = bridge.getHarRecorder("tab-1") orelse return error.TestUnexpectedResult;

    try std.testing.expectEqual(first_client, second_client);
    try std.testing.expectEqual(first_recorder, second_recorder);
}
