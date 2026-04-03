const std = @import("std");
const mer = @import("mer");
const store = @import("viz_store");
const viz_spec = @import("viz_spec");
const snapshot_data = @import("snapshot_data");

pub fn render(req: mer.Request) mer.Response {
    if (req.method != .POST) return mer.text(.method_not_allowed, "POST only");
    if (req.body.len == 0) return mer.badRequest("missing json body");

    const parsed = std.json.parseFromSlice(std.json.Value, req.allocator, req.body, .{ .ignore_unknown_fields = true }) catch return mer.badRequest("invalid json");
    defer parsed.deinit();
    if (parsed.value != .object) return mer.badRequest("body must be a json object");
    const root = parsed.value.object;

    var payload_holder: ?std.json.Parsed(std.json.Value) = null;
    defer if (payload_holder) |parsed_payload| parsed_payload.deinit();

    const prompt = valueString(root.get("prompt"), "");
    const source = valueString(root.get("source"), "manual");
    const days = valueU16(root.get("days"), 30);

    var resolved_prompt = prompt;
    var resolved_source = source;

    const payload = if (root.get("session_id")) |session_id_value| blk: {
        if (!(session_id_value == .string and session_id_value.string.len > 0)) return mer.badRequest("invalid session_id");
        const raw = store.readSession(req.allocator, session_id_value.string) catch return mer.notFound();
        const session = std.json.parseFromSlice(std.json.Value, req.allocator, raw, .{ .ignore_unknown_fields = true }) catch return mer.internalError("session parse failed");
        payload_holder = session;
        if (session.value != .object) return mer.internalError("bad session payload");
        const object = session.value.object;
        if (resolved_prompt.len == 0) resolved_prompt = valueString(object.get("prompt"), "");
        resolved_source = valueString(object.get("source"), source);
        break :blk object.get("payload") orelse return mer.internalError("session missing payload");
    } else if (root.get("payload")) |payload| payload else if (std.mem.eql(u8, source, "analytics_snapshot")) blk: {
        const body = snapshot_data.buildSnapshotBody(req.allocator, days) catch return mer.internalError("snapshot build failed");
        const snapshot = std.json.parseFromSlice(std.json.Value, req.allocator, body, .{ .ignore_unknown_fields = true }) catch return mer.internalError("snapshot parse failed");
        payload_holder = snapshot;
        break :blk snapshot.value;
    } else return mer.badRequest("missing payload");

    const jsonl = viz_spec.buildSpecStream(req.allocator, resolved_prompt, resolved_source, payload) catch return mer.internalError("spec build failed");
    return mer.text(.ok, jsonl);
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
