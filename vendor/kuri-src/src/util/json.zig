const std = @import("std");

/// Write a JSON object with string key-value pairs.
pub fn writeJsonObject(writer: anytype, fields: []const [2][]const u8) !void {
    try writer.writeAll("{");
    for (fields, 0..) |field, i| {
        if (i > 0) try writer.writeAll(",");
        try writer.print("\"{s}\":\"{s}\"", .{ field[0], field[1] });
    }
    try writer.writeAll("}");
}

/// Escape a string for JSON output.
pub fn jsonEscape(input: []const u8, allocator: std.mem.Allocator) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    for (input) |c| {
        switch (c) {
            '"' => try buf.appendSlice(allocator, "\\\""),
            '\\' => try buf.appendSlice(allocator, "\\\\"),
            '\n' => try buf.appendSlice(allocator, "\\n"),
            '\r' => try buf.appendSlice(allocator, "\\r"),
            '\t' => try buf.appendSlice(allocator, "\\t"),
            else => {
                if (c < 0x20) {
                    try buf.writer(allocator).print("\\u{x:0>4}", .{c});
                } else {
                    try buf.append(allocator, c);
                }
            },
        }
    }
    return buf.toOwnedSlice(allocator);
}

test "jsonEscape handles special chars" {
    const result = try jsonEscape("hello \"world\"\nnewline", std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqualStrings("hello \\\"world\\\"\\nnewline", result);
}

test "jsonEscape handles backslash" {
    const result = try jsonEscape("path\\to\\file", std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqualStrings("path\\\\to\\\\file", result);
}
