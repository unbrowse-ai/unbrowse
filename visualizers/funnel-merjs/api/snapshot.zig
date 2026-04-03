const std = @import("std");
const mer = @import("mer");
const snapshot_data = @import("snapshot_data");

pub fn render(req: mer.Request) mer.Response {
    const parsed_days = std.fmt.parseInt(u16, req.queryParam("days") orelse "30", 10) catch 30;
    const window_days: u16 = if (parsed_days < 1) 1 else if (parsed_days > 180) 180 else parsed_days;
    const body = snapshot_data.buildSnapshotBody(req.allocator, window_days) catch return mer.internalError("snapshot build failed");
    return mer.json(body);
}
