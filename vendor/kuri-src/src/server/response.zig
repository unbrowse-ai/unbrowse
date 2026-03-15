const std = @import("std");

pub fn sendJson(request: *std.http.Server.Request, body: []const u8) void {
    request.respond(body, .{
        .extra_headers = &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "access-control-allow-origin", .value = "*" },
        },
    }) catch {};
}

pub fn sendError(request: *std.http.Server.Request, status_code: u10, message: []const u8) void {
    const status: std.http.Status = @enumFromInt(status_code);
    var buf: [256]u8 = undefined;
    const body = std.fmt.bufPrint(&buf, "{{\"error\":\"{s}\"}}", .{message}) catch message;
    request.respond(body, .{
        .status = status,
        .extra_headers = &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "access-control-allow-origin", .value = "*" },
        },
    }) catch {};
}

test "response helpers compile" {
    try std.testing.expect(true);
}
