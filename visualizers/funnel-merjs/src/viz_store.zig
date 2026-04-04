const std = @import("std");

pub const SessionEnvelope = struct {
    id: []const u8,
    created_at_unix: i64,
    source: []const u8,
    prompt: []const u8,
    view_hints: []const []const u8,
    payload_json: []const u8,
};

pub fn sessionDir() []const u8 {
    return ".viz-sessions";
}

pub fn ensureSessionDir() !void {
    try std.fs.cwd().makePath(sessionDir());
}

pub fn sessionPath(allocator: std.mem.Allocator, id: []const u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "{s}/{s}.json", .{ sessionDir(), id });
}

pub fn generateId(allocator: std.mem.Allocator) ![]u8 {
    var bytes: [8]u8 = undefined;
    std.crypto.random.bytes(&bytes);
    return std.fmt.allocPrint(allocator, "{d}-{x}", .{ std.time.timestamp(), bytes });
}

pub fn writeSession(allocator: std.mem.Allocator, session: SessionEnvelope) !void {
    try ensureSessionDir();
    const path = try sessionPath(allocator, session.id);
    defer allocator.free(path);

    var out: std.io.Writer.Allocating = .init(allocator);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("id");
    try jw.write(session.id);
    try jw.objectField("created_at_unix");
    try jw.write(session.created_at_unix);
    try jw.objectField("source");
    try jw.write(session.source);
    try jw.objectField("prompt");
    try jw.write(session.prompt);
    try jw.objectField("view_hints");
    try jw.beginArray();
    for (session.view_hints) |hint| try jw.write(hint);
    try jw.endArray();
    try jw.objectField("payload");
    try jw.beginWriteRaw();
    try out.writer.writeAll(session.payload_json);
    jw.endWriteRaw();
    try jw.endObject();

    const file = try std.fs.cwd().createFile(path, .{ .truncate = true });
    defer file.close();
    try file.writeAll(out.written());
}

pub fn readSession(allocator: std.mem.Allocator, id: []const u8) ![]u8 {
    const path = try sessionPath(allocator, id);
    defer allocator.free(path);

    const file = try std.fs.cwd().openFile(path, .{});
    defer file.close();
    return try file.readToEndAlloc(allocator, 4 * 1024 * 1024);
}
