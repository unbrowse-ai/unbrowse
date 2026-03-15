const std = @import("std");
const A11yNode = @import("a11y.zig").A11yNode;

pub const DiffKind = enum {
    added,
    removed,
    changed,
};

pub const DiffEntry = struct {
    kind: DiffKind,
    node: A11yNode,
};

/// Compute delta between previous and current snapshots.
/// Returns only nodes that were added, removed, or changed.
pub fn diffSnapshots(
    prev: []const A11yNode,
    current: []const A11yNode,
    allocator: std.mem.Allocator,
) ![]DiffEntry {
    var result: std.ArrayList(DiffEntry) = .empty;

    var prev_map = std.AutoHashMap(u32, A11yNode).init(allocator);
    defer prev_map.deinit();
    for (prev) |node| {
        if (node.backend_node_id) |id| {
            try prev_map.put(id, node);
        }
    }

    var seen = std.AutoHashMap(u32, void).init(allocator);
    defer seen.deinit();

    for (current) |node| {
        if (node.backend_node_id) |id| {
            try seen.put(id, {});
            if (prev_map.get(id)) |prev_node| {
                if (!std.mem.eql(u8, node.name, prev_node.name) or
                    !std.mem.eql(u8, node.value, prev_node.value) or
                    !std.mem.eql(u8, node.role, prev_node.role))
                {
                    try result.append(allocator, .{ .kind = .changed, .node = node });
                }
            } else {
                try result.append(allocator, .{ .kind = .added, .node = node });
            }
        }
    }

    for (prev) |node| {
        if (node.backend_node_id) |id| {
            if (!seen.contains(id)) {
                try result.append(allocator, .{ .kind = .removed, .node = node });
            }
        }
    }

    return result.toOwnedSlice(allocator);
}

test "diffSnapshots detects additions" {
    const prev = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "A", .value = "", .backend_node_id = 1, .depth = 0 },
    };
    const current = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "A", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "e1", .role = "link", .name = "B", .value = "", .backend_node_id = 2, .depth = 0 },
    };

    const diff = try diffSnapshots(&prev, &current, std.testing.allocator);
    defer std.testing.allocator.free(diff);

    try std.testing.expectEqual(@as(usize, 1), diff.len);
    try std.testing.expectEqual(DiffKind.added, diff[0].kind);
}

test "diffSnapshots detects removals" {
    const prev = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "A", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "e1", .role = "link", .name = "B", .value = "", .backend_node_id = 2, .depth = 0 },
    };
    const current = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "A", .value = "", .backend_node_id = 1, .depth = 0 },
    };

    const diff = try diffSnapshots(&prev, &current, std.testing.allocator);
    defer std.testing.allocator.free(diff);

    try std.testing.expectEqual(@as(usize, 1), diff.len);
    try std.testing.expectEqual(DiffKind.removed, diff[0].kind);
}

test "diffSnapshots detects changes" {
    const prev = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "Submit", .value = "", .backend_node_id = 1, .depth = 0 },
    };
    const current = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "Send", .value = "", .backend_node_id = 1, .depth = 0 },
    };

    const diff = try diffSnapshots(&prev, &current, std.testing.allocator);
    defer std.testing.allocator.free(diff);

    try std.testing.expectEqual(@as(usize, 1), diff.len);
    try std.testing.expectEqual(DiffKind.changed, diff[0].kind);
}
