//! The terms step of setting up (screens/onboarding.zig): the short version, the documents a click away, the choice to
//! share with other Unbrowse users or keep everything on this computer, and the yes. The node holds off joining until
//! it is answered (`terms::standing`), and the step comes back whenever the node carries a newer version. The documents'
//! words are the node's (`terms_text`), since the node updates by itself and can be newer than this window.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const App = @import("../app.zig").App;
const onboarding = @import("onboarding.zig");

/// The terms step of setting up (screens/onboarding.zig): the short version first, the documents a click away, the
/// choice to share or not, and the yes. Only pressing Agree and continue answers it: seeing it sends nothing.
pub fn body(a: *App, c: *ui.Context) void {
    if (!a.terms_asked) {
        a.terms_asked = true;
        a.store.fetch(.terms_text);
    }
    const x = look.x(c);
    const text = a.store.get(.terms_text);
    {
        const words = ui.div(c).column().wFull().gap(8);
        defer words.end();
        look.title(c, "The short version");
        onboarding.point(c, "Unbrowse runs on this computer. Your logins, keys and money stay with you.");
        onboarding.point(c, "With sharing on, what your Unbrowse learns about a site can help other people's AI, and you earn when they use it.");
        onboarding.point(c, "What it does on the sites it visits is your responsibility, as with your own browser.");
    }
    {
        const r = ui.div(c).row().wFull().gap(10).itemsCenter();
        defer r.end();
        if (look.ghost(c, if (a.terms_open) "Hide the full terms" else "Read the full terms and privacy notice", .{ .size = .sm })) a.terms_open = !a.terms_open;
        ui.spacer(c);
        if (text) |t| ui.text(c, c.print("Version {s}", .{t.version}), .{ .size = 12, .color = x.text3 });
    }
    if (a.terms_open) {
        const sheet = ui.div(c).column().h(280).wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(12).clip();
        defer sheet.end();
        {
            const head = ui.div(c).row().wFull().px(14).py(10).gap(12).itemsCenter();
            defer head.end();
            _ = ui.segmented(c, &.{ "Terms of Service", "Privacy Policy" }, &a.terms_tab);
        }
        look.rule(c);
        const box = ui.div(c).column().grow().wFull().minW(0).scrollY().px(18).py(14).gap(10);
        defer box.end();
        if (text) |t| document(c, if (a.terms_tab == 0) t.terms else t.privacy) else if (a.store.err(.terms_text)) |e| look.failText(c, e) else look.body(c, "Reading the terms\u{2026}");
    }
    var share = !a.keepOff();
    {
        const r = ui.div(c).row().wFull().gap(12).itemsCenter();
        defer r.end();
        if (ui.checkbox(c, "Share what my Unbrowse learns with other Unbrowse users", &share)) a.keep_off = !share;
    }
    look.small(c, if (share) "You can turn sharing off at any time in Settings." else "Everything stays on this computer, and your AI apps work just the same.");
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const r = ui.div(c).row().wFull().gap(12).itemsCenter();
        defer r.end();
        if (a.new_node orelse false) {
            if (look.secondary(c, "Back", .{})) a.onboardGo(.back, .terms);
        }
        // No answer can be given to terms that weren't there to read.
        if (look.primary(c, "Agree and continue", .{ .size = .md, .disabled = text == null, .loading = a.store.isBusy("accept_terms") })) a.acceptTerms();
        look.small(c, "Agreeing records that you were shown these terms.");
    }
}

/// A document as written in Markdown, its lines wrapped by hand: each paragraph and list item runs together and wraps
/// to the window, and its headings stand out.
fn document(c: *ui.Context, text: []const u8) void {
    var blocks = std.mem.tokenizeSequence(u8, text, "\n\n");
    while (blocks.next()) |block| {
        const b = std.mem.trim(u8, block, " \n");
        if (std.mem.startsWith(u8, b, "#")) {
            ui.text(c, std.mem.trimStart(u8, b, "# "), .{ .size = 14, .weight = .semibold, .wrap = true });
            continue;
        }
        var start: usize = 0;
        while (start < b.len) {
            const end = if (std.mem.indexOfPos(u8, b, start + 1, "\n- ")) |i| i else b.len;
            const part = c.alloc().dupe(u8, b[start..end]) catch return;
            std.mem.replaceScalar(u8, part, '\n', ' ');
            const line = std.mem.trim(u8, part, " ");
            // A list item keeps its mark, drawn as one.
            const plain = readable(c.alloc(), line);
            if (std.mem.startsWith(u8, plain, "- ")) look.body(c, c.print("\u{2022}  {s}", .{plain[2..]})) else look.body(c, plain);
            start = end + 1;
        }
    }
}

/// A line of Markdown as a reader reads it: a link `[words](target)` is its words, and code in backticks loses them.
pub fn readable(alloc: std.mem.Allocator, line: []const u8) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < line.len) {
        const ch = line[i];
        if (ch == '`') {
            i += 1;
            continue;
        }
        if (ch == '[') {
            if (std.mem.indexOfScalarPos(u8, line, i + 1, ']')) |close| {
                if (close + 1 < line.len and line[close + 1] == '(') {
                    if (std.mem.indexOfScalarPos(u8, line, close + 2, ')')) |end| {
                        out.appendSlice(alloc, line[i + 1 .. close]) catch return line;
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        out.append(alloc, ch) catch return line;
        i += 1;
    }
    return out.items;
}

test "a link reads as its words and code loses its backticks" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings("the Apache License 2.0 (LICENSE); run unbrowse-node terms accept", readable(arena.allocator(), "the Apache License 2.0 ([LICENSE](LICENSE)); run `unbrowse-node terms accept`"));
    try std.testing.expectEqualStrings("a [bracket] stays", readable(arena.allocator(), "a [bracket] stays"));
}
