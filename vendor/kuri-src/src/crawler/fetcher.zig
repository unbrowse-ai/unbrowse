const std = @import("std");
const validator = @import("validator.zig");
const CdpClient = @import("../cdp/client.zig").CdpClient;

pub const FetchError = error{
    ValidationFailed,
    RateLimited,
    FetchFailed,
    ContentTooLarge,
};

pub const FetchOpts = struct {
    max_retries: u8 = 3,
    max_content_length: usize = 20 * 1024 * 1024, // 20MB
    timeout_ms: u32 = 30_000,
    rate_limiter: ?*RateLimiter = null,
};

pub const FetchResult = struct {
    html: []const u8,
    status_code: u16,
    content_type: []const u8,
};

/// Calculate exponential backoff delay in milliseconds for a given retry attempt (0-indexed).
/// Returns 100ms * 2^attempt, capped at attempt=20 to avoid overflow.
pub fn retryDelayMs(attempt: u8) u64 {
    const shift: u6 = @intCast(@min(attempt, 20));
    return @as(u64, 100) * (@as(u64, 1) << shift);
}

/// Fetch a page via CDP: validate URL, check rate limiter, navigate, extract HTML.
/// Retries up to opts.max_retries times with exponential backoff (100ms * 2^attempt).
/// If initial HTML is < 5KB, waits for Page.loadEventFired then re-extracts.
pub fn fetchPage(
    client: *CdpClient,
    url: []const u8,
    opts: FetchOpts,
    arena: std.mem.Allocator,
) !FetchResult {
    // Validate URL
    validator.validateUrl(url) catch return FetchError.ValidationFailed;

    // Check rate limiter
    if (opts.rate_limiter) |rl| {
        if (!rl.tryAcquire()) return FetchError.RateLimited;
    }

    const eval_params = "{\"expression\":\"document.documentElement.outerHTML\",\"returnByValue\":true}";

    var attempt: u8 = 0;
    while (attempt <= opts.max_retries) : (attempt += 1) {
        // Exponential backoff for retries (no delay on first attempt)
        if (attempt > 0) {
            const delay_ms = retryDelayMs(attempt - 1);
            std.Thread.sleep(delay_ms * std.time.ns_per_ms);
        }

        // Navigate to URL via CDP Page.navigate
        const nav_params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\"}}", .{url}) catch continue;
        _ = client.send(arena, "Page.navigate", nav_params) catch continue;

        // Extract HTML via Runtime.evaluate
        const result = client.send(arena, "Runtime.evaluate", eval_params) catch continue;
        const html = extractHtmlValue(result, arena) catch continue;

        // Dynamic content wait: poll for Page.loadEventFired instead of blind sleep
        var final_html = html;
        if (html.len < 5 * 1024) {
            // Wait for page load event (up to ~10 WS reads, typically <100ms)
            _ = client.waitForEvent(arena, "Page.loadEventFired", 10);
            if (client.send(arena, "Runtime.evaluate", eval_params)) |result2| {
                final_html = extractHtmlValue(result2, arena) catch html;
            } else |_| {}
        }

        // Check content length limit
        if (final_html.len > opts.max_content_length) return FetchError.ContentTooLarge;

        return FetchResult{
            .html = final_html,
            .status_code = 200,
            .content_type = "text/html",
        };
    }

    return FetchError.FetchFailed;
}

/// Extract the HTML string from a Runtime.evaluate CDP response JSON.
/// Expected format: {"id":N,"result":{"result":{"type":"string","value":"<html>..."}}}
pub fn extractHtmlValue(json: []const u8, arena: std.mem.Allocator) ![]const u8 {
    const value_key = "\"value\":\"";
    const key_idx = std.mem.indexOf(u8, json, value_key) orelse return FetchError.FetchFailed;
    const str_start = key_idx + value_key.len;

    // Scan for the closing (unescaped) quote
    var i = str_start;
    while (i < json.len) : (i += 1) {
        if (json[i] == '"') break;
        if (json[i] == '\\') i += 1; // skip next char (escape sequence)
    }
    if (i >= json.len) return FetchError.FetchFailed;

    return unescapeJson(arena, json[str_start..i]);
}

/// Unescape JSON string escape sequences into a new allocation.
fn unescapeJson(arena: std.mem.Allocator, escaped: []const u8) ![]const u8 {
    var list: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < escaped.len) : (i += 1) {
        if (escaped[i] == '\\' and i + 1 < escaped.len) {
            i += 1;
            switch (escaped[i]) {
                '"' => try list.append(arena, '"'),
                '\\' => try list.append(arena, '\\'),
                '/' => try list.append(arena, '/'),
                'n' => try list.append(arena, '\n'),
                'r' => try list.append(arena, '\r'),
                't' => try list.append(arena, '\t'),
                'b' => try list.append(arena, 8),
                'f' => try list.append(arena, 12),
                else => {
                    try list.append(arena, '\\');
                    try list.append(arena, escaped[i]);
                },
            }
        } else {
            try list.append(arena, escaped[i]);
        }
    }
    return list.toOwnedSlice(arena);
}

/// Calculate exponential backoff delay in nanoseconds for a given retry attempt (0-indexed).
/// Returns 100_000_000 * 2^attempt, capped at 3_200_000_000 (3.2 seconds).
pub fn retryDelayNs(attempt: u8) u64 {
    const shift: u6 = @intCast(@min(attempt, 20));
    const delay = @as(u64, 100_000_000) * (@as(u64, 1) << shift);
    return @min(delay, 3_200_000_000);
}

/// Generic page fetcher that works with any CDP-like client (including test mocks).
/// Uses `anytype` for client so pure-function tests don't need a real CdpClient.
pub fn fetchPageGeneric(client: anytype, url: []const u8, _: FetchOpts, rate_limiter: ?*RateLimiter, arena: std.mem.Allocator) FetchError!FetchResult {
    // Validate URL
    validator.validateUrl(url) catch return FetchError.ValidationFailed;

    // Check rate limiter
    if (rate_limiter) |rl| {
        if (!rl.tryAcquire()) return FetchError.RateLimited;
    }

    // Navigate to URL via CDP Page.navigate
    const nav_params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\"}}", .{url}) catch return FetchError.FetchFailed;
    _ = client.send(arena, "Page.navigate", nav_params) catch return FetchError.FetchFailed;

    // Brief wait for page load (50ms baseline — CDP navigate is async)
    std.Thread.sleep(50 * std.time.ns_per_ms);

    // Extract HTML via Runtime.evaluate
    const eval_params = "{\"expression\":\"document.documentElement.outerHTML\",\"returnByValue\":true}";
    const response = client.send(arena, "Runtime.evaluate", eval_params) catch return FetchError.FetchFailed;

    return FetchResult{
        .html = response,
        .status_code = 200,
        .content_type = "text/html",
    };
}

/// Generic page fetcher with retry logic. Retries on FetchFailed with exponential backoff;
/// other errors (ValidationFailed, RateLimited) are returned immediately.
pub fn fetchPageWithRetry(client: anytype, url: []const u8, opts: FetchOpts, rate_limiter: ?*RateLimiter, arena: std.mem.Allocator) FetchError!FetchResult {
    var attempt: u8 = 0;
    while (attempt < opts.max_retries) : (attempt += 1) {
        const result = fetchPageGeneric(client, url, opts, rate_limiter, arena);
        if (result) |res| {
            return res;
        } else |err| {
            if (err != FetchError.FetchFailed) return err;
            std.Thread.sleep(retryDelayNs(attempt));
        }
    }
    return FetchError.FetchFailed;
}

/// Token bucket rate limiter using atomics (lock-free).
pub const RateLimiter = struct {
    tokens: std.atomic.Value(u32),
    max_tokens: u32,
    last_refill: std.atomic.Value(i64),
    refill_interval_ns: i64,

    pub fn init(max_tokens: u32, refill_interval_ms: u32) RateLimiter {
        return .{
            .tokens = std.atomic.Value(u32).init(max_tokens),
            .max_tokens = max_tokens,
            .last_refill = std.atomic.Value(i64).init(@intCast(std.time.nanoTimestamp())),
            .refill_interval_ns = @as(i64, refill_interval_ms) * std.time.ns_per_ms,
        };
    }

    pub fn tryAcquire(self: *RateLimiter) bool {
        // Try to refill first
        self.maybeRefill();

        // Try to take a token
        while (true) {
            const current = self.tokens.load(.acquire);
            if (current == 0) return false;
            if (self.tokens.cmpxchgWeak(current, current - 1, .release, .monotonic) == null) {
                return true;
            }
        }
    }

    fn maybeRefill(self: *RateLimiter) void {
        const now: i64 = @intCast(std.time.nanoTimestamp());
        const last = self.last_refill.load(.acquire);
        if (now - last >= self.refill_interval_ns) {
            if (self.last_refill.cmpxchgWeak(last, now, .release, .monotonic) == null) {
                self.tokens.store(self.max_tokens, .release);
            }
        }
    }
};

test "RateLimiter acquires and exhausts tokens" {
    var limiter = RateLimiter.init(3, 1000);

    try std.testing.expect(limiter.tryAcquire());
    try std.testing.expect(limiter.tryAcquire());
    try std.testing.expect(limiter.tryAcquire());
    try std.testing.expect(!limiter.tryAcquire()); // exhausted
}

test "FetchOpts defaults" {
    const opts = FetchOpts{};
    try std.testing.expectEqual(@as(u8, 3), opts.max_retries);
    try std.testing.expectEqual(@as(usize, 20 * 1024 * 1024), opts.max_content_length);
    try std.testing.expectEqual(@as(u32, 30_000), opts.timeout_ms);
    try std.testing.expectEqual(@as(?*RateLimiter, null), opts.rate_limiter);
}

test "retry delay calculation" {
    try std.testing.expectEqual(@as(u64, 100), retryDelayMs(0));
    try std.testing.expectEqual(@as(u64, 200), retryDelayMs(1));
    try std.testing.expectEqual(@as(u64, 400), retryDelayMs(2));
    try std.testing.expectEqual(@as(u64, 800), retryDelayMs(3));
}

test "HTML extraction from Runtime.evaluate response" {
    const response = "{\"id\":1,\"result\":{\"result\":{\"type\":\"string\",\"value\":\"<html><body>hello</body></html>\"}}}";
    const html = try extractHtmlValue(response, std.testing.allocator);
    defer std.testing.allocator.free(html);
    try std.testing.expectEqualStrings("<html><body>hello</body></html>", html);
}

test "HTML extraction with escaped characters" {
    const response = "{\"id\":1,\"result\":{\"result\":{\"type\":\"string\",\"value\":\"<p class=\\\"x\\\">hi</p>\"}}}";
    const html = try extractHtmlValue(response, std.testing.allocator);
    defer std.testing.allocator.free(html);
    try std.testing.expectEqualStrings("<p class=\"x\">hi</p>", html);
}

test "retryDelayNs exponential backoff" {
    try std.testing.expectEqual(@as(u64, 100_000_000), retryDelayNs(0));
    try std.testing.expectEqual(@as(u64, 200_000_000), retryDelayNs(1));
    try std.testing.expectEqual(@as(u64, 400_000_000), retryDelayNs(2));
}

test "retryDelayNs caps at 3.2 seconds" {
    // attempt=5 would be 3_200_000_000 exactly
    try std.testing.expectEqual(@as(u64, 3_200_000_000), retryDelayNs(5));
    // higher attempts should also cap
    try std.testing.expectEqual(@as(u64, 3_200_000_000), retryDelayNs(10));
    try std.testing.expectEqual(@as(u64, 3_200_000_000), retryDelayNs(20));
}

test "FetchResult can be constructed with all fields" {
    const result = FetchResult{
        .html = "<html></html>",
        .status_code = 200,
        .content_type = "text/html",
    };
    try std.testing.expectEqualStrings("<html></html>", result.html);
    try std.testing.expectEqual(@as(u16, 200), result.status_code);
    try std.testing.expectEqualStrings("text/html", result.content_type);
}
