//! The look: Quartz's light palette (the film's ink #1F2550 on white, a cool canvas behind) as a nanoui theme, its
//! dark twin, the painted landing page's motion, and the few parts every screen is made of: page headers, panels,
//! rows, status words, wells and tables.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const Color = ui.Color;
const motion = ui.motion;

// ---- motion ----
// The painted landing's motion identity (landing-painted's motion.tsx): one curve, three durations, one entrance.
// Everything here moves only when it arrives or changes; nothing loops at rest. With reduced motion, ui.motion jumps.

/// The one curve: cubic-bezier(.16, 1, .3, 1), quick out of the gate and landing softly.
pub const ease: motion.Easing = .{ .bezier = .{ 0.16, 1, 0.3, 1 } };
/// 160 ms: a control answering.
pub const quick: motion.Transition = .{ .tween = .{ .duration = 0.16, .ease = ease } };
/// 320 ms: a value changing, so the change reads as a change.
pub const change: motion.Transition = .{ .tween = .{ .duration = 0.32, .ease = ease } };
/// 700 ms: the entrance.
pub const arrive: motion.Transition = .{ .tween = .{ .duration = 0.7, .ease = ease } };

/// How many boxes have risen this frame: each waits 40 ms more than the one before, up to 200 ms, as the landing's
/// lists cascade. The shell resets it at the top of every frame.
var risen: usize = 0;

pub fn newFrame() void {
    risen = 0;
}

/// The entrance, for the next box: 14 points up and faded the first time it is drawn, rising into place. A box seen
/// before stays where it is, so only what arrives moves: a screen opened, a row new to the list.
pub fn rise(c: *ui.Context) motion.Frame {
    const i = @min(risen, 5);
    risen += 1;
    return motion.frame(c, .{ .initial = .{ .y = 14, .opacity = 0 }, .delay = motion.stagger(i, 0.04), .transition = arrive });
}

/// Colors the theme has no field for.
pub const Extra = struct {
    canvas: Color,
    well: Color,
    frame: Color,
    hair: Color,
    text2: Color,
    text3: Color,
    run: Color,
    warn: Color,
    fail_text: Color,
    selected: Color,
    /// A panel's outer frame, the grey its header sits on: lighter than the well (Quartz's --surface-frame).
    panel: Color,
};

const ink = Color.hex(0x1f2550);
const cream = Color.hex(0xfbf8f0);

pub const light: ui.Theme = .{
    .dark = false,
    .background = .hex(0xf4f6fb),
    .surface = .white,
    .surface_hover = ink.alpha(0.05),
    .text = ink,
    .muted = ink.alpha(0.66),
    .border = ink.alpha(0.16),
    .accent = ink,
    .accent_hover = .hex(0x323a6e),
    .accent_text = .white,
    .track = .hex(0xd5d8e4),
    .knob = .white,
    .danger = .hex(0xd9412f),
    .success = .hex(0x2c8a62),
    .shadow = ink.alpha(0.12),
};

pub const dark: ui.Theme = .{
    .dark = true,
    .background = .hex(0x14183b),
    .surface = .hex(0x1f2550),
    .surface_hover = cream.alpha(0.08),
    .text = cream,
    .muted = cream.alpha(0.66),
    .border = cream.alpha(0.18),
    .accent = cream,
    .accent_hover = .hex(0xe6e2d6),
    .accent_text = ink,
    .track = .hex(0x3a4176),
    .knob = cream,
    .danger = .hex(0xec5a48),
    .success = .hex(0x4cc08e),
    .shadow = Color.black.alpha(0.45),
};

const extra_light: Extra = .{
    .canvas = .hex(0xf4f6fb),
    .well = .hex(0xeef1f8),
    .frame = ink.alpha(0.14),
    .hair = ink.alpha(0.08),
    .text2 = ink.alpha(0.80),
    .text3 = ink.alpha(0.66),
    .run = .hex(0x2f55d8),
    .warn = .hex(0x8a5a0a),
    .fail_text = .hex(0xb3302a),
    .selected = ink.alpha(0.09),
    .panel = .hex(0xf5f7fb),
};

const extra_dark: Extra = .{
    .canvas = .hex(0x14183b),
    .well = .hex(0x272e63),
    .frame = cream.alpha(0.20),
    .hair = cream.alpha(0.10),
    .text2 = cream.alpha(0.80),
    .text3 = cream.alpha(0.66),
    .run = .hex(0x7fa4ff),
    .warn = .hex(0xe8b45a),
    .fail_text = .hex(0xf08a7c),
    .selected = cream.alpha(0.12),
    .panel = .hex(0x232a5a),
};

/// The palette for the system's appearance: the window's theme follows it,
/// and the view swaps in Quartz's colors at the top of every frame.
pub fn apply(c: *ui.Context) void {
    c.theme = if (c.theme.dark) dark else light;
}

pub fn x(c: *ui.Context) Extra {
    return if (c.theme.dark) extra_dark else extra_light;
}

// ---- type ----

pub fn title(c: *ui.Context, s: []const u8) void {
    ui.text(c, s, .{ .size = 24, .weight = .semibold });
}

pub fn body(c: *ui.Context, s: []const u8) void {
    ui.text(c, s, .{ .size = 13.5, .color = x(c).text2, .wrap = true, .leading = 1.25 });
}

pub fn small(c: *ui.Context, s: []const u8) void {
    ui.text(c, clip(c, s), .{ .size = 12, .color = x(c).text3, .wrap = true });
}

/// The most of a line of words a screen draws. What the node says can be as long as what a site sent it (a call's error
/// can hold a whole page), and wrapping that every frame stalls the window; the whole of it stays in the node's log.
pub const most_shown = 600;

/// `s`, or its first `most_shown` bytes cut where a character starts, with "…".
pub fn clip(c: *ui.Context, s: []const u8) []const u8 {
    return clipTo(c, s, most_shown);
}

/// `s`, or its first `n` bytes cut where a character starts, with "…": a reason short enough for one line of a row.
pub fn clipTo(c: *ui.Context, s: []const u8, n: usize) []const u8 {
    if (s.len <= n) return s;
    var end: usize = n;
    while (end > 0 and s[end] & 0xC0 == 0x80) end -= 1;
    return c.print("{s}\u{2026}", .{s[0..end]});
}

pub fn label(c: *ui.Context, s: []const u8) void {
    ui.text(c, s, .{ .size = 13, .weight = .medium });
}

pub fn mono(c: *ui.Context, s: []const u8, color: ?Color) void {
    ui.text(c, s, .{ .size = 12, .mono = true, .color = color orelse x(c).text3 });
}

pub fn failText(c: *ui.Context, s: []const u8) void {
    ui.text(c, clip(c, s), .{ .size = 13, .color = x(c).fail_text, .wrap = true });
}

// ---- page ----

/// A page header: the title, its description, and room on the right for
/// actions (draw them, then `end`).
pub const Header = struct {
    row: ui.Div,
    pub fn end(h: Header) void {
        h.row.end();
    }
};

pub fn header(c: *ui.Context, t: []const u8, description: []const u8) Header {
    const f = rise(c);
    const r = ui.div(c).row().wFull().gap(16).itemsStart().motion(f);
    {
        const words = ui.div(c).column().grow().gap(6).maxW(720);
        defer words.end();
        title(c, t);
        body(c, description);
    }
    ui.spacer(c);
    return .{ .row = r };
}

/// A panel, as Quartz's: a grey frame with its header on the grey and the
/// content in one white group 4px inside it. Draw the body, then `end`.
pub const Panel = struct {
    box: ui.Div,
    /// Ends the body `panelBody` opened, then the frame.
    pub fn end(p: Panel) void {
        p.box.c.end();
        p.box.end();
    }
};

/// Opens a panel and its header row (title, meta, then whatever the caller
/// puts on the right); `panelBody` closes the header and opens the body,
/// then `end`.
pub fn panel(c: *ui.Context, t: []const u8, meta: []const u8) Panel {
    const box = frame(c);
    head(c, t, meta);
    return .{ .box = box };
}

/// Ends a panel's header row and opens its white body: what follows is in it.
pub fn panelBody(c: *ui.Context) void {
    c.end();
    _ = inset(c);
}

/// A panel that fills the height its column gives it, its body growing with it: one beside taller panels.
pub fn panelFill(c: *ui.Context, t: []const u8, meta: []const u8) Panel {
    const box = frame(c).grow();
    head(c, t, meta);
    return .{ .box = box };
}

/// `panelBody` for a `panelFill`.
pub fn panelBodyFill(c: *ui.Context) void {
    c.end();
    _ = inset(c).grow();
}

/// The grey frame of a panel or a table; 4px of it shows around the white body.
fn frame(c: *ui.Context) ui.Div {
    const f = rise(c);
    return ui.div(c).column().wFull().bg(x(c).panel).border(x(c).frame).rounded(10).px(4).pb(4).clip().motion(f);
}

/// A frame's 40px header on the grey, with no rule under it: the title, then its meta, quieter. Left open for an
/// action on the right.
fn head(c: *ui.Context, t: []const u8, meta: []const u8) void {
    _ = ui.div(c).row().wFull().px(8).h(40).gap(8).itemsCenter();
    ui.text(c, t, .{ .size = 13.5, .weight = .medium });
    if (meta.len > 0) ui.text(c, meta, .{ .size = 13, .color = x(c).text3 });
    ui.spacer(c);
}

/// The white group inside a frame, its corner the frame's less the gap.
fn inset(c: *ui.Context) ui.Div {
    return ui.div(c).column().wFull().bg(c.theme.surface).border(x(c).hair).rounded(8).clip();
}

/// A padded column inside a panel's body.
pub fn pad(c: *ui.Context) ui.Div {
    return ui.div(c).column().wFull().p(16).gap(12);
}

/// One item of a list in a panel: words on the left, the rest on the right.
pub const Item = struct {
    row: ui.Div,
    words: ui.Div,
    /// Ends the words: what follows sits on the right.
    pub fn right(it: Item) void {
        it.words.end();
    }
    pub fn end(it: Item) void {
        it.row.end();
    }
};

pub fn item(c: *ui.Context, key: []const u8, t: []const u8, description: []const u8) Item {
    ui.key(c, key);
    const f = rise(c);
    const r = ui.div(c).row().wFull().px(16).py(10).gap(12).itemsCenter().motion(f);
    const w = ui.div(c).column().grow().gap(2);
    ui.text(c, clip(c, t), .{ .size = 13.5, .weight = .medium, .wrap = true });
    if (description.len > 0) ui.text(c, clip(c, description), .{ .size = 12.5, .color = x(c).text2, .wrap = true });
    return .{ .row = r, .words = w };
}

pub fn rule(c: *ui.Context) void {
    const d = ui.div(c).wFull().h(1).bg(x(c).hair);
    d.end();
}

pub fn empty(c: *ui.Context, s: []const u8) void {
    const d = ui.div(c).wFull().p(16);
    defer d.end();
    body(c, s);
}

/// The rows a long table shows at a time.
pub const per_page = 25;

/// How many pages `n` rows take: none for none.
pub fn pages(n: usize) usize {
    return pagesBy(n, per_page);
}

/// How many pages `n` rows take at `per` to a page: none for none.
pub fn pagesBy(n: usize, per: usize) usize {
    return (n + per - 1) / per;
}

pub const Rows = struct { from: usize, to: usize };

/// The rows of `n` that page `page` shows. A page past the end (a delete, a narrower search) becomes the last one there is.
pub fn pageRows(page: *usize, n: usize) Rows {
    return pageRowsBy(page, n, per_page);
}

/// The rows of `n` that page `page` shows at `per` to a page, for a list whose rows are shorter or taller than a
/// table's (a log's lines, a row of tabs).
pub fn pageRowsBy(page: *usize, n: usize, per: usize) Rows {
    page.* = @min(page.*, pagesBy(n, per) -| 1);
    const from = page.* * per;
    return .{ .from = from, .to = @min(from + per, n) };
}

/// Under a table of `n` rows: which this page shows, of how many, and the pages to move to. Nothing for one page.
pub fn pager(c: *ui.Context, key: []const u8, page: *usize, rows: Rows, n: usize) void {
    pagerBy(c, key, page, rows, n, per_page);
}

/// `pager` for a list of `per` to a page.
pub fn pagerBy(c: *ui.Context, key: []const u8, page: *usize, rows: Rows, n: usize, per: usize) void {
    if (pagesBy(n, per) < 2) return;
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    small(c, c.print("Showing {s}\u{2013}{s} of {s}", .{ count(c, rows.from + 1), count(c, rows.to), count(c, n) }));
    ui.spacer(c);
    ui.key(c, key);
    _ = kit.pagination(c, page, pagesBy(n, per));
}

fn count(c: *ui.Context, n: usize) []const u8 {
    return @import("fmt.zig").count(c.alloc(), @floatFromInt(n));
}

/// A table's count: "15 of 30" while a search narrows it.
pub fn countOf(c: *ui.Context, shown: usize, all: usize, searching: bool) []const u8 {
    return if (searching) c.print("{s} of {s}", .{ count(c, shown), count(c, all) }) else count(c, all);
}

/// A search over a table: typing narrows it and goes back to the first page; Clear shows all again.
pub fn search(c: *ui.Context, key: []const u8, q: *ui.TextBuffer, page: *usize, hint: []const u8, focus: ?*bool) void {
    const r = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer r.end();
    ui.key(c, key);
    if (focus) |f| if (f.*) {
        c.focus = c.peekId(null);
        f.* = false;
    };
    if (ui.textField(c, q, .{ .width = .{ .px = 420 }, .placeholder = hint }).changed) page.* = 0;
    if (q.len > 0 and ghost(c, "Clear", .{ .size = .sm })) {
        q.clear();
        page.* = 0;
    }
}

/// Whether every word of `query` is in one of `fields`, in any case. A search of no words finds everything.
pub fn findsAll(fields: []const []const u8, query: []const u8) bool {
    var words = std.mem.tokenizeAny(u8, query, " \t\r\n");
    while (words.next()) |w| {
        var found = false;
        for (fields) |f| found = found or std.ascii.findIgnoreCase(f, w) != null;
        if (!found) return false;
    }
    return true;
}

/// A grey well for code and setup strings.
pub fn well(c: *ui.Context, s: []const u8) void {
    const d = ui.div(c).wFull().p(12).rounded(8).bg(x(c).well);
    defer d.end();
    ui.text(c, s, .{ .size = 12, .mono = true, .wrap = true, .leading = 1.3 });
}

// ---- status ----

pub const Status = enum { ok, fail, idle, running, warn };

/// A status word with its dot, as Quartz's Status.
pub fn status(c: *ui.Context, s: Status, word: []const u8) void {
    const col = switch (s) {
        .ok => c.theme.success,
        .fail => c.theme.danger,
        .idle => x(c).text3,
        .running => x(c).run,
        .warn => Color.hex(0xd99a1e),
    };
    const r = ui.div(c).row().minW(0).gap(6).itemsCenter();
    defer r.end();
    const dot = ui.div(c).w(7).h(7).roundedFull().bg(col);
    dot.end();
    ui.text(c, word, .{ .size = 12.5, .weight = .medium, .color = if (s == .fail) x(c).fail_text else x(c).text2, .wrap = true });
}

/// A small chip: a count or a word.
pub fn chip(c: *ui.Context, s: []const u8, warn: bool) void {
    const d = ui.div(c).px(8).py(2).rounded(4).bg(if (warn) Color.hex(0xd99a1e).alpha(0.18) else x(c).selected);
    defer d.end();
    ui.text(c, s, .{ .size = 11.5, .weight = .medium, .color = if (warn) x(c).warn else c.theme.text });
}

/// A switch, on in ink as Quartz's (the theme's success green is for status).
pub fn toggle(c: *ui.Context, v: *bool) bool {
    const saved = c.theme;
    defer c.theme = saved;
    c.theme.success = c.theme.accent;
    if (c.theme.dark) c.theme.knob = c.theme.accent_text;
    return ui.toggle(c, "", v);
}

// ---- buttons ----

pub fn primary(c: *ui.Context, s: []const u8, opts: struct { disabled: bool = false, loading: bool = false, size: kit.Size = .sm }) bool {
    return kit.button(c, s, .{ .variant = .primary, .size = opts.size, .disabled = opts.disabled, .loading = opts.loading }).clicked;
}

pub fn secondary(c: *ui.Context, s: []const u8, opts: struct { disabled: bool = false, loading: bool = false, size: kit.Size = .sm }) bool {
    return kit.button(c, s, .{ .variant = .default, .size = opts.size, .disabled = opts.disabled, .loading = opts.loading }).clicked;
}

pub fn ghost(c: *ui.Context, s: []const u8, opts: struct { disabled: bool = false, size: kit.Size = .xs }) bool {
    return kit.button(c, s, .{ .variant = .ghost, .size = opts.size, .disabled = opts.disabled }).clicked;
}

pub fn danger(c: *ui.Context, s: []const u8, opts: struct { disabled: bool = false, loading: bool = false }) bool {
    return kit.button(c, s, .{ .variant = .danger, .size = .sm, .disabled = opts.disabled, .loading = opts.loading }).clicked;
}

// ---- tables ----

/// A column of a table: its width (0 grows) and whether it's right-aligned.
pub const Col = struct { name: []const u8, w: f32 = 0, end: bool = false };

/// A table: its frame, the title on the grey, and the rows in the white body
/// under their column names; `end` closes both.
pub const Table = struct {
    box: ui.Div,
    pub fn end(t: Table) void {
        t.box.c.end();
        t.box.end();
    }
};

/// The width a table on the sheet has: the window's, less the sidebar and the sheet's padding. A table with more
/// columns than fit picks a narrower set by it, so nothing is pushed past the window's edge.
pub fn tableWidth(c: *ui.Context) f32 {
    return c.size.w - 216 - 92;
}

/// A table's frame and header row; rows go in with `cell`.
pub fn tableHead(c: *ui.Context, t: []const u8, n: []const u8, cols: []const Col) Table {
    return tableHeadAction(c, t, n, cols, "", null);
}

/// A table with a button in its header; `clicked` says whether it was.
pub fn tableHeadAction(c: *ui.Context, t: []const u8, n: []const u8, cols: []const Col, action: []const u8, clicked: ?*bool) Table {
    const box = frame(c);
    head(c, t, n);
    if (action.len > 0) {
        const hit = secondary(c, action, .{ .size = .xs });
        if (clicked) |p| p.* = hit;
    }
    c.end();
    _ = inset(c);
    const r = ui.div(c).row().wFull().px(12).py(8).gap(12);
    defer r.end();
    for (cols) |col| {
        const cell = cellBox(c, col);
        defer cell.end();
        ui.text(c, col.name, .{ .size = 12, .weight = .medium, .color = x(c).text3 });
    }
    return .{ .box = box };
}

/// A table cell's box for `col`.
pub fn cellBox(c: *ui.Context, col: Col) ui.Div {
    var d = ui.div(c).column().gap(2);
    d = if (col.w == 0) d.grow().minW(0).clip() else d.w(col.w);
    if (col.end) d = d.itemsEnd();
    return d;
}

/// A table's row, keyed; then its cells with `cellBox`.
pub fn tableRow(c: *ui.Context, key: []const u8, failing: bool) ui.Div {
    rule(c);
    // Keyed by what it shows, so a row new to the table (the next page, a search) rises in, and one seen stays put.
    ui.key(c, key);
    const f = rise(c);
    var r = ui.div(c).row().wFull().px(12).py(10).gap(12).itemsStart().motion(f);
    if (failing) r = r.bg(c.theme.danger.alpha(0.05));
    return r;
}

/// A right-aligned figure in a table cell.
pub fn figure(c: *ui.Context, s: []const u8, muted: bool) void {
    ui.text(c, s, .{ .size = 13, .mono = !muted, .color = if (muted) x(c).text3 else c.theme.text });
}

// ---- stats ----

pub fn stat(c: *ui.Context, lbl: []const u8, value: []const u8, unit: []const u8, description: []const u8, big: bool) void {
    const d = ui.div(c).column().gap(4).grow().minW(0);
    defer d.end();
    if (lbl.len > 0) ui.text(c, lbl, .{ .size = 12.5, .weight = .medium, .color = x(c).text2 });
    {
        const r = ui.div(c).row().gap(6).itemsEnd();
        defer r.end();
        ui.text(c, value, .{ .size = if (big) 36 else 22, .weight = .medium, .color = c.theme.text });
        if (unit.len > 0) ui.text(c, unit, .{ .size = 13, .weight = .medium, .color = x(c).text3 });
    }
    if (description.len > 0) small(c, description);
}

/// A bar chart of `values` with `labels` under them, drawn as boxes in the run blue mark (Quartz's hue-3).
pub fn bars(c: *ui.Context, values: []const f64, labels: []const []const u8, height: f32) void {
    var top: f64 = 0;
    for (values) |v| top = @max(top, v);
    if (top <= 0) top = 1;
    const r = ui.div(c).row().wFull().h(height + 18).gap(6).itemsEnd();
    defer r.end();
    for (values, 0..) |v, i| {
        ui.key(c, c.print("bar-{d}", .{i}));
        // A few days are a few bars, not slabs across the panel.
        const col = ui.div(c).column().grow().maxW(56).gap(4).itemsCenter();
        defer col.end();
        const h: f32 = @floatCast(@max(2, v / top * height));
        const b = ui.div(c).wFull().h(h).rounded(3).bg(Color.hex(0x7ea4ff));
        b.end();
        ui.text(c, labels[i], .{ .size = 10, .color = x(c).text3 });
    }
}

test {
    std.testing.refAllDecls(@This());
}

/// A labelled field as wide as the dialog: its label, then the control
/// (draw it, then `end`), then a hint.
pub const Field = struct {
    c: *ui.Context,
    box: ui.Div,
    hint: []const u8,
    pub fn end(f: Field) void {
        if (f.hint.len > 0) ui.text(f.c, f.hint, .{ .size = 11.5, .color = x(f.c).text3, .wrap = true });
        f.box.end();
    }
};

pub fn field(c: *ui.Context, lbl: []const u8, opts: struct { hint: []const u8 = "" }) Field {
    const box = ui.div(c).column().wFull().gap(5);
    ui.text(c, lbl, .{ .size = 12.5, .weight = .medium });
    return .{ .c = c, .box = box, .hint = opts.hint };
}
