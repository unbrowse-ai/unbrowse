const std = @import("std");
const mer = @import("mer");
const store = @import("viz_store");
const snapshot_data = @import("snapshot_data");

const CreateVizResponse = struct {
    session_id: []const u8,
    session_path: []const u8,
    viz_path: []const u8,
    source: []const u8,
};

pub fn render(req: mer.Request) mer.Response {
    return switch (req.method) {
        .POST => createSession(req),
        .GET => readSession(req),
        else => mer.text(.method_not_allowed, "GET or POST only"),
    };
}

fn createSession(req: mer.Request) mer.Response {
    if (req.body.len == 0) return mer.badRequest("missing json body");
    const parsed = std.json.parseFromSlice(std.json.Value, req.allocator, req.body, .{ .ignore_unknown_fields = true }) catch return mer.badRequest("invalid json");
    defer parsed.deinit();

    if (parsed.value != .object) return mer.badRequest("body must be a json object");
    const root = parsed.value.object;

    const prompt = valueString(root.get("prompt"), "show me what matters in this analytics payload");
    const source = valueString(root.get("source"), "manual");
    const kind = valueString(root.get("kind"), "");
    const days = valueU16(root.get("days"), 30);
    const view_hints = parseViewHints(req.allocator, root.get("view_hints")) catch return mer.internalError("view hints alloc failed");

    const payload_json = if (root.get("payload")) |payload|
        stringifyValue(req.allocator, payload) catch return mer.internalError("payload stringify failed")
    else if (std.mem.eql(u8, source, "analytics_snapshot") or std.mem.eql(u8, kind, "analytics_snapshot"))
        snapshot_data.buildSnapshotBody(req.allocator, days) catch return mer.internalError("snapshot build failed")
    else
        return mer.badRequest("missing payload");

    const id = if (root.get("session_id")) |value|
        if (value == .string and value.string.len > 0) value.string else store.generateId(req.allocator) catch return mer.internalError("id alloc failed")
    else
        store.generateId(req.allocator) catch return mer.internalError("id alloc failed");

    store.writeSession(req.allocator, .{
        .id = id,
        .created_at_unix = std.time.timestamp(),
        .source = source,
        .prompt = prompt,
        .view_hints = view_hints,
        .payload_json = payload_json,
    }) catch return mer.internalError("session write failed");

    const session_path = std.fmt.allocPrint(req.allocator, "/api/viz?id={s}", .{id}) catch return mer.internalError("path alloc failed");
    const viz_path = std.fmt.allocPrint(req.allocator, "/viz?id={s}", .{id}) catch return mer.internalError("path alloc failed");

    return mer.typedJson(req.allocator, CreateVizResponse{
        .session_id = id,
        .session_path = session_path,
        .viz_path = viz_path,
        .source = source,
    });
}

fn stringifyValue(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var out: std.io.Writer.Allocating = .init(allocator);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.write(value);
    return out.toOwnedSlice();
}

fn readSession(req: mer.Request) mer.Response {
    const id = req.queryParam("id") orelse return mer.badRequest("missing id");
    const raw = store.readSession(req.allocator, id) catch return mer.notFound();
    return mer.json(raw);
}

fn valueString(value: ?std.json.Value, fallback: []const u8) []const u8 {
    if (value) |v| {
        if (v == .string and v.string.len > 0) return v.string;
    }
    return fallback;
}

fn valueU16(value: ?std.json.Value, fallback: u16) u16 {
    if (value) |v| switch (v) {
        .integer => return std.math.cast(u16, v.integer) orelse fallback,
        .float => return std.math.cast(u16, @as(i64, @intFromFloat(v.float))) orelse fallback,
        .string => return std.fmt.parseInt(u16, v.string, 10) catch fallback,
        else => {},
    };
    return fallback;
}

fn parseViewHints(allocator: std.mem.Allocator, value: ?std.json.Value) ![]const []const u8 {
    if (value) |v| {
        if (v == .array) {
            var hints = std.ArrayList([]const u8){};
            defer hints.deinit(allocator);
            for (v.array.items) |item| {
                if (item == .string and item.string.len > 0) try hints.append(allocator, item.string);
            }
            return hints.toOwnedSlice(allocator);
        }
    }
    return allocator.alloc([]const u8, 0);
}
