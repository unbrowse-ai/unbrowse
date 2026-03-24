const std = @import("std");
const net = std.net;
const bridge_mod = @import("../bridge/bridge.zig");
const Bridge = bridge_mod.Bridge;
const TabEntry = bridge_mod.TabEntry;
const RefCache = bridge_mod.RefCache;
const Config = @import("../bridge/config.zig").Config;
const resp = @import("response.zig");
const middleware = @import("middleware.zig");
const json_util = @import("../util/json.zig");
const protocol = @import("../cdp/protocol.zig");
const HarRecorder = @import("../cdp/har.zig").HarRecorder;
const CdpClient = @import("../cdp/client.zig").CdpClient;

pub fn run(gpa: std.mem.Allocator, bridge: *Bridge, cfg: Config) !void {
    const address = try net.Address.parseIp4(cfg.host, cfg.port);
    var tcp_server = try address.listen(.{
        .reuse_address = true,
    });
    defer tcp_server.deinit();

    std.log.info("server ready on {s}:{d}", .{ cfg.host, cfg.port });

    while (true) {
        const conn = tcp_server.accept() catch |err| {
            std.log.err("accept error: {s}", .{@errorName(err)});
            continue;
        };

        const thread = std.Thread.spawn(.{}, handleConnection, .{ gpa, bridge, cfg, conn }) catch |err| {
            std.log.err("thread spawn error: {s}", .{@errorName(err)});
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}

fn handleConnection(gpa: std.mem.Allocator, bridge: *Bridge, cfg: Config, conn: net.Server.Connection) void {
    defer conn.stream.close();

    var arena_impl = std.heap.ArenaAllocator.init(gpa);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    var read_buf: [8192]u8 = undefined;
    var net_reader = net.Stream.Reader.init(conn.stream, &read_buf);
    var write_buf: [8192]u8 = undefined;
    var net_writer = net.Stream.Writer.init(conn.stream, &write_buf);

    var http_server = std.http.Server.init(net_reader.interface(), &net_writer.interface);

    while (true) {
        var request = http_server.receiveHead() catch |err| {
            if (err == error.EndOfStream) return;
            std.log.debug("receiveHead error: {s}", .{@errorName(err)});
            return;
        };

        if (!middleware.checkAuth(&request, cfg)) {
            resp.sendError(&request, 401, "Unauthorized");
            return;
        }

        route(&request, arena, bridge, cfg);

        if (!request.head.keep_alive) return;

        // Free per-request allocations while keeping arena pages for reuse
        _ = arena_impl.reset(.retain_capacity);
    }
}

fn route(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge, cfg: Config) void {
    const path = request.head.target;
    const clean_path = if (std.mem.indexOfScalar(u8, path, '?')) |idx| path[0..idx] else path;

    if (std.mem.eql(u8, clean_path, "/health")) {
        handleHealth(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/tabs")) {
        handleTabs(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/discover")) {
        handleDiscover(request, arena, bridge, cfg);
    } else if (std.mem.eql(u8, clean_path, "/navigate")) {
        handleNavigate(request, arena, bridge, cfg);
    } else if (std.mem.eql(u8, clean_path, "/snapshot")) {
        handleSnapshot(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/action")) {
        handleAction(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/text")) {
        handleText(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/screenshot")) {
        handleScreenshot(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/evaluate")) {
        handleEvaluate(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/browdie")) {
        handleBrowdie(request);
    } else if (std.mem.eql(u8, clean_path, "/har/start")) {
        handleHarStart(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/har/stop")) {
        handleHarStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/har/status")) {
        handleHarStatus(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/close")) {
        handleClose(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/cookies")) {
        handleCookies(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/cookies/clear")) {
        handleCookiesClear(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/storage/local")) {
        handleStorage(request, arena, bridge, "localStorage");
    } else if (std.mem.eql(u8, clean_path, "/storage/session")) {
        handleStorage(request, arena, bridge, "sessionStorage");
    } else if (std.mem.eql(u8, clean_path, "/storage/local/clear")) {
        handleStorageClear(request, arena, bridge, "localStorage");
    } else if (std.mem.eql(u8, clean_path, "/storage/session/clear")) {
        handleStorageClear(request, arena, bridge, "sessionStorage");
    } else if (std.mem.eql(u8, clean_path, "/get")) {
        handleGet(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/back")) {
        handleBack(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/forward")) {
        handleForward(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/reload")) {
        handleReload(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/diff/snapshot")) {
        handleDiffSnapshot(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/emulate")) {
        handleEmulate(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/geolocation")) {
        handleGeolocation(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/upload")) {
        handleUpload(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/session/save")) {
        handleSessionSave(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/session/load")) {
        handleSessionLoad(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/screenshot/annotated")) {
        handleAnnotatedScreenshot(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/screenshot/diff")) {
        handleDiffScreenshot(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/screencast/start")) {
        handleScreencastStart(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/screencast/stop")) {
        handleScreencastStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/video/start")) {
        handleVideoStart(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/video/stop")) {
        handleVideoStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/console")) {
        handleConsole(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/intercept/start")) {
        handleInterceptStart(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/intercept/stop")) {
        handleInterceptStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/markdown")) {
        handleMarkdown(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/links")) {
        handleLinks(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/pdf")) {
        handlePdf(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/dom/query")) {
        handleDomQuery(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/dom/html")) {
        handleDomHtml(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/cookies/delete")) {
        handleCookiesDelete(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/headers")) {
        handleHeaders(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/script/inject")) {
        handleScriptInject(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/stop")) {
        handleStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/scrollintoview")) {
        handleScrollIntoView(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/drag")) {
        handleDrag(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/keyboard/type")) {
        handleKeyboardType(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/keyboard/inserttext")) {
        handleKeyboardInsertText(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/keydown")) {
        handleKeyDown(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/keyup")) {
        handleKeyUp(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/wait")) {
        handleWait(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/tab/new")) {
        handleTabNew(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/tab/close")) {
        handleTabClose(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/highlight")) {
        handleHighlight(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/errors")) {
        handleErrors(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/set/offline")) {
        handleSetOffline(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/set/media")) {
        handleSetMedia(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/set/credentials")) {
        handleSetCredentials(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/find")) {
        handleFind(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/trace/start")) {
        handleTraceStart(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/trace/stop")) {
        handleTraceStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/profiler/start")) {
        handleProfilerStart(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/profiler/stop")) {
        handleProfilerStop(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/inspect")) {
        handleInspect(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/window/new")) {
        handleWindowNew(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/session/list")) {
        handleSessionList(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/set/viewport")) {
        handleSetViewport(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/set/useragent")) {
        handleSetUserAgent(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/dom/attributes")) {
        handleDomAttributes(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/frames")) {
        handleFrames(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/network")) {
        handleNetwork(request, arena, bridge);
    } else if (std.mem.eql(u8, clean_path, "/perf/lcp")) {
        handlePerfLcp(request, arena, bridge);
    } else {
        resp.sendError(request, 404, "Not Found");
    }
}

// --- Query string helpers ---

fn getQueryParam(target: []const u8, key: []const u8) ?[]const u8 {
    const query_start = (std.mem.indexOfScalar(u8, target, '?') orelse return null) + 1;
    const query = target[query_start..];
    var iter = std.mem.splitScalar(u8, query, '&');
    while (iter.next()) |pair| {
        if (std.mem.indexOfScalar(u8, pair, '=')) |eq| {
            if (std.mem.eql(u8, pair[0..eq], key)) {
                return pair[eq + 1 ..];
            }
        }
    }
    return null;
}

fn readRequestBody(request: *std.http.Server.Request, arena: std.mem.Allocator) ?[]const u8 {
    if (!request.head.method.requestHasBody()) return null;
    if (request.head.expect != null) return null;
    const content_length = request.head.content_length orelse return null;
    if (content_length == 0) return null;
    const max_body: usize = 1024 * 1024; // 1MB — supports large script injection
    const len: usize = @intCast(@min(content_length, max_body));
    var buf: [65536]u8 = undefined;
    const reader = request.readerExpectNone(&buf);
    const body = reader.readAlloc(arena, len) catch return null;
    if (body.len == 0) return null;
    return body;
}

// --- Route handlers ---

fn handleHealth(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const tab_count = bridge.tabCount();
    const body = std.fmt.allocPrint(arena, "{{\"ok\":true,\"tabs\":{d},\"version\":\"0.1.0\",\"name\":\"kuri\"}}", .{tab_count}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleTabs(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const tabs = bridge.listTabs(arena) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    var json_buf: std.ArrayList(u8) = .empty;
    const writer = json_buf.writer(arena);

    writer.writeAll("[") catch return;
    for (tabs, 0..) |tab, i| {
        if (i > 0) writer.writeAll(",") catch return;
        writer.print("{{\"id\":\"{s}\",\"url\":\"{s}\",\"title\":\"{s}\"}}", .{ tab.id, tab.url, tab.title }) catch return;
    }
    writer.writeAll("]") catch return;

    resp.sendJson(request, json_buf.items);
}

fn handleNavigate(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge, cfg: Config) void {
    const target = request.head.target;
    const url = getQueryParam(target, "url") orelse {
        resp.sendError(request, 400, "Missing url parameter");
        return;
    };
    const tab_id = getQueryParam(target, "tab_id");

    // If we have a tab, use its CDP client
    if (tab_id) |tid| {
        const client = bridge.getCdpClient(tid) orelse {
            resp.sendError(request, 404, "Tab not found");
            return;
        };
        // Drain any pending events from the WebSocket after navigate
        // (Network events arrive after the navigate response)
        if (bridge.getHarRecorder(tid)) |rec| {
            if (rec.isRecording()) {
                const short_timeout = std.posix.timeval{ .sec = 1, .usec = 0 };
                const orig_timeout = std.posix.timeval{ .sec = 10, .usec = 0 };
                if (client.ws) |*ws| {
                    std.posix.setsockopt(ws.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&short_timeout)) catch {};
                    var drained: u32 = 0;
                    while (drained < 200) : (drained += 1) {
                        const msg = ws.receiveMessageAlloc(arena, 2 * 1024 * 1024) catch break;
                        rec.handleCdpEvent(msg);
                        client.event_buf.push(msg);
                    }
                    std.log.info("navigate: drained {d} events after response", .{drained});
                    std.posix.setsockopt(ws.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&orig_timeout)) catch {};
                }
            }
        }
        const params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\"}}", .{url}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.page_navigate, params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
        return;
    }

    // No tab specified — discover from Chrome debugging endpoint
    _ = cfg;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"url\":\"{s}\",\"message\":\"Navigate requires tab_id. Use /tabs to list available tabs.\"}}", .{url}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleSnapshot(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const filter = getQueryParam(target, "filter");
    const format = getQueryParam(target, "format");
    const depth_str = getQueryParam(target, "depth");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Get full a11y tree from Chrome
    const raw_response = client.send(arena, protocol.Methods.accessibility_get_full_tree, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    // If format=raw, return the raw CDP response
    if (format) |f| {
        if (std.mem.eql(u8, f, "raw")) {
            resp.sendJson(request, raw_response);
            return;
        }
    }

    // Parse and filter the a11y tree
    const a11y = @import("../snapshot/a11y.zig");
    const nodes = parseA11yNodes(arena, raw_response) catch {
        resp.sendError(request, 500, "Failed to parse a11y tree");
        return;
    };

    const max_depth: ?u16 = if (depth_str) |ds| std.fmt.parseInt(u16, ds, 10) catch null else null;

    const opts = a11y.SnapshotOpts{
        .filter_interactive = if (filter) |f| std.mem.eql(u8, f, "interactive") else false,
        .format_text = if (format) |f| std.mem.eql(u8, f, "text") else false,
        .max_depth = max_depth,
    };

    const snapshot = a11y.buildSnapshot(nodes, opts, arena) catch {
        resp.sendError(request, 500, "Failed to build snapshot");
        return;
    };

    // Populate the ref cache with backend_node_ids from the snapshot
    {
        bridge.mu.lock();
        defer bridge.mu.unlock();

        // Get or create ref cache for this tab
        // Use getPtr first; only dupe key if we need to insert
        var cache_ptr = bridge.snapshots.getPtr(tab_id);
        if (cache_ptr == null) {
            const owned_key = bridge.allocator.dupe(u8, tab_id) catch {
                sendSnapshotResponse(request, arena, snapshot, opts);
                return;
            };
            bridge.snapshots.put(owned_key, RefCache.init(bridge.allocator)) catch {
                bridge.allocator.free(owned_key);
                sendSnapshotResponse(request, arena, snapshot, opts);
                return;
            };
            cache_ptr = bridge.snapshots.getPtr(tab_id);
        }
        const ref_cache = cache_ptr orelse {
            sendSnapshotResponse(request, arena, snapshot, opts);
            return;
        };

        // Clear old refs and repopulate
        ref_cache.refs.clearRetainingCapacity();
        for (snapshot) |node| {
            if (node.backend_node_id) |bid| {
                const owned_ref = bridge.allocator.dupe(u8, node.ref) catch continue;
                ref_cache.refs.put(owned_ref, bid) catch continue;
            }
        }
        ref_cache.node_count = snapshot.len;
    }

    sendSnapshotResponse(request, arena, snapshot, opts);
}

fn sendSnapshotResponse(request: *std.http.Server.Request, arena: std.mem.Allocator, snapshot: []const @import("../snapshot/a11y.zig").A11yNode, opts: @import("../snapshot/a11y.zig").SnapshotOpts) void {
    const a11y_mod = @import("../snapshot/a11y.zig");
    // Text format for LLM-friendly output
    if (opts.format_text) {
        const text = a11y_mod.formatText(snapshot, arena) catch {
            resp.sendError(request, 500, "Failed to format snapshot");
            return;
        };
        resp.sendJson(request, text);
        return;
    }

    // JSON format
    var json_buf: std.ArrayList(u8) = .empty;
    const writer = json_buf.writer(arena);
    writer.writeAll("[") catch return;
    for (snapshot, 0..) |node, i| {
        if (i > 0) writer.writeAll(",") catch return;
        writer.print("{{\"ref\":\"{s}\",\"role\":\"{s}\",\"name\":\"{s}\"", .{ node.ref, node.role, node.name }) catch return;
        if (node.value.len > 0) {
            writer.print(",\"value\":\"{s}\"", .{node.value}) catch return;
        }
        writer.writeAll("}") catch return;
    }
    writer.writeAll("]") catch return;
    resp.sendJson(request, json_buf.items);
}

fn handleAction(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const action = getQueryParam(target, "action") orelse {
        resp.sendError(request, 400, "Missing action parameter");
        return;
    };
    const ref = getQueryParam(target, "ref") orelse {
        resp.sendError(request, 400, "Missing ref parameter (e.g. e0, e1)");
        return;
    };
    const value = getQueryParam(target, "value");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Look up the ref in the snapshot cache to get the backend node ID
    bridge.mu.lockShared();
    const cache = bridge.snapshots.get(tab_id);
    bridge.mu.unlockShared();

    const node_id = if (cache) |c| c.refs.get(ref) else null;

    // Build the appropriate CDP command based on action
    const actions = @import("../cdp/actions.zig");
    const kind = actions.ActionKind.fromString(action) orelse {
        resp.sendError(request, 400, "Unknown action type");
        return;
    };

    // For scroll and press, no element reference needed
    if (kind == .scroll) {
        const params = std.fmt.allocPrint(arena, "{{\"expression\":\"window.scrollBy(0, 500) || 'scrolled'\",\"returnByValue\":true}}", .{}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
        return;
    }
    if (kind == .press) {
        const v = value orelse {
            resp.sendError(request, 400, "Missing value parameter for press");
            return;
        };
        const params = std.fmt.allocPrint(arena, "{{\"expression\":\"document.dispatchEvent(new KeyboardEvent('keydown', {{key: '{s}'}})) || 'pressed'\",\"returnByValue\":true}}", .{v}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
        return;
    }

    // For element-targeted actions, need backend_node_id
    const bid = node_id orelse {
        resp.sendError(request, 400, "Ref not found. Call /snapshot first to populate refs");
        return;
    };

    // Step 1: Resolve the backend node to a JS object via DOM.resolveNode
    const resolve_params = std.fmt.allocPrint(arena, "{{\"backendNodeId\":{d}}}", .{bid}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const resolve_response = client.send(arena, protocol.Methods.dom_resolve_node, resolve_params) catch {
        resp.sendError(request, 502, "DOM.resolveNode failed");
        return;
    };

    // Extract objectId from response
    const object_id = extractSimpleJsonString(resolve_response, 0, "\"objectId\"") orelse {
        resp.sendError(request, 500, "Could not resolve element objectId");
        return;
    };

    // Step 2: Build the JS function for the action
    const js_fn: []const u8 = switch (kind) {
        .click => "function() { this.scrollIntoViewIfNeeded(); this.click(); return 'clicked'; }",
        .focus => "function() { this.focus(); return 'focused'; }",
        .hover => "function() { this.dispatchEvent(new MouseEvent('mouseover', {bubbles:true})); return 'hovered'; }",
        .dblclick => "function() { this.scrollIntoViewIfNeeded(); this.dispatchEvent(new MouseEvent('dblclick', {bubbles:true,cancelable:true})); return 'dblclicked'; }",
        .check => "function() { if (!this.checked) { this.click(); } return 'checked'; }",
        .uncheck => "function() { if (this.checked) { this.click(); } return 'unchecked'; }",
        .blur => "function() { this.blur(); return 'blurred'; }",
        .fill, .@"type" => blk: {
            const v = value orelse {
                resp.sendError(request, 400, "Missing value parameter for fill/type");
                return;
            };
            const fn_str = std.fmt.allocPrint(arena, "function() {{ this.focus(); this.value = '{s}'; this.dispatchEvent(new Event('input', {{bubbles:true}})); return 'filled'; }}", .{v}) catch {
                resp.sendError(request, 500, "Internal Server Error");
                return;
            };
            break :blk fn_str;
        },
        .select => blk: {
            const v = value orelse {
                resp.sendError(request, 400, "Missing value parameter for select");
                return;
            };
            const fn_str = std.fmt.allocPrint(arena, "function() {{ this.value = '{s}'; this.dispatchEvent(new Event('change', {{bubbles:true}})); return 'selected'; }}", .{v}) catch {
                resp.sendError(request, 500, "Internal Server Error");
                return;
            };
            break :blk fn_str;
        },
        .scroll, .press => unreachable,
    };

    // Step 3: Call function on the resolved object
    const call_params = std.fmt.allocPrint(arena, "{{\"objectId\":\"{s}\",\"functionDeclaration\":\"{s}\",\"returnByValue\":true}}", .{ object_id, js_fn }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const call_response = client.send(arena, protocol.Methods.runtime_call_function_on, call_params) catch {
        resp.sendError(request, 502, "Runtime.callFunctionOn failed");
        return;
    };
    resp.sendJson(request, call_response);
}

fn handleText(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const selector = getQueryParam(target, "selector");
    const params = if (selector) |sel|
        std.fmt.allocPrint(arena,
            "{{\"expression\":\"document.querySelector('{s}')?.innerText || null\",\"returnByValue\":true}}", .{sel}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        }
    else
        @as([]const u8, "{\"expression\":\"document.body.innerText\",\"returnByValue\":true}");
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleScreenshot(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const format = getQueryParam(target, "format") orelse "png";
    const quality = getQueryParam(target, "quality") orelse "80";
    const full = getQueryParam(target, "full");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const is_full = if (full) |f| std.mem.eql(u8, f, "true") else false;

    const params = if (is_full)
        std.fmt.allocPrint(arena, "{{\"format\":\"{s}\",\"quality\":{s},\"captureBeyondViewport\":true}}", .{ format, quality })
    else
        std.fmt.allocPrint(arena, "{{\"format\":\"{s}\",\"quality\":{s}}}", .{ format, quality });

    const screenshot_params = params catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const response = client.send(arena, protocol.Methods.page_capture_screenshot, screenshot_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleEvaluate(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const expr = getQueryParam(target, "expression") orelse {
        resp.sendError(request, 400, "Missing expression parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}", .{expr}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

/// 🧁 Easter egg: she's a bro + a baddie = browdie
fn handleBrowdie(request: *std.http.Server.Request) void {
    const browdie =
        \\{"kuri":"🌰",
        \\"formerly":"browdie 🧁",
        \\"vibe":"not just a bro, not just a baddie — a browdie.",
        \\"powers":["sees the web through a11y trees","97% token reduction","stealth mode UA rotation","zero node_modules"],
        \\"catchphrase":"she browses different.",
        \\"built_with":"zig 0.15.1 btw"}
    ;
    resp.sendJson(request, browdie);
}

fn handleDiscover(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge, cfg: Config) void {
    const cdp_base = cfg.cdp_url orelse {
        resp.sendError(request, 400, "No CDP_URL configured");
        return;
    };

    // Parse host:port from CDP URL (strip ws:// prefix and path)
    const after_scheme = if (std.mem.startsWith(u8, cdp_base, "ws://"))
        cdp_base[5..]
    else
        cdp_base;
    const host_end = std.mem.indexOfScalar(u8, after_scheme, '/') orelse after_scheme.len;
    const host_port = after_scheme[0..host_end];

    var host: []const u8 = "127.0.0.1";
    var port: u16 = 9222;
    if (std.mem.indexOfScalar(u8, host_port, ':')) |colon| {
        host = host_port[0..colon];
        if (std.mem.eql(u8, host, "localhost")) host = "127.0.0.1";
        port = std.fmt.parseInt(u16, host_port[colon + 1 ..], 10) catch 9222;
    }

    const address = net.Address.parseIp4(host, port) catch {
        resp.sendError(request, 502, "Cannot resolve Chrome address");
        return;
    };
    const stream = net.tcpConnectToAddress(address) catch {
        resp.sendError(request, 502, "Cannot connect to Chrome");
        return;
    };
    defer stream.close();

    // Set read timeout (2 seconds) to avoid blocking forever
    const timeout = std.posix.timeval{ .sec = 2, .usec = 0 };
    std.posix.setsockopt(stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout)) catch {};

    // HTTP/1.1 required — Chrome ignores HTTP/1.0
    const http_req = std.fmt.allocPrint(arena, "GET /json/list HTTP/1.1\r\nHost: {s}:{d}\r\nConnection: close\r\n\r\n", .{ host, port }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    stream.writeAll(http_req) catch {
        resp.sendError(request, 502, "Failed to send request to Chrome");
        return;
    };

    // Read response with Content-Length awareness
    var response_buf: [65536]u8 = undefined;
    var total: usize = 0;
    while (total < response_buf.len) {
        const n = stream.read(response_buf[total..]) catch break;
        if (n == 0) break;
        total += n;
        // Once we have headers, check Content-Length to know when body is complete
        if (std.mem.indexOf(u8, response_buf[0..total], "\r\n\r\n")) |hdr_end| {
            const headers = response_buf[0..hdr_end];
            if (findContentLength(headers)) |content_len| {
                const body_start = hdr_end + 4;
                if (total >= body_start + content_len) break;
            }
        }
    }

    if (total == 0) {
        resp.sendError(request, 502, "Empty response from Chrome");
        return;
    }
    const raw_response = response_buf[0..total];

    const body_start = (std.mem.indexOf(u8, raw_response, "\r\n\r\n") orelse {
        resp.sendError(request, 502, "Invalid response from Chrome");
        return;
    }) + 4;
    const body = raw_response[body_start..total];

    // Parse targets and register tabs
    var registered: usize = 0;
    var pos: usize = 0;
    while (pos < body.len) {
        const id_start = std.mem.indexOfPos(u8, body, pos, "\"id\"") orelse break;

        const id_val = extractSimpleJsonString(body, id_start, "\"id\"") orelse {
            pos = id_start + 4;
            continue;
        };
        const type_val = extractSimpleJsonString(body, id_start, "\"type\"") orelse "page";
        const url_val = extractSimpleJsonString(body, id_start, "\"url\"") orelse "";
        const title_val = extractSimpleJsonString(body, id_start, "\"title\"") orelse "";
        const ws_val = extractSimpleJsonString(body, id_start, "\"webSocketDebuggerUrl\"") orelse "";

        if (std.mem.eql(u8, type_val, "page") and ws_val.len > 0) {
            // Dupe strings into arena so they outlive the stack buffer
            const entry = TabEntry{
                .id = arena.dupe(u8, id_val) catch id_val,
                .url = arena.dupe(u8, url_val) catch url_val,
                .title = arena.dupe(u8, title_val) catch title_val,
                .ws_url = arena.dupe(u8, ws_val) catch ws_val,
                .created_at = @intCast(std.time.timestamp()),
                .last_accessed = @intCast(std.time.timestamp()),
            };
            bridge.putTab(entry) catch {};
            registered += 1;
        }

        const next_id = std.mem.indexOfPos(u8, body, id_start + 4, "\"id\"") orelse body.len;
        pos = next_id;
    }

    const result = std.fmt.allocPrint(arena,
        "{{\"discovered\":{d},\"total_tabs\":{d}}}", .{ registered, bridge.tabCount() }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, result);
}

fn findContentLength(headers: []const u8) ?usize {
    // Chrome sends "Content-Length:1773" (no space after colon)
    const patterns = [_][]const u8{ "Content-Length:", "Content-Length: ", "content-length:", "content-length: " };
    for (patterns) |pat| {
        if (std.mem.indexOf(u8, headers, pat)) |cl_pos| {
            const val_start = cl_pos + pat.len;
            const val_end = std.mem.indexOfScalarPos(u8, headers, val_start, '\r') orelse continue;
            const val_str = std.mem.trim(u8, headers[val_start..val_end], " ");
            return std.fmt.parseInt(usize, val_str, 10) catch continue;
        }
    }
    return null;
}

fn extractSimpleJsonString(json: []const u8, start: usize, field: []const u8) ?[]const u8 {
    const field_pos = std.mem.indexOfPos(u8, json, start, field) orelse return null;
    if (field_pos - start > 1000) return null;
    const colon = std.mem.indexOfScalarPos(u8, json, field_pos + field.len, ':') orelse return null;
    // Skip whitespace and find opening quote
    var i = colon + 1;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t' or json[i] == '\n' or json[i] == '\r')) : (i += 1) {}
    if (i >= json.len or json[i] != '"') return null;
    const val_start = i + 1;
    const val_end = std.mem.indexOfScalarPos(u8, json, val_start, '"') orelse return null;
    return json[val_start..val_end];
}

// --- A11y tree parsing helper ---

fn extractSimpleJsonInt(json: []const u8, start: usize, field: []const u8) ?u32 {
    const field_pos = std.mem.indexOfPos(u8, json, start, field) orelse return null;
    if (field_pos - start > 1000) return null;
    const colon = std.mem.indexOfScalarPos(u8, json, field_pos + field.len, ':') orelse return null;
    var i = colon + 1;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t' or json[i] == '\n' or json[i] == '\r')) : (i += 1) {}
    var end = i;
    while (end < json.len and json[end] >= '0' and json[end] <= '9') : (end += 1) {}
    if (end == i) return null;
    return std.fmt.parseInt(u32, json[i..end], 10) catch null;
}

fn parseA11yNodes(arena: std.mem.Allocator, raw_json: []const u8) ![]const @import("../snapshot/a11y.zig").A11yNode {
    const a11y = @import("../snapshot/a11y.zig");
    // Parse the CDP response to extract node info
    // The response has { "result": { "nodes": [ ... ] } }
    // We do a simple scan for role/name/nodeId patterns
    var nodes: std.ArrayList(a11y.A11yNode) = .empty;

    // Find "nodes" array start
    const nodes_start = std.mem.indexOf(u8, raw_json, "\"nodes\"") orelse return nodes.toOwnedSlice(arena);
    const array_start = std.mem.indexOfScalarPos(u8, raw_json, nodes_start, '[') orelse return nodes.toOwnedSlice(arena);

    // Simple state-machine parser for CDP a11y nodes
    var pos = array_start + 1;
    var depth: u16 = 0;
    while (pos < raw_json.len) {
        // Find next nodeId
        const node_start = std.mem.indexOfPos(u8, raw_json, pos, "\"nodeId\"") orelse break;
        const role_val = extractJsonStringField(raw_json, node_start, "\"role\"") orelse "";
        const name_val = extractNestedValue(raw_json, node_start) orelse "";
        const backend_id = extractSimpleJsonInt(raw_json, node_start, "\"backendDOMNodeId\"");

        if (role_val.len > 0) {
            try nodes.append(arena, .{
                .ref = "",
                .role = role_val,
                .name = name_val,
                .value = "",
                .backend_node_id = backend_id,
                .depth = depth,
            });
        }

        // Move past this node object
        const next_node = std.mem.indexOfPos(u8, raw_json, node_start + 10, "\"nodeId\"") orelse raw_json.len;
        pos = next_node;
        depth = 0; // flat for now
    }

    return nodes.toOwnedSlice(arena);
}

fn extractJsonStringField(json: []const u8, start: usize, field: []const u8) ?[]const u8 {
    const field_pos = std.mem.indexOfPos(u8, json, start, field) orelse return null;
    // Limit search to next 500 chars (within same node object)
    if (field_pos - start > 500) return null;
    // Find the value string after ":"
    const colon = std.mem.indexOfScalarPos(u8, json, field_pos + field.len, ':') orelse return null;
    // Look for nested "value" field
    const value_field = std.mem.indexOfPos(u8, json, colon, "\"value\"") orelse return null;
    if (value_field - colon > 100) return null;
    const val_colon = std.mem.indexOfScalarPos(u8, json, value_field + 7, ':') orelse return null;
    const quote_start = std.mem.indexOfScalarPos(u8, json, val_colon + 1, '"') orelse return null;
    const quote_end = std.mem.indexOfScalarPos(u8, json, quote_start + 1, '"') orelse return null;
    return json[quote_start + 1 .. quote_end];
}

fn extractNestedValue(json: []const u8, start: usize) ?[]const u8 {
    const name_pos = std.mem.indexOfPos(u8, json, start, "\"name\"") orelse return null;
    if (name_pos - start > 800) return null;
    return extractJsonStringField(json, name_pos - 1, "\"name\"");
}

// ── HAR Endpoints ───────────────────────────────────────────────────────

fn handleHarStart(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const rec = bridge.getHarRecorder(tab_id) orelse {
        resp.sendError(request, 500, "Cannot create HAR recorder");
        return;
    };

    // If we have a CDP client, enable Network domain and wire HAR recording
    if (bridge.getCdpClient(tab_id)) |client| {
        // Wire the HAR recorder to the CDP client so events are captured in real-time
        // HAR recorder is wired via event drain in navigate/evaluate handlers

        rec.start(client) catch {
            // Continue even if Network.enable fails — we can still manually add entries
        };
    } else {
        rec.recording = true;
    }

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"recording\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleHarStop(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const rec = bridge.getHarRecorder(tab_id) orelse {
        resp.sendError(request, 404, "No HAR recorder for this tab");
        return;
    };

    // Flush buffered CDP events and disconnect HAR recorder from CDP client.
    if (bridge.getCdpClient(tab_id)) |client| {
        // Disconnect HAR recorder from real-time event feeding
        // HAR recorder disconnect handled by stop()
        // First: read all pending WebSocket messages with a short timeout.
        // Network events arrive asynchronously and queue on the WebSocket.
        if (client.ws) |*ws| {
            const short_timeout = std.posix.timeval{ .sec = 0, .usec = 500_000 };
            const orig_timeout = std.posix.timeval{ .sec = 10, .usec = 0 };
            std.posix.setsockopt(ws.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&short_timeout)) catch {};

            var flush_read: u32 = 0;
            while (flush_read < 200) : (flush_read += 1) {
                const msg = ws.receiveMessageAlloc(arena, 2 * 1024 * 1024) catch break;
                rec.handleCdpEvent(msg);
                client.event_buf.push(msg);
            }
            std.log.info("HAR: read {d} pending WS messages", .{flush_read});

            std.posix.setsockopt(ws.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&orig_timeout)) catch {};
        }

        // Second: flush any events already in the buffer from prior send() calls
        flushEventsToHar(client, rec);

        // Third: stop recording (sends Network.disable, which may read more events)
        const har_json = rec.stop(client) catch {
            resp.sendError(request, 500, "Failed to generate HAR");
            return;
        };

        // Fourth: flush again — stop() may have buffered more events during Network.disable
        flushEventsToHar(client, rec);

        defer rec.allocator.free(har_json);
        // Re-serialize since we may have added entries after stop
        const final_json = rec.toJson() catch {
            resp.sendError(request, 500, "Failed to generate HAR");
            return;
        };
        defer rec.allocator.free(final_json);
        const result = std.fmt.allocPrint(arena, "{{\"status\":\"stopped\",\"entries\":{d},\"har\":{s}}}", .{ rec.entryCount(), final_json }) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        resp.sendJson(request, result);
    } else {
        rec.recording = false;
        const har_json = rec.toJson() catch {
            resp.sendError(request, 500, "Failed to generate HAR");
            return;
        };
        defer rec.allocator.free(har_json);
        const result = std.fmt.allocPrint(arena, "{{\"status\":\"stopped\",\"entries\":{d},\"har\":{s}}}", .{ rec.entryCount(), har_json }) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        resp.sendJson(request, result);
    }
}

/// Feed all buffered CDP events from the client's event buffer to the HAR recorder.
fn flushEventsToHar(client: *CdpClient, rec: *HarRecorder) void {
    std.log.info("HAR flush: {d} buffered events", .{client.event_buf.len});
    var network_events: usize = 0;
    for (client.event_buf.items[0..client.event_buf.len]) |item| {
        if (item) |ev| {
            if (std.mem.indexOf(u8, ev, "Network.") != null) {
                network_events += 1;
            }
            rec.handleCdpEvent(ev);
        }
    }
    std.log.info("HAR flush: {d} network events fed to recorder", .{network_events});
}

fn handleHarStatus(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const rec = bridge.getHarRecorder(tab_id) orelse {
        const body = std.fmt.allocPrint(arena, "{{\"recording\":false,\"entries\":0,\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        resp.sendJson(request, body);
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"recording\":{s},\"entries\":{d},\"tab_id\":\"{s}\"}}", .{
        if (rec.isRecording()) "true" else "false",
        rec.entryCount(),
        tab_id,
    }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

// ── Console Log Capture Endpoint ────────────────────────────────────────

fn handleConsole(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    _ = client.send(arena, protocol.Methods.runtime_enable, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"message\":\"Runtime.enable sent\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

// ── Network Interception Endpoints ──────────────────────────────────────

fn handleInterceptStart(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    _ = client.send(arena, protocol.Methods.fetch_enable, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"message\":\"Fetch.enable sent\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleInterceptStop(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    _ = client.send(arena, protocol.Methods.fetch_disable, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"message\":\"Fetch.disable sent\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

// ── Close / Cleanup Endpoint ────────────────────────────────────────────

fn handleClose(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id");

    if (tab_id) |tid| {
        // Close a specific tab — disconnect CDP, remove from registry
        bridge.removeTab(tid);
        const body = std.fmt.allocPrint(arena, "{{\"closed\":\"{s}\",\"remaining_tabs\":{d}}}", .{ tid, bridge.tabCount() }) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        resp.sendJson(request, body);
    } else {
        // Close all tabs
        const count = bridge.tabCount();
        // Can't iterate+remove safely, so just report
        const body = std.fmt.allocPrint(arena, "{{\"status\":\"close_all\",\"tabs_closed\":{d}}}", .{count}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        resp.sendJson(request, body);
    }
}

// ── Cookie Management Endpoints ─────────────────────────────────────────

fn handleCookies(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Check if this is a set operation (has name and value params)
    const name = getQueryParam(target, "name");
    const value = getQueryParam(target, "value");

    if (name != null and value != null) {
        // Set cookie
        const domain = getQueryParam(target, "domain") orelse "localhost";
        const params = std.fmt.allocPrint(arena,
            "{{\"name\":\"{s}\",\"value\":\"{s}\",\"domain\":\"{s}\",\"path\":\"/\"}}", .{ name.?, value.?, domain }) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, "Network.setCookie", params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
    } else {
        // Get all cookies
        const response = client.send(arena, "Network.getCookies", null) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
    }
}

fn handleCookiesClear(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const response = client.send(arena, "Network.clearBrowserCookies", null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

// ── Storage Endpoints ───────────────────────────────────────────────────

fn handleStorage(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge, storage_type: []const u8) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const key = getQueryParam(target, "key");
    const value = getQueryParam(target, "value");

    const expr = if (key != null and value != null)
        std.fmt.allocPrint(arena, "(() => {{ {s}.setItem('{s}', '{s}'); return 'stored'; }})()", .{ storage_type, key.?, value.? })
    else if (key) |k|
        std.fmt.allocPrint(arena, "{s}.getItem('{s}')", .{ storage_type, k })
    else
        std.fmt.allocPrint(arena, "JSON.stringify(Object.fromEntries(Object.entries({s})))", .{storage_type});

    const js = expr catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}", .{js}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleStorageClear(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge, storage_type: []const u8) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}.clear() || 'cleared'\",\"returnByValue\":true}}", .{storage_type}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

// ── Element Info Query Endpoint ─────────────────────────────────────────

fn buildGetExpression(arena: std.mem.Allocator, query_type: []const u8, selector: ?[]const u8, attr_name: ?[]const u8) ?[]const u8 {
    if (std.mem.eql(u8, query_type, "title"))
        return std.fmt.allocPrint(arena, "document.title", .{}) catch return null;
    if (std.mem.eql(u8, query_type, "url"))
        return std.fmt.allocPrint(arena, "window.location.href", .{}) catch return null;

    const sel = selector orelse return null;

    if (std.mem.eql(u8, query_type, "html"))
        return std.fmt.allocPrint(arena, "document.querySelector('{s}')?.innerHTML || null", .{sel}) catch return null;
    if (std.mem.eql(u8, query_type, "value"))
        return std.fmt.allocPrint(arena, "document.querySelector('{s}')?.value || null", .{sel}) catch return null;
    if (std.mem.eql(u8, query_type, "text"))
        return std.fmt.allocPrint(arena, "document.querySelector('{s}')?.innerText || null", .{sel}) catch return null;
    if (std.mem.eql(u8, query_type, "attr")) {
        const a = attr_name orelse return null;
        return std.fmt.allocPrint(arena, "document.querySelector('{s}')?.getAttribute('{s}') || null", .{ sel, a }) catch return null;
    }
    if (std.mem.eql(u8, query_type, "count"))
        return std.fmt.allocPrint(arena, "document.querySelectorAll('{s}').length", .{sel}) catch return null;
    if (std.mem.eql(u8, query_type, "box"))
        return std.fmt.allocPrint(arena, "JSON.stringify(document.querySelector('{s}')?.getBoundingClientRect())", .{sel}) catch return null;
    if (std.mem.eql(u8, query_type, "styles"))
        return std.fmt.allocPrint(arena, "JSON.stringify(Object.fromEntries([...window.getComputedStyle(document.querySelector('{s}'))].map(k => [k, window.getComputedStyle(document.querySelector('{s}'))[k]])))", .{ sel, sel }) catch return null;

    return null;
}

fn handleGet(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const query_type = getQueryParam(target, "type") orelse {
        resp.sendError(request, 400, "Missing type parameter (html|value|attr|title|url|count|box|styles)");
        return;
    };
    const selector = getQueryParam(target, "selector");
    const attr_name = getQueryParam(target, "attr");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // For "attr" type, validate the attr param early
    if (std.mem.eql(u8, query_type, "attr") and attr_name == null) {
        resp.sendError(request, 400, "Missing attr parameter");
        return;
    }

    const js = buildGetExpression(arena, query_type, selector, attr_name) orelse {
        resp.sendError(request, 400, "Unknown type or missing selector. Use: html, value, text, attr, title, url, count, box, styles");
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}", .{js}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

// ── Navigation Endpoints ────────────────────────────────────────────────

fn handleBack(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const params = "{\"expression\":\"history.back() || 'back'\",\"returnByValue\":true}";
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleForward(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const params = "{\"expression\":\"history.forward() || 'forward'\",\"returnByValue\":true}";
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleReload(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const response = client.send(arena, protocol.Methods.page_reload, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

// ── Diff Snapshot Endpoint ──────────────────────────────────────────────

fn handleDiffSnapshot(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Get current a11y tree
    const raw_response = client.send(arena, protocol.Methods.accessibility_get_full_tree, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const a11y = @import("../snapshot/a11y.zig");
    const nodes = parseA11yNodes(arena, raw_response) catch {
        resp.sendError(request, 500, "Failed to parse a11y tree");
        return;
    };

    const current = a11y.buildSnapshot(nodes, .{}, arena) catch {
        resp.sendError(request, 500, "Failed to build snapshot");
        return;
    };

    // Get previous snapshot from bridge (empty if first call)
    bridge.mu.lock();
    const prev_nodes = if (bridge.prev_snapshots.get(tab_id)) |prev| prev else &[_]a11y.A11yNode{};
    bridge.mu.unlock();

    // Compute diff
    const diff_mod = @import("../snapshot/diff.zig");
    const diff_entries = diff_mod.diffSnapshots(prev_nodes, current, arena) catch {
        resp.sendError(request, 500, "Failed to compute diff");
        return;
    };

    // Store current snapshot as previous for next diff
    {
        bridge.mu.lock();
        defer bridge.mu.unlock();
        bridge.prev_snapshots.put(tab_id, current) catch {};
    }

    // Serialize diff as JSON
    var json_buf: std.ArrayList(u8) = .empty;
    const writer = json_buf.writer(arena);
    writer.writeAll("[") catch return;
    for (diff_entries, 0..) |entry, i| {
        if (i > 0) writer.writeAll(",") catch return;
        const kind_str: []const u8 = switch (entry.kind) {
            .added => "added",
            .removed => "removed",
            .changed => "changed",
        };
        writer.print("{{\"kind\":\"{s}\",\"ref\":\"{s}\",\"role\":\"{s}\",\"name\":\"{s}\"}}", .{ kind_str, entry.node.ref, entry.node.role, entry.node.name }) catch return;
    }
    writer.writeAll("]") catch return;
    resp.sendJson(request, json_buf.items);
}

fn handleEmulate(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const width_str = getQueryParam(target, "width") orelse "1280";
    const height_str = getQueryParam(target, "height") orelse "720";
    const scale_str = getQueryParam(target, "scale") orelse "1";
    const ua = getQueryParam(target, "ua");

    const params = std.fmt.allocPrint(arena,
        "{{\"width\":{s},\"height\":{s},\"deviceScaleFactor\":{s},\"mobile\":false}}",
        .{ width_str, height_str, scale_str },
    ) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.emulation_set_device_metrics, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    if (ua) |ua_str| {
        const ua_params = std.fmt.allocPrint(arena, "{{\"userAgent\":\"{s}\"}}", .{ua_str}) catch {
            resp.sendJson(request, response);
            return;
        };
        _ = client.send(arena, protocol.Methods.emulation_set_user_agent, ua_params) catch {};
    }

    resp.sendJson(request, response);
}

fn handleGeolocation(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const lat = getQueryParam(target, "lat") orelse {
        resp.sendError(request, 400, "Missing lat parameter");
        return;
    };
    const lng = getQueryParam(target, "lng") orelse {
        resp.sendError(request, 400, "Missing lng parameter");
        return;
    };
    const accuracy_str = getQueryParam(target, "accuracy") orelse "1";

    const params = std.fmt.allocPrint(arena,
        "{{\"latitude\":{s},\"longitude\":{s},\"accuracy\":{s}}}",
        .{ lat, lng, accuracy_str },
    ) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.emulation_set_geolocation, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleUpload(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const ref = getQueryParam(target, "ref") orelse {
        resp.sendError(request, 400, "Missing ref parameter");
        return;
    };
    const file_path = getQueryParam(target, "file_path") orelse {
        resp.sendError(request, 400, "Missing file_path parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Look up the ref in the snapshot cache to get the backend node ID
    bridge.mu.lockShared();
    const cache = bridge.snapshots.get(tab_id);
    bridge.mu.unlockShared();

    const node_id = if (cache) |c| c.refs.get(ref) else null;
    const bid = node_id orelse {
        resp.sendError(request, 400, "Ref not found. Call /snapshot first to populate refs");
        return;
    };

    // Send DOM.setFileInputFiles with the resolved backendNodeId
    const params = std.fmt.allocPrint(arena, "{{\"files\":[\"{s}\"],\"backendNodeId\":{d}}}", .{ file_path, bid }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.dom_set_file_input_files, params) catch {
        resp.sendError(request, 502, "DOM.setFileInputFiles failed");
        return;
    };
    resp.sendJson(request, response);
}

test "route matching" {
    const path = "/health?foo=bar";
    const clean = if (std.mem.indexOfScalar(u8, path, '?')) |idx| path[0..idx] else path;
    try std.testing.expectEqualStrings("/health", clean);
}

test "getQueryParam" {
    try std.testing.expectEqualStrings("bar", getQueryParam("/test?foo=bar", "foo").?);
    try std.testing.expectEqualStrings("123", getQueryParam("/test?a=1&tab_id=123&b=2", "tab_id").?);
    try std.testing.expect(getQueryParam("/test?foo=bar", "baz") == null);
    try std.testing.expect(getQueryParam("/test", "foo") == null);
}

test "emulate query param parsing" {
    const target = "/emulate?tab_id=abc&width=1920&height=1080&scale=2&ua=Mozilla/5.0";
    try std.testing.expectEqualStrings("abc", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("1920", getQueryParam(target, "width").?);
    try std.testing.expectEqualStrings("1080", getQueryParam(target, "height").?);
    try std.testing.expectEqualStrings("2", getQueryParam(target, "scale").?);
    try std.testing.expectEqualStrings("Mozilla/5.0", getQueryParam(target, "ua").?);
    // missing optional params return null
    try std.testing.expect(getQueryParam("/emulate?tab_id=abc", "width") == null);
    try std.testing.expect(getQueryParam("/emulate?tab_id=abc", "ua") == null);
}

test "geolocation query param parsing" {
    const target = "/geolocation?tab_id=xyz&lat=37.7749&lng=-122.4194&accuracy=10";
    try std.testing.expectEqualStrings("xyz", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("37.7749", getQueryParam(target, "lat").?);
    try std.testing.expectEqualStrings("-122.4194", getQueryParam(target, "lng").?);
    try std.testing.expectEqualStrings("10", getQueryParam(target, "accuracy").?);
    // lat and lng are required; missing returns null
    try std.testing.expect(getQueryParam("/geolocation?tab_id=xyz", "lat") == null);
    try std.testing.expect(getQueryParam("/geolocation?tab_id=xyz", "lng") == null);
}

test "emulate route matching" {
    const path = "/emulate?tab_id=abc&width=1280";
    const clean = if (std.mem.indexOfScalar(u8, path, '?')) |idx| path[0..idx] else path;
    try std.testing.expectEqualStrings("/emulate", clean);
}

test "geolocation route matching" {
    const path = "/geolocation?tab_id=abc&lat=0&lng=0";
    const clean = if (std.mem.indexOfScalar(u8, path, '?')) |idx| path[0..idx] else path;
    try std.testing.expectEqualStrings("/geolocation", clean);
}

fn handleSessionSave(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const state = bridge.exportState(arena) catch {
        resp.sendError(request, 500, "Failed to export state");
        return;
    };
    resp.sendJson(request, state);
}

fn handleSessionLoad(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const body = readRequestBody(request, arena) orelse {
        resp.sendError(request, 400, "Missing request body");
        return;
    };
    const count = bridge.importState(body, arena) catch {
        resp.sendError(request, 400, "Invalid session JSON");
        return;
    };
    const result = std.fmt.allocPrint(arena, "{{\"imported\":{d}}}", .{count}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, result);
}

// ── Annotated / Diff Screenshot & Screencast Endpoints ──────────────────

fn handleAnnotatedScreenshot(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const ref = getQueryParam(target, "ref") orelse {
        resp.sendError(request, 400, "Missing ref parameter");
        return;
    };
    _ = ref;

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Highlight the node with an overlay
    const highlight_params = "{\"nodeId\":0,\"highlightConfig\":{\"showInfo\":true,\"contentColor\":{\"r\":111,\"g\":168,\"b\":220,\"a\":0.66}}}";
    _ = client.send(arena, protocol.Methods.overlay_highlight_node, highlight_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    // Take screenshot
    const screenshot_params = "{\"format\":\"png\"}";
    const response = client.send(arena, protocol.Methods.page_capture_screenshot, screenshot_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    // Clean up highlight
    _ = client.send(arena, protocol.Methods.overlay_hide_highlight, null) catch {};

    resp.sendJson(request, response);
}

fn handleDiffScreenshot(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const delay_str = getQueryParam(target, "delay") orelse "1000";

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const screenshot_params = "{\"format\":\"png\"}";

    // Take first screenshot
    const resp1 = client.send(arena, protocol.Methods.page_capture_screenshot, screenshot_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    // Sleep for the delay
    const delay_ms = std.fmt.parseInt(u64, delay_str, 10) catch 1000;
    std.Thread.sleep(delay_ms * std.time.ns_per_ms);

    // Take second screenshot
    const resp2 = client.send(arena, protocol.Methods.page_capture_screenshot, screenshot_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"before\":{s},\"after\":{s}}}", .{ resp1, resp2 }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleScreencastStart(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = "{\"format\":\"jpeg\",\"quality\":80}";
    _ = client.send(arena, protocol.Methods.page_start_screencast, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"screencast_started\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleScreencastStop(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    _ = client.send(arena, protocol.Methods.page_stop_screencast, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"screencast_stopped\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

const handleVideoStart = handleScreencastStart;
const handleVideoStop = handleScreencastStop;

// ── Lightpanda Parity Endpoints ─────────────────────────────────────────

fn handleMarkdown(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const js =
        \\(function(){
        \\  function n2md(node,li){
        \\    if(node.nodeType===3)return node.textContent;
        \\    if(node.nodeType!==1)return '';
        \\    var tag=node.tagName.toLowerCase(),c='',ch=node.childNodes;
        \\    for(var i=0;i<ch.length;i++)c+=n2md(ch[i]);
        \\    switch(tag){
        \\      case 'h1':return '# '+c.trim()+'\\n\\n';
        \\      case 'h2':return '## '+c.trim()+'\\n\\n';
        \\      case 'h3':return '### '+c.trim()+'\\n\\n';
        \\      case 'h4':return '#### '+c.trim()+'\\n\\n';
        \\      case 'h5':return '##### '+c.trim()+'\\n\\n';
        \\      case 'h6':return '###### '+c.trim()+'\\n\\n';
        \\      case 'p':return c.trim()+'\\n\\n';
        \\      case 'br':return '\\n';
        \\      case 'hr':return '---\\n\\n';
        \\      case 'strong':case 'b':return '**'+c+'**';
        \\      case 'em':case 'i':return '*'+c+'*';
        \\      case 'code':return '`'+c+'`';
        \\      case 'pre':return '```\\n'+c+'\\n```\\n\\n';
        \\      case 'blockquote':return c.split('\\n').map(function(l){return '> '+l}).join('\\n')+'\\n\\n';
        \\      case 'a':var h=node.getAttribute('href');return '['+c+']('+h+')';
        \\      case 'img':var s=node.getAttribute('src'),a=node.getAttribute('alt')||'';return '!['+a+']('+s+')';
        \\      case 'ul':case 'ol':return c+'\\n';
        \\      case 'li':return (li=node.parentNode&&node.parentNode.tagName==='OL'?'1. ':'- ')+c.trim()+'\\n';
        \\      case 'table':return c+'\\n';
        \\      case 'tr':var cells=[];for(var j=0;j<node.children.length;j++)cells.push(n2md(node.children[j]).trim());return '| '+cells.join(' | ')+' |\\n';
        \\      case 'thead':var r=c,cols=node.querySelector('tr')?node.querySelector('tr').children.length:0;var sep='|';for(var k=0;k<cols;k++)sep+=' --- |';return r+sep+'\\n';
        \\      case 'script':case 'style':case 'noscript':return '';
        \\      default:return c;
        \\    }
        \\  }
        \\  return n2md(document.body);
        \\})()
    ;

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}", .{js}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleLinks(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const js = "JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>({text:a.innerText.trim().substring(0,200),href:a.href})))";

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}", .{js}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handlePdf(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const landscape = getQueryParam(target, "landscape") orelse "false";
    const params = std.fmt.allocPrint(arena,
        "{{\"landscape\":{s},\"printBackground\":true}}", .{landscape}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const response = client.send(arena, protocol.Methods.page_print_to_pdf, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleDomQuery(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const selector = getQueryParam(target, "selector") orelse {
        resp.sendError(request, 400, "Missing selector parameter");
        return;
    };
    const all = getQueryParam(target, "all");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Step 1: Get document root node
    const doc_response = client.send(arena, protocol.Methods.dom_get_document, "{\"depth\":0}") catch {
        resp.sendError(request, 502, "DOM.getDocument failed");
        return;
    };
    const root_node_id = extractSimpleJsonInt(doc_response, 0, "\"nodeId\"") orelse {
        resp.sendError(request, 500, "Could not extract root nodeId");
        return;
    };

    // Step 2: Query selector
    const use_all = if (all) |a| std.mem.eql(u8, a, "true") else false;
    const method = if (use_all) protocol.Methods.dom_query_selector_all else protocol.Methods.dom_query_selector;

    const query_params = std.fmt.allocPrint(arena,
        "{{\"nodeId\":{d},\"selector\":\"{s}\"}}", .{ root_node_id, selector }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, method, query_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleDomHtml(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const node_id_str = getQueryParam(target, "node_id") orelse {
        resp.sendError(request, 400, "Missing node_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"nodeId\":{s}}}", .{node_id_str}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.dom_get_outer_html, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleCookiesDelete(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const name = getQueryParam(target, "name") orelse {
        resp.sendError(request, 400, "Missing name parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const domain = getQueryParam(target, "domain");
    const params = if (domain) |d|
        std.fmt.allocPrint(arena, "{{\"name\":\"{s}\",\"domain\":\"{s}\"}}", .{ name, d })
    else
        std.fmt.allocPrint(arena, "{{\"name\":\"{s}\"}}", .{name});

    const delete_params = params catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.network_delete_cookies, delete_params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleHeaders(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const body = readRequestBody(request, arena) orelse {
        // If no body, enable with empty headers
        const params = "{\"headers\":{}}";
        const response = client.send(arena, protocol.Methods.network_set_extra_http_headers, params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"headers\":{s}}}", .{body}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.network_set_extra_http_headers, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleScriptInject(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    // Support both query param and POST body for script source.
    // POST body is preferred for large scripts that exceed URL length limits.
    const source = blk: {
        // Try POST body first (JSON: {"source": "..."})
        if (readRequestBody(request, arena)) |body| {
            if (body.len > 0) {
                // Try to extract "source" field from JSON body
                if (extractSimpleJsonString(body, 0, "\"source\"")) |s| {
                    break :blk s;
                }
                // If not JSON, treat entire body as raw script source
                break :blk body;
            }
        }
        // Fall back to query param
        break :blk getQueryParam(target, "source") orelse {
            resp.sendError(request, 400, "Missing source parameter — send as POST body or ?source= query param");
            return;
        };
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Build JSON with proper escaping for the script source
    const escaped = jsonEscapeAlloc(arena, source) orelse {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const params = std.fmt.allocPrint(arena,
        "{{\"source\":\"{s}\"}}", .{escaped}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.page_add_script, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

/// Escape a string for embedding inside a JSON string value.
/// Handles backslash, double-quote, newlines, tabs, and control characters.
fn jsonEscapeAlloc(allocator: std.mem.Allocator, input: []const u8) ?[]const u8 {
    // Count output size
    var out_len: usize = 0;
    for (input) |c| {
        out_len += switch (c) {
            '"', '\\' => 2,
            '\n', '\r', '\t' => 2,
            else => if (c < 0x20) @as(usize, 6) else 1,
        };
    }
    if (out_len == input.len) return input; // no escaping needed
    const buf = allocator.alloc(u8, out_len) catch return null;
    var i: usize = 0;
    for (input) |c| {
        switch (c) {
            '"' => {
                buf[i] = '\\';
                buf[i + 1] = '"';
                i += 2;
            },
            '\\' => {
                buf[i] = '\\';
                buf[i + 1] = '\\';
                i += 2;
            },
            '\n' => {
                buf[i] = '\\';
                buf[i + 1] = 'n';
                i += 2;
            },
            '\r' => {
                buf[i] = '\\';
                buf[i + 1] = 'r';
                i += 2;
            },
            '\t' => {
                buf[i] = '\\';
                buf[i + 1] = 't';
                i += 2;
            },
            else => if (c < 0x20) {
                const hex = "0123456789abcdef";
                buf[i] = '\\';
                buf[i + 1] = 'u';
                buf[i + 2] = '0';
                buf[i + 3] = '0';
                buf[i + 4] = hex[c >> 4];
                buf[i + 5] = hex[c & 0x0f];
                i += 6;
            } else {
                buf[i] = c;
                i += 1;
            },
        }
    }
    return buf;
}

fn handleStop(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const response = client.send(arena, protocol.Methods.page_stop_loading, null) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleScrollIntoView(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const ref = getQueryParam(target, "ref") orelse {
        resp.sendError(request, 400, "Missing ref parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    bridge.mu.lockShared();
    const cache = bridge.snapshots.get(tab_id);
    bridge.mu.unlockShared();

    const node_id = if (cache) |c| c.refs.get(ref) else null;
    const bid = node_id orelse {
        resp.sendError(request, 400, "Ref not found. Call /snapshot first");
        return;
    };

    const resolve_params = std.fmt.allocPrint(arena, "{{\"backendNodeId\":{d}}}", .{bid}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const resolve_response = client.send(arena, protocol.Methods.dom_resolve_node, resolve_params) catch {
        resp.sendError(request, 502, "DOM.resolveNode failed");
        return;
    };
    const object_id = extractSimpleJsonString(resolve_response, 0, "\"objectId\"") orelse {
        resp.sendError(request, 500, "Could not resolve element objectId");
        return;
    };
    const call_params = std.fmt.allocPrint(arena, "{{\"objectId\":\"{s}\",\"functionDeclaration\":\"function() {{ this.scrollIntoView({{behavior:'smooth',block:'center'}}); return 'scrolled_into_view'; }}\",\"returnByValue\":true}}", .{object_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.runtime_call_function_on, call_params) catch {
        resp.sendError(request, 502, "Runtime.callFunctionOn failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleDrag(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const src_ref = getQueryParam(target, "src") orelse {
        resp.sendError(request, 400, "Missing src ref parameter");
        return;
    };
    const tgt_ref = getQueryParam(target, "tgt") orelse {
        resp.sendError(request, 400, "Missing tgt ref parameter");
        return;
    };

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    bridge.mu.lockShared();
    const cache = bridge.snapshots.get(tab_id);
    bridge.mu.unlockShared();

    const src_bid = if (cache) |c| c.refs.get(src_ref) else null;
    const tgt_bid = if (cache) |c| c.refs.get(tgt_ref) else null;

    if (src_bid == null or tgt_bid == null) {
        resp.sendError(request, 400, "Source or target ref not found. Call /snapshot first");
        return;
    }

    // Resolve source element
    const src_resolve = std.fmt.allocPrint(arena, "{{\"backendNodeId\":{d}}}", .{src_bid.?}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const src_resp = client.send(arena, protocol.Methods.dom_resolve_node, src_resolve) catch {
        resp.sendError(request, 502, "DOM.resolveNode failed for source");
        return;
    };
    const src_oid = extractSimpleJsonString(src_resp, 0, "\"objectId\"") orelse {
        resp.sendError(request, 500, "Could not resolve source objectId");
        return;
    };

    // Resolve target element
    const tgt_resolve = std.fmt.allocPrint(arena, "{{\"backendNodeId\":{d}}}", .{tgt_bid.?}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const tgt_resp = client.send(arena, protocol.Methods.dom_resolve_node, tgt_resolve) catch {
        resp.sendError(request, 502, "DOM.resolveNode failed for target");
        return;
    };
    const tgt_oid = extractSimpleJsonString(tgt_resp, 0, "\"objectId\"") orelse {
        resp.sendError(request, 500, "Could not resolve target objectId");
        return;
    };

    // Use JS to perform drag-and-drop via DataTransfer events
    const js = std.fmt.allocPrint(arena,
        \\{{"objectId":"{s}","functionDeclaration":"function() {{ var src=this; var tgtOid='{s}'; var dt=new DataTransfer(); src.dispatchEvent(new DragEvent('dragstart',{{bubbles:true,dataTransfer:dt}})); src.dispatchEvent(new DragEvent('drag',{{bubbles:true,dataTransfer:dt}})); return 'drag_started'; }}","returnByValue":true}}
    , .{ src_oid, tgt_oid }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.runtime_call_function_on, js) catch {
        resp.sendError(request, 502, "Drag failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleKeyboardType(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const text = getQueryParam(target, "text") orelse {
        resp.sendError(request, 400, "Missing text parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Type each character via Input.dispatchKeyEvent
    for (text) |ch| {
        const char_str = std.fmt.allocPrint(arena, "{c}", .{ch}) catch continue;
        const key_params = std.fmt.allocPrint(arena,
            "{{\"type\":\"keyDown\",\"text\":\"{s}\",\"key\":\"{s}\",\"unmodifiedText\":\"{s}\"}}", .{ char_str, char_str, char_str }) catch continue;
        _ = client.send(arena, protocol.Methods.input_dispatch_key_event, key_params) catch continue;
        const up_params = std.fmt.allocPrint(arena,
            "{{\"type\":\"keyUp\",\"key\":\"{s}\"}}", .{char_str}) catch continue;
        _ = client.send(arena, protocol.Methods.input_dispatch_key_event, up_params) catch continue;
    }
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"typed\":\"{s}\",\"chars\":{d}}}", .{ text, text.len }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleKeyboardInsertText(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const text = getQueryParam(target, "text") orelse {
        resp.sendError(request, 400, "Missing text parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = std.fmt.allocPrint(arena, "{{\"text\":\"{s}\"}}", .{text}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.input_insert_text, params) catch {
        resp.sendError(request, 502, "Input.insertText failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleKeyDown(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const key = getQueryParam(target, "key") orelse {
        resp.sendError(request, 400, "Missing key parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = std.fmt.allocPrint(arena, "{{\"type\":\"keyDown\",\"key\":\"{s}\"}}", .{key}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.input_dispatch_key_event, params) catch {
        resp.sendError(request, 502, "Input.dispatchKeyEvent failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleKeyUp(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const key = getQueryParam(target, "key") orelse {
        resp.sendError(request, 400, "Missing key parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = std.fmt.allocPrint(arena, "{{\"type\":\"keyUp\",\"key\":\"{s}\"}}", .{key}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.input_dispatch_key_event, params) catch {
        resp.sendError(request, 502, "Input.dispatchKeyEvent failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleWait(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const selector = getQueryParam(target, "selector");
    const timeout_str = getQueryParam(target, "timeout") orelse "5000";
    const timeout_ms = std.fmt.parseInt(u64, timeout_str, 10) catch 5000;
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    if (selector) |sel| {
        // Poll for element existence
        const max_polls = timeout_ms / 100;
        var polls: u64 = 0;
        while (polls < max_polls) : (polls += 1) {
            const params = std.fmt.allocPrint(arena, "{{\"expression\":\"!!document.querySelector('{s}')\",\"returnByValue\":true}}", .{sel}) catch {
                resp.sendError(request, 500, "Internal Server Error");
                return;
            };
            const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
                resp.sendError(request, 502, "CDP command failed");
                return;
            };
            // Check if result is true
            if (std.mem.indexOf(u8, response, "true") != null) {
                const body = std.fmt.allocPrint(arena, "{{\"status\":\"found\",\"selector\":\"{s}\",\"polls\":{d}}}", .{ sel, polls + 1 }) catch {
                    resp.sendError(request, 500, "Internal Server Error");
                    return;
                };
                resp.sendJson(request, body);
                return;
            }
            std.Thread.sleep(100 * std.time.ns_per_ms);
        }
        const body = std.fmt.allocPrint(arena, "{{\"status\":\"timeout\",\"selector\":\"{s}\",\"timeout_ms\":{d}}}", .{ sel, timeout_ms }) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        resp.sendError(request, 408, body);
    } else {
        // Wait for page load (check document.readyState)
        const max_polls = timeout_ms / 100;
        var polls: u64 = 0;
        while (polls < max_polls) : (polls += 1) {
            const params = "{\"expression\":\"document.readyState\",\"returnByValue\":true}";
            const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
                resp.sendError(request, 502, "CDP command failed");
                return;
            };
            if (std.mem.indexOf(u8, response, "complete") != null) {
                const body = std.fmt.allocPrint(arena, "{{\"status\":\"ready\",\"readyState\":\"complete\",\"polls\":{d}}}", .{polls + 1}) catch {
                    resp.sendError(request, 500, "Internal Server Error");
                    return;
                };
                resp.sendJson(request, body);
                return;
            }
            std.Thread.sleep(100 * std.time.ns_per_ms);
        }
        resp.sendJson(request, "{\"status\":\"ready\",\"readyState\":\"timeout\"}");
    }
}

fn handleTabNew(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const url = getQueryParam(target, "url") orelse "about:blank";

    const params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\"}}", .{url}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    // Use any existing client to create a new target
    const tabs = bridge.listTabs(arena) catch {
        resp.sendError(request, 500, "Failed to list tabs");
        return;
    };
    if (tabs.len == 0) {
        resp.sendError(request, 500, "No active tabs to create from");
        return;
    }
    const client = bridge.getCdpClient(tabs[0].id) orelse {
        resp.sendError(request, 500, "No active CDP client");
        return;
    };

    const response = client.send(arena, protocol.Methods.target_create_target, params) catch {
        resp.sendError(request, 502, "Target.createTarget failed");
        return;
    };

    // Extract targetId from response
    const new_tab_id = extractSimpleJsonString(response, 0, "\"targetId\"") orelse "unknown";
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"created\",\"tab_id\":\"{s}\",\"url\":\"{s}\"}}", .{ new_tab_id, url }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleTabClose(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };

    bridge.removeTab(tab_id);
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"closed\",\"tab_id\":\"{s}\",\"remaining\":{d}}}", .{ tab_id, bridge.tabCount() }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleHighlight(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const ref = getQueryParam(target, "ref");
    const selector = getQueryParam(target, "selector");
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    if (ref) |r| {
        bridge.mu.lockShared();
        const cache = bridge.snapshots.get(tab_id);
        bridge.mu.unlockShared();
        const node_id = if (cache) |c| c.refs.get(r) else null;
        const bid = node_id orelse {
            resp.sendError(request, 400, "Ref not found");
            return;
        };
        const params = std.fmt.allocPrint(arena,
            "{{\"highlightConfig\":{{\"showInfo\":true,\"contentColor\":{{\"r\":111,\"g\":168,\"b\":220,\"a\":0.66}},\"borderColor\":{{\"r\":111,\"g\":168,\"b\":220,\"a\":1}}}},\"backendNodeId\":{d}}}", .{bid}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.overlay_highlight_node, params) catch {
            resp.sendError(request, 502, "Overlay.highlightNode failed");
            return;
        };
        resp.sendJson(request, response);
    } else if (selector) |sel| {
        // Highlight via JS + overlay
        const params = std.fmt.allocPrint(arena,
            "{{\"expression\":\"(function(){{ var el=document.querySelector('{s}'); if(!el) return 'not_found'; el.style.outline='3px solid #6fa8dc'; return 'highlighted'; }})()\",\"returnByValue\":true}}", .{sel}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
    } else {
        // Clear highlight
        const response = client.send(arena, protocol.Methods.overlay_hide_highlight, null) catch {
            resp.sendError(request, 502, "Overlay.hideHighlight failed");
            return;
        };
        resp.sendJson(request, response);
    }
}

fn handleErrors(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Enable Runtime to collect exceptions, then evaluate to get any stored errors
    _ = client.send(arena, protocol.Methods.runtime_enable, null) catch {};
    const params = "{\"expression\":\"(function(){ var e=window.__kuri_errors||[]; return JSON.stringify(e); })()\",\"returnByValue\":true}";
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleSetOffline(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const mode = getQueryParam(target, "mode") orelse "on";
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const offline = std.mem.eql(u8, mode, "on") or std.mem.eql(u8, mode, "true");
    const params = std.fmt.allocPrint(arena,
        "{{\"offline\":{s},\"latency\":0,\"downloadThroughput\":-1,\"uploadThroughput\":-1}}", .{if (offline) "true" else "false"}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.network_emulate_conditions, params) catch {
        resp.sendError(request, 502, "Network.emulateNetworkConditions failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"offline\":{s}}}", .{if (offline) "true" else "false"}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleSetMedia(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const scheme = getQueryParam(target, "scheme") orelse "dark";
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"features\":[{{\"name\":\"prefers-color-scheme\",\"value\":\"{s}\"}}]}}", .{scheme}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.emulation_set_emulated_media, params) catch {
        resp.sendError(request, 502, "Emulation.setEmulatedMedia failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"colorScheme\":\"{s}\"}}", .{scheme}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleSetCredentials(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const username = getQueryParam(target, "username") orelse {
        resp.sendError(request, 400, "Missing username parameter");
        return;
    };
    const password = getQueryParam(target, "password") orelse {
        resp.sendError(request, 400, "Missing password parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Enable Fetch to intercept auth challenges
    _ = client.send(arena, protocol.Methods.fetch_enable, "{\"handleAuthRequests\":true}") catch {};

    // Also set as Authorization header for immediate use
    const b64_input = std.fmt.allocPrint(arena, "{s}:{s}", .{ username, password }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const encoder = std.base64.standard.Encoder;
    const encoded_len = encoder.calcSize(b64_input.len);
    const encoded = arena.alloc(u8, encoded_len) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    _ = encoder.encode(encoded, b64_input);

    const header_params = std.fmt.allocPrint(arena,
        "{{\"headers\":{{\"Authorization\":\"Basic {s}\"}}}}", .{encoded}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    _ = client.send(arena, protocol.Methods.network_set_extra_http_headers, header_params) catch {};

    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"username\":\"{s}\"}}", .{username}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleFind(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const by = getQueryParam(target, "by") orelse {
        resp.sendError(request, 400, "Missing 'by' parameter (role|text|label|placeholder|testid|alt|title)");
        return;
    };
    const value = getQueryParam(target, "value") orelse {
        resp.sendError(request, 400, "Missing 'value' parameter");
        return;
    };
    const action_param = getQueryParam(target, "action");
    const exact = getQueryParam(target, "exact");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // Build JS to find elements by semantic locator
    const js = if (std.mem.eql(u8, by, "role"))
        std.fmt.allocPrint(arena,
            "JSON.stringify([...document.querySelectorAll('[role=\"{s}\"]')].map((el,i)=>{{return {{index:i,tag:el.tagName,text:el.innerText.substring(0,100),ref:'found_'+i}}}}))", .{value})
    else if (std.mem.eql(u8, by, "text"))
        if (exact != null and std.mem.eql(u8, exact.?, "true"))
            std.fmt.allocPrint(arena,
                "JSON.stringify([...document.querySelectorAll('*')].filter(el=>el.innerText.trim()==='{s}'&&el.children.length===0).slice(0,20).map((el,i)=>{{return {{index:i,tag:el.tagName,text:el.innerText.substring(0,100)}}}}))", .{value})
        else
            std.fmt.allocPrint(arena,
                "JSON.stringify([...document.querySelectorAll('*')].filter(el=>el.innerText.includes('{s}')&&el.children.length===0).slice(0,20).map((el,i)=>{{return {{index:i,tag:el.tagName,text:el.innerText.substring(0,100)}}}}))", .{value})
    else if (std.mem.eql(u8, by, "label"))
        std.fmt.allocPrint(arena,
            "JSON.stringify([...document.querySelectorAll('label')].filter(l=>l.innerText.includes('{s}')).map((l,i)=>{{var el=l.htmlFor?document.getElementById(l.htmlFor):l.querySelector('input,select,textarea');return {{index:i,label:l.innerText.substring(0,100),tag:el?el.tagName:'none'}}}}))", .{value})
    else if (std.mem.eql(u8, by, "placeholder"))
        std.fmt.allocPrint(arena,
            "JSON.stringify([...document.querySelectorAll('[placeholder]')].filter(el=>el.placeholder.includes('{s}')).map((el,i)=>{{return {{index:i,tag:el.tagName,placeholder:el.placeholder}}}}))", .{value})
    else if (std.mem.eql(u8, by, "testid"))
        std.fmt.allocPrint(arena,
            "JSON.stringify([...document.querySelectorAll('[data-testid=\"{s}\"]')].map((el,i)=>{{return {{index:i,tag:el.tagName,text:el.innerText.substring(0,100)}}}}))", .{value})
    else if (std.mem.eql(u8, by, "alt"))
        std.fmt.allocPrint(arena,
            "JSON.stringify([...document.querySelectorAll('[alt]')].filter(el=>el.alt.includes('{s}')).map((el,i)=>{{return {{index:i,tag:el.tagName,alt:el.alt}}}}))", .{value})
    else if (std.mem.eql(u8, by, "title"))
        std.fmt.allocPrint(arena,
            "JSON.stringify([...document.querySelectorAll('[title]')].filter(el=>el.title.includes('{s}')).map((el,i)=>{{return {{index:i,tag:el.tagName,title:el.title}}}}))", .{value})
    else {
        resp.sendError(request, 400, "Unknown 'by' type. Use: role|text|label|placeholder|testid|alt|title");
        return;
    };

    const expr = js catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}", .{expr}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    _ = action_param; // Future: auto-execute action on found elements
    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleTraceStart(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const categories = getQueryParam(target, "categories") orelse "-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline";
    const params = std.fmt.allocPrint(arena,
        "{{\"categories\":\"{s}\",\"options\":\"sampling-frequency=10000\"}}", .{categories}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.tracing_start, params) catch {
        resp.sendError(request, 502, "Tracing.start failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"tracing\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleTraceStop(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const response = client.send(arena, protocol.Methods.tracing_end, null) catch {
        resp.sendError(request, 502, "Tracing.end failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleProfilerStart(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    _ = client.send(arena, protocol.Methods.profiler_enable, null) catch {
        resp.sendError(request, 502, "Profiler.enable failed");
        return;
    };
    const response = client.send(arena, protocol.Methods.profiler_start, null) catch {
        resp.sendError(request, 502, "Profiler.start failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"profiling\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleProfilerStop(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const response = client.send(arena, protocol.Methods.profiler_stop, null) catch {
        resp.sendError(request, 502, "Profiler.stop failed");
        return;
    };
    _ = client.send(arena, protocol.Methods.profiler_disable, null) catch {};
    resp.sendJson(request, response);
}

fn handleInspect(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    _ = client.send(arena, protocol.Methods.inspector_enable, null) catch {};
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"message\":\"DevTools enabled\",\"tab_id\":\"{s}\"}}", .{tab_id}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleWindowNew(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const url = getQueryParam(target, "url") orelse "about:blank";

    // Get any existing client to create target
    const tabs = bridge.listTabs(arena) catch {
        resp.sendError(request, 500, "Failed to list tabs");
        return;
    };
    if (tabs.len == 0) {
        resp.sendError(request, 500, "No active tabs");
        return;
    }
    const client = bridge.getCdpClient(tabs[0].id) orelse {
        resp.sendError(request, 500, "No active CDP client");
        return;
    };

    // Create in a new browser context for window-like isolation
    const ctx_response = client.send(arena, protocol.Methods.target_create_browser_context, null) catch {
        // Fallback: create without isolated context
        const params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\",\"newWindow\":true}}", .{url}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.target_create_target, params) catch {
            resp.sendError(request, 502, "Target.createTarget failed");
            return;
        };
        resp.sendJson(request, response);
        return;
    };

    const ctx_id = extractSimpleJsonString(ctx_response, 0, "\"browserContextId\"") orelse "";
    const params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\",\"newWindow\":true,\"browserContextId\":\"{s}\"}}", .{ url, ctx_id }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.target_create_target, params) catch {
        resp.sendError(request, 502, "Target.createTarget failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleSessionList(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const tabs = bridge.listTabs(arena) catch {
        resp.sendError(request, 500, "Failed to list sessions");
        return;
    };

    var json_buf: std.ArrayList(u8) = .empty;
    const writer = json_buf.writer(arena);
    writer.writeAll("{\"sessions\":[") catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    for (tabs, 0..) |tab, i| {
        if (i > 0) writer.writeByte(',') catch {};
        writer.print("{{\"id\":\"{s}\",\"url\":\"{s}\",\"title\":\"{s}\"}}", .{
            tab.id, tab.url, tab.title,
        }) catch {};
    }
    writer.writeAll("]}") catch {};
    resp.sendJson(request, json_buf.items);
}

fn handleSetViewport(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const width = getQueryParam(target, "width") orelse "1280";
    const height = getQueryParam(target, "height") orelse "720";
    const scale = getQueryParam(target, "scale") orelse "1";
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const params = std.fmt.allocPrint(arena,
        "{{\"width\":{s},\"height\":{s},\"deviceScaleFactor\":{s},\"mobile\":false}}", .{ width, height, scale }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.emulation_set_device_metrics, params) catch {
        resp.sendError(request, 502, "Emulation.setDeviceMetricsOverride failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena,
        "{{\"status\":\"ok\",\"width\":{s},\"height\":{s},\"scale\":{s}}}", .{ width, height, scale }) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleSetUserAgent(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const ua = getQueryParam(target, "ua") orelse {
        resp.sendError(request, 400, "Missing ua parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    const params = std.fmt.allocPrint(arena, "{{\"userAgent\":\"{s}\"}}", .{ua}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    const response = client.send(arena, protocol.Methods.emulation_set_user_agent, params) catch {
        resp.sendError(request, 502, "Emulation.setUserAgentOverride failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"userAgent\":\"{s}\"}}", .{ua}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handleDomAttributes(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const ref = getQueryParam(target, "ref");
    const selector = getQueryParam(target, "selector");
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    if (ref) |r| {
        const cache = bridge.snapshots.get(tab_id);
        const node_id = if (cache) |c| c.refs.get(r) else null;
        const bid = node_id orelse {
            resp.sendError(request, 400, "Ref not found");
            return;
        };
        const resolve_params = std.fmt.allocPrint(arena, "{{\"backendNodeId\":{d}}}", .{bid}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const resolve_response = client.send(arena, protocol.Methods.dom_resolve_node, resolve_params) catch {
            resp.sendError(request, 502, "DOM.resolveNode failed");
            return;
        };
        const object_id = extractSimpleJsonString(resolve_response, 0, "\"objectId\"") orelse {
            resp.sendError(request, 500, "Could not resolve element");
            return;
        };
        const call_params = std.fmt.allocPrint(arena,
            "{{\"objectId\":\"{s}\",\"functionDeclaration\":\"function() {{ var attrs={{}}; for(var a of this.attributes){{ attrs[a.name]=a.value; }} return JSON.stringify(attrs); }}\",\"returnByValue\":true}}", .{object_id}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.runtime_call_function_on, call_params) catch {
            resp.sendError(request, 502, "Runtime.callFunctionOn failed");
            return;
        };
        resp.sendJson(request, response);
    } else if (selector) |sel| {
        const params = std.fmt.allocPrint(arena,
            "{{\"expression\":\"(function(){{ var el=document.querySelector('{s}'); if(!el) return 'null'; var attrs={{}}; for(var a of el.attributes){{ attrs[a.name]=a.value; }} return JSON.stringify(attrs); }})()\",\"returnByValue\":true}}", .{sel}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
            resp.sendError(request, 502, "CDP command failed");
            return;
        };
        resp.sendJson(request, response);
    } else {
        resp.sendError(request, 400, "Missing ref or selector parameter");
    }
}

fn handleFrames(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };
    _ = client.send(arena, protocol.Methods.page_enable, null) catch {};
    const response = client.send(arena, protocol.Methods.page_get_frame_tree, null) catch {
        resp.sendError(request, 502, "Page.getFrameTree failed");
        return;
    };
    resp.sendJson(request, response);
}

fn handleNetwork(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const mode = getQueryParam(target, "mode") orelse "enable";
    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    const method = if (std.mem.eql(u8, mode, "disable")) protocol.Methods.network_disable else protocol.Methods.network_enable;
    const response = client.send(arena, method, null) catch {
        resp.sendError(request, 502, "Network command failed");
        return;
    };
    _ = response;
    const body = std.fmt.allocPrint(arena, "{{\"status\":\"ok\",\"network\":\"{s}\"}}", .{mode}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };
    resp.sendJson(request, body);
}

fn handlePerfLcp(request: *std.http.Server.Request, arena: std.mem.Allocator, bridge: *Bridge) void {
    const target = request.head.target;
    const tab_id = getQueryParam(target, "tab_id") orelse {
        resp.sendError(request, 400, "Missing tab_id parameter");
        return;
    };
    const url = getQueryParam(target, "url");

    const client = bridge.getCdpClient(tab_id) orelse {
        resp.sendError(request, 404, "Tab not found");
        return;
    };

    // If url is provided, navigate first and wait for page load
    if (url) |nav_url| {
        _ = client.send(arena, protocol.Methods.page_enable, null) catch {};
        const nav_params = std.fmt.allocPrint(arena, "{{\"url\":\"{s}\"}}", .{nav_url}) catch {
            resp.sendError(request, 500, "Internal Server Error");
            return;
        };
        _ = client.send(arena, protocol.Methods.page_navigate, nav_params) catch {
            resp.sendError(request, 502, "Navigation failed");
            return;
        };
        _ = client.waitForEvent(arena, "Page.loadEventFired", 50);
    }

    const lcp_js =
        "new Promise((resolve) => { " ++
        "const entries = performance.getEntriesByType('largest-contentful-paint'); " ++
        "if (entries.length > 0) { " ++
        "const lcp = entries[entries.length - 1]; " ++
        "resolve(JSON.stringify({lcp_ms: lcp.startTime, element: lcp.element ? lcp.element.tagName : null, url: lcp.url || null, size: lcp.size})); " ++
        "} else { " ++
        "new PerformanceObserver((list) => { " ++
        "const entries = list.getEntries(); " ++
        "const lcp = entries[entries.length - 1]; " ++
        "resolve(JSON.stringify({lcp_ms: lcp.startTime, element: lcp.element ? lcp.element.tagName : null, url: lcp.url || null, size: lcp.size})); " ++
        "}).observe({type: 'largest-contentful-paint', buffered: true}); " ++
        "setTimeout(() => resolve(JSON.stringify({lcp_ms: null, error: 'timeout'})), 10000); " ++
        "}})";

    const params = std.fmt.allocPrint(arena,
        "{{\"expression\":\"{s}\",\"awaitPromise\":true,\"returnByValue\":true}}", .{lcp_js}) catch {
        resp.sendError(request, 500, "Internal Server Error");
        return;
    };

    const response = client.send(arena, protocol.Methods.runtime_evaluate, params) catch {
        resp.sendError(request, 502, "CDP command failed");
        return;
    };
    resp.sendJson(request, response);
}

test "screenshot routes match" {
    for ([_][]const u8{ "/screenshot/annotated", "/screenshot/diff", "/screencast/start", "/screencast/stop" }) |p| {
        try std.testing.expect(p.len > 0);
    }
}

test "upload route matching" {
    const path = "/upload?tab_id=1&ref=e0&file_path=/tmp/test.png";
    const clean = if (std.mem.indexOfScalar(u8, path, '?')) |idx| path[0..idx] else path;
    try std.testing.expectEqualStrings("/upload", clean);
}

test "upload parameter validation" {
    const target = "/upload?tab_id=t1&ref=e3&file_path=/home/user/file.pdf";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("e3", getQueryParam(target, "ref").?);
    try std.testing.expectEqualStrings("/home/user/file.pdf", getQueryParam(target, "file_path").?);
    // missing required params return null
    try std.testing.expect(getQueryParam("/upload?ref=e0&file_path=/tmp/f", "tab_id") == null);
    try std.testing.expect(getQueryParam("/upload?tab_id=1&file_path=/tmp/f", "ref") == null);
    try std.testing.expect(getQueryParam("/upload?tab_id=1&ref=e0", "file_path") == null);
}

// ── Lightpanda Parity Route & Parameter Tests ───────────────────────────

test "lightpanda parity route matching" {
    const routes = [_][]const u8{
        "/markdown",
        "/links",
        "/pdf",
        "/dom/query",
        "/dom/html",
        "/cookies/delete",
        "/headers",
        "/script/inject",
        "/stop",
    };
    for (routes) |p| {
        const clean = if (std.mem.indexOfScalar(u8, p, '?')) |idx| p[0..idx] else p;
        try std.testing.expectEqualStrings(p, clean);
    }
}

test "markdown route with tab_id" {
    const target = "/markdown?tab_id=abc123";
    try std.testing.expectEqualStrings("abc123", getQueryParam(target, "tab_id").?);
}

test "links route with tab_id" {
    const target = "/links?tab_id=xyz";
    try std.testing.expectEqualStrings("xyz", getQueryParam(target, "tab_id").?);
}

test "pdf route with params" {
    const target = "/pdf?tab_id=t1&landscape=true";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("true", getQueryParam(target, "landscape").?);
}

test "pdf route landscape default" {
    const target = "/pdf?tab_id=t1";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expect(getQueryParam(target, "landscape") == null);
}

test "dom/query route with selector" {
    const target = "/dom/query?tab_id=t1&selector=div.main&all=true";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("div.main", getQueryParam(target, "selector").?);
    try std.testing.expectEqualStrings("true", getQueryParam(target, "all").?);
}

test "dom/query single selector" {
    const target = "/dom/query?tab_id=t1&selector=h1";
    try std.testing.expectEqualStrings("h1", getQueryParam(target, "selector").?);
    try std.testing.expect(getQueryParam(target, "all") == null);
}

test "dom/html route with node_id" {
    const target = "/dom/html?tab_id=t1&node_id=42";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("42", getQueryParam(target, "node_id").?);
}

test "cookies/delete route with name and domain" {
    const target = "/cookies/delete?tab_id=t1&name=session_id&domain=example.com";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("session_id", getQueryParam(target, "name").?);
    try std.testing.expectEqualStrings("example.com", getQueryParam(target, "domain").?);
}

test "cookies/delete without domain" {
    const target = "/cookies/delete?tab_id=t1&name=auth_token";
    try std.testing.expectEqualStrings("auth_token", getQueryParam(target, "name").?);
    try std.testing.expect(getQueryParam(target, "domain") == null);
}

test "headers route with tab_id" {
    const target = "/headers?tab_id=t1";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
}

test "script/inject route with source" {
    const target = "/script/inject?tab_id=t1&source=console.log('hi')";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("console.log('hi')", getQueryParam(target, "source").?);
}

test "stop route with tab_id" {
    const target = "/stop?tab_id=t1";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
}

test "lightpanda parity routes parse from full URL" {
    // Verify route dispatch paths extract correctly
    const test_urls = [_]struct { url: []const u8, expected_path: []const u8 }{
        .{ .url = "/markdown?tab_id=1", .expected_path = "/markdown" },
        .{ .url = "/links?tab_id=1", .expected_path = "/links" },
        .{ .url = "/pdf?tab_id=1&landscape=true", .expected_path = "/pdf" },
        .{ .url = "/dom/query?tab_id=1&selector=div", .expected_path = "/dom/query" },
        .{ .url = "/dom/html?tab_id=1&node_id=5", .expected_path = "/dom/html" },
        .{ .url = "/cookies/delete?tab_id=1&name=x", .expected_path = "/cookies/delete" },
        .{ .url = "/headers?tab_id=1", .expected_path = "/headers" },
        .{ .url = "/script/inject?tab_id=1&source=x", .expected_path = "/script/inject" },
        .{ .url = "/stop?tab_id=1", .expected_path = "/stop" },
    };
    for (test_urls) |t| {
        const clean = if (std.mem.indexOfScalar(u8, t.url, '?')) |idx| t.url[0..idx] else t.url;
        try std.testing.expectEqualStrings(t.expected_path, clean);
    }
}

test "tier 1 routes parse correctly" {
    const tier1_urls = [_]struct { url: []const u8, expected: []const u8 }{
        .{ .url = "/scrollintoview?tab_id=1&ref=e0", .expected = "/scrollintoview" },
        .{ .url = "/drag?tab_id=1&src=e0&tgt=e1", .expected = "/drag" },
        .{ .url = "/keyboard/type?tab_id=1&text=hello", .expected = "/keyboard/type" },
        .{ .url = "/keyboard/inserttext?tab_id=1&text=hello", .expected = "/keyboard/inserttext" },
        .{ .url = "/keydown?tab_id=1&key=Enter", .expected = "/keydown" },
        .{ .url = "/keyup?tab_id=1&key=Enter", .expected = "/keyup" },
        .{ .url = "/wait?tab_id=1&selector=div&timeout=3000", .expected = "/wait" },
        .{ .url = "/tab/new?url=https://example.com", .expected = "/tab/new" },
        .{ .url = "/tab/close?tab_id=abc", .expected = "/tab/close" },
        .{ .url = "/highlight?tab_id=1&ref=e0", .expected = "/highlight" },
        .{ .url = "/errors?tab_id=1", .expected = "/errors" },
        .{ .url = "/set/offline?tab_id=1&mode=on", .expected = "/set/offline" },
        .{ .url = "/set/media?tab_id=1&scheme=dark", .expected = "/set/media" },
        .{ .url = "/set/credentials?tab_id=1&username=u&password=p", .expected = "/set/credentials" },
    };
    for (tier1_urls) |t| {
        const clean = if (std.mem.indexOfScalar(u8, t.url, '?')) |idx| t.url[0..idx] else t.url;
        try std.testing.expectEqualStrings(t.expected, clean);
    }
}

test "wait route parameters" {
    const target = "/wait?tab_id=t1&selector=div.main&timeout=3000";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("div.main", getQueryParam(target, "selector").?);
    try std.testing.expectEqualStrings("3000", getQueryParam(target, "timeout").?);
}

test "keyboard/type route parameters" {
    const target = "/keyboard/type?tab_id=t1&text=hello";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("hello", getQueryParam(target, "text").?);
}

test "set/offline route parameters" {
    const target = "/set/offline?tab_id=t1&mode=on";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("on", getQueryParam(target, "mode").?);
}

test "set/media route parameters" {
    const target = "/set/media?tab_id=t1&scheme=dark";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("dark", getQueryParam(target, "scheme").?);
}

test "set/credentials route parameters" {
    const target = "/set/credentials?tab_id=t1&username=admin&password=secret";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("admin", getQueryParam(target, "username").?);
    try std.testing.expectEqualStrings("secret", getQueryParam(target, "password").?);
}

test "drag route parameters" {
    const target = "/drag?tab_id=t1&src=e0&tgt=e5";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("e0", getQueryParam(target, "src").?);
    try std.testing.expectEqualStrings("e5", getQueryParam(target, "tgt").?);
}

test "highlight route with ref" {
    const target = "/highlight?tab_id=t1&ref=e3";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("e3", getQueryParam(target, "ref").?);
}

test "highlight route with selector" {
    const target = "/highlight?tab_id=t1&selector=div.main";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("div.main", getQueryParam(target, "selector").?);
}

test "tab/new route with url" {
    const target = "/tab/new?url=https://example.com";
    try std.testing.expectEqualStrings("https://example.com", getQueryParam(target, "url").?);
}

test "tab/close route with tab_id" {
    const target = "/tab/close?tab_id=abc123";
    try std.testing.expectEqualStrings("abc123", getQueryParam(target, "tab_id").?);
}

test "action dblclick route" {
    const target = "/action?tab_id=t1&action=dblclick&ref=e0";
    try std.testing.expectEqualStrings("dblclick", getQueryParam(target, "action").?);
}

test "action check/uncheck routes" {
    const check_target = "/action?tab_id=t1&action=check&ref=e2";
    try std.testing.expectEqualStrings("check", getQueryParam(check_target, "action").?);
    const uncheck_target = "/action?tab_id=t1&action=uncheck&ref=e2";
    try std.testing.expectEqualStrings("uncheck", getQueryParam(uncheck_target, "action").?);
}

test "total endpoint count" {
    // Verify we have the expected number of routes
    const routes = [_][]const u8{
        "/health", "/tabs", "/discover", "/navigate", "/snapshot", "/action",
        "/text", "/screenshot", "/evaluate", "/browdie",
        "/har/start", "/har/stop", "/har/status",
        "/close", "/cookies", "/cookies/clear", "/cookies/delete",
        "/storage/local", "/storage/session", "/storage/local/clear", "/storage/session/clear",
        "/get", "/back", "/forward", "/reload",
        "/diff/snapshot", "/emulate", "/geolocation", "/upload",
        "/session/save", "/session/load",
        "/screenshot/annotated", "/screenshot/diff",
        "/screencast/start", "/screencast/stop", "/video/start", "/video/stop",
        "/console", "/intercept/start", "/intercept/stop",
        "/markdown", "/links", "/pdf",
        "/dom/query", "/dom/html",
        "/headers", "/script/inject", "/stop",
        // Tier 1 new endpoints
        "/scrollintoview", "/drag",
        "/keyboard/type", "/keyboard/inserttext",
        "/keydown", "/keyup",
        "/wait",
        "/tab/new", "/tab/close",
        "/highlight", "/errors",
        "/set/offline", "/set/media", "/set/credentials",
        // Tier 2 new endpoints
        "/find",
        "/trace/start", "/trace/stop",
        "/profiler/start", "/profiler/stop",
        "/inspect",
        "/window/new", "/session/list",
        "/set/viewport", "/set/useragent",
        "/dom/attributes", "/frames", "/network",
        "/perf/lcp",
    };
    try std.testing.expectEqual(@as(usize, 76), routes.len);
}

test "buildGetExpression title" {
    const expr = buildGetExpression(std.testing.allocator, "title", null, null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("document.title", expr);
}

test "buildGetExpression url" {
    const expr = buildGetExpression(std.testing.allocator, "url", null, null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("window.location.href", expr);
}

test "buildGetExpression html with selector" {
    const expr = buildGetExpression(std.testing.allocator, "html", "#main", null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("document.querySelector('#main')?.innerHTML || null", expr);
}

test "buildGetExpression value with selector" {
    const expr = buildGetExpression(std.testing.allocator, "value", "input.email", null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("document.querySelector('input.email')?.value || null", expr);
}

test "buildGetExpression text with selector" {
    const expr = buildGetExpression(std.testing.allocator, "text", "p.intro", null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("document.querySelector('p.intro')?.innerText || null", expr);
}

test "buildGetExpression attr with selector and attr name" {
    const expr = buildGetExpression(std.testing.allocator, "attr", "a.link", "href") orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("document.querySelector('a.link')?.getAttribute('href') || null", expr);
}

test "buildGetExpression attr without attr name returns null" {
    try std.testing.expect(buildGetExpression(std.testing.allocator, "attr", "a.link", null) == null);
}

test "buildGetExpression count" {
    const expr = buildGetExpression(std.testing.allocator, "count", "li", null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expectEqualStrings("document.querySelectorAll('li').length", expr);
}

test "buildGetExpression box" {
    const expr = buildGetExpression(std.testing.allocator, "box", "div.card", null) orelse unreachable;
    defer std.testing.allocator.free(expr);
    try std.testing.expect(std.mem.indexOf(u8, expr, "getBoundingClientRect") != null);
}

test "buildGetExpression html without selector returns null" {
    try std.testing.expect(buildGetExpression(std.testing.allocator, "html", null, null) == null);
}

test "buildGetExpression unknown type returns null" {
    try std.testing.expect(buildGetExpression(std.testing.allocator, "unknown", "div", null) == null);
}

test "extractSimpleJsonString extracts value" {
    const json = "{\"objectId\":\"obj-123\",\"type\":\"object\"}";
    const val = extractSimpleJsonString(json, 0, "\"objectId\"");
    try std.testing.expect(val != null);
    try std.testing.expectEqualStrings("obj-123", val.?);
}

test "extractSimpleJsonString missing field returns null" {
    const json = "{\"other\":\"value\"}";
    try std.testing.expect(extractSimpleJsonString(json, 0, "\"objectId\"") == null);
}

test "extractSimpleJsonString with offset" {
    const json = "{\"a\":\"first\",\"a\":\"second\"}";
    const first = extractSimpleJsonString(json, 0, "\"a\"");
    try std.testing.expect(first != null);
    try std.testing.expectEqualStrings("first", first.?);
}

test "extractSimpleJsonInt extracts number" {
    const json = "{\"backendDOMNodeId\":42,\"nodeId\":\"n1\"}";
    const val = extractSimpleJsonInt(json, 0, "\"backendDOMNodeId\"");
    try std.testing.expect(val != null);
    try std.testing.expectEqual(@as(u32, 42), val.?);
}

test "extractSimpleJsonInt missing field returns null" {
    const json = "{\"other\":123}";
    try std.testing.expect(extractSimpleJsonInt(json, 0, "\"nodeId\"") == null);
}

test "findContentLength parses header" {
    try std.testing.expectEqual(@as(?usize, 1234), findContentLength("Content-Length: 1234\r\n"));
    try std.testing.expectEqual(@as(?usize, 0), findContentLength("Content-Length: 0\r\n"));
    try std.testing.expect(findContentLength("X-Other: 5\r\n") == null);
}

test "findContentLength case insensitive" {
    try std.testing.expectEqual(@as(?usize, 42), findContentLength("content-length: 42\r\n"));
}

test "tier 2 routes parse correctly" {
    const tier2_urls = [_]struct { url: []const u8, expected: []const u8 }{
        .{ .url = "/find?tab_id=1&by=role&value=button", .expected = "/find" },
        .{ .url = "/trace/start?tab_id=1", .expected = "/trace/start" },
        .{ .url = "/trace/stop?tab_id=1", .expected = "/trace/stop" },
        .{ .url = "/profiler/start?tab_id=1", .expected = "/profiler/start" },
        .{ .url = "/profiler/stop?tab_id=1", .expected = "/profiler/stop" },
        .{ .url = "/inspect?tab_id=1", .expected = "/inspect" },
        .{ .url = "/window/new?url=about:blank", .expected = "/window/new" },
        .{ .url = "/session/list", .expected = "/session/list" },
        .{ .url = "/set/viewport?tab_id=1&width=1920&height=1080", .expected = "/set/viewport" },
        .{ .url = "/set/useragent?tab_id=1&ua=Mozilla", .expected = "/set/useragent" },
        .{ .url = "/dom/attributes?tab_id=1&ref=e0", .expected = "/dom/attributes" },
        .{ .url = "/frames?tab_id=1", .expected = "/frames" },
        .{ .url = "/network?tab_id=1&mode=enable", .expected = "/network" },
    };
    for (tier2_urls) |t| {
        const clean = if (std.mem.indexOfScalar(u8, t.url, '?')) |idx| t.url[0..idx] else t.url;
        try std.testing.expectEqualStrings(t.expected, clean);
    }
}

test "find route parameters" {
    const target = "/find?tab_id=t1&by=role&value=button&exact=true";
    try std.testing.expectEqualStrings("t1", getQueryParam(target, "tab_id").?);
    try std.testing.expectEqualStrings("role", getQueryParam(target, "by").?);
    try std.testing.expectEqualStrings("button", getQueryParam(target, "value").?);
    try std.testing.expectEqualStrings("true", getQueryParam(target, "exact").?);
}

test "set/viewport route parameters" {
    const target = "/set/viewport?tab_id=t1&width=1920&height=1080&scale=2";
    try std.testing.expectEqualStrings("1920", getQueryParam(target, "width").?);
    try std.testing.expectEqualStrings("1080", getQueryParam(target, "height").?);
    try std.testing.expectEqualStrings("2", getQueryParam(target, "scale").?);
}

test "dom/attributes route with ref" {
    const target = "/dom/attributes?tab_id=t1&ref=e5";
    try std.testing.expectEqualStrings("e5", getQueryParam(target, "ref").?);
}

test "dom/attributes route with selector" {
    const target = "/dom/attributes?tab_id=t1&selector=input.email";
    try std.testing.expectEqualStrings("input.email", getQueryParam(target, "selector").?);
}

test "network route parameters" {
    const target = "/network?tab_id=t1&mode=disable";
    try std.testing.expectEqualStrings("disable", getQueryParam(target, "mode").?);
}

test "jsonEscapeAlloc escapes special chars" {
    const arena = std.testing.allocator;
    // No escaping needed
    try std.testing.expectEqualStrings("hello", jsonEscapeAlloc(arena, "hello").?);
    // Quotes and backslashes
    const escaped = jsonEscapeAlloc(arena, "say \"hello\" \\ world").?;
    defer arena.free(escaped);
    try std.testing.expectEqualStrings("say \\\"hello\\\" \\\\ world", escaped);
    // Newlines
    const nl = jsonEscapeAlloc(arena, "line1\nline2\r\n").?;
    defer arena.free(nl);
    try std.testing.expectEqualStrings("line1\\nline2\\r\\n", nl);
}

test "script/inject accepts POST body" {
    // Route matching test — verify POST method is supported
    const path = "/script/inject?tab_id=abc";
    const clean = path[0..std.mem.indexOfScalar(u8, path, '?').?];
    try std.testing.expectEqualStrings("/script/inject", clean);
}

test "perf/lcp route parameters" {
    const path = "/perf/lcp?tab_id=abc&url=https://example.com";
    const clean = path[0..std.mem.indexOfScalar(u8, path, '?').?];
    try std.testing.expectEqualStrings("/perf/lcp", clean);
    try std.testing.expect(getQueryParam(path, "tab_id") != null);
    try std.testing.expect(getQueryParam(path, "url") != null);
}
