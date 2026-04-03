const std = @import("std");
const mer = @import("mer");

const DEFAULT_BACKEND_URL = "https://beta-api.unbrowse.ai";

const EndpointSpec = struct {
    field: []const u8,
    path: []const u8,
};

const endpoints = [_]EndpointSpec{
    .{ .field = "campaigns", .path = "/v1/analytics/campaigns?days={d}" },
    .{ .field = "acquisition", .path = "/v1/analytics/acquisition?days={d}" },
    .{ .field = "install_funnel", .path = "/v1/analytics/install?days={d}" },
    .{ .field = "raw_funnel", .path = "/v1/analytics/install-funnel?days={d}" },
    .{ .field = "canonical_funnel", .path = "/v1/analytics/funnel?days={d}" },
    .{ .field = "activation", .path = "/v1/analytics/activation" },
    .{ .field = "landing_summary", .path = "/v1/landing/summary" },
};

fn buildEndpointUrl(allocator: std.mem.Allocator, backend_url: []const u8, index: usize, window_days: u16) ![]u8 {
    return switch (index) {
        0 => std.fmt.allocPrint(allocator, "{s}/v1/analytics/campaigns?days={d}", .{ backend_url, window_days }),
        1 => std.fmt.allocPrint(allocator, "{s}/v1/analytics/acquisition?days={d}", .{ backend_url, window_days }),
        2 => std.fmt.allocPrint(allocator, "{s}/v1/analytics/install?days={d}", .{ backend_url, window_days }),
        3 => std.fmt.allocPrint(allocator, "{s}/v1/analytics/install-funnel?days={d}", .{ backend_url, window_days }),
        4 => std.fmt.allocPrint(allocator, "{s}/v1/analytics/funnel?days={d}", .{ backend_url, window_days }),
        5 => std.fmt.allocPrint(allocator, "{s}/v1/analytics/activation", .{backend_url}),
        6 => std.fmt.allocPrint(allocator, "{s}/v1/landing/summary", .{backend_url}),
        else => std.fmt.allocPrint(allocator, "{s}", .{backend_url}),
    };
}

pub fn buildSnapshotBody(allocator: std.mem.Allocator, requested_days: u16) ![]u8 {
    const backend_url = mer.env("UNBROWSE_BACKEND_URL") orelse DEFAULT_BACKEND_URL;
    const api_key = mer.env("UNBROWSE_API_KEY");
    const has_api_key = api_key != null and api_key.?.len > 0;
    const window_days: u16 = if (requested_days < 1) 1 else if (requested_days > 180) 180 else requested_days;

    var errors: std.ArrayList([]const u8) = .{};
    defer errors.deinit(allocator);

    var responses_buf: [endpoints.len]?mer.FetchResponse = .{null} ** endpoints.len;
    if (!has_api_key) {
        try errors.append(allocator, "UNBROWSE_API_KEY missing; analytics snapshot is running in degraded mode.");
    } else {
        const auth_value = try std.fmt.allocPrint(allocator, "Bearer {s}", .{api_key.?});
        const auth_headers = [_]std.http.Header{
            .{ .name = "Authorization", .value = auth_value },
        };

        var requests: [endpoints.len]mer.FetchRequest = undefined;
        for (endpoints, 0..) |_, i| {
            const url = try buildEndpointUrl(allocator, backend_url, i, window_days);
            requests[i] = .{
                .url = url,
                .headers = &auth_headers,
            };
        }

        const fetched = mer.fetchAll(allocator, &requests);
        for (fetched, 0..) |maybe_res, i| responses_buf[i] = maybe_res;
    }
    defer {
        for (responses_buf) |maybe_res| {
            if (maybe_res) |res| res.deinit(allocator);
        }
    }

    for (endpoints, 0..) |endpoint, i| {
        const maybe_res = responses_buf[i];
        if (maybe_res) |res| {
            if (res.status != .ok) {
                const err = try std.fmt.allocPrint(allocator, "{s} returned {d}", .{ endpoint.field, @intFromEnum(res.status) });
                try errors.append(allocator, err);
            }
        }
    }

    var out: std.io.Writer.Allocating = .init(allocator);
    var jw: std.json.Stringify = .{ .writer = &out.writer };

    try jw.beginObject();
    try jw.objectField("window_days");
    try jw.write(window_days);

    try jw.objectField("configured");
    try jw.beginObject();
    try jw.objectField("backend_url");
    try jw.write(backend_url);
    try jw.objectField("has_api_key");
    try jw.write(has_api_key);
    try jw.endObject();

    try jw.objectField("errors");
    try jw.beginArray();
    for (errors.items) |err| try jw.write(err);
    try jw.endArray();

    for (endpoints, 0..) |endpoint, i| {
        try jw.objectField(endpoint.field);
        const maybe_res = responses_buf[i];
        if (maybe_res) |res| {
            if (res.status == .ok) {
                try jw.beginWriteRaw();
                try out.writer.writeAll(res.body);
                jw.endWriteRaw();
            } else {
                try jw.beginObject();
                try jw.endObject();
            }
        } else {
            try jw.beginObject();
            try jw.endObject();
        }
    }

    try jw.endObject();
    return out.written();
}
