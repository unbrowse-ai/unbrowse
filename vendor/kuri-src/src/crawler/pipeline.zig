const std = @import("std");

pub const CrawlResult = struct {
    url: []const u8,
    html: ?[]const u8 = null,
    markdown: ?[]const u8 = null,
    err: ?[]const u8 = null,
    elapsed_ms: u64 = 0,
};

pub const PipelineOpts = struct {
    max_concurrent: usize = 5,
    output_dir: []const u8 = ".",
};

pub const WorkItem = struct {
    func: *const fn (*anyopaque) void,
    context: *anyopaque,
};

pub const ThreadPool = struct {
    threads: []std.Thread,
    queue: std.ArrayList(WorkItem),
    mutex: std.Thread.Mutex,
    allocator: std.mem.Allocator,
    active: std.atomic.Value(u32),
    shutdown: std.atomic.Value(bool),

    pub fn init(allocator: std.mem.Allocator, max_workers: usize) ThreadPool {
        return .{
            .threads = allocator.alloc(std.Thread, max_workers) catch &.{},
            .queue = .empty,
            .mutex = .{},
            .allocator = allocator,
            .active = std.atomic.Value(u32).init(0),
            .shutdown = std.atomic.Value(bool).init(false),
        };
    }

    pub fn deinit(self: *ThreadPool) void {
        self.shutdown.store(true, .release);
        self.allocator.free(self.threads);
        self.queue.deinit(self.allocator);
    }

    pub fn submit(self: *ThreadPool, work_fn: *const fn (*anyopaque) void, context: *anyopaque) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.queue.append(self.allocator, .{ .func = work_fn, .context = context });
    }

    pub fn pendingCount(self: *ThreadPool) usize {
        return self.queue.items.len;
    }

    pub fn activeCount(self: *ThreadPool) u32 {
        return self.active.load(.acquire);
    }
};

pub fn buildCrawlResults(urls: []const []const u8, allocator: std.mem.Allocator) ![]CrawlResult {
    const results = try allocator.alloc(CrawlResult, urls.len);
    for (results, urls) |*r, url| {
        r.* = .{
            .url = url,
            .html = null,
            .markdown = null,
            .err = null,
            .elapsed_ms = 0,
        };
    }
    return results;
}

test "CrawlResult defaults" {
    const result = CrawlResult{ .url = "https://example.com" };
    try std.testing.expectEqualStrings("https://example.com", result.url);
    try std.testing.expect(result.html == null);
    try std.testing.expect(result.err == null);
}

test "ThreadPool init/deinit" {
    var pool = ThreadPool.init(std.testing.allocator, 4);
    defer pool.deinit();
    try std.testing.expectEqual(4, pool.threads.len);
    try std.testing.expectEqual(false, pool.shutdown.load(.acquire));
}

test "pendingCount starts at 0" {
    var pool = ThreadPool.init(std.testing.allocator, 2);
    defer pool.deinit();
    try std.testing.expectEqual(@as(usize, 0), pool.pendingCount());
}

test "WorkItem can be constructed" {
    const S = struct {
        fn noop(_: *anyopaque) void {}
    };
    var dummy: u8 = 0;
    const item = WorkItem{ .func = S.noop, .context = @ptrCast(&dummy) };
    try std.testing.expectEqual(S.noop, item.func);
}

test "buildCrawlResults creates array with urls" {
    const urls = &[_][]const u8{ "https://a.com", "https://b.com" };
    const results = try buildCrawlResults(urls, std.testing.allocator);
    defer std.testing.allocator.free(results);
    try std.testing.expectEqual(@as(usize, 2), results.len);
    try std.testing.expectEqualStrings("https://a.com", results[0].url);
    try std.testing.expectEqualStrings("https://b.com", results[1].url);
    try std.testing.expect(results[0].html == null);
    try std.testing.expectEqual(@as(u64, 0), results[1].elapsed_ms);
}
