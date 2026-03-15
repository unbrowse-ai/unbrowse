const std = @import("std");

pub const A11yNode = struct {
    ref: []const u8,
    role: []const u8,
    name: []const u8,
    value: []const u8,
    backend_node_id: ?u32,
    depth: u16,
};

pub const SnapshotOpts = struct {
    filter_interactive: bool = false,
    max_depth: ?u16 = null,
    format_text: bool = false,
    diff: bool = false,
};

/// Interactive roles that pass the filter=interactive check.
const interactive_roles = std.StaticStringMap(void).initComptime(.{
    .{ "button", {} },
    .{ "link", {} },
    .{ "textbox", {} },
    .{ "checkbox", {} },
    .{ "radio", {} },
    .{ "combobox", {} },
    .{ "listbox", {} },
    .{ "menuitem", {} },
    .{ "tab", {} },
    .{ "slider", {} },
    .{ "spinbutton", {} },
    .{ "switch", {} },
    .{ "searchbox", {} },
    .{ "option", {} },
    .{ "menuitemcheckbox", {} },
    .{ "menuitemradio", {} },
});

pub fn isInteractive(role: []const u8) bool {
    return interactive_roles.has(role);
}

/// Build a filtered/flattened snapshot from raw a11y nodes.
pub fn buildSnapshot(
    nodes: []const A11yNode,
    opts: SnapshotOpts,
    allocator: std.mem.Allocator,
) ![]A11yNode {
    var result: std.ArrayList(A11yNode) = .empty;

    for (nodes) |node| {
        if (opts.max_depth) |max| {
            if (node.depth > max) continue;
        }
        if (opts.filter_interactive and !isInteractive(node.role)) continue;

        const ref = try std.fmt.allocPrint(allocator, "e{d}", .{result.items.len});
        try result.append(allocator, .{
            .ref = ref,
            .role = node.role,
            .name = node.name,
            .value = node.value,
            .backend_node_id = node.backend_node_id,
            .depth = node.depth,
        });
    }

    return result.toOwnedSlice(allocator);
}

/// Format snapshot as indented plain text (40-60% token savings vs JSON).
pub fn formatText(nodes: []const A11yNode, allocator: std.mem.Allocator) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    const writer = buf.writer(allocator);

    for (nodes) |node| {
        for (0..node.depth) |_| {
            try writer.writeAll("  ");
        }
        try writer.print("[{s}] {s}", .{ node.ref, node.role });
        if (node.name.len > 0) {
            try writer.print(" \"{s}\"", .{node.name});
        }
        if (node.value.len > 0) {
            try writer.print(" value=\"{s}\"", .{node.value});
        }
        try writer.writeAll("\n");
    }

    return buf.toOwnedSlice(allocator);
}

test "isInteractive" {
    try std.testing.expect(isInteractive("button"));
    try std.testing.expect(isInteractive("link"));
    try std.testing.expect(isInteractive("textbox"));
    try std.testing.expect(!isInteractive("generic"));
    try std.testing.expect(!isInteractive("paragraph"));
    try std.testing.expect(!isInteractive("heading"));
}

test "buildSnapshot filters interactive" {
    const nodes = [_]A11yNode{
        .{ .ref = "", .role = "generic", .name = "div", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "", .role = "button", .name = "Submit", .value = "", .backend_node_id = 2, .depth = 1 },
        .{ .ref = "", .role = "paragraph", .name = "text", .value = "", .backend_node_id = 3, .depth = 1 },
        .{ .ref = "", .role = "link", .name = "Home", .value = "", .backend_node_id = 4, .depth = 1 },
    };

    const result = try buildSnapshot(&nodes, .{ .filter_interactive = true }, std.testing.allocator);
    defer {
        for (result) |n| std.testing.allocator.free(n.ref);
        std.testing.allocator.free(result);
    }

    try std.testing.expectEqual(@as(usize, 2), result.len);
    try std.testing.expectEqualStrings("button", result[0].role);
    try std.testing.expectEqualStrings("link", result[1].role);
}

test "buildSnapshot respects max_depth" {
    const nodes = [_]A11yNode{
        .{ .ref = "", .role = "generic", .name = "root", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "", .role = "button", .name = "btn", .value = "", .backend_node_id = 2, .depth = 1 },
        .{ .ref = "", .role = "link", .name = "deep", .value = "", .backend_node_id = 3, .depth = 5 },
    };

    const result = try buildSnapshot(&nodes, .{ .max_depth = 2 }, std.testing.allocator);
    defer {
        for (result) |n| std.testing.allocator.free(n.ref);
        std.testing.allocator.free(result);
    }

    try std.testing.expectEqual(@as(usize, 2), result.len);
}

test "formatText output" {
    const nodes = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "Submit", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "e1", .role = "textbox", .name = "Email", .value = "user@test.com", .backend_node_id = 2, .depth = 1 },
    };

    const text = try formatText(&nodes, std.testing.allocator);
    defer std.testing.allocator.free(text);

    try std.testing.expect(std.mem.indexOf(u8, text, "[e0] button \"Submit\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "  [e1] textbox \"Email\" value=\"user@test.com\"") != null);
}
