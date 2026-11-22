//! First run: the terms and the choice to stay off the network, before anything else the window shows. The node holds
//! off joining until it is answered (`terms::standing`), and it comes back whenever the node carries a newer version.
//! Only pressing Open my node answers it: seeing it sends nothing. The words are the node's (`terms_text`), since the
//! node updates by itself and can be newer than this window. Answering it goes on to Connect your agents (the shell's
//! next screen in line, `shell.front`) and then to Home.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const art = @import("../art.zig");
const App = @import("../app.zig").App;

pub fn view(a: *App, c: *ui.Context) void {
    if (!a.terms_asked) {
        a.terms_asked = true;
        a.store.fetch(.terms_text);
    }
    const x = look.x(c);
    // One column on the canvas, as wide as a page of terms reads, the terms on a sheet in it: /link's card, grown.
    const page = ui.div(c).column().sizeFull().bg(x.canvas).px(32).pt(46).pb(28).itemsCenter();
    defer page.end();
    const col = ui.div(c).column().wFull().maxW(680).grow().gap(16);
    defer col.end();
    {
        const brand = ui.div(c).row().gap(8).itemsCenter();
        defer brand.end();
        art.mark(c, 24);
        ui.text(c, "Unbrowse", .{ .size = 17, .weight = .semibold });
    }
    {
        const words = ui.div(c).column().wFull().gap(6);
        defer words.end();
        look.title(c, "Before your node joins the network");
        look.body(c, "Routes go straight between nodes run by other people. What your node shares, serves and calls is your responsibility, not Unbrowse's.");
    }
    const text = a.store.get(.terms_text);
    {
        const sheet = ui.div(c).column().grow().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(16).shadowMd().clip();
        defer sheet.end();
        {
            const head = ui.div(c).row().wFull().px(16).py(12).gap(12).itemsCenter();
            defer head.end();
            _ = ui.segmented(c, &.{ "Terms of Service", "Privacy Policy" }, &a.terms_tab);
            ui.spacer(c);
            if (text) |t| ui.text(c, c.print("Version {s}", .{t.version}), .{ .size = 12, .color = x.text3 });
        }
        look.rule(c);
        const box = ui.div(c).column().grow().wFull().minW(0).scrollY().px(20).py(16).gap(10);
        defer box.end();
        if (text) |t| document(c, if (a.terms_tab == 0) t.terms else t.privacy) else if (a.store.err(.terms_text)) |e| look.failText(c, e) else look.body(c, "Reading the terms…");
    }
    var off = a.keepOff();
    {
        const r = ui.div(c).row().wFull().gap(12).itemsCenter();
        defer r.end();
        if (ui.checkbox(c, "Keep my node off the network", &off)) a.keep_off = off;
        if (off) look.small(c, "Routes stay on this computer and your agents keep working.");
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const r = ui.div(c).row().wFull().gap(12).itemsCenter();
        defer r.end();
        // No answer can be given to terms that weren't there to read.
        if (look.primary(c, "Open my node", .{ .size = .md, .disabled = text == null, .loading = a.store.isBusy("accept_terms") })) a.acceptTerms();
        look.small(c, "Opening your node records that you were shown these terms.");
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
            if (std.mem.startsWith(u8, line, "- ")) look.body(c, c.print("\u{2022}  {s}", .{line[2..]})) else look.body(c, line);
            start = end + 1;
        }
    }
}
