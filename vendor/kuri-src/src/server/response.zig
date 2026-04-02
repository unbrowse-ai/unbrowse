const std = @import("std");
const json_util = @import("../util/json.zig");

pub fn sendJson(request: *std.http.Server.Request, body: []const u8) void {
    request.respond(body, .{
        .extra_headers = &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "access-control-allow-origin", .value = "*" },
        },
    }) catch |err| {
        std.log.err("sendJson: failed to respond: {s}", .{@errorName(err)});
    };
}

pub fn sendError(request: *std.http.Server.Request, status_code: u10, message: []const u8) void {
    const status: std.http.Status = @enumFromInt(status_code);
    const escaped = json_util.jsonEscape(message, std.heap.page_allocator) catch null;
    defer if (escaped) |safe| std.heap.page_allocator.free(safe);

    var body_buf: [512]u8 = undefined;
    const body = if (escaped) |safe|
        std.fmt.bufPrint(&body_buf, "{{\"error\":\"{s}\"}}", .{safe}) catch "{\"error\":\"Internal Server Error\"}"
    else
        "{\"error\":\"Internal Server Error\"}";

    request.respond(body, .{
        .status = status,
        .extra_headers = &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "access-control-allow-origin", .value = "*" },
        },
    }) catch |err| {
        std.log.err("sendError: failed to respond (status {d}): {s}", .{ status_code, @errorName(err) });
    };
}
