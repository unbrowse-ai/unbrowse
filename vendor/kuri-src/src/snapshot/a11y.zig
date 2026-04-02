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
    filter_semantic: bool = false,
    max_depth: ?u16 = null,
    format_text: bool = false,
    compact: bool = false,
    json_output: bool = false,
    diff: bool = false,
};

/// Roles with no semantic meaning — skip in semantic/compact mode.
const noise_roles = std.StaticStringMap(void).initComptime(.{
    .{ "none", {} },
    .{ "generic", {} },
    .{ "presentation", {} },
    .{ "ignored", {} },
    .{ "InlineTextBox", {} },
    .{ "LineBreak", {} },
});

/// Interactive roles — always kept, ref saved to session.
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

/// Semantic roles kept in full/semantic mode (structure + content).
const semantic_roles = std.StaticStringMap(void).initComptime(.{
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
    .{ "heading", {} },
    .{ "img", {} },
    .{ "figure", {} },
    .{ "article", {} },
    .{ "main", {} },
    .{ "navigation", {} },
    .{ "banner", {} },
    .{ "contentinfo", {} },
    .{ "complementary", {} },
    .{ "search", {} },
    .{ "form", {} },
    .{ "region", {} },
    .{ "list", {} },
    .{ "listitem", {} },
    .{ "table", {} },
    .{ "row", {} },
    .{ "cell", {} },
    .{ "columnheader", {} },
    .{ "rowheader", {} },
    .{ "grid", {} },
    .{ "gridcell", {} },
    .{ "dialog", {} },
    .{ "alertdialog", {} },
    .{ "alert", {} },
    .{ "status", {} },
    .{ "log", {} },
    .{ "progressbar", {} },
    .{ "tablist", {} },
    .{ "tabpanel", {} },
    .{ "tree", {} },
    .{ "treeitem", {} },
    .{ "group", {} },
    .{ "toolbar", {} },
    .{ "menubar", {} },
    .{ "paragraph", {} },
    .{ "blockquote", {} },
    .{ "separator", {} },
    .{ "StaticText", {} },
});

pub fn isInteractive(role: []const u8) bool {
    return interactive_roles.has(role);
}

pub fn isSemantic(role: []const u8) bool {
    return semantic_roles.has(role);
}

pub fn isNoise(role: []const u8) bool {
    return noise_roles.has(role);
}

/// Build a filtered/flattened snapshot from raw a11y nodes.
pub fn buildSnapshot(
    nodes: []const A11yNode,
    opts: SnapshotOpts,
    allocator: std.mem.Allocator,
) ![]A11yNode {
    var result: std.ArrayList(A11yNode) = .empty;
    errdefer {
        for (result.items) |node| allocator.free(node.ref);
        result.deinit(allocator);
    }

    for (nodes) |node| {
        if (opts.max_depth) |max| {
            if (node.depth > max) continue;
        }
        if (opts.filter_interactive and !isInteractive(node.role)) continue;

        // Semantic filter: skip noise roles; also skip nameless non-semantic nodes
        if (opts.filter_semantic and !opts.filter_interactive) {
            if (isNoise(node.role)) continue;
            if (!isSemantic(node.role) and node.name.len == 0) continue;
        }

        // Compact mode: skip noise + deduplicate StaticText
        if (opts.compact and !opts.filter_interactive) {
            if (isNoise(node.role)) continue;
            if (node.name.len == 0 and !isInteractive(node.role)) continue;
        }

        const ref = try std.fmt.allocPrint(allocator, "e{d}", .{result.items.len});

        // Truncate name — 70 chars captures all useful info without waste
        const name = if (node.name.len > 70) node.name[0..70] else node.name;

        try result.append(allocator, .{
            .ref = ref,
            .role = node.role,
            .name = name,
            .value = node.value,
            .backend_node_id = node.backend_node_id,
            .depth = node.depth,
        });
    }

    // Compact mode: drop StaticText whose name already appears in a non-StaticText node
    if (opts.compact) {
        // Collect all non-StaticText names
        var name_set: std.StringHashMap(void) = .init(allocator);
        defer name_set.deinit();
        for (result.items) |node| {
            if (!std.mem.eql(u8, node.role, "StaticText") and node.name.len > 2) {
                try name_set.put(node.name, {});
            }
        }
        // Filter: keep StaticText only if its name is NOT in the set
        var filtered: std.ArrayList(A11yNode) = .empty;
        errdefer {
            for (filtered.items) |node| {
                if (node.ref.len != 0) allocator.free(node.ref);
            }
            filtered.deinit(allocator);
        }
        var ref_idx: usize = 0;
        for (result.items) |node| {
            if (std.mem.eql(u8, node.role, "StaticText")) {
                // Drop whitespace-only
                const trimmed = std.mem.trim(u8, node.name, " \t\n\r");
                if (trimmed.len <= 1) continue;
                // Drop if text appears in a non-StaticText node's name
                if (name_set.contains(node.name)) continue;
                // Drop if mostly non-ASCII (unicode separators, bullets, etc.)
                var ascii_count: usize = 0;
                for (trimmed) |c| {
                    if (c >= 0x20 and c < 0x7f) ascii_count += 1;
                }
                if (trimmed.len > 2 and ascii_count * 3 < trimmed.len) continue;
            }
            // Only assign refs to interactive elements — agents only click/type those
            const is_act = isInteractive(node.role);
            const new_ref = if (is_act) try std.fmt.allocPrint(allocator, "e{d}", .{ref_idx}) else "";
            if (is_act) ref_idx += 1;
            try filtered.append(allocator, .{
                .ref = new_ref,
                .role = node.role,
                .name = node.name,
                .value = node.value,
                .backend_node_id = node.backend_node_id,
                .depth = node.depth,
            });
        }
        for (result.items) |node| allocator.free(node.ref);
        result.deinit(allocator);
        return filtered.toOwnedSlice(allocator);
    }

    return result.toOwnedSlice(allocator);

}

/// Compact text-tree format: `role "name" @ref` — agent-browser style.
/// ~6x fewer tokens than JSON for the same data.
pub fn formatCompact(nodes: []const A11yNode, allocator: std.mem.Allocator) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    const w = buf.writer(allocator);

    for (nodes) |node| {
        // Indent by depth
        var d: u16 = 0;
        while (d < node.depth) : (d += 1) try w.writeAll("  ");

        try w.writeAll(node.role);
        if (node.name.len > 0) {
            try w.print(" \"{s}\"", .{node.name});
        }
        if (node.ref.len > 0) try w.print(" @{s}", .{node.ref});
        if (node.value.len > 0) {
            try w.print(" = {s}", .{node.value});
        }
        try w.writeAll("\n");
    }

    return buf.toOwnedSlice(allocator);
}

/// Legacy indented text format (kept for --text flag).
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

test "isNoise" {
    try std.testing.expect(isNoise("none"));
    try std.testing.expect(isNoise("generic"));
    try std.testing.expect(isNoise("presentation"));
    try std.testing.expect(!isNoise("button"));
    try std.testing.expect(!isNoise("heading"));
}

test "buildSnapshot filters noise in compact mode" {
    const nodes = [_]A11yNode{
        .{ .ref = "", .role = "none", .name = "", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "", .role = "generic", .name = "", .value = "", .backend_node_id = 2, .depth = 0 },
        .{ .ref = "", .role = "button", .name = "Submit", .value = "", .backend_node_id = 3, .depth = 1 },
        .{ .ref = "", .role = "heading", .name = "Flights", .value = "", .backend_node_id = 4, .depth = 1 },
        .{ .ref = "", .role = "paragraph", .name = "", .value = "", .backend_node_id = 5, .depth = 1 },
    };

    const result = try buildSnapshot(&nodes, .{ .compact = true }, std.testing.allocator);
    defer {
        for (result) |n| std.testing.allocator.free(n.ref);
        std.testing.allocator.free(result);
    }

    // none, generic filtered; paragraph filtered (no name); button + heading kept
    try std.testing.expectEqual(@as(usize, 2), result.len);
    try std.testing.expectEqualStrings("button", result[0].role);
    try std.testing.expectEqualStrings("heading", result[1].role);
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
}
