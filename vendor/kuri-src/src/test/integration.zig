const std = @import("std");

// Import all modules under test
const config_mod = @import("../bridge/config.zig");
const Bridge = @import("../bridge/bridge.zig").Bridge;
const TabEntry = @import("../bridge/bridge.zig").TabEntry;
const RefCache = @import("../bridge/bridge.zig").RefCache;
const SnapshotRefCache = @import("../snapshot/ref_cache.zig").SnapshotRefCache;
const diff = @import("../snapshot/diff.zig");
const A11yNode = @import("../snapshot/a11y.zig").A11yNode;
const a11y = @import("../snapshot/a11y.zig");
const markdown = @import("../crawler/markdown.zig");
const validator = @import("../crawler/validator.zig");
const json_util = @import("../util/json.zig");
const harness_mod = @import("harness.zig");
const launcher_mod = @import("../chrome/launcher.zig");

// ─── Config Tests ───────────────────────────────────────────────────────

test "config defaults are sensible" {
    const cfg = config_mod.load();
    try std.testing.expectEqualStrings("127.0.0.1", cfg.host);
    try std.testing.expectEqual(@as(u16, 8080), cfg.port);
    try std.testing.expectEqual(@as(?[]const u8, null), cfg.cdp_url);
    try std.testing.expectEqual(@as(?[]const u8, null), cfg.auth_secret);
    try std.testing.expectEqualStrings(".browdie", cfg.state_dir);
    try std.testing.expectEqual(@as(u32, 30), cfg.stale_tab_interval_s);
    try std.testing.expectEqual(@as(u32, 30_000), cfg.request_timeout_ms);
    try std.testing.expectEqual(@as(u32, 30_000), cfg.navigate_timeout_ms);
}

// ─── Bridge Stress Tests ────────────────────────────────────────────────

test "bridge handles many tabs" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    // Add 100 tabs
    for (0..100) |i| {
        const id = try std.fmt.allocPrint(std.testing.allocator, "tab-{d}", .{i});
        defer std.testing.allocator.free(id);
        const url = try std.fmt.allocPrint(std.testing.allocator, "https://example.com/{d}", .{i});
        defer std.testing.allocator.free(url);

        try bridge.putTab(.{
            .id = id,
            .url = url,
            .title = "Test",
            .ws_url = "",
            .created_at = @as(i64, @intCast(i)),
            .last_accessed = @as(i64, @intCast(i)),
        });
    }

    try std.testing.expectEqual(@as(usize, 100), bridge.tabCount());

    // Remove all tabs
    for (0..100) |i| {
        const id = try std.fmt.allocPrint(std.testing.allocator, "tab-{d}", .{i});
        defer std.testing.allocator.free(id);
        bridge.removeTab(id);
    }

    try std.testing.expectEqual(@as(usize, 0), bridge.tabCount());
}

test "bridge tab overwrite replaces old entry" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    try bridge.putTab(.{
        .id = "tab-x",
        .url = "https://old.com",
        .title = "Old",
        .ws_url = "",
        .created_at = 1,
        .last_accessed = 1,
    });

    try bridge.putTab(.{
        .id = "tab-x",
        .url = "https://new.com",
        .title = "New",
        .ws_url = "",
        .created_at = 2,
        .last_accessed = 2,
    });

    try std.testing.expectEqual(@as(usize, 1), bridge.tabCount());
    const tab = bridge.getTab("tab-x").?;
    try std.testing.expectEqualStrings("https://new.com", tab.url);
}

test "bridge removeTab non-existent is safe" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    bridge.removeTab("does-not-exist");
    try std.testing.expectEqual(@as(usize, 0), bridge.tabCount());
}

test "bridge listTabs returns all entries" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    try bridge.putTab(.{ .id = "a", .url = "u1", .title = "t1", .ws_url = "", .created_at = 0, .last_accessed = 0 });
    try bridge.putTab(.{ .id = "b", .url = "u2", .title = "t2", .ws_url = "", .created_at = 0, .last_accessed = 0 });

    const tabs = try bridge.listTabs(std.testing.allocator);
    defer std.testing.allocator.free(tabs);

    try std.testing.expectEqual(@as(usize, 2), tabs.len);
}

// ─── Snapshot Diff Tests ────────────────────────────────────────────────

test "diff empty snapshots" {
    const empty: []const A11yNode = &.{};
    const result = try diff.diffSnapshots(empty, empty, std.testing.allocator);
    defer std.testing.allocator.free(result);
    try std.testing.expectEqual(@as(usize, 0), result.len);
}

test "diff all new nodes" {
    const empty: []const A11yNode = &.{};
    const current = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "A", .value = "", .backend_node_id = 1, .depth = 0 },
        .{ .ref = "e1", .role = "link", .name = "B", .value = "", .backend_node_id = 2, .depth = 0 },
    };

    const result = try diff.diffSnapshots(empty, &current, std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqual(@as(usize, 2), result.len);
    try std.testing.expectEqual(diff.DiffKind.added, result[0].kind);
    try std.testing.expectEqual(diff.DiffKind.added, result[1].kind);
}

test "diff all removed nodes" {
    const prev = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "A", .value = "", .backend_node_id = 1, .depth = 0 },
    };
    const empty: []const A11yNode = &.{};

    const result = try diff.diffSnapshots(&prev, empty, std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqual(@as(usize, 1), result.len);
    try std.testing.expectEqual(diff.DiffKind.removed, result[0].kind);
}

test "diff value change detected" {
    const prev = [_]A11yNode{
        .{ .ref = "e0", .role = "textbox", .name = "Email", .value = "", .backend_node_id = 10, .depth = 0 },
    };
    const current = [_]A11yNode{
        .{ .ref = "e0", .role = "textbox", .name = "Email", .value = "user@test.com", .backend_node_id = 10, .depth = 0 },
    };

    const result = try diff.diffSnapshots(&prev, &current, std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqual(@as(usize, 1), result.len);
    try std.testing.expectEqual(diff.DiffKind.changed, result[0].kind);
}

test "diff role change detected" {
    const prev = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "X", .value = "", .backend_node_id = 5, .depth = 0 },
    };
    const current = [_]A11yNode{
        .{ .ref = "e0", .role = "link", .name = "X", .value = "", .backend_node_id = 5, .depth = 0 },
    };

    const result = try diff.diffSnapshots(&prev, &current, std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqual(@as(usize, 1), result.len);
    try std.testing.expectEqual(diff.DiffKind.changed, result[0].kind);
}

test "diff unchanged nodes not reported" {
    const nodes = [_]A11yNode{
        .{ .ref = "e0", .role = "button", .name = "OK", .value = "", .backend_node_id = 1, .depth = 0 },
    };

    const result = try diff.diffSnapshots(&nodes, &nodes, std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expectEqual(@as(usize, 0), result.len);
}

test "ref cache sequential put/get" {
    var cache = SnapshotRefCache.init(std.testing.allocator);
    defer cache.deinit();

    // Use static ref names to avoid dangling pointer issue (StringHashMap borrows keys)
    const refs = [_][]const u8{ "e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9" };
    for (refs, 0..) |ref, i| {
        try cache.put(ref, @as(u32, @intCast(i + 100)));
    }

    try std.testing.expectEqual(@as(usize, 10), cache.count());
    try std.testing.expectEqual(@as(?u32, 100), cache.get("e0"));
    try std.testing.expectEqual(@as(?u32, 109), cache.get("e9"));
    try std.testing.expectEqual(@as(?u32, null), cache.get("e10"));
}

test "ref cache clear invalidates all refs" {
    var cache = SnapshotRefCache.init(std.testing.allocator);
    defer cache.deinit();

    try cache.put("e0", 10);
    try cache.put("e1", 20);
    try std.testing.expectEqual(@as(usize, 2), cache.count());

    cache.clear();
    try std.testing.expectEqual(@as(usize, 0), cache.count());
    try std.testing.expectEqual(@as(?u32, null), cache.get("e0"));
}

test "ref cache overwrite updates node id" {
    var cache = SnapshotRefCache.init(std.testing.allocator);
    defer cache.deinit();

    try cache.put("e0", 10);
    try cache.put("e0", 99);
    try std.testing.expectEqual(@as(?u32, 99), cache.get("e0"));
    try std.testing.expectEqual(@as(usize, 1), cache.count());
}

// ─── Markdown Converter Tests ───────────────────────────────────────────

test "markdown nested tags" {
    const html = "<p><strong><em>bold italic</em></strong></p>";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "***bold italic***") != null or
        std.mem.indexOf(u8, md, "**") != null);
}

test "markdown list items" {
    const html = "<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "- Alpha") != null);
    try std.testing.expect(std.mem.indexOf(u8, md, "- Beta") != null);
    try std.testing.expect(std.mem.indexOf(u8, md, "- Gamma") != null);
}

test "markdown blockquote" {
    const html = "<blockquote>Wise words</blockquote>";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "> Wise words") != null);
}

test "markdown pre code block" {
    const html = "<pre>fn main() {}</pre>";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "```") != null);
    try std.testing.expect(std.mem.indexOf(u8, md, "fn main() {}") != null);
}

test "markdown hr tag" {
    const html = "above<hr>below";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "---") != null);
}

test "markdown style tag stripped" {
    const html = "before<style>.x{color:red}</style>after";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expectEqualStrings("beforeafter", md);
}

test "markdown nbsp entity" {
    const html = "hello&nbsp;world";
    const md = try markdown.htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expectEqualStrings("hello world", md);
}

test "markdown empty input" {
    const md = try markdown.htmlToMarkdown("", std.testing.allocator);
    defer std.testing.allocator.free(md);
    try std.testing.expectEqualStrings("", md);
}

// ─── URL Validator Tests ────────────────────────────────────────────────

test "validator accepts HTTPS with port" {
    try validator.validateUrl("https://example.com:443/path");
}

test "validator accepts HTTP with query" {
    try validator.validateUrl("http://example.com?key=val&foo=bar");
}

test "validator rejects data URI" {
    try std.testing.expectError(
        validator.ValidationError.InvalidScheme,
        validator.validateUrl("data:text/html,<h1>hi</h1>"),
    );
}

test "validator rejects all private ranges" {
    // 10.x.x.x
    try std.testing.expectError(validator.ValidationError.PrivateIp, validator.validateUrl("http://10.255.255.255"));
    // 172.16-31.x.x
    try std.testing.expectError(validator.ValidationError.PrivateIp, validator.validateUrl("http://172.31.255.255"));
    // 192.168.x.x
    try std.testing.expectError(validator.ValidationError.PrivateIp, validator.validateUrl("http://192.168.0.1"));
    // 172.15 is NOT private
    try validator.validateUrl("http://172.15.0.1");
    // 172.32 is NOT private
    try validator.validateUrl("http://172.32.0.1");
}

test "validator blocks IPv6 loopback" {
    try std.testing.expectError(
        validator.ValidationError.LocalhostBlocked,
        validator.validateUrl("http://[::1]/path"),
    );
}

test "validator handles URL with auth" {
    try validator.validateUrl("https://user:pass@example.com/path");
}

// ─── JSON Utility Tests ────────────────────────────────────────────────

test "jsonEscape control characters" {
    const result = try json_util.jsonEscape("tab\there\nnewline\rcarriage", std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expect(std.mem.indexOf(u8, result, "\\t") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\\r") != null);
}

test "jsonEscape low control char" {
    // ASCII 0x01 should become \u0001
    const input = &[_]u8{0x01};
    const result = try json_util.jsonEscape(input, std.testing.allocator);
    defer std.testing.allocator.free(result);

    try std.testing.expect(std.mem.indexOf(u8, result, "\\u") != null);
}

test "jsonEscape empty string" {
    const result = try json_util.jsonEscape("", std.testing.allocator);
    defer std.testing.allocator.free(result);
    try std.testing.expectEqualStrings("", result);
}

test "jsonEscape no escaping needed" {
    const result = try json_util.jsonEscape("hello world 123", std.testing.allocator);
    defer std.testing.allocator.free(result);
    try std.testing.expectEqualStrings("hello world 123", result);
}

test "writeJsonObject single field" {
    var buf: [256]u8 = undefined;
    var stream = std.io.fixedBufferStream(&buf);
    const writer = stream.writer();

    const fields = [_][2][]const u8{
        .{ "key", "value" },
    };
    try json_util.writeJsonObject(writer, &fields);

    try std.testing.expectEqualStrings("{\"key\":\"value\"}", stream.getWritten());
}

test "writeJsonObject multiple fields" {
    var buf: [256]u8 = undefined;
    var stream = std.io.fixedBufferStream(&buf);
    const writer = stream.writer();

    const fields = [_][2][]const u8{
        .{ "a", "1" },
        .{ "b", "2" },
    };
    try json_util.writeJsonObject(writer, &fields);

    try std.testing.expectEqualStrings("{\"a\":\"1\",\"b\":\"2\"}", stream.getWritten());
}

test "writeJsonObject empty" {
    var buf: [256]u8 = undefined;
    var stream = std.io.fixedBufferStream(&buf);
    const writer = stream.writer();

    const fields: [0][2][]const u8 = .{};
    try json_util.writeJsonObject(writer, &fields);

    try std.testing.expectEqualStrings("{}", stream.getWritten());
}

// ─── Harness Self-Tests ─────────────────────────────────────────────────

test "harness init default port" {
    var h = harness_mod.TestHarness.init(std.testing.allocator);
    _ = &h;
    try std.testing.expectEqual(@as(u16, 8080), h.browdie_port);
}

test "harness countOccurrences overlapping" {
    // "aaa" in "aaaa" = 2 (non-overlapping)
    try std.testing.expectEqual(@as(usize, 2), harness_mod.TestHarness.countOccurrences("aaaa", "aa"));
}

test "harness snapshotElementCount with no refs" {
    try std.testing.expectEqual(@as(usize, 0), harness_mod.TestHarness.snapshotElementCount("{}"));
}

// ─── Chrome Launcher Tests ──────────────────────────────────────────────

test "launcher healthCheck on unbound port returns not alive" {
    var chrome = launcher_mod.Launcher.init(std.testing.allocator, config_mod.load());
    defer chrome.deinit();
    // Force a high port that won't be in use
    chrome.cdp_port = 19876;
    const status = chrome.healthCheck();
    try std.testing.expect(!status.alive);
    try std.testing.expectEqual(@as(?[]const u8, null), status.ws_url);
}

test "launcher findFreePort returns valid port" {
    const port = try launcher_mod.findFreePort(9222);
    try std.testing.expect(port >= 9222);
    try std.testing.expect(port <= 9322);
}

test "isPortInUse returns false for unbound port" {
    try std.testing.expect(!launcher_mod.isPortInUse(19999));
}
// ─── A11y Snapshot Tests ────────────────────────────────────────────────

test "isInteractive roles" {
    try std.testing.expect(a11y.isInteractive("button"));
    try std.testing.expect(a11y.isInteractive("link"));
    try std.testing.expect(a11y.isInteractive("textbox"));
    try std.testing.expect(!a11y.isInteractive("generic"));
    try std.testing.expect(!a11y.isInteractive(""));
}

// ─── Lightpanda Parity Protocol Tests ──────────────────────────────────

const protocol = @import("../cdp/protocol.zig");

test "lightpanda parity: network domain methods defined" {
    try std.testing.expectEqualStrings("Network.getCookies", protocol.Methods.network_get_cookies);
    try std.testing.expectEqualStrings("Network.setCookies", protocol.Methods.network_set_cookies);
    try std.testing.expectEqualStrings("Network.deleteCookies", protocol.Methods.network_delete_cookies);
    try std.testing.expectEqualStrings("Network.setExtraHTTPHeaders", protocol.Methods.network_set_extra_http_headers);
}

test "lightpanda parity: page domain methods defined" {
    try std.testing.expectEqualStrings("Page.printToPDF", protocol.Methods.page_print_to_pdf);
    try std.testing.expectEqualStrings("Page.stopLoading", protocol.Methods.page_stop_loading);
    try std.testing.expectEqualStrings("Page.addScriptToEvaluateOnNewDocument", protocol.Methods.page_add_script);
}

test "lightpanda parity: DOM domain methods defined" {
    try std.testing.expectEqualStrings("DOM.querySelector", protocol.Methods.dom_query_selector);
    try std.testing.expectEqualStrings("DOM.querySelectorAll", protocol.Methods.dom_query_selector_all);
    try std.testing.expectEqualStrings("DOM.getOuterHTML", protocol.Methods.dom_get_outer_html);
    try std.testing.expectEqualStrings("DOM.getDocument", protocol.Methods.dom_get_document);
    try std.testing.expectEqualStrings("DOM.resolveNode", protocol.Methods.dom_resolve_node);
}

test "lightpanda parity: all new methods are unique strings" {
    const methods = [_][]const u8{
        protocol.Methods.network_get_cookies,
        protocol.Methods.network_set_cookies,
        protocol.Methods.network_delete_cookies,
        protocol.Methods.network_set_extra_http_headers,
        protocol.Methods.page_print_to_pdf,
        protocol.Methods.page_stop_loading,
        protocol.Methods.dom_query_selector,
        protocol.Methods.dom_query_selector_all,
        protocol.Methods.dom_get_outer_html,
    };
    // Verify no duplicates
    for (methods, 0..) |m1, i| {
        for (methods[i + 1 ..]) |m2| {
            try std.testing.expect(!std.mem.eql(u8, m1, m2));
        }
    }
}

// ─── Tier 1 Handler Logic Tests ──────────────────────────────────────────

test "action kinds support new tier 1 types" {
    const actions = @import("../cdp/actions.zig");
    // Verify all new action kinds resolve correctly
    try std.testing.expect(actions.ActionKind.fromString("dblclick") != null);
    try std.testing.expect(actions.ActionKind.fromString("check") != null);
    try std.testing.expect(actions.ActionKind.fromString("uncheck") != null);
    try std.testing.expect(actions.ActionKind.fromString("blur") != null);

    // Verify original ones still work
    try std.testing.expect(actions.ActionKind.fromString("click") != null);
    try std.testing.expect(actions.ActionKind.fromString("fill") != null);
    try std.testing.expect(actions.ActionKind.fromString("hover") != null);

    // Unknown still returns null
    try std.testing.expect(actions.ActionKind.fromString("swipe") == null);
}

test "ref cache supports tier 1 handler lookups" {
    // Simulates what scrollintoview, highlight, drag handlers do:
    // 1. Put refs in cache from snapshot
    // 2. Look them up by ref name to get backend node IDs
    var cache = SnapshotRefCache.init(std.testing.allocator);
    defer cache.deinit();

    // Simulate snapshot populating refs
    try cache.put("e0", 100);
    try cache.put("e1", 101);
    try cache.put("e2", 102);
    try cache.put("e3", 103);

    // scrollintoview: lookup single ref
    try std.testing.expectEqual(@as(?u32, 100), cache.get("e0"));

    // drag: lookup src and tgt refs
    try std.testing.expectEqual(@as(?u32, 101), cache.get("e1"));
    try std.testing.expectEqual(@as(?u32, 103), cache.get("e3"));

    // highlight: lookup ref
    try std.testing.expectEqual(@as(?u32, 102), cache.get("e2"));

    // Unknown ref returns null (handler should return 400)
    try std.testing.expect(cache.get("e99") == null);
}

test "bridge tab operations for tab/new and tab/close" {
    var bridge = Bridge.init(std.testing.allocator);
    defer bridge.deinit();

    // Initially no tabs
    try std.testing.expectEqual(@as(usize, 0), bridge.tabCount());

    // Simulate adding tabs (what tab/new does after CDP call)
    try bridge.putTab(.{
        .id = "tab-1",
        .ws_url = "ws://127.0.0.1:9222/devtools/page/tab-1",
        .url = "about:blank",
        .title = "New Tab",
        .created_at = 1000,
        .last_accessed = 1000,
    });
    try std.testing.expectEqual(@as(usize, 1), bridge.tabCount());

    try bridge.putTab(.{
        .id = "tab-2",
        .ws_url = "ws://127.0.0.1:9222/devtools/page/tab-2",
        .url = "https://example.com",
        .title = "Example",
        .created_at = 1001,
        .last_accessed = 1001,
    });
    try std.testing.expectEqual(@as(usize, 2), bridge.tabCount());

    // tab/close: remove specific tab
    bridge.removeTab("tab-1");
    try std.testing.expectEqual(@as(usize, 1), bridge.tabCount());

    // Verify correct tab was removed
    try std.testing.expect(bridge.getCdpClient("tab-1") == null);
}

test "CDP protocol methods for tier 1 endpoints exist" {
    // Input domain
    try std.testing.expectEqualStrings("Input.dispatchKeyEvent", protocol.Methods.input_dispatch_key_event);
    try std.testing.expectEqualStrings("Input.insertText", protocol.Methods.input_insert_text);
    try std.testing.expectEqualStrings("Input.dispatchMouseEvent", protocol.Methods.input_dispatch_mouse_event);

    // DOM scroll
    try std.testing.expectEqualStrings("DOM.scrollIntoViewIfNeeded", protocol.Methods.dom_scroll_into_view);

    // Emulation
    try std.testing.expectEqualStrings("Emulation.setEmulatedMedia", protocol.Methods.emulation_set_emulated_media);

    // Network
    try std.testing.expectEqualStrings("Network.emulateNetworkConditions", protocol.Methods.network_emulate_conditions);
}

test "snapshot ref cache clear and repopulate cycle" {
    // Tests the pattern: navigate → snapshot → action → re-snapshot
    // The ref cache must be clearable and repopulatable
    var cache = SnapshotRefCache.init(std.testing.allocator);
    defer cache.deinit();

    // First snapshot
    try cache.put("e0", 10);
    try cache.put("e1", 11);
    try std.testing.expectEqual(@as(?u32, 10), cache.get("e0"));

    // After re-snapshot, refs may change (page re-rendered)
    cache.clear();
    try std.testing.expect(cache.get("e0") == null);

    // New snapshot populates different refs
    try cache.put("e0", 20); // same name, different node ID
    try cache.put("e1", 21);
    try cache.put("e2", 22); // new element appeared
    try std.testing.expectEqual(@as(?u32, 20), cache.get("e0"));
    try std.testing.expectEqual(@as(?u32, 22), cache.get("e2"));
}
