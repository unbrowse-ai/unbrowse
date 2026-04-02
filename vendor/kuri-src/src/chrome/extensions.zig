const std = @import("std");

/// Builtin extension files — embedded at compile time, zero runtime I/O to read them.
const builtin_manifest = @embedFile("js/extensions/kuri-builtin/manifest.json");
const builtin_content = @embedFile("js/extensions/kuri-builtin/content.js");
const builtin_background = @embedFile("js/extensions/kuri-builtin/background.js");

const BuiltinFile = struct {
    name: []const u8,
    data: []const u8,
};

const builtin_files = [_]BuiltinFile{
    .{ .name = "manifest.json", .data = builtin_manifest },
    .{ .name = "content.js", .data = builtin_content },
    .{ .name = "background.js", .data = builtin_background },
};

/// Extract the builtin extension to disk and return its path.
/// Writes to `<state_dir>/builtin-ext/`. Overwrites existing files
/// so the extension stays in sync with the binary version.
/// Returns an allocator-owned path string the caller must free.
pub fn extractBuiltinExtension(allocator: std.mem.Allocator, state_dir: []const u8) ![]const u8 {
    const home = std.posix.getenv("HOME") orelse "/tmp";
    const ext_dir = try std.fmt.allocPrint(allocator, "{s}/{s}/builtin-ext", .{ home, state_dir });
    errdefer allocator.free(ext_dir);

    // Ensure directory exists
    std.fs.cwd().makePath(ext_dir) catch |err| {
        std.log.err("failed to create builtin extension dir {s}: {}", .{ ext_dir, err });
        return err;
    };

    // Write each embedded file
    for (builtin_files) |file| {
        const file_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ ext_dir, file.name });
        defer allocator.free(file_path);

        const out = std.fs.cwd().createFile(file_path, .{}) catch |err| {
            std.log.err("failed to write {s}: {}", .{ file_path, err });
            return err;
        };
        defer out.close();
        out.writeAll(file.data) catch |err| {
            std.log.err("failed to write {s}: {}", .{ file_path, err });
            return err;
        };
    }

    std.log.info("extracted builtin extension to {s} ({d} files)", .{ ext_dir, builtin_files.len });
    return ext_dir;
}

/// Prepend the builtin extension path to an existing extensions string.
/// If `existing` is null, returns just the builtin path.
/// Caller owns the returned string.
pub fn prependBuiltinExtension(allocator: std.mem.Allocator, builtin_path: []const u8, existing: ?[]const u8) ![]const u8 {
    if (existing) |ext| {
        return std.fmt.allocPrint(allocator, "{s},{s}", .{ builtin_path, ext });
    }
    return allocator.dupe(u8, builtin_path);
}

// ── Tests ──

test "extractBuiltinExtension creates files" {
    const allocator = std.testing.allocator;
    // Use a temp dir to avoid polluting ~/.kuri
    const ext_dir = try extractBuiltinExtension(allocator, ".kuri-test");
    defer allocator.free(ext_dir);
    defer std.fs.cwd().deleteTree(ext_dir) catch {};

    // Verify all files exist
    for (builtin_files) |file| {
        const path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ ext_dir, file.name });
        defer allocator.free(path);
        const stat = try std.fs.cwd().statFile(path);
        try std.testing.expect(stat.size > 0);
    }
}

test "prependBuiltinExtension with existing" {
    const allocator = std.testing.allocator;
    const result = try prependBuiltinExtension(allocator, "/tmp/builtin", "/path/to/shopback");
    defer allocator.free(result);
    try std.testing.expectEqualStrings("/tmp/builtin,/path/to/shopback", result);
}

test "prependBuiltinExtension without existing" {
    const allocator = std.testing.allocator;
    const result = try prependBuiltinExtension(allocator, "/tmp/builtin", null);
    defer allocator.free(result);
    try std.testing.expectEqualStrings("/tmp/builtin", result);
}

test "builtin files are non-empty" {
    try std.testing.expect(builtin_manifest.len > 0);
    try std.testing.expect(builtin_content.len > 0);
    try std.testing.expect(builtin_background.len > 0);
}
