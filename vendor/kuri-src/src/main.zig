const std = @import("std");
const config = @import("bridge/config.zig");
const server = @import("server/router.zig");
const Bridge = @import("bridge/bridge.zig").Bridge;
const launcher = @import("chrome/launcher.zig");

pub fn main() !void {
    var gpa_impl: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa_impl.deinit();
    const gpa = gpa_impl.allocator();

    const cfg = config.load();
    var server_cfg = cfg;

    std.log.info("kuri v0.1.0", .{});
    std.log.info("listening on {s}:{d}", .{ cfg.host, cfg.port });

    // Chrome lifecycle management
    var chrome = launcher.Launcher.init(gpa, cfg);
    defer chrome.deinit();

    if (cfg.cdp_url) |url| {
        std.log.info("connecting to existing Chrome at {s}", .{url});
    } else {
        std.log.info("launching managed Chrome instance", .{});
    }

    const cdp_port = chrome.start(cfg) catch |err| blk: {
        std.log.warn("Chrome launch failed: {s}, continuing without Chrome", .{@errorName(err)});
        break :blk @as(u16, 9222);
    };
    std.log.info("CDP port: {d}", .{cdp_port});
    var managed_cdp_url: ?[]u8 = null;
    defer if (managed_cdp_url) |url| gpa.free(url);
    if (server_cfg.cdp_url == null and chrome.mode == .managed and chrome.child != null) {
        managed_cdp_url = try std.fmt.allocPrint(gpa, "ws://127.0.0.1:{d}", .{cdp_port});
        server_cfg.cdp_url = managed_cdp_url;
    }

    // Initialize bridge (central state)
    var bridge = Bridge.init(gpa);
    defer bridge.deinit();

    // Start HTTP server
    try server.run(gpa, &bridge, server_cfg);
}

test {
    _ = @import("bridge/config.zig");
    _ = @import("bridge/bridge.zig");
    _ = @import("server/router.zig");
    _ = @import("server/response.zig");
    _ = @import("server/middleware.zig");
    _ = @import("cdp/protocol.zig");
    _ = @import("cdp/client.zig");
    _ = @import("cdp/websocket.zig");
    _ = @import("cdp/actions.zig");
    _ = @import("cdp/stealth.zig");
    _ = @import("cdp/har.zig");
    _ = @import("snapshot/a11y.zig");
    _ = @import("snapshot/diff.zig");
    _ = @import("snapshot/ref_cache.zig");
    _ = @import("crawler/validator.zig");
    _ = @import("crawler/markdown.zig");
    _ = @import("crawler/fetcher.zig");
    _ = @import("crawler/pipeline.zig");
    _ = @import("crawler/extractor.zig");
    _ = @import("util/json.zig");
    _ = @import("test/harness.zig");
    _ = @import("chrome/launcher.zig");
    _ = @import("test/integration.zig");
    _ = @import("storage/local.zig");
    _ = @import("util/tls.zig");
}
