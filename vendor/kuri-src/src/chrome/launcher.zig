const std = @import("std");
const config = @import("../bridge/config.zig");
const extensions_mod = @import("extensions.zig");

/// 🧁 Chrome lifecycle manager — launch, supervise, restart.
/// Handles spawning headless Chrome with CDP debugging port,
/// health-checking via /json/version, and auto-restart on crash.
pub const Launcher = struct {
    allocator: std.mem.Allocator,
    cdp_port: u16,
    child: ?std.process.Child,
    ws_url_buf: [512]u8,
    ws_url_len: usize,
    restarts: u8,
    mode: Mode,
    extensions: ?[]const u8,
    headless: bool,
    state_dir: []const u8,
    builtin_ext_path: ?[]const u8,

    pub const Mode = enum {
        managed, // we launched Chrome ourselves
        external, // connecting to an existing instance
    };

    pub const ChromeStatus = struct {
        alive: bool,
        ws_url: ?[]const u8,
    };

    pub const StartResult = struct {
        cdp_port: u16,
        cdp_url: []const u8,
    };

    const ParsedUrl = struct {
        host: []const u8,
        port: u16,
        path: []const u8,
    };

    const default_cdp_port: u16 = 9222;
    const max_restarts: u8 = 3;
    const health_timeout_ms: u32 = 2_000;

    /// Chrome binary search paths (platform-dependent).
    const chrome_paths = switch (@import("builtin").os.tag) {
        .macos => &[_][]const u8{
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        },
        else => &[_][]const u8{
            "chrome",
            "google-chrome",
            "chromium-browser",
            "chromium",
        },
    };

    /// Initialize a launcher. If `cdp_url` is set in config, uses external mode.
    pub fn init(allocator: std.mem.Allocator, cfg: config.Config) Launcher {
        const mode: Mode = if (cfg.cdp_url != null) .external else .managed;
        return .{
            .allocator = allocator,
            .cdp_port = default_cdp_port,
            .child = null,
            .ws_url_buf = undefined,
            .ws_url_len = 0,
            .restarts = 0,
            .mode = mode,
            .extensions = cfg.extensions,
            .headless = cfg.headless,
            .state_dir = cfg.state_dir,
            .builtin_ext_path = null,
        };
    }

    /// Start Chrome or connect to an existing instance.
    /// Returns the resolved websocket CDP endpoint and port.
    pub fn start(self: *Launcher, cfg: config.Config) !StartResult {
        switch (self.mode) {
            .external => {
                const raw_url = cfg.cdp_url orelse return error.MissingCdpUrl;
                try self.resolveExternal(raw_url);
                return .{
                    .cdp_port = self.cdp_port,
                    .cdp_url = self.cdpUrl() orelse return error.MissingDebuggerUrl,
                };
            },
            .managed => {
                // Find a free CDP port
                self.cdp_port = try findFreePort(default_cdp_port);
                try self.launchChrome();
                try self.waitForDebuggerUrl();
                return .{
                    .cdp_port = self.cdp_port,
                    .cdp_url = self.cdpUrl() orelse return error.MissingDebuggerUrl,
                };
            },
        }
    }

    /// Spawn the Chrome process with headless flags.
    fn launchChrome(self: *Launcher) !void {
        const chrome_bin = findChromeBinary() orelse {
            std.log.err("no Chrome binary found on this system", .{});
            return error.ChromeNotFound;
        };

        // Extract builtin extension to disk and prepend to extensions list
        const builtin_path = extensions_mod.extractBuiltinExtension(self.allocator, self.state_dir) catch |err| blk: {
            std.log.warn("failed to extract builtin extension: {}, continuing without it", .{err});
            break :blk null;
        };
        if (builtin_path) |bp| {
            self.builtin_ext_path = bp;
        }

        // Merge builtin extension with user-configured extensions
        const merged_extensions: ?[]const u8 = if (builtin_path) |bp|
            extensions_mod.prependBuiltinExtension(self.allocator, bp, self.extensions) catch null
        else
            null;
        defer if (merged_extensions) |m| self.allocator.free(m);

        const effective_extensions = merged_extensions orelse self.extensions;

        // Allocate the port flag on the heap so it outlives this function.
        // Previously this was written into ws_url_buf which gets overwritten
        // by storeWsUrl(), causing a dangling pointer in the Child struct on Linux.
        const port_flag = try std.fmt.allocPrint(self.allocator, "--remote-debugging-port={d}", .{self.cdp_port});

        // Build argv
        var argv_list: std.ArrayList([]const u8) = .empty;
        defer argv_list.deinit(self.allocator);

        try argv_list.append(self.allocator, chrome_bin);
        if (self.headless) {
            try argv_list.append(self.allocator, "--headless=new");
            try argv_list.append(self.allocator, "--disable-gpu");
        } else {
            // Visible mode: needs a data dir for CDP to work on macOS
            const home = std.posix.getenv("HOME") orelse "/tmp";
            const data_dir = try std.fmt.allocPrint(self.allocator, "--user-data-dir={s}/.kuri/chrome-profile", .{home});
            try argv_list.append(self.allocator, data_dir);
        }
        try argv_list.append(self.allocator, "--no-sandbox");
        try argv_list.append(self.allocator, "--remote-allow-origins=*");
        try argv_list.append(self.allocator, port_flag);

        // Build and append extension flags (builtin + user-configured)
        const ext_flags: ?[][]u8 = if (effective_extensions) |ext_str|
            try buildExtensionFlags(self.allocator, ext_str)
        else
            null;

        if (ext_flags) |flags| {
            for (flags) |f| try argv_list.append(self.allocator, f);
        }

        var child = std.process.Child.init(argv_list.items, self.allocator);
        child.stderr_behavior = .Ignore;
        child.stdout_behavior = .Ignore;

        try child.spawn();
        self.child = child;

        // Free argv-owned strings now that spawn has completed and child has exec'd.
        // The Child struct no longer needs these after spawn().
        self.allocator.free(port_flag);
        if (!self.headless) {
            // data_dir was appended at index 1 (after chrome_bin)
            if (argv_list.items.len > 1) {
                // Find and free the data_dir string (starts with --user-data-dir=)
                for (argv_list.items) |item| {
                    if (std.mem.startsWith(u8, item, "--user-data-dir=")) {
                        self.allocator.free(item);
                        break;
                    }
                }
            }
        }
        if (ext_flags) |flags| {
            for (flags) |f| self.allocator.free(f);
            self.allocator.free(flags);
        }

        std.log.info("launched Chrome (pid={d}) on CDP port {d}", .{
            child.id,
            self.cdp_port,
        });
        if (builtin_path != null) {
            std.log.info("builtin extension loaded from {s}", .{self.builtin_ext_path.?});
        }
        // Give Chrome a moment to start
        std.Thread.sleep(500 * std.time.ns_per_ms);
    }

    /// Check if Chrome is alive by probing /json/version on the CDP port.
    pub fn healthCheck(self: *Launcher) ChromeStatus {
        return httpProbeJsonVersion(self.cdp_port);
    }

    pub fn cdpUrl(self: *const Launcher) ?[]const u8 {
        if (self.ws_url_len == 0) return null;
        return self.ws_url_buf[0..self.ws_url_len];
    }

    /// Supervise Chrome — call periodically. Restarts on crash.
    pub fn supervise(self: *Launcher) !void {
        if (self.mode == .external) return;

        const status = self.healthCheck();
        if (status.alive) return;

        // Chrome appears dead
        if (self.child) |*child| {
            _ = child.wait() catch {};
            self.child = null;
        }

        if (self.restarts >= max_restarts) {
            std.log.err("Chrome crashed {d} times, giving up", .{self.restarts});
            return error.MaxRestartsExceeded;
        }

        self.restarts += 1;
        std.log.warn("Chrome crash detected, restarting (attempt {d}/{d})", .{
            self.restarts,
            max_restarts,
        });

        try self.launchChrome();
    }

    /// Shut down the managed Chrome process.
    pub fn deinit(self: *Launcher) void {
        if (self.child) |*child| {
            _ = child.kill() catch {};
            _ = child.wait() catch {};
            self.child = null;
        }
        if (self.builtin_ext_path) |bp| {
            self.allocator.free(bp);
            self.builtin_ext_path = null;
        }
    }

    /// Find the first Chrome binary that exists on this system.
    fn findChromeBinary() ?[]const u8 {
        for (chrome_paths) |path| {
            // For absolute paths, check file existence
            if (path[0] == '/') {
                std.fs.cwd().access(path, .{}) catch continue;
                return path;
            }
            // For bare names, assume PATH lookup will work
            return path;
        }
        return null;
    }

    fn resolveExternal(self: *Launcher, raw_url: []const u8) !void {
        if (std.mem.startsWith(u8, raw_url, "ws://") or std.mem.startsWith(u8, raw_url, "wss://")) {
            const parsed = parseSocketUrl(raw_url) orelse return error.InvalidCdpUrl;
            self.cdp_port = parsed.port;
            try self.storeWsUrl(raw_url);

            const status = httpProbe(raw_url, parsed.host, parsed.port, "/json/version");
            if (!status.alive) return error.ConnectionRefused;
            return;
        }

        if (std.mem.startsWith(u8, raw_url, "http://")) {
            const parsed = parseHttpUrl(raw_url) orelse return error.InvalidCdpUrl;
            self.cdp_port = parsed.port;
            const status = httpProbe(raw_url, parsed.host, parsed.port, parsed.path);
            if (!status.alive) return error.ConnectionRefused;
            const ws_url = status.ws_url orelse return error.MissingDebuggerUrl;
            try self.storeWsUrl(ws_url);
            return;
        }

        if (std.mem.startsWith(u8, raw_url, "https://")) {
            return error.UnsupportedCdpScheme;
        }

        return error.InvalidCdpUrl;
    }

    fn waitForDebuggerUrl(self: *Launcher) !void {
        var attempts: u8 = 0;
        while (attempts < 20) : (attempts += 1) {
            const status = self.healthCheck();
            if (status.alive and status.ws_url != null) {
                try self.storeWsUrl(status.ws_url.?);
                return;
            }
            std.Thread.sleep(250 * std.time.ns_per_ms);
        }
        return error.ConnectionRefused;
    }

    fn storeWsUrl(self: *Launcher, ws_url: []const u8) !void {
        if (ws_url.len > self.ws_url_buf.len) return error.NameTooLong;
        @memcpy(self.ws_url_buf[0..ws_url.len], ws_url);
        self.ws_url_len = ws_url.len;
    }
};

// ── Extension utilities ─────────────────────────────────────────────────

/// Parse a comma-separated extensions string and return the Chrome flags needed
/// to load them: one `--load-extension=<path>` per entry plus one
/// `--disable-extensions-except=<path1>,<path2>,...` covering all paths.
///
/// The caller owns the returned slice and every string in it — free each item
/// then free the slice itself (or use an arena).
pub fn buildExtensionFlags(allocator: std.mem.Allocator, extensions: []const u8) ![][]u8 {
    var flags: std.ArrayList([]u8) = .empty;
    errdefer {
        for (flags.items) |f| allocator.free(f);
        flags.deinit(allocator);
    }

    var paths: std.ArrayList([]const u8) = .empty;
    defer paths.deinit(allocator);

    var it = std.mem.splitScalar(u8, extensions, ',');
    while (it.next()) |raw| {
        const path = std.mem.trim(u8, raw, " \t");
        if (path.len == 0) continue;
        try paths.append(allocator, path);

        const load_flag = try std.fmt.allocPrint(allocator, "--load-extension={s}", .{path});
        try flags.append(allocator, load_flag);
    }

    if (paths.items.len > 0) {
        const joined = try std.mem.join(allocator, ",", paths.items);
        defer allocator.free(joined);
        const except_flag = try std.fmt.allocPrint(
            allocator,
            "--disable-extensions-except={s}",
            .{joined},
        );
        try flags.append(allocator, except_flag);
    }

    return flags.toOwnedSlice(allocator);
}

// ── Port utilities ──────────────────────────────────────────────────────

/// Find a free port starting from `start_port`.
/// Tries to bind a TCP listener; if the port is taken, increments and retries.
pub fn findFreePort(start_port: u16) !u16 {
    var port = start_port;
    while (port < start_port +| 100) : (port +|= 1) {
        if (!isPortInUse(port)) return port;
    }
    return error.NoFreePortFound;
}

/// Check if a TCP port is currently in use by attempting to connect.
pub fn isPortInUse(port: u16) bool {
    const addr = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, port);
    var stream = std.net.tcpConnectToAddress(addr) catch return false;
    stream.close();
    return true;
}

// ── HTTP health probe ───────────────────────────────────────────────────

/// Probe Chrome's /json/version endpoint via raw TCP HTTP GET.
/// Returns alive status and optional webSocketDebuggerUrl.
fn httpProbeJsonVersion(port: u16) Launcher.ChromeStatus {
    return httpProbe("/json/version", "127.0.0.1", port, "/json/version");
}

fn httpProbe(raw_url: []const u8, host: []const u8, port: u16, path: []const u8) Launcher.ChromeStatus {
    const connect_host = normalizeHost(host);
    var stream = std.net.tcpConnectToHost(std.heap.page_allocator, connect_host, port) catch
        return .{ .alive = false, .ws_url = null };

    defer stream.close();

    var req_buf: [512]u8 = undefined;
    const request = std.fmt.bufPrint(&req_buf, "GET {s} HTTP/1.1\r\nHost: {s}:{d}\r\nConnection: close\r\n\r\n", .{ path, host, port }) catch
        return .{ .alive = false, .ws_url = null };
    _ = stream.write(request) catch
        return .{ .alive = false, .ws_url = null };

    var buf: [4096]u8 = undefined;
    const n = stream.read(&buf) catch
        return .{ .alive = false, .ws_url = null };

    if (n == 0) return .{ .alive = false, .ws_url = null };

    const body = buf[0..n];

    // Check we got an HTTP 200
    if (!std.mem.startsWith(u8, body, "HTTP/1.1 200") and
        !std.mem.startsWith(u8, body, "HTTP/1.0 200"))
    {
        return .{ .alive = false, .ws_url = null };
    }

    // Try to extract webSocketDebuggerUrl
    const ws_url = extractWsUrl(body);
    _ = raw_url;
    return .{ .alive = true, .ws_url = ws_url };
}

fn normalizeHost(host: []const u8) []const u8 {
    if (std.mem.eql(u8, host, "localhost")) return "127.0.0.1";
    return host;
}

fn parseSocketUrl(url: []const u8) ?Launcher.ParsedUrl {
    var remainder = url;
    if (std.mem.startsWith(u8, url, "ws://")) {
        remainder = url[5..];
    } else if (std.mem.startsWith(u8, url, "wss://")) {
        remainder = url[6..];
    } else {
        return null;
    }
    return parseHostPortPath(remainder, Launcher.default_cdp_port, "/");
}

fn parseHttpUrl(url: []const u8) ?Launcher.ParsedUrl {
    if (!std.mem.startsWith(u8, url, "http://")) return null;
    return parseHostPortPath(url[7..], 80, "/json/version");
}

fn parseHostPortPath(remainder: []const u8, default_port: u16, default_path: []const u8) ?Launcher.ParsedUrl {
    const slash = std.mem.indexOfScalar(u8, remainder, '/') orelse remainder.len;
    const host_port = remainder[0..slash];
    if (host_port.len == 0) return null;

    var host = host_port;
    var port = default_port;
    if (std.mem.indexOfScalar(u8, host_port, ':')) |colon| {
        host = host_port[0..colon];
        port = std.fmt.parseInt(u16, host_port[colon + 1 ..], 10) catch return null;
    }
    if (host.len == 0) return null;

    const path = if (slash < remainder.len) remainder[slash..] else default_path;
    return .{
        .host = normalizeHost(host),
        .port = port,
        .path = path,
    };
}

/// Extract the webSocketDebuggerUrl value from a JSON response body.
fn extractWsUrl(body: []const u8) ?[]const u8 {
    const key = "\"webSocketDebuggerUrl\"";
    const key_pos = std.mem.indexOf(u8, body, key) orelse return null;
    const after_key = key_pos + key.len;

    // Skip : and whitespace, find opening quote
    var i = after_key;
    while (i < body.len and (body[i] == ':' or body[i] == ' ' or body[i] == '\t')) : (i += 1) {}
    if (i >= body.len or body[i] != '"') return null;
    i += 1; // skip opening quote

    const start = i;
    while (i < body.len and body[i] != '"') : (i += 1) {}
    if (i >= body.len) return null;

    return body[start..i];
}

// ── Tests ───────────────────────────────────────────────────────────────

test "findFreePort returns a port" {
    // Should find some free port in the range — CI won't have 9222+ bound
    const port = try findFreePort(19222);
    try std.testing.expect(port >= 19222);
    try std.testing.expect(port < 19322);
}

test "isPortInUse returns false for unbound port" {
    // Port 19999 is almost certainly not bound in test
    try std.testing.expect(!isPortInUse(19999));
}

test "extractWsUrl parses debugger URL" {
    const body =
        \\HTTP/1.1 200 OK
        \\Content-Type: application/json
        \\
        \\{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc123"}
    ;
    const url = extractWsUrl(body);
    try std.testing.expect(url != null);
    try std.testing.expectEqualStrings("ws://127.0.0.1:9222/devtools/browser/abc123", url.?);
}

test "extractWsUrl returns null for missing key" {
    const body = "HTTP/1.1 200 OK\r\n\r\n{\"Browser\":\"Chrome\"}";
    try std.testing.expect(extractWsUrl(body) == null);
}

test "parseHttpUrl extracts host port and path" {
    const parsed = parseHttpUrl("http://localhost:9333/json/version").?;
    try std.testing.expectEqualStrings("127.0.0.1", parsed.host);
    try std.testing.expectEqual(@as(u16, 9333), parsed.port);
    try std.testing.expectEqualStrings("/json/version", parsed.path);
}

test "parseSocketUrl extracts websocket port" {
    const parsed = parseSocketUrl("ws://127.0.0.1:9444/devtools/browser/abc").?;
    try std.testing.expectEqualStrings("127.0.0.1", parsed.host);
    try std.testing.expectEqual(@as(u16, 9444), parsed.port);
    try std.testing.expectEqualStrings("/devtools/browser/abc", parsed.path);
}

test "Launcher init managed mode" {
    const cfg = config.Config{
        .host = "127.0.0.1",
        .port = 8080,
        .cdp_url = null,
        .auth_secret = null,
        .state_dir = ".browdie",
        .stale_tab_interval_s = 30,
        .request_timeout_ms = 30_000,
        .navigate_timeout_ms = 30_000,
        .extensions = null,
        .headless = true,
    };
    const launcher_inst = Launcher.init(std.testing.allocator, cfg);
    try std.testing.expectEqual(Launcher.Mode.managed, launcher_inst.mode);
    try std.testing.expectEqual(@as(?[]const u8, null), launcher_inst.extensions);
    try std.testing.expectEqual(@as(?[]const u8, null), launcher_inst.builtin_ext_path);
}

test "Launcher init external mode" {
    const cfg = config.Config{
        .host = "127.0.0.1",
        .port = 8080,
        .cdp_url = "ws://localhost:9222",
        .auth_secret = null,
        .state_dir = ".browdie",
        .stale_tab_interval_s = 30,
        .request_timeout_ms = 30_000,
        .navigate_timeout_ms = 30_000,
        .extensions = null,
        .headless = true,
    };
    const launcher_inst = Launcher.init(std.testing.allocator, cfg);
    try std.testing.expectEqual(Launcher.Mode.external, launcher_inst.mode);
}

test "Launcher init with extensions" {
    const cfg = config.Config{
        .host = "127.0.0.1",
        .port = 8080,
        .cdp_url = null,
        .auth_secret = null,
        .state_dir = ".browdie",
        .stale_tab_interval_s = 30,
        .request_timeout_ms = 30_000,
        .navigate_timeout_ms = 30_000,
        .extensions = "/path/to/ext1,/path/to/ext2",
        .headless = true,
    };
    const launcher_inst = Launcher.init(std.testing.allocator, cfg);
    try std.testing.expectEqual(Launcher.Mode.managed, launcher_inst.mode);
    try std.testing.expectEqualStrings("/path/to/ext1,/path/to/ext2", launcher_inst.extensions.?);
}

test "healthCheck returns not alive for unbound port" {
    var launcher_inst = Launcher{
        .allocator = std.testing.allocator,
        .cdp_port = 19876,
        .child = null,
        .ws_url_buf = undefined,
        .ws_url_len = 0,
        .restarts = 0,
        .mode = .managed,
        .extensions = null,
        .headless = true,
        .state_dir = ".kuri",
        .builtin_ext_path = null,
    };
    const status = launcher_inst.healthCheck();
    try std.testing.expect(!status.alive);
    try std.testing.expect(status.ws_url == null);
}

test "buildExtensionFlags single extension" {
    const alloc = std.testing.allocator;
    const flags = try buildExtensionFlags(alloc, "/path/to/ext");
    defer {
        for (flags) |f| alloc.free(f);
        alloc.free(flags);
    }
    try std.testing.expectEqual(@as(usize, 2), flags.len);
    try std.testing.expectEqualStrings("--load-extension=/path/to/ext", flags[0]);
    try std.testing.expectEqualStrings("--disable-extensions-except=/path/to/ext", flags[1]);
}

test "buildExtensionFlags multiple extensions" {
    const alloc = std.testing.allocator;
    const flags = try buildExtensionFlags(alloc, "/ext/a,/ext/b,/ext/c");
    defer {
        for (flags) |f| alloc.free(f);
        alloc.free(flags);
    }
    // 3 --load-extension flags + 1 --disable-extensions-except flag
    try std.testing.expectEqual(@as(usize, 4), flags.len);
    try std.testing.expectEqualStrings("--load-extension=/ext/a", flags[0]);
    try std.testing.expectEqualStrings("--load-extension=/ext/b", flags[1]);
    try std.testing.expectEqualStrings("--load-extension=/ext/c", flags[2]);
    try std.testing.expectEqualStrings("--disable-extensions-except=/ext/a,/ext/b,/ext/c", flags[3]);
}

test "buildExtensionFlags trims whitespace around paths" {
    const alloc = std.testing.allocator;
    const flags = try buildExtensionFlags(alloc, " /ext/a , /ext/b ");
    defer {
        for (flags) |f| alloc.free(f);
        alloc.free(flags);
    }
    try std.testing.expectEqual(@as(usize, 3), flags.len);
    try std.testing.expectEqualStrings("--load-extension=/ext/a", flags[0]);
    try std.testing.expectEqualStrings("--load-extension=/ext/b", flags[1]);
    try std.testing.expectEqualStrings("--disable-extensions-except=/ext/a,/ext/b", flags[2]);
}

test "buildExtensionFlags empty string returns no flags" {
    const alloc = std.testing.allocator;
    const flags = try buildExtensionFlags(alloc, "");
    defer {
        for (flags) |f| alloc.free(f);
        alloc.free(flags);
    }
    try std.testing.expectEqual(@as(usize, 0), flags.len);
}

test "buildExtensionFlags skips blank comma-separated entries" {
    const alloc = std.testing.allocator;
    const flags = try buildExtensionFlags(alloc, "/ext/a,,/ext/b");
    defer {
        for (flags) |f| alloc.free(f);
        alloc.free(flags);
    }
    try std.testing.expectEqual(@as(usize, 3), flags.len);
    try std.testing.expectEqualStrings("--load-extension=/ext/a", flags[0]);
    try std.testing.expectEqualStrings("--load-extension=/ext/b", flags[1]);
    try std.testing.expectEqualStrings("--disable-extensions-except=/ext/a,/ext/b", flags[2]);
}
