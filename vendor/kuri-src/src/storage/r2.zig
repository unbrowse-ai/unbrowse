const std = @import("std");

pub const R2Config = struct {
    endpoint_url: []const u8,
    access_key: []const u8,
    secret_key: []const u8,
    bucket_name: []const u8,
};

pub fn loadConfig() ?R2Config {
    const endpoint = std.posix.getenv("R2_ENDPOINT_URL") orelse return null;
    const access_key = std.posix.getenv("R2_ACCESS_KEY") orelse return null;
    const secret_key = std.posix.getenv("R2_SECRET_KEY") orelse return null;
    const bucket = std.posix.getenv("R2_BUCKET_NAME") orelse return null;

    return .{
        .endpoint_url = endpoint,
        .access_key = access_key,
        .secret_key = secret_key,
        .bucket_name = bucket,
    };
}

pub const R2Client = struct {
    config: R2Config,
    upload_count: u64,

    pub fn init(cfg: R2Config) R2Client {
        return .{
            .config = cfg,
            .upload_count = 0,
        };
    }

    pub fn buildUploadUrl(self: *R2Client, key: []const u8, allocator: std.mem.Allocator) ![]const u8 {
        return std.fmt.allocPrint(allocator, "{s}/{s}/{s}", .{ self.config.endpoint_url, self.config.bucket_name, key });
    }

    pub fn getUploadCount(self: *R2Client) u64 {
        return self.upload_count;
    }
};

pub fn generateObjectKey(url: []const u8, uuid: []const u8, ext: []const u8, allocator: std.mem.Allocator) ![]const u8 {
    // Extract domain from URL
    var domain = url;
    if (std.mem.indexOf(u8, domain, "://")) |idx| {
        domain = domain[idx + 3 ..];
    }
    if (std.mem.indexOfScalar(u8, domain, '/')) |idx| {
        domain = domain[0..idx];
    }
    const timestamp = std.time.timestamp();
    return std.fmt.allocPrint(allocator, "{s}/{s}/{d}.{s}", .{ uuid, domain, timestamp, ext });
}

test "loadConfig returns null without env" {
    const cfg = loadConfig();
    try std.testing.expect(cfg == null);
}

test "R2Client buildUploadUrl format" {
    var client = R2Client.init(.{
        .endpoint_url = "https://r2.example.com",
        .access_key = "key",
        .secret_key = "secret",
        .bucket_name = "mybucket",
    });
    const url = try client.buildUploadUrl("test/file.md", std.testing.allocator);
    defer std.testing.allocator.free(url);
    try std.testing.expectEqualStrings("https://r2.example.com/mybucket/test/file.md", url);
}

test "generateObjectKey format" {
    const key = try generateObjectKey("https://example.com/page", "abc-123", "md", std.testing.allocator);
    defer std.testing.allocator.free(key);
    // Should start with uuid/domain/
    try std.testing.expect(std.mem.startsWith(u8, key, "abc-123/example.com/"));
    try std.testing.expect(std.mem.endsWith(u8, key, ".md"));
}
