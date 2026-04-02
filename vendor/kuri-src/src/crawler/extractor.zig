const std = @import("std");
const CdpClient = @import("../cdp/client.zig").CdpClient;
const json_util = @import("../util/json.zig");

/// Readability JS script embedded at comptime.
pub const readability_script = @embedFile("js/readability.js");

/// Result from readability extraction.
pub const ReadabilityResult = struct {
    title: []const u8,
    content: []const u8,
    text_content: []const u8,
    excerpt: []const u8,
};

/// Inject readability.js via CDP Runtime.evaluate and parse the result.
/// Falls back to document.body.innerText as text_content if extraction fails.
pub fn extractReadability(client: *CdpClient, tab_id: []const u8, arena: std.mem.Allocator) !ReadabilityResult {
    _ = tab_id;

    const expression = readability_script ++ "; extractContent()";

    // JSON-escape the expression for safe embedding in the params string
    const escaped_expr = try json_util.jsonEscape(expression, arena);
    const params = try std.fmt.allocPrint(
        arena,
        "{{\"expression\":\"{s}\",\"returnByValue\":true}}",
        .{escaped_expr},
    );

    // Try readability extraction via CDP
    if (client.send(arena, "Runtime.evaluate", params)) |response| {
        if (parseReadabilityResponse(response, arena)) |result| {
            return result;
        } else |_| {}
    } else |_| {}

    // Fallback: return document.body.innerText as text_content
    const fallback_response = client.send(
        arena,
        "Runtime.evaluate",
        "{\"expression\":\"document.body.innerText\",\"returnByValue\":true}",
    ) catch {
        return ReadabilityResult{ .title = "", .content = "", .text_content = "", .excerpt = "" };
    };

    const text = extractCdpStringValue(fallback_response, arena) orelse "";
    return ReadabilityResult{ .title = "", .content = "", .text_content = text, .excerpt = "" };
}

/// Parse a CDP Runtime.evaluate response containing readability JSON.
/// Returns error.JsException if the JS threw, error.NoValue if value is missing.
pub fn parseReadabilityResponse(response: []const u8, arena: std.mem.Allocator) !ReadabilityResult {
    if (std.mem.indexOf(u8, response, "\"exceptionDetails\"") != null) {
        return error.JsException;
    }
    const value_str = extractCdpStringValue(response, arena) orelse return error.NoValue;
    return parseReadabilityJson(value_str, arena);
}

/// Extract the string "value" from a CDP Runtime.evaluate response.
/// CDP structure: {"result":{"result":{"type":"string","value":"<the string>"}}}
fn extractCdpStringValue(response: []const u8, arena: std.mem.Allocator) ?[]const u8 {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, response, .{}) catch return null;

    const result1 = switch (parsed) {
        .object => |obj| obj.get("result") orelse return null,
        else => return null,
    };
    const result2 = switch (result1) {
        .object => |obj| obj.get("result") orelse return null,
        else => return null,
    };
    const value = switch (result2) {
        .object => |obj| obj.get("value") orelse return null,
        else => return null,
    };
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

/// Parse the readability JSON string returned by readability.js into a ReadabilityResult.
/// JS returns: {"title":"...","content":"...","textContent":"...","excerpt":"..."}
pub fn parseReadabilityJson(json_str: []const u8, arena: std.mem.Allocator) !ReadabilityResult {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, json_str, .{}) catch return error.InvalidJson;

    const obj = switch (parsed) {
        .object => |o| o,
        else => return error.NotObject,
    };

    const title = switch (obj.get("title") orelse .null) {
        .string => |s| s,
        else => "",
    };
    const content = switch (obj.get("content") orelse .null) {
        .string => |s| s,
        else => "",
    };
    // JS uses "textContent" (camelCase); Zig struct uses "text_content"
    const text_content = switch (obj.get("textContent") orelse .null) {
        .string => |s| s,
        else => "",
    };
    const excerpt = switch (obj.get("excerpt") orelse .null) {
        .string => |s| s,
        else => "",
    };

    return ReadabilityResult{
        .title = title,
        .content = content,
        .text_content = text_content,
        .excerpt = excerpt,
    };
}

// --- Tests ---

/// Build the full JS to inject via CDP Runtime.evaluate.
/// Concatenates the readability script with a call to extractContent().
pub fn buildExtractionJs(allocator: std.mem.Allocator) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{s}; extractContent()", .{readability_script});
}

/// Best-effort extraction of fields from a JSON string returned by readability.
/// Uses simple string searching — not a full JSON parser.
pub fn parseReadabilityResult(json: []const u8, allocator: std.mem.Allocator) ReadabilityResult {
    _ = allocator;
    return .{
        .title = extractJsonStringField(json, "title"),
        .content = extractJsonStringField(json, "content"),
        .text_content = extractJsonStringField(json, "textContent"),
        .excerpt = extractJsonStringField(json, "excerpt"),
    };
}

fn extractJsonStringField(json: []const u8, field_name: []const u8) []const u8 {
    // Look for "field_name":"value"
    // Build the search key: "field_name":"
    const quote = "\"";
    _ = quote;

    // Search for "field_name"
    var pos: usize = 0;
    while (pos < json.len) {
        const field_start = std.mem.indexOf(u8, json[pos..], "\"") orelse return "";
        const abs_start = pos + field_start + 1;
        if (abs_start >= json.len) return "";

        const field_end = std.mem.indexOf(u8, json[abs_start..], "\"") orelse return "";
        const abs_field_end = abs_start + field_end;

        const found_name = json[abs_start..abs_field_end];
        if (std.mem.eql(u8, found_name, field_name)) {
            // Skip past the closing quote and find ':'
            var i = abs_field_end + 1;
            // Skip whitespace and colon
            while (i < json.len and (json[i] == ' ' or json[i] == ':')) : (i += 1) {}
            if (i >= json.len) return "";

            if (json[i] == '"') {
                // String value
                const val_start = i + 1;
                const val_end = std.mem.indexOf(u8, json[val_start..], "\"") orelse return "";
                return json[val_start .. val_start + val_end];
            }
            return "";
        }
        pos = abs_field_end + 1;
    }
    return "";
}

test "readability script loads" {
    try std.testing.expect(readability_script.len > 0);
    try std.testing.expect(std.mem.indexOf(u8, readability_script, "extractContent") != null);
}

test "buildExtractionJs contains script and call" {
    const allocator = std.testing.allocator;
    const js = try buildExtractionJs(allocator);
    defer allocator.free(js);
    try std.testing.expect(js.len > readability_script.len);
    try std.testing.expect(std.mem.indexOf(u8, js, "extractContent()") != null);
    // Should start with the readability script content
    try std.testing.expect(std.mem.startsWith(u8, js, readability_script));
}

test "parseReadabilityResult extracts fields from JSON" {
    const json =
        \\{"title":"Hello World","content":"<p>body</p>","textContent":"body","excerpt":"summary"}
    ;
    const result = parseReadabilityResult(json, std.testing.allocator);
    try std.testing.expectEqualStrings("Hello World", result.title);
    try std.testing.expectEqualStrings("<p>body</p>", result.content);
    try std.testing.expectEqualStrings("body", result.text_content);
    try std.testing.expectEqualStrings("summary", result.excerpt);
}

test "ReadabilityResult default values" {
    const result = parseReadabilityResult("{}", std.testing.allocator);
    try std.testing.expectEqualStrings("", result.title);
    try std.testing.expectEqualStrings("", result.content);
    try std.testing.expectEqualStrings("", result.text_content);
    try std.testing.expectEqualStrings("", result.excerpt);
}

test "parseReadabilityJson parses all fields" {
    var arena_impl = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    const json = "{\"title\":\"Test Title\",\"content\":\"<p>body</p>\",\"textContent\":\"body text\",\"excerpt\":\"short desc\"}";
    const result = try parseReadabilityJson(json, arena);

    try std.testing.expectEqualStrings("Test Title", result.title);
    try std.testing.expectEqualStrings("<p>body</p>", result.content);
    try std.testing.expectEqualStrings("body text", result.text_content);
    try std.testing.expectEqualStrings("short desc", result.excerpt);
}

test "parseReadabilityJson returns empty strings for missing fields" {
    var arena_impl = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    const result = try parseReadabilityJson("{\"title\":\"Only Title\"}", arena);
    try std.testing.expectEqualStrings("Only Title", result.title);
    try std.testing.expectEqualStrings("", result.content);
    try std.testing.expectEqualStrings("", result.text_content);
    try std.testing.expectEqualStrings("", result.excerpt);
}

test "parseReadabilityJson returns error on invalid JSON" {
    var arena_impl = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    try std.testing.expectError(error.InvalidJson, parseReadabilityJson("not json", arena));
}

test "parseReadabilityResponse returns JsException on exceptionDetails" {
    var arena_impl = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    const response = "{\"id\":1,\"result\":{\"exceptionDetails\":{\"text\":\"ReferenceError: extractContent is not defined\"},\"result\":{\"type\":\"undefined\"}}}";
    try std.testing.expectError(error.JsException, parseReadabilityResponse(response, arena));
}

test "parseReadabilityResponse parses valid CDP response" {
    var arena_impl = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    // The readability JSON string, JSON-encoded as the CDP "value" field
    const cdp_response =
        \\{"id":1,"result":{"result":{"type":"string","value":"{\"title\":\"Hello\",\"content\":\"<p>World<\/p>\",\"textContent\":\"World\",\"excerpt\":\"\"}"}}}
    ;

    const result = try parseReadabilityResponse(cdp_response, arena);
    try std.testing.expectEqualStrings("Hello", result.title);
    try std.testing.expectEqualStrings("World", result.text_content);
}

test "parseReadabilityResponse returns NoValue on missing result value" {
    var arena_impl = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_impl.deinit();
    const arena = arena_impl.allocator();

    const response = "{\"id\":1,\"result\":{\"result\":{\"type\":\"undefined\"}}}";
    try std.testing.expectError(error.NoValue, parseReadabilityResponse(response, arena));
}
