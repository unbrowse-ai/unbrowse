const std = @import("std");

/// Maps ref strings (e.g. "e0", "e1") to backend DOM node IDs.
/// Used by /action endpoint to target elements by their snapshot ref.
pub const SnapshotRefCache = struct {
    refs: std.StringHashMap(u32),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) SnapshotRefCache {
        return .{
            .refs = std.StringHashMap(u32).init(allocator),
            .allocator = allocator,
        };
    }

    pub fn put(self: *SnapshotRefCache, ref: []const u8, node_id: u32) !void {
        try self.refs.put(ref, node_id);
    }

    pub fn get(self: *SnapshotRefCache, ref: []const u8) ?u32 {
        return self.refs.get(ref);
    }

    pub fn count(self: *SnapshotRefCache) usize {
        return self.refs.count();
    }

    pub fn clear(self: *SnapshotRefCache) void {
        self.refs.clearAndFree();
    }

    pub fn deinit(self: *SnapshotRefCache) void {
        self.refs.deinit();
    }
};

test "SnapshotRefCache basic ops" {
    var cache = SnapshotRefCache.init(std.testing.allocator);
    defer cache.deinit();

    try cache.put("e0", 42);
    try cache.put("e1", 99);

    try std.testing.expectEqual(@as(?u32, 42), cache.get("e0"));
    try std.testing.expectEqual(@as(?u32, 99), cache.get("e1"));
    try std.testing.expectEqual(@as(?u32, null), cache.get("e2"));
    try std.testing.expectEqual(@as(usize, 2), cache.count());

    cache.clear();
    try std.testing.expectEqual(@as(usize, 0), cache.count());
}
