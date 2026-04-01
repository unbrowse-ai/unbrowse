const std = @import("std");
const markdown = @import("crawler/markdown.zig");
const validator = @import("crawler/validator.zig");

const version = "0.1.0";
const user_agent = "kuri-browse/" ++ version;

pub fn main() !void {
    var gpa_impl: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa_impl.deinit();
    const gpa = gpa_impl.allocator();

    const args = try std.process.argsAlloc(gpa);
    defer std.process.argsFree(gpa, args);

    if (args.len > 1 and (std.mem.eql(u8, args[1], "--version") or std.mem.eql(u8, args[1], "-V"))) {
        const stdout = std.fs.File.stdout();
        stdout.writeAll("kuri-browse " ++ version ++ "\n") catch {};
        return;
    }
    if (args.len > 1 and (std.mem.eql(u8, args[1], "--help") or std.mem.eql(u8, args[1], "-h"))) {
        printUsage();
        return;
    }

    const color = shouldUseColor();

    if (color) {
        std.debug.print("\x1b[1m🌰 kuri-browse\x1b[0m — terminal browser\n", .{});
    } else {
        std.debug.print("kuri-browse — terminal browser\n", .{});
    }

    var browser = Browser.init(gpa, color);
    defer browser.deinit();

    // If a URL was passed as argument, navigate to it
    if (args.len > 1 and args[1].len > 0 and args[1][0] != '-') {
        browser.navigate(args[1]) catch |err| {
            if (color) {
                std.debug.print("\x1b[31m✗\x1b[0m failed to load: {s}\n", .{@errorName(err)});
            } else {
                std.debug.print("error: failed to load: {s}\n", .{@errorName(err)});
            }
        };
    }

    // Enter REPL
    browser.repl();
}

// ─── Browser ────────────────────────────────────────────────────────────────

const Browser = struct {
    allocator: std.mem.Allocator,
    color: bool,
    history: History,
    current_url: ?[]const u8,
    current_html: ?[]const u8,
    current_md: ?[]const u8,
    links: std.ArrayList([]const u8),
    arena: std.heap.ArenaAllocator,
    search_term: ?[]const u8,

    fn init(allocator: std.mem.Allocator, color: bool) Browser {
        return .{
            .allocator = allocator,
            .color = color,
            .history = History.init(allocator),
            .current_url = null,
            .current_html = null,
            .current_md = null,
            .links = .empty,
            .arena = std.heap.ArenaAllocator.init(allocator),
            .search_term = null,
        };
    }

    fn deinit(self: *Browser) void {
        self.history.deinit();
        self.arena.deinit();
    }

    fn navigate(self: *Browser, url: []const u8) !void {
        const resolved = self.resolveUrl(url);

        // SSRF validation — block private IPs, metadata endpoints, non-HTTP schemes
        validator.validateUrl(resolved) catch |err| {
            if (self.color) {
                std.debug.print("\x1b[31m✗\x1b[0m blocked: {s} ({s})\n", .{ resolved, @errorName(err) });
            } else {
                std.debug.print("error: blocked URL: {s} ({s})\n", .{ resolved, @errorName(err) });
            }
            return error.FetchFailed;
        };

        if (self.color) {
            std.debug.print("\x1b[2m→\x1b[0m loading \x1b[4m{s}\x1b[0m\n", .{resolved});
        } else {
            std.debug.print("loading {s}\n", .{resolved});
        }

        // Reset arena for new page
        _ = self.arena.reset(.retain_capacity);
        const arena = self.arena.allocator();

        const fetch_start = std.time.nanoTimestamp();
        const html = fetchHttp(arena, resolved, user_agent) catch |err| {
            if (self.color) {
                std.debug.print("\x1b[31m✗\x1b[0m fetch failed: {s}\n", .{@errorName(err)});
            } else {
                std.debug.print("error: fetch failed: {s}\n", .{@errorName(err)});
            }
            return err;
        };
        const fetch_ms = elapsed(fetch_start);

        const md = markdown.htmlToMarkdown(html, arena) catch html;

        // Extract links
        self.links = .empty;
        extractLinksFromHtml(html, arena, &self.links) catch {};

        // Store state
        self.current_html = html;
        self.current_md = md;
        const duped_url = arena.dupe(u8, resolved) catch resolved;
        self.current_url = duped_url;
        self.search_term = null;

        // Push to history
        self.history.push(duped_url);

        // Render
        self.renderPage(null);

        // Footer
        if (self.color) {
            std.debug.print("\n\x1b[32m✓\x1b[0m {d} bytes, {d} links ({d}ms)\n", .{ html.len, self.links.items.len, fetch_ms });
        } else {
            std.debug.print("\n{d} bytes, {d} links ({d}ms)\n", .{ html.len, self.links.items.len, fetch_ms });
        }
    }

    fn resolveUrl(self: *Browser, input: []const u8) []const u8 {
        // Already absolute
        if (std.mem.startsWith(u8, input, "http://") or std.mem.startsWith(u8, input, "https://")) {
            return input;
        }

        const base = self.current_url orelse {
            // No current page — assume https://
            const arena = self.arena.allocator();
            return std.fmt.allocPrint(arena, "https://{s}", .{input}) catch input;
        };

        const arena = self.arena.allocator();

        // Protocol-relative: //example.com/path
        if (std.mem.startsWith(u8, input, "//")) {
            const scheme_end = std.mem.indexOf(u8, base, "://") orelse return input;
            return std.fmt.allocPrint(arena, "{s}:{s}", .{ base[0..scheme_end], input }) catch input;
        }

        // Extract scheme + host from base
        const scheme_end = (std.mem.indexOf(u8, base, "://") orelse return input) + 3;
        const host_end = std.mem.indexOfScalarPos(u8, base, scheme_end, '/') orelse base.len;
        const origin = base[0..host_end];

        // Absolute path: /path
        if (input.len > 0 and input[0] == '/') {
            return std.fmt.allocPrint(arena, "{s}{s}", .{ origin, input }) catch input;
        }

        // Fragment: #section
        if (input.len > 0 and input[0] == '#') {
            return base;
        }

        // Relative path: resolve against current directory
        const last_slash = std.mem.lastIndexOfScalar(u8, base, '/') orelse return input;
        if (last_slash < scheme_end) {
            return std.fmt.allocPrint(arena, "{s}/{s}", .{ origin, input }) catch input;
        }
        return std.fmt.allocPrint(arena, "{s}{s}", .{ base[0 .. last_slash + 1], input }) catch input;
    }

    fn renderPage(self: *Browser, highlight: ?[]const u8) void {
        const md = self.current_md orelse return;
        const arena = self.arena.allocator();
        const rendered = renderColoredMarkdown(md, self.links.items, self.color, highlight, arena);
        const stdout = std.fs.File.stdout();
        stdout.writeAll("\n") catch {};
        stdout.writeAll(rendered) catch {};
    }

    fn repl(self: *Browser) void {
        const stdin = std.fs.File.stdin();
        var line_buf: [4096]u8 = undefined;

        while (true) {
            // Prompt
            if (self.color) {
                if (self.current_url) |url| {
                    const display = truncateUrl(url, 50);
                    std.debug.print("\x1b[36m{s}\x1b[0m {s}> ", .{ self.history.positionStr(), display });
                } else {
                    std.debug.print("\x1b[36m[no page]\x1b[0m > ", .{});
                }
            } else {
                if (self.current_url) |url| {
                    const display = truncateUrl(url, 50);
                    std.debug.print("{s} {s}> ", .{ self.history.positionStr(), display });
                } else {
                    std.debug.print("[no page] > ", .{});
                }
            }

            const line = readLine(stdin, &line_buf) orelse {
                std.debug.print("\n", .{});
                return;
            };
            const trimmed = std.mem.trim(u8, line, " \t\r");
            if (trimmed.len == 0) continue;

            // Number → follow link
            if (std.fmt.parseInt(usize, trimmed, 10)) |num| {
                if (num == 0 or num > self.links.items.len) {
                    if (self.color) {
                        std.debug.print("\x1b[31m✗\x1b[0m link [{d}] not found (1-{d})\n", .{ num, self.links.items.len });
                    } else {
                        std.debug.print("error: link [{d}] not found (1-{d})\n", .{ num, self.links.items.len });
                    }
                } else {
                    const link = self.links.items[num - 1];
                    self.navigate(link) catch {};
                }
                continue;
            } else |_| {}

            // Commands
            if (std.mem.eql(u8, trimmed, ":q") or std.mem.eql(u8, trimmed, ":quit") or std.mem.eql(u8, trimmed, ":exit")) {
                return;
            } else if (std.mem.eql(u8, trimmed, ":h") or std.mem.eql(u8, trimmed, ":help")) {
                printReplHelp(self.color);
            } else if (std.mem.eql(u8, trimmed, ":b") or std.mem.eql(u8, trimmed, ":back")) {
                if (self.history.back()) |url| {
                    self.navigateNoHistory(url);
                } else {
                    std.debug.print("already at oldest page\n", .{});
                }
            } else if (std.mem.eql(u8, trimmed, ":f") or std.mem.eql(u8, trimmed, ":forward")) {
                if (self.history.forward()) |url| {
                    self.navigateNoHistory(url);
                } else {
                    std.debug.print("already at newest page\n", .{});
                }
            } else if (std.mem.eql(u8, trimmed, ":l") or std.mem.eql(u8, trimmed, ":links")) {
                const arena = self.arena.allocator();
                const index_str = formatLinkIndex(self.links.items, self.color, arena);
                const stdout = std.fs.File.stdout();
                stdout.writeAll(index_str) catch {};
            } else if (std.mem.eql(u8, trimmed, ":r") or std.mem.eql(u8, trimmed, ":reload")) {
                if (self.current_url) |url| {
                    const arena = self.arena.allocator();
                    const url_copy = arena.dupe(u8, url) catch url;
                    self.navigateNoHistory(url_copy);
                } else {
                    std.debug.print("no page to reload\n", .{});
                }
            } else if (std.mem.eql(u8, trimmed, ":history") or std.mem.eql(u8, trimmed, ":hist")) {
                self.history.print(self.color);
            } else if (std.mem.startsWith(u8, trimmed, ":go ") or std.mem.startsWith(u8, trimmed, ":open ")) {
                const url_part = std.mem.trimLeft(u8, trimmed[if (std.mem.startsWith(u8, trimmed, ":go ")) @as(usize, 4) else 6..], " ");
                if (url_part.len > 0) {
                    self.navigate(url_part) catch {};
                }
            } else if (std.mem.startsWith(u8, trimmed, ":search ") or std.mem.startsWith(u8, trimmed, ":s ")) {
                const term = std.mem.trimLeft(u8, trimmed[if (std.mem.startsWith(u8, trimmed, ":s ")) @as(usize, 3) else 8..], " ");
                self.searchInPage(term);
            } else if (trimmed.len > 0 and trimmed[0] == '/') {
                if (trimmed.len > 1) {
                    self.searchInPage(trimmed[1..]);
                }
            } else if (std.mem.eql(u8, trimmed, ":n") or std.mem.eql(u8, trimmed, ":next")) {
                if (self.search_term) |term| {
                    self.searchInPage(term);
                } else {
                    std.debug.print("no previous search\n", .{});
                }
            } else if (trimmed.len > 0 and trimmed[0] != ':') {
                // Treat as URL if it looks like one
                if (std.mem.indexOf(u8, trimmed, ".") != null) {
                    self.navigate(trimmed) catch {};
                } else {
                    std.debug.print("unknown command: {s} (type :help)\n", .{trimmed});
                }
            } else {
                std.debug.print("unknown command: {s} (type :help)\n", .{trimmed});
            }
        }
    }

    fn navigateNoHistory(self: *Browser, url: []const u8) void {
        if (self.color) {
            std.debug.print("\x1b[2m→\x1b[0m loading \x1b[4m{s}\x1b[0m\n", .{url});
        } else {
            std.debug.print("loading {s}\n", .{url});
        }

        _ = self.arena.reset(.retain_capacity);
        const arena = self.arena.allocator();

        const fetch_start = std.time.nanoTimestamp();
        const html = fetchHttp(arena, url, user_agent) catch |err| {
            if (self.color) {
                std.debug.print("\x1b[31m✗\x1b[0m fetch failed: {s}\n", .{@errorName(err)});
            } else {
                std.debug.print("error: fetch failed: {s}\n", .{@errorName(err)});
            }
            return;
        };
        const fetch_ms = elapsed(fetch_start);

        const md = markdown.htmlToMarkdown(html, arena) catch html;

        self.links = .empty;
        extractLinksFromHtml(html, arena, &self.links) catch {};

        self.current_html = html;
        self.current_md = md;
        self.current_url = arena.dupe(u8, url) catch url;
        self.search_term = null;

        self.renderPage(null);

        if (self.color) {
            std.debug.print("\n\x1b[32m✓\x1b[0m {d} bytes, {d} links ({d}ms)\n", .{ html.len, self.links.items.len, fetch_ms });
        } else {
            std.debug.print("\n{d} bytes, {d} links ({d}ms)\n", .{ html.len, self.links.items.len, fetch_ms });
        }
    }

    fn searchInPage(self: *Browser, term: []const u8) void {
        const md = self.current_md orelse {
            std.debug.print("no page loaded\n", .{});
            return;
        };

        self.search_term = term;

        // Count matches
        var count: usize = 0;
        var pos: usize = 0;
        while (pos < md.len) {
            const found = indexOfIgnoreCase(md, pos, term) orelse break;
            count += 1;
            pos = found + term.len;
        }

        if (count == 0) {
            if (self.color) {
                std.debug.print("\x1b[33m!\x1b[0m no matches for \"{s}\"\n", .{term});
            } else {
                std.debug.print("no matches for \"{s}\"\n", .{term});
            }
            return;
        }

        if (self.color) {
            std.debug.print("\x1b[32m✓\x1b[0m {d} matches for \"{s}\"\n", .{ count, term });
        } else {
            std.debug.print("{d} matches for \"{s}\"\n", .{ count, term });
        }

        // Re-render with highlights
        self.renderPage(term);
    }
};

// ─── History ────────────────────────────────────────────────────────────────

const History = struct {
    entries: std.ArrayList([]const u8),
    pos: usize,
    allocator: std.mem.Allocator,

    fn init(allocator: std.mem.Allocator) History {
        return .{
            .entries = .empty,
            .pos = 0,
            .allocator = allocator,
        };
    }

    fn deinit(self: *History) void {
        for (self.entries.items) |entry| {
            self.allocator.free(entry);
        }
        self.entries.deinit(self.allocator);
    }

    fn push(self: *History, url: []const u8) void {
        // Truncate forward history
        if (self.entries.items.len > 0 and self.pos < self.entries.items.len - 1) {
            const start = self.pos + 1;
            for (self.entries.items[start..]) |entry| {
                self.allocator.free(entry);
            }
            self.entries.shrinkRetainingCapacity(start);
        }

        const duped = self.allocator.dupe(u8, url) catch return;
        self.entries.append(self.allocator, duped) catch {
            self.allocator.free(duped);
            return;
        };
        self.pos = self.entries.items.len - 1;
    }

    fn back(self: *History) ?[]const u8 {
        if (self.pos == 0) return null;
        self.pos -= 1;
        return self.entries.items[self.pos];
    }

    fn forward(self: *History) ?[]const u8 {
        if (self.pos + 1 >= self.entries.items.len) return null;
        self.pos += 1;
        return self.entries.items[self.pos];
    }

    fn positionStr(self: *const History) []const u8 {
        if (self.entries.items.len == 0) return "[0/0]";
        return "[nav]";
    }

    fn print(self: *const History, color: bool) void {
        if (self.entries.items.len == 0) {
            std.debug.print("  (empty history)\n", .{});
            return;
        }
        for (self.entries.items, 0..) |entry, i| {
            if (i == self.pos) {
                if (color) {
                    std.debug.print("  \x1b[1m→ {s}\x1b[0m\n", .{entry});
                } else {
                    std.debug.print("  > {s}\n", .{entry});
                }
            } else {
                std.debug.print("    {s}\n", .{entry});
            }
        }
    }
};

// ─── Colored Markdown Renderer ──────────────────────────────────────────────

fn renderColoredMarkdown(md: []const u8, links: []const []const u8, color: bool, highlight: ?[]const u8, allocator: std.mem.Allocator) []const u8 {
    var buf: std.ArrayList(u8) = .empty;
    const w = buf.writer(allocator);

    var link_num: usize = 0;
    var i: usize = 0;

    while (i < md.len) {
        // Check for search highlight
        if (highlight) |term| {
            if (i + term.len <= md.len and matchIgnoreCase(md[i .. i + term.len], term)) {
                if (color) {
                    w.writeAll("\x1b[30;43m") catch {};
                    w.writeAll(md[i .. i + term.len]) catch {};
                    w.writeAll("\x1b[0m") catch {};
                } else {
                    w.writeAll(">>") catch {};
                    w.writeAll(md[i .. i + term.len]) catch {};
                    w.writeAll("<<") catch {};
                }
                i += term.len;
                continue;
            }
        }

        // Markdown heading: # at start of line
        if ((i == 0 or md[i - 1] == '\n') and md[i] == '#') {
            var j = i;
            while (j < md.len and md[j] == '#') : (j += 1) {}
            const eol = std.mem.indexOfScalarPos(u8, md, j, '\n') orelse md.len;
            if (color) {
                w.writeAll("\x1b[1;36m") catch {};
                w.writeAll(md[i..eol]) catch {};
                w.writeAll("\x1b[0m") catch {};
            } else {
                w.writeAll(md[i..eol]) catch {};
            }
            i = eol;
            continue;
        }

        // Markdown link: [text](url)
        if (md[i] == '[') {
            if (parseMdLink(md, i)) |link_info| {
                link_num += 1;
                const display_num = findLinkNum(links, link_info.url, link_num);

                if (color) {
                    w.writeAll("\x1b[4;34m") catch {};
                    w.writeAll(link_info.text) catch {};
                    w.print("\x1b[0m \x1b[2;33m[{d}]\x1b[0m", .{display_num}) catch {};
                } else {
                    w.writeAll(link_info.text) catch {};
                    w.print(" [{d}]", .{display_num}) catch {};
                }
                i = link_info.end;
                continue;
            }
        }

        // Inline code: `code`
        if (md[i] == '`') {
            if (std.mem.indexOfScalarPos(u8, md, i + 1, '`')) |close| {
                if (color) {
                    w.writeAll("\x1b[33m") catch {};
                    w.writeAll(md[i .. close + 1]) catch {};
                    w.writeAll("\x1b[0m") catch {};
                } else {
                    w.writeAll(md[i .. close + 1]) catch {};
                }
                i = close + 1;
                continue;
            }
        }

        // Bold: **text**
        if (i + 1 < md.len and md[i] == '*' and md[i + 1] == '*') {
            if (std.mem.indexOf(u8, md[i + 2 ..], "**")) |close_offset| {
                if (color) {
                    w.writeAll("\x1b[1m") catch {};
                    w.writeAll(md[i .. i + 4 + close_offset]) catch {};
                    w.writeAll("\x1b[0m") catch {};
                } else {
                    w.writeAll(md[i .. i + 4 + close_offset]) catch {};
                }
                i = i + 4 + close_offset;
                continue;
            }
        }

        // Code block: ``` ... ```
        if (i + 2 < md.len and std.mem.startsWith(u8, md[i..], "```")) {
            if (std.mem.indexOf(u8, md[i + 3 ..], "```")) |close_offset| {
                if (color) {
                    w.writeAll("\x1b[2m") catch {};
                    w.writeAll(md[i .. i + 6 + close_offset]) catch {};
                    w.writeAll("\x1b[0m") catch {};
                } else {
                    w.writeAll(md[i .. i + 6 + close_offset]) catch {};
                }
                i = i + 6 + close_offset;
                continue;
            }
        }

        // Blockquote: > at start of line
        if ((i == 0 or md[i - 1] == '\n') and md[i] == '>') {
            if (color) w.writeAll("\x1b[2;32m") catch {};
            const eol = std.mem.indexOfScalarPos(u8, md, i, '\n') orelse md.len;
            w.writeAll(md[i..eol]) catch {};
            if (color) w.writeAll("\x1b[0m") catch {};
            i = eol;
            continue;
        }

        // List item: - at start of line
        if ((i == 0 or md[i - 1] == '\n') and md[i] == '-' and i + 1 < md.len and md[i + 1] == ' ') {
            if (color) {
                w.writeAll("\x1b[36m•\x1b[0m ") catch {};
            } else {
                w.writeAll("• ") catch {};
            }
            i += 2;
            continue;
        }

        // Horizontal rule: ---
        if ((i == 0 or md[i - 1] == '\n') and i + 2 < md.len and std.mem.startsWith(u8, md[i..], "---")) {
            if (color) {
                w.writeAll("\x1b[2m────────────────────────────────\x1b[0m\n") catch {};
            } else {
                w.writeAll("--------------------------------\n") catch {};
            }
            i += 3;
            if (i < md.len and md[i] == '\n') i += 1;
            continue;
        }

        w.writeByte(md[i]) catch {};
        i += 1;
    }

    // Print link index
    if (links.len > 0) {
        w.writeAll("\n") catch {};
        appendLinkIndex(&buf, links, color, allocator);
    }

    return buf.toOwnedSlice(allocator) catch "";
}

fn appendLinkIndex(buf: *std.ArrayList(u8), links: []const []const u8, color: bool, allocator: std.mem.Allocator) void {
    const w = buf.writer(allocator);
    if (links.len == 0) return;
    if (color) {
        w.writeAll("\n\x1b[2m───── Links ─────\x1b[0m\n") catch {};
    } else {
        w.writeAll("\n----- Links -----\n") catch {};
    }
    for (links, 1..) |link, num| {
        if (color) {
            w.print("  \x1b[33m[{d}]\x1b[0m \x1b[4m{s}\x1b[0m\n", .{ num, link }) catch {};
        } else {
            w.print("  [{d}] {s}\n", .{ num, link }) catch {};
        }
    }
}

fn formatLinkIndex(links: []const []const u8, color: bool, allocator: std.mem.Allocator) []const u8 {
    var buf: std.ArrayList(u8) = .empty;
    appendLinkIndex(&buf, links, color, allocator);
    return buf.toOwnedSlice(allocator) catch "";
}

const MdLink = struct {
    text: []const u8,
    url: []const u8,
    end: usize,
};

fn parseMdLink(md: []const u8, start: usize) ?MdLink {
    if (start >= md.len or md[start] != '[') return null;
    const text_end = std.mem.indexOfScalarPos(u8, md, start + 1, ']') orelse return null;
    if (text_end + 1 >= md.len or md[text_end + 1] != '(') return null;
    const url_end = std.mem.indexOfScalarPos(u8, md, text_end + 2, ')') orelse return null;
    return .{
        .text = md[start + 1 .. text_end],
        .url = md[text_end + 2 .. url_end],
        .end = url_end + 1,
    };
}

fn findLinkNum(links: []const []const u8, url: []const u8, fallback: usize) usize {
    for (links, 1..) |link, num| {
        if (std.mem.eql(u8, link, url)) return num;
    }
    return fallback;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn readLine(file: std.fs.File, buf: []u8) ?[]const u8 {
    var i: usize = 0;
    while (i < buf.len) {
        const bytes_read = file.read(buf[i .. i + 1]) catch return null;
        if (bytes_read == 0) {
            if (i == 0) return null; // EOF with no data
            return buf[0..i];
        }
        if (buf[i] == '\n') return buf[0..i];
        i += 1;
    }
    return buf[0..i]; // buffer full
}

fn truncateUrl(url: []const u8, max: usize) []const u8 {
    if (url.len <= max) return url;
    return url[0..max];
}

fn shouldUseColor() bool {
    if (std.posix.getenv("NO_COLOR")) |v| {
        if (v.len > 0) return false;
    }
    if (std.posix.getenv("TERM")) |term| {
        if (std.mem.eql(u8, term, "dumb")) return false;
    }
    return std.posix.isatty(std.fs.File.stderr().handle);
}

fn elapsed(start: i128) u64 {
    const diff = std.time.nanoTimestamp() - start;
    return if (diff > 0) @as(u64, @intCast(diff)) / std.time.ns_per_ms else 0;
}

fn matchIgnoreCase(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |ca, cb| {
        if (std.ascii.toLower(ca) != std.ascii.toLower(cb)) return false;
    }
    return true;
}

fn indexOfIgnoreCase(haystack: []const u8, start: usize, needle: []const u8) ?usize {
    if (needle.len == 0) return null;
    if (start + needle.len > haystack.len) return null;
    var i = start;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (matchIgnoreCase(haystack[i .. i + needle.len], needle)) return i;
    }
    return null;
}

fn printReplHelp(color: bool) void {
    _ = color;
    std.debug.print(
        \\
        \\  🌰 kuri-browse commands
        \\
        \\  <number>          Follow link [N]
        \\  <url>             Navigate to URL (if contains '.')
        \\  :go <url>         Navigate to URL
        \\  :back, :b         Go back
        \\  :forward, :f      Go forward
        \\  :reload, :r       Reload current page
        \\  :links, :l        Show link index
        \\  :search <t>, /t   Search in page
        \\  :n, :next         Next search match (re-highlights)
        \\  :history, :hist   Show history
        \\  :help, :h         Show this help
        \\  :quit, :q         Exit
        \\
    , .{});
}

fn printUsage() void {
    std.debug.print(
        \\
        \\  kuri-browse 🌰 — interactive terminal browser
        \\
        \\  USAGE
        \\    kuri-browse [url]       Open a URL and browse interactively
        \\    kuri-browse             Start with no page (type :go <url>)
        \\
        \\  OPTIONS
        \\    -V, --version              Print version and exit
        \\    -h, --help                 Show this help
        \\
        \\  INTERACTIVE COMMANDS
        \\    <number>          Follow link [N]
        \\    <url>             Navigate (if it contains '.')
        \\    :go <url>         Navigate to URL
        \\    :back             Go back in history
        \\    :forward          Go forward in history
        \\    :reload           Re-fetch current page
        \\    :links            Show all page links
        \\    /search-term      Search in page
        \\    :help             Show all commands
        \\    :quit             Exit
        \\
        \\  ENVIRONMENT
        \\    NO_COLOR          Disable colored output (https://no-color.org)
        \\
    , .{});
}

// ─── HTTP fetch ─────────────────────────────────────────────────────────────

fn fetchHttp(allocator: std.mem.Allocator, url: []const u8, ua: []const u8) ![]const u8 {
    var client: std.http.Client = .{ .allocator = allocator };
    defer client.deinit();

    const uri = try std.Uri.parse(url);

    var req = try client.request(.GET, uri, .{
        .extra_headers = &.{
            .{ .name = "User-Agent", .value = ua },
            .{ .name = "Accept", .value = "text/html,application/xhtml+xml,*/*" },
            .{ .name = "Accept-Encoding", .value = "gzip, deflate" },
        },
    });
    defer req.deinit();

    try req.sendBodiless();

    var redirect_buf: [8192]u8 = undefined;
    var response = try req.receiveHead(&redirect_buf);

    if (response.head.status != .ok) {
        std.debug.print("HTTP {d}\n", .{@intFromEnum(response.head.status)});
        return error.HttpError;
    }

    var body: std.ArrayList(u8) = .empty;
    var transfer_buf: [8192]u8 = undefined;
    var decompress: std.http.Decompress = undefined;
    var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
    const reader = response.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);
    try reader.appendRemainingUnlimited(allocator, &body);

    return body.items;
}

/// Extract all href values from <a> tags in HTML.
fn extractLinksFromHtml(html: []const u8, allocator: std.mem.Allocator, links: *std.ArrayList([]const u8)) !void {
    var i: usize = 0;

    while (i < html.len) {
        const tag_start = std.mem.indexOfPos(u8, html, i, "<a ") orelse
            std.mem.indexOfPos(u8, html, i, "<a\t") orelse
            std.mem.indexOfPos(u8, html, i, "<A ") orelse
            std.mem.indexOfPos(u8, html, i, "<A\t") orelse break;

        const tag_end = std.mem.indexOfScalarPos(u8, html, tag_start, '>') orelse break;
        const tag = html[tag_start..tag_end];

        if (findAttrValue(tag, "href")) |href| {
            if (href.len > 0 and !std.mem.startsWith(u8, href, "javascript:") and !std.mem.startsWith(u8, href, "mailto:")) {
                try links.append(allocator, href);
            }
        }
        i = tag_end + 1;
    }
}

fn findAttrValue(tag: []const u8, attr: []const u8) ?[]const u8 {
    var pos: usize = 0;
    while (pos < tag.len) {
        const attr_pos = std.mem.indexOfPos(u8, tag, pos, attr) orelse return null;
        const eq_pos = attr_pos + attr.len;
        if (eq_pos >= tag.len) return null;

        var j = eq_pos;
        while (j < tag.len and tag[j] == ' ') : (j += 1) {}
        if (j >= tag.len or tag[j] != '=') {
            pos = attr_pos + 1;
            continue;
        }
        j += 1;
        while (j < tag.len and tag[j] == ' ') : (j += 1) {}
        if (j >= tag.len) return null;

        const quote = tag[j];
        if (quote == '"' or quote == '\'') {
            const start = j + 1;
            const end = std.mem.indexOfScalarPos(u8, tag, start, quote) orelse return null;
            return tag[start..end];
        } else {
            const start = j;
            var end = start;
            while (end < tag.len and tag[end] != ' ' and tag[end] != '>' and tag[end] != '\t') : (end += 1) {}
            return tag[start..end];
        }
    }
    return null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test "History push and back" {
    var history = History.init(std.testing.allocator);
    defer history.deinit();

    history.push("https://a.com");
    history.push("https://b.com");
    history.push("https://c.com");

    try std.testing.expectEqualStrings("https://b.com", history.back().?);
    try std.testing.expectEqualStrings("https://a.com", history.back().?);
    try std.testing.expect(history.back() == null);
}

test "History forward" {
    var history = History.init(std.testing.allocator);
    defer history.deinit();

    history.push("https://a.com");
    history.push("https://b.com");

    _ = history.back();
    try std.testing.expectEqualStrings("https://b.com", history.forward().?);
    try std.testing.expect(history.forward() == null);
}

test "History push truncates forward" {
    var history = History.init(std.testing.allocator);
    defer history.deinit();

    history.push("https://a.com");
    history.push("https://b.com");
    history.push("https://c.com");

    _ = history.back(); // at b
    _ = history.back(); // at a

    history.push("https://d.com"); // truncates b,c
    try std.testing.expect(history.forward() == null);
    try std.testing.expectEqualStrings("https://a.com", history.back().?);
}

test "parseMdLink" {
    const link = parseMdLink("[Example](https://example.com)", 0);
    try std.testing.expect(link != null);
    try std.testing.expectEqualStrings("Example", link.?.text);
    try std.testing.expectEqualStrings("https://example.com", link.?.url);
}

test "parseMdLink no link" {
    try std.testing.expect(parseMdLink("just text", 0) == null);
}

test "indexOfIgnoreCase" {
    try std.testing.expectEqual(@as(?usize, 0), indexOfIgnoreCase("Hello World", 0, "hello"));
    try std.testing.expectEqual(@as(?usize, 6), indexOfIgnoreCase("Hello World", 0, "world"));
    try std.testing.expect(indexOfIgnoreCase("Hello", 0, "xyz") == null);
}

test "extractLinksFromHtml filters javascript:" {
    var links: std.ArrayList([]const u8) = .empty;
    try extractLinksFromHtml("<a href=\"javascript:void(0)\">x</a><a href=\"https://ok.com\">ok</a>", std.testing.allocator, &links);
    defer links.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), links.items.len);
    try std.testing.expectEqualStrings("https://ok.com", links.items[0]);
}

test "renderColoredMarkdown headings" {
    const md = "# Hello\n\nWorld";
    const result = renderColoredMarkdown(md, &.{}, false, null, std.testing.allocator);
    defer std.testing.allocator.free(result);
    try std.testing.expect(std.mem.indexOf(u8, result, "# Hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "World") != null);
}

test "renderColoredMarkdown links numbered" {
    const md = "[Click](https://example.com)";
    const links = [_][]const u8{"https://example.com"};
    const result = renderColoredMarkdown(md, &links, false, null, std.testing.allocator);
    defer std.testing.allocator.free(result);
    try std.testing.expect(std.mem.indexOf(u8, result, "Click") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "[1]") != null);
}

test "renderColoredMarkdown search highlight" {
    const md = "Hello World";
    const result = renderColoredMarkdown(md, &.{}, false, "World", std.testing.allocator);
    defer std.testing.allocator.free(result);
    try std.testing.expect(std.mem.indexOf(u8, result, ">>World<<") != null);
}

test {
    _ = @import("crawler/markdown.zig");
}
