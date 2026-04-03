const std = @import("std");
const mer = @import("mer");

const log = std.log.scoped(.main);

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    const args = try std.process.argsAlloc(alloc);
    defer std.process.argsFree(alloc, args);

    mer.loadDotenv(alloc);

    var config = mer.Config{
        .host = "127.0.0.1",
        .port = 3011,
        .dev = true,
    };

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--port") and i + 1 < args.len) {
            config.port = try std.fmt.parseInt(u16, args[i + 1], 10);
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--host") and i + 1 < args.len) {
            config.host = args[i + 1];
            i += 1;
        } else if (std.mem.eql(u8, args[i], "--no-dev")) {
            config.dev = false;
        } else if (std.mem.eql(u8, args[i], "--debug")) {
            config.debug = true;
        } else if (std.mem.eql(u8, args[i], "--verbose") or std.mem.eql(u8, args[i], "-v")) {
            config.verbose = true;
        }
    }

    var router = mer.Router.fromGenerated(alloc, @import("routes"));
    defer router.deinit();

    var watcher = mer.Watcher.init(alloc, "app");
    defer watcher.deinit();

    if (config.dev) {
        const wt = try std.Thread.spawn(.{}, mer.Watcher.run, .{&watcher});
        wt.detach();
        log.info("hot reload active — watching app/", .{});
    }

    var server = mer.Server.init(alloc, config, &router, if (config.dev) &watcher else null);
    try server.listen();
}
