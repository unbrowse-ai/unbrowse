const std = @import("std");
const a11y = @import("snapshot/a11y.zig");
const markdown = @import("crawler/markdown.zig");
const fetcher = @import("crawler/fetcher.zig");
const validator = @import("crawler/validator.zig");
const bridge_mod = @import("bridge/bridge.zig");
const middleware = @import("server/middleware.zig");
const cdp_client = @import("cdp/client.zig");

// ── Benchmark harness ──────────────────────────────────────────────────

const Bench = struct {
    name: []const u8,
    iterations: u32,
    min_ns: u64,
    max_ns: u64,
    total_ns: u64,
    median_ns: u64,

    fn run(name: []const u8, iterations: u32, func: *const fn () void) Bench {
        var times: [1000]u64 = undefined;
        const n = @min(iterations, 1000);

        // Warmup
        for (0..@min(n / 10, 10)) |_| func();

        for (0..n) |i| {
            const start = @as(u64, @intCast(@max(std.time.nanoTimestamp(), 0)));
            func();
            const end = @as(u64, @intCast(@max(std.time.nanoTimestamp(), 0)));
            times[i] = end -| start;
        }

        // Sort for median
        std.mem.sort(u64, times[0..n], {}, std.sort.asc(u64));

        var total: u64 = 0;
        for (times[0..n]) |t| total += t;

        return .{
            .name = name,
            .iterations = n,
            .min_ns = times[0],
            .max_ns = times[n - 1],
            .total_ns = total,
            .median_ns = times[n / 2],
        };
    }

    fn print(self: Bench) void {
        const avg_ns = self.total_ns / self.iterations;
        std.debug.print("  {s:<40} {d:>8} iters   avg {s}   med {s}   min {s}   max {s}\n", .{
            self.name,
            self.iterations,
            fmtDuration(avg_ns),
            fmtDuration(self.median_ns),
            fmtDuration(self.min_ns),
            fmtDuration(self.max_ns),
        });
    }
};

fn fmtDuration(ns: u64) [12]u8 {
    var buf: [12]u8 = .{' '} ** 12;
    if (ns < 1_000) {
        _ = std.fmt.bufPrint(&buf, "{d:>7}ns   ", .{ns}) catch {};
    } else if (ns < 1_000_000) {
        _ = std.fmt.bufPrint(&buf, "{d:>5}.{d}µs  ", .{ ns / 1000, (ns % 1000) / 100 }) catch {};
    } else if (ns < 1_000_000_000) {
        _ = std.fmt.bufPrint(&buf, "{d:>5}.{d}ms  ", .{ ns / 1_000_000, (ns % 1_000_000) / 100_000 }) catch {};
    } else {
        _ = std.fmt.bufPrint(&buf, "{d:>5}.{d}s   ", .{ ns / 1_000_000_000, (ns % 1_000_000_000) / 100_000_000 }) catch {};
    }
    return buf;
}

// ── Benchmark data ─────────────────────────────────────────────────────

const sample_html_small = "<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p></body></html>";
const sample_html_medium = "<html><body>" ++ "<div class=\"item\"><h2>Title</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p><a href=\"https://example.com\">Link</a></div>" ** 50 ++ "</body></html>";

fn makeLargeHtml() []const u8 {
    return "<html><body>" ++ "<div class=\"item\"><h2>Title</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p><ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul><a href=\"https://example.com\">Link</a></div>" ** 200 ++ "</body></html>";
}

fn makeA11yNodes() [200]a11y.A11yNode {
    var nodes: [200]a11y.A11yNode = undefined;
    for (&nodes, 0..) |*n, i| {
        n.* = .{
            .ref = "e0",
            .role = if (i % 5 == 0) "button" else if (i % 3 == 0) "link" else "text",
            .name = "Test Node",
            .value = "",
            .backend_node_id = @intCast(i),
            .depth = @intCast(i % 8),
        };
    }
    return nodes;
}

// ── Benchmark functions ────────────────────────────────────────────────

var gpa = std.heap.page_allocator;

fn benchHtmlToMarkdownSmall() void {
    const result = markdown.htmlToMarkdown(sample_html_small, gpa) catch return;
    gpa.free(result);
}

fn benchHtmlToMarkdownMedium() void {
    const result = markdown.htmlToMarkdown(sample_html_medium, gpa) catch return;
    gpa.free(result);
}

fn benchHtmlToMarkdownLarge() void {
    const html = makeLargeHtml();
    const result = markdown.htmlToMarkdown(html, gpa) catch return;
    gpa.free(result);
}

fn benchCountTagsSimdSmall() void {
    std.mem.doNotOptimizeAway(markdown.countTagsSimd(sample_html_small));
}

fn benchCountTagsSimdMedium() void {
    std.mem.doNotOptimizeAway(markdown.countTagsSimd(sample_html_medium));
}

fn benchCountTagsSimdLarge() void {
    std.mem.doNotOptimizeAway(markdown.countTagsSimd(makeLargeHtml()));
}

fn benchA11yBuildSnapshot() void {
    const nodes = makeA11yNodes();
    const result = a11y.buildSnapshot(&nodes, .{}, gpa) catch return;
    for (result) |n| gpa.free(n.ref);
    gpa.free(result);
}

fn benchA11yBuildSnapshotFiltered() void {
    const nodes = makeA11yNodes();
    const result = a11y.buildSnapshot(&nodes, .{ .filter_interactive = true }, gpa) catch return;
    for (result) |n| gpa.free(n.ref);
    gpa.free(result);
}

fn benchA11yBuildSnapshotDepth() void {
    const nodes = makeA11yNodes();
    const result = a11y.buildSnapshot(&nodes, .{ .max_depth = 3 }, gpa) catch return;
    for (result) |n| gpa.free(n.ref);
    gpa.free(result);
}

fn benchA11yFormatText() void {
    const nodes = makeA11yNodes();
    const result = a11y.formatText(&nodes, gpa) catch return;
    gpa.free(result);
}

fn benchValidateUrl() void {
    validator.validateUrl("https://example.com/path?q=1&r=2#frag") catch {};
    validator.validateUrl("http://192.168.1.1/admin") catch {};
    validator.validateUrl("https://sub.domain.example.co.uk/very/long/path/to/resource") catch {};
}

fn benchBridgePutGet() void {
    var bridge = bridge_mod.Bridge.init(gpa);
    defer bridge.deinit();

    for (0..50) |i| {
        var id_buf: [16]u8 = undefined;
        const id = std.fmt.bufPrint(&id_buf, "tab-{d}", .{i}) catch continue;
        bridge.putTab(.{
            .id = id,
            .url = "https://example.com",
            .title = "Test Tab",
            .ws_url = "ws://localhost:9222/tab",
            .created_at = 1000,
            .last_accessed = 1000,
        }) catch continue;
    }
    for (0..50) |i| {
        var id_buf: [16]u8 = undefined;
        const id = std.fmt.bufPrint(&id_buf, "tab-{d}", .{i}) catch continue;
        std.mem.doNotOptimizeAway(bridge.getTab(id));
    }
}

fn benchCdpBuildMessage() void {
    var client = cdp_client.CdpClient.init(gpa, "ws://localhost:9222");
    defer client.deinit();

    for (0..100) |_| {
        const msg = client.buildMessage(gpa, "Runtime.evaluate", "{\"expression\":\"document.title\",\"returnByValue\":true}") catch continue;
        gpa.free(msg);
    }
}

fn benchMatchesResponseId() void {
    const responses = [_][]const u8{
        "{\"id\":1,\"result\":{\"type\":\"string\",\"value\":\"hello\"}}",
        "{\"method\":\"Page.loadEventFired\",\"params\":{}}",
        "{\"id\":42,\"result\":{\"frameId\":\"ABC\",\"loaderId\":\"DEF\"}}",
        "{\"method\":\"Network.requestWillBeSent\",\"params\":{\"requestId\":\"1\"}}",
        "{\"id\":100,\"error\":{\"code\":-32601,\"message\":\"not found\"}}",
    };
    for (0..100) |_| {
        for (responses) |r| {
            std.mem.doNotOptimizeAway(cdp_client.CdpClient.matchesResponseId(r, 42));
        }
    }
}

fn benchEventBuffer() void {
    var buf = cdp_client.EventBuffer.init(gpa);
    defer buf.deinit();

    for (0..32) |_| {
        const ev = gpa.dupe(u8, "{\"method\":\"Network.dataReceived\",\"params\":{}}") catch return;
        buf.push(ev);
    }
    std.mem.doNotOptimizeAway(buf.hasEvent("Page.loadEventFired"));
    std.mem.doNotOptimizeAway(buf.hasEvent("Network.dataReceived"));
    buf.drain();
}

fn benchRetryDelay() void {
    for (0..100) |i| {
        std.mem.doNotOptimizeAway(fetcher.retryDelayMs(@intCast(i % 21)));
        std.mem.doNotOptimizeAway(fetcher.retryDelayNs(@intCast(i % 21)));
    }
}

fn benchRateLimiter() void {
    var rl = fetcher.RateLimiter.init(100, 1000);
    for (0..200) |_| {
        std.mem.doNotOptimizeAway(rl.tryAcquire());
    }
}

fn benchHtmlExtraction() void {
    const response = "{\"id\":1,\"result\":{\"result\":{\"type\":\"string\",\"value\":\"<html><body>hello world</body></html>\"}}}";
    const result = fetcher.extractHtmlValue(response, gpa) catch return;
    gpa.free(result);
}

fn benchRequestTimer() void {
    for (0..100) |_| {
        const timer = middleware.RequestTimer.start();
        std.mem.doNotOptimizeAway(timer.elapsed());
    }
}

fn benchExportState() void {
    var bridge = bridge_mod.Bridge.init(gpa);
    defer bridge.deinit();

    for (0..20) |i| {
        var id_buf: [16]u8 = undefined;
        const id = std.fmt.bufPrint(&id_buf, "tab-{d}", .{i}) catch continue;
        bridge.putTab(.{
            .id = id,
            .url = "https://example.com/page",
            .title = "Test Page Title",
            .ws_url = "ws://localhost:9222/devtools/page/ABC",
            .created_at = 1000,
            .last_accessed = 1000,
        }) catch continue;
    }
    const json = bridge.exportState(gpa) catch return;
    gpa.free(json);
}

fn benchArenaAllocReset() void {
    var arena_impl = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    for (0..100) |_| {
        // Simulate per-request allocations
        const a = arena.alloc(u8, 4096) catch continue;
        const b = arena.alloc(u8, 1024) catch continue;
        const c = arena.alloc(u8, 512) catch continue;
        std.mem.doNotOptimizeAway(a);
        std.mem.doNotOptimizeAway(b);
        std.mem.doNotOptimizeAway(c);
        _ = arena_impl.reset(.retain_capacity);
    }
}

// ── Main ───────────────────────────────────────────────────────────────

pub fn main() !void {
    const iters: u32 = 500;

    std.debug.print("\n", .{});
    std.debug.print("╔══════════════════════════════════════════════════════════════════════════════════════════════════╗\n", .{});
    std.debug.print("║  browdie benchmark suite                                                                       ║\n", .{});
    std.debug.print("╚══════════════════════════════════════════════════════════════════════════════════════════════════╝\n", .{});

    std.debug.print("\n── HTML → Markdown ───────────────────────────────────────────────────\n", .{});
    Bench.run("htmlToMarkdown (82B)", iters, benchHtmlToMarkdownSmall).print();
    Bench.run("htmlToMarkdown (8KB)", iters, benchHtmlToMarkdownMedium).print();
    Bench.run("htmlToMarkdown (52KB)", iters, benchHtmlToMarkdownLarge).print();

    std.debug.print("\n── SIMD tag counting ─────────────────────────────────────────────────\n", .{});
    Bench.run("countTagsSimd (82B)", iters, benchCountTagsSimdSmall).print();
    Bench.run("countTagsSimd (8KB)", iters, benchCountTagsSimdMedium).print();
    Bench.run("countTagsSimd (52KB)", iters, benchCountTagsSimdLarge).print();

    std.debug.print("\n── A11y snapshot ─────────────────────────────────────────────────────\n", .{});
    Bench.run("buildSnapshot (200 nodes)", iters, benchA11yBuildSnapshot).print();
    Bench.run("buildSnapshot filtered", iters, benchA11yBuildSnapshotFiltered).print();
    Bench.run("buildSnapshot depth≤3", iters, benchA11yBuildSnapshotDepth).print();
    Bench.run("formatText (200 nodes)", iters, benchA11yFormatText).print();

    std.debug.print("\n── CDP client ────────────────────────────────────────────────────────\n", .{});
    Bench.run("buildMessage ×100", iters, benchCdpBuildMessage).print();
    Bench.run("matchesResponseId ×500", iters, benchMatchesResponseId).print();
    Bench.run("EventBuffer fill+scan+drain", iters, benchEventBuffer).print();

    std.debug.print("\n── Fetcher / validator ───────────────────────────────────────────────\n", .{});
    Bench.run("validateUrl ×3", iters, benchValidateUrl).print();
    Bench.run("retryDelay ×200", iters, benchRetryDelay).print();
    Bench.run("RateLimiter ×200", iters, benchRateLimiter).print();
    Bench.run("extractHtmlValue", iters, benchHtmlExtraction).print();

    std.debug.print("\n── Bridge ────────────────────────────────────────────────────────────\n", .{});
    Bench.run("putTab+getTab ×50", iters, benchBridgePutGet).print();
    Bench.run("exportState (20 tabs)", iters, benchExportState).print();

    std.debug.print("\n── Server infra ──────────────────────────────────────────────────────\n", .{});
    Bench.run("RequestTimer ×100", iters, benchRequestTimer).print();
    Bench.run("arena alloc+reset ×100", iters, benchArenaAllocReset).print();

    std.debug.print("\n", .{});
}
