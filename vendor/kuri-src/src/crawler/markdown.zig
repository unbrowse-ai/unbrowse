const std = @import("std");

/// Convert HTML content to Markdown.
/// Handles common HTML elements: headings, paragraphs, links, lists, code blocks, emphasis.
pub fn htmlToMarkdown(html: []const u8, allocator: std.mem.Allocator) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    const writer = buf.writer(allocator);

    var i: usize = 0;
    while (i < html.len) {
        if (html[i] == '<') {
            const tag_end = std.mem.indexOfScalarPos(u8, html, i + 1, '>') orelse {
                i += 1;
                continue;
            };
            const tag_content = html[i + 1 .. tag_end];
            const is_close = tag_content.len > 0 and tag_content[0] == '/';
            const tag_name = extractTagName(if (is_close) tag_content[1..] else tag_content);

            if (std.mem.eql(u8, tag_name, "h1")) {
                if (!is_close) try writer.writeAll("# ") else try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "h2")) {
                if (!is_close) try writer.writeAll("## ") else try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "h3")) {
                if (!is_close) try writer.writeAll("### ") else try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "h4")) {
                if (!is_close) try writer.writeAll("#### ") else try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "h5")) {
                if (!is_close) try writer.writeAll("##### ") else try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "h6")) {
                if (!is_close) try writer.writeAll("###### ") else try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "p")) {
                if (is_close) try writer.writeAll("\n\n");
            } else if (std.mem.eql(u8, tag_name, "br")) {
                try writer.writeAll("\n");
            } else if (std.mem.eql(u8, tag_name, "strong") or std.mem.eql(u8, tag_name, "b")) {
                try writer.writeAll("**");
            } else if (std.mem.eql(u8, tag_name, "em") or std.mem.eql(u8, tag_name, "i")) {
                try writer.writeAll("*");
            } else if (std.mem.eql(u8, tag_name, "code")) {
                try writer.writeAll("`");
            } else if (std.mem.eql(u8, tag_name, "pre")) {
                if (!is_close) try writer.writeAll("\n```\n") else try writer.writeAll("\n```\n\n");
            } else if (std.mem.eql(u8, tag_name, "li")) {
                if (!is_close) try writer.writeAll("- ");
                if (is_close) try writer.writeAll("\n");
            } else if (std.mem.eql(u8, tag_name, "blockquote")) {
                if (!is_close) try writer.writeAll("> ");
            } else if (std.mem.eql(u8, tag_name, "hr")) {
                try writer.writeAll("\n---\n\n");
            } else if (std.mem.eql(u8, tag_name, "a")) {
                if (!is_close) {
                    if (extractAttr(tag_content, "href")) |href| {
                        try writer.writeAll("[");
                        if (std.mem.indexOf(u8, html[tag_end + 1 ..], "</a>")) |close_idx| {
                            const text = html[tag_end + 1 .. tag_end + 1 + close_idx];
                            try writer.writeAll(text);
                            try writer.print("]({s})", .{href});
                            i = tag_end + 1 + close_idx + 4;
                            continue;
                        }
                    }
                }
            } else if (std.mem.eql(u8, tag_name, "script") or std.mem.eql(u8, tag_name, "style")) {
                if (!is_close) {
                    const close_tag = if (std.mem.eql(u8, tag_name, "script")) "</script>" else "</style>";
                    if (std.mem.indexOf(u8, html[tag_end + 1 ..], close_tag)) |close_idx| {
                        i = tag_end + 1 + close_idx + close_tag.len;
                        continue;
                    }
                }
            }

            i = tag_end + 1;
        } else {
            if (html[i] == '&') {
                if (std.mem.startsWith(u8, html[i..], "&amp;")) {
                    try writer.writeByte('&');
                    i += 5;
                } else if (std.mem.startsWith(u8, html[i..], "&lt;")) {
                    try writer.writeByte('<');
                    i += 4;
                } else if (std.mem.startsWith(u8, html[i..], "&gt;")) {
                    try writer.writeByte('>');
                    i += 4;
                } else if (std.mem.startsWith(u8, html[i..], "&quot;")) {
                    try writer.writeByte('"');
                    i += 6;
                } else if (std.mem.startsWith(u8, html[i..], "&nbsp;")) {
                    try writer.writeByte(' ');
                    i += 6;
                } else {
                    try writer.writeByte(html[i]);
                    i += 1;
                }
            } else {
                try writer.writeByte(html[i]);
                i += 1;
            }
        }
    }

    return buf.toOwnedSlice(allocator);
}

fn extractTagName(tag: []const u8) []const u8 {
    var end: usize = 0;
    while (end < tag.len and tag[end] != ' ' and tag[end] != '/' and tag[end] != '>') : (end += 1) {}
    return tag[0..end];
}

fn extractAttr(tag: []const u8, name: []const u8) ?[]const u8 {
    // Search for name="..." pattern in tag attributes
    var pos: usize = 0;
    while (pos < tag.len) {
        const name_pos = std.mem.indexOfPos(u8, tag, pos, name) orelse return null;
        const eq_pos = name_pos + name.len;
        if (eq_pos + 1 < tag.len and tag[eq_pos] == '=' and tag[eq_pos + 1] == '"') {
            const start = eq_pos + 2;
            const end = std.mem.indexOfScalarPos(u8, tag, start, '"') orelse return null;
            return tag[start..end];
        }
        pos = name_pos + 1;
    }
    return null;
}

pub fn countTagsSimd(html: []const u8) usize {
    const Vec = @Vector(16, u8);
    const needle: Vec = @splat(@as(u8, '<'));
    var count: usize = 0;
    var i: usize = 0;

    while (i + 16 <= html.len) : (i += 16) {
        const chunk: Vec = html[i..][0..16].*;
        const matches = chunk == needle;
        const mask: @Vector(16, u1) = @bitCast(matches);
        const bits: u16 = @bitCast(mask);
        count += @popCount(bits);
    }

    // Scalar tail
    while (i < html.len) : (i += 1) {
        if (html[i] == '<') count += 1;
    }

    return count;
}

test "countTagsSimd with tags" {
    try std.testing.expectEqual(@as(usize, 2), countTagsSimd("<p>hello</p>"));
}

test "countTagsSimd empty string" {
    try std.testing.expectEqual(@as(usize, 0), countTagsSimd(""));
}

test "countTagsSimd no tags" {
    try std.testing.expectEqual(@as(usize, 0), countTagsSimd("hello world"));
}

test "basic HTML to Markdown" {
    const html = "<h1>Hello</h1><p>World</p>";
    const md = try htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "# Hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, md, "World") != null);
}

test "HTML entities decoded" {
    const html = "Tom &amp; Jerry &lt;3";
    const md = try htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expectEqualStrings("Tom & Jerry <3", md);
}

test "emphasis and code" {
    const html = "<strong>bold</strong> and <em>italic</em> and <code>code</code>";
    const md = try htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expect(std.mem.indexOf(u8, md, "**bold**") != null);
    try std.testing.expect(std.mem.indexOf(u8, md, "*italic*") != null);
    try std.testing.expect(std.mem.indexOf(u8, md, "`code`") != null);
}

test "links converted" {
    const html = "<a href=\"https://example.com\">Example</a>";
    const md = try htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expectEqualStrings("[Example](https://example.com)", md);
}

test "script tags stripped" {
    const html = "before<script>alert(1)</script>after";
    const md = try htmlToMarkdown(html, std.testing.allocator);
    defer std.testing.allocator.free(md);

    try std.testing.expectEqualStrings("beforeafter", md);
}
