const std = @import("std");
const mer = @import("mer");

const host = "https://esm.sh";

pub fn render(req: mer.Request) mer.Response {
    const path = req.queryParam("path") orelse return mer.text(.bad_request, "missing path");
    const trimmed = std.mem.trimLeft(u8, path, "/");
    const url = buildUpstreamUrl(req.allocator, trimmed) catch return mer.internalError("alloc failed");

    var res = mer.fetch(req.allocator, .{ .url = url }) catch return mer.internalError("module fetch failed");
    defer res.deinit(req.allocator);

    if (res.status != .ok) {
        return mer.text(res.status, "module upstream failed");
    }

    const rewritten = rewriteModuleSource(req.allocator, trimmed, res.body) catch return mer.internalError("module rewrite failed");
    return mer.Response.init(.ok, .js, rewritten);
}

fn rewriteModuleSource(allocator: std.mem.Allocator, current_path: []const u8, source: []const u8) ![]u8 {
    var out = std.ArrayList(u8){};
    defer out.deinit(allocator);

    var i: usize = 0;
    while (i < source.len) {
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "from \"", '"')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "from '", '\'')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "from\"", '"')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "from'", '\'')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "import \"", '"')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "import '", '\'')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "import\"", '"')) continue;
        if (try rewriteImportPrefix(allocator, &out, current_path, source, &i, "import'", '\'')) continue;
        try out.append(allocator, source[i]);
        i += 1;
    }

    return out.toOwnedSlice(allocator);
}

fn rewriteImportPrefix(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    current_path: []const u8,
    source: []const u8,
    index: *usize,
    comptime prefix: []const u8,
    comptime quote: u8,
) !bool {
    if (!std.mem.startsWith(u8, source[index.*..], prefix)) return false;

    try out.appendSlice(allocator, prefix);
    index.* += prefix.len;
    const start = index.*;
    while (index.* < source.len and source[index.*] != quote) : (index.* += 1) {}
    if (index.* >= source.len) {
        try out.appendSlice(allocator, source[start..]);
        return true;
    }

    const raw_spec = source[start..index.*];
    const rewritten = try rewriteImportSpecifier(allocator, current_path, raw_spec);
    try out.appendSlice(allocator, rewritten);
    try out.append(allocator, quote);
    index.* += 1;
    return true;
}

fn rewriteImportSpecifier(allocator: std.mem.Allocator, current_path: []const u8, raw_spec: []const u8) ![]u8 {
    const resolved = try resolveSpecifier(allocator, current_path, raw_spec);
    defer allocator.free(resolved);

    const escaped = try escapeQuery(allocator, resolved);
    defer allocator.free(escaped);

    return std.fmt.allocPrint(allocator, "/api/esm?path={s}", .{escaped});
}

fn resolveSpecifier(allocator: std.mem.Allocator, current_path: []const u8, raw_spec: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, raw_spec, "http://") or std.mem.startsWith(u8, raw_spec, "https://")) {
        return allocator.dupe(u8, raw_spec);
    }
    if (std.mem.startsWith(u8, raw_spec, "/")) {
        return allocator.dupe(u8, std.mem.trimLeft(u8, raw_spec, "/"));
    }
    if (!std.mem.startsWith(u8, raw_spec, "./") and !std.mem.startsWith(u8, raw_spec, "../") and !looksLikeLocalModule(raw_spec)) {
        return allocator.dupe(u8, raw_spec);
    }

    const query_index = std.mem.indexOfScalar(u8, current_path, '?') orelse current_path.len;
    const current_no_query = current_path[0..query_index];
    const dir = std.fs.path.dirnamePosix(current_no_query) orelse "";

    var parts = std.ArrayList([]const u8){};
    defer parts.deinit(allocator);

    var base_it = std.mem.tokenizeScalar(u8, dir, '/');
    while (base_it.next()) |segment| {
        try parts.append(allocator, segment);
    }

    var rel_it = std.mem.tokenizeScalar(u8, raw_spec, '/');
    while (rel_it.next()) |segment| {
        if (std.mem.eql(u8, segment, ".") or segment.len == 0) continue;
        if (std.mem.eql(u8, segment, "..")) {
            _ = parts.pop();
            continue;
        }
        try parts.append(allocator, segment);
    }

    var out = std.ArrayList(u8){};
    defer out.deinit(allocator);
    for (parts.items, 0..) |segment, idx| {
        if (idx != 0) try out.append(allocator, '/');
        try out.appendSlice(allocator, segment);
    }
    return out.toOwnedSlice(allocator);
}

fn escapeQuery(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var out = std.ArrayList(u8){};
    defer out.deinit(allocator);

    for (value) |ch| {
        if (isUnreserved(ch)) {
            try out.append(allocator, ch);
            continue;
        }
        try out.writer(allocator).print("%{X:0>2}", .{ch});
    }

    return out.toOwnedSlice(allocator);
}

fn isUnreserved(ch: u8) bool {
    return std.ascii.isAlphanumeric(ch) or ch == '-' or ch == '_' or ch == '.' or ch == '~';
}

fn buildUpstreamUrl(allocator: std.mem.Allocator, trimmed: []const u8) ![]u8 {
    var out = std.ArrayList(u8){};
    defer out.deinit(allocator);

    try out.appendSlice(allocator, host);
    try out.append(allocator, '/');
    for (trimmed) |ch| {
        if (std.ascii.isAlphanumeric(ch) or ch == '@' or ch == '/' or ch == '?' or ch == '&' or ch == '=' or ch == '-' or ch == '_' or ch == '.' or ch == '~') {
            try out.append(allocator, ch);
            continue;
        }
        try out.writer(allocator).print("%{X:0>2}", .{ch});
    }
    return out.toOwnedSlice(allocator);
}

fn looksLikeLocalModule(raw_spec: []const u8) bool {
    if (std.mem.startsWith(u8, raw_spec, "node:") or std.mem.startsWith(u8, raw_spec, "npm:")) return false;
    return std.mem.endsWith(u8, raw_spec, ".mjs") or std.mem.endsWith(u8, raw_spec, ".js") or std.mem.endsWith(u8, raw_spec, ".json");
}
