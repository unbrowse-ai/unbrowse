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
    var runtime_cfg = cfg;

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

    const start_result = try chrome.start(cfg);
    runtime_cfg.cdp_url = start_result.cdp_url;
    std.log.info("CDP endpoint: {s}", .{start_result.cdp_url});
    std.log.info("CDP port: {d}", .{start_result.cdp_port});

    // Initialize bridge (central state)
    var bridge = Bridge.init(gpa);
    defer bridge.deinit();

    // Hydrate the bridge before serving so first-run /tabs works immediately.
    var startup_arena_impl = std.heap.ArenaAllocator.init(gpa);
    defer startup_arena_impl.deinit();
    const startup_discovered = try server.discoverTabs(startup_arena_impl.allocator(), &bridge, runtime_cfg, start_result.cdp_port);
    std.log.info("startup discovery registered {d} tabs", .{startup_discovered});

    // Start HTTP server
    try server.run(gpa, &bridge, runtime_cfg, start_result.cdp_port);
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
    _ = @import("chrome/extensions.zig");
    _ = @import("test/integration.zig");
    _ = @import("storage/local.zig");
    _ = @import("storage/auth_profiles.zig");
    _ = @import("util/tls.zig");
}
