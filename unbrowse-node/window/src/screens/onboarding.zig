//! Setting up Unbrowse: one guided flow in place of separate first-run screens. A new node goes Welcome, Terms, Sign in,
//! Apps, ChatGPT and Claude, Done; a step a node has done already (signed in from a terminal, apps connected) is passed
//! over and shown as done. A node only asked for a newer version of the terms sees that one step, with no stepper.
//!
//! Which step stands is the shell's (`shell.front`, from the node's own state: `termsDue`, `signInDue`, `connectDue`),
//! so the flow never disagrees with the node. This screen draws the frame around each step: the brand, where the owner
//! is (the stepper, its progress filling on a spring), and the step's body, which slides in from the side the owner is
//! heading (Back slides the other way) and settles with no bounce. With reduced motion it appears at once.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const art = @import("../art.zig");
const App = @import("../app.zig").App;
const first_run = @import("first_run.zig");
const sign_in = @import("sign_in.zig");
const connect = @import("connect.zig");

pub const Step = enum { welcome, terms, sign_in, apps, web, done };

/// The steps a new node is taken through, in order, with the names the stepper shows.
const all = [_]Step{ .welcome, .terms, .sign_in, .apps, .web, .done };
fn name(s: Step) []const u8 {
    return switch (s) {
        .welcome => "Welcome",
        .terms => "Terms",
        .sign_in => "Sign in",
        .apps => "Your AI apps",
        .web => "ChatGPT and Claude",
        .done => "Done",
    };
}

/// The steps the stepper shows: all of them for a new node, the apps and the web for a node set up elsewhere, and none
/// (one step, no stepper) for a node asked only to answer newer terms.
fn plan(a: *App, step: Step) []const Step {
    if (a.new_node orelse false) return &all;
    return switch (step) {
        .apps, .web, .done => all[3..],
        else => &.{},
    };
}

/// A step's body slides in from this far to the side it comes from, in points.
const slide: f32 = 36;
/// The body's arrival and the progress fill: critically damped (no bounce), settling in about a third of a second.
const settle: ui.motion.Transition = .{ .spring = ui.motion.Spring.visual(0.35, 0) };

pub fn view(a: *App, c: *ui.Context, step: Step) void {
    const x = look.x(c);
    const page = ui.div(c).column().sizeFull().bg(x.canvas).px(32).pt(56).pb(28).itemsCenter().scrollY();
    defer page.end();
    const col = ui.div(c).column().wFull().maxW(620).gap(24);
    defer col.end();
    {
        const brand = ui.div(c).row().gap(8).itemsCenter();
        defer brand.end();
        art.mark(c, 24);
        ui.text(c, "Unbrowse", .{ .size = 17, .weight = .semibold });
    }
    stepper(a, c, step);
    // Keyed by the step, so each step's body arrives as its own: from the right going on, from the left going back.
    ui.key(c, @tagName(step));
    const f = ui.motion.frame(c, .{ .initial = .{ .x = slide * a.onboard_dir, .opacity = 0 }, .transition = settle });
    // The step on a card of its own, raised off the canvas: one thing to look at, one thing to do.
    const body = ui.div(c).column().wFull().minW(0).bg(c.theme.surface).border(x.frame).rounded(16).shadowMd().px(28).py(26).gap(16).motion(f);
    defer body.end();
    switch (step) {
        .welcome => welcome(a, c),
        .terms => first_run.body(a, c),
        .sign_in => sign_in.body(a, c),
        .apps => connect.appsBody(a, c),
        .web => connect.webBody(a, c),
        .done => done(a, c),
    }
}

/// Where the owner is: each step a numbered dot (a tick once done) with its name, and a track under them whose fill
/// moves to the step on a spring.
fn stepper(a: *App, c: *ui.Context, step: Step) void {
    const steps = plan(a, step);
    const at = std.mem.indexOfScalar(Step, steps, step) orelse return;
    const x = look.x(c);
    const wrap = ui.div(c).column().wFull().gap(10);
    defer wrap.end();
    {
        const row = ui.div(c).row().wFull().gap(6).itemsCenter();
        defer row.end();
        for (steps, 0..) |s, i| {
            ui.key(c, name(s));
            const cell = ui.div(c).row().grow().minW(0).gap(7).itemsCenter();
            defer cell.end();
            const done_ = i < at;
            const here = i == at;
            const dot = ui.div(c).w(20).h(20).roundedFull().itemsCenter().justifyCenter().bg(if (done_ or here) c.theme.accent else c.theme.surface).border(if (done_ or here) c.theme.accent else x.hair);
            {
                defer dot.end();
                ui.text(c, if (done_) "\u{2713}" else c.print("{d}", .{i + 1}), .{ .size = 11, .weight = .semibold, .color = if (done_ or here) c.theme.accent_text else x.text3 });
            }
            ui.text(c, name(s), .{ .size = 12, .weight = if (here) .semibold else .medium, .color = if (here) c.theme.text else x.text3 });
        }
    }
    // The track: its fill eases to where the owner is, so moving on reads as progress made.
    const total: f32 = @floatFromInt(@max(steps.len - 1, 1));
    const fill = ui.motion.number(c, "progress", @as(f32, @floatFromInt(at)) / total, settle);
    const track = ui.div(c).row().wFull().h(3).rounded(2).bg(x.hair).clip();
    defer track.end();
    const bar = ui.div(c).h(3).rounded(2).bg(c.theme.accent).w(620 * std.math.clamp(fill, 0, 1));
    bar.end();
}

/// Step one: what Unbrowse does for the owner, and how long setting it up takes.
fn welcome(a: *App, c: *ui.Context) void {
    {
        const hero = ui.div(c).row().wFull().gap(20).itemsCenter();
        defer hero.end();
        art.uni(c, .happy, 96);
        const words = ui.div(c).column().grow().minW(0).gap(8);
        defer words.end();
        look.title(c, "Let your AI use any website");
        look.body(c, "Unbrowse lets your AI apps use websites directly, on this computer: no browser to watch, and no copying and pasting. It learns a site once, then answers in a fraction of a second.");
    }
    {
        const points = ui.div(c).column().wFull().gap(8);
        defer points.end();
        point(c, "Your logins stay on this computer. Your AI gets a reference to them, never the password.");
        point(c, "You approve anything that needs you, like a payment or a sign-in, on this screen.");
        point(c, "Setup takes about two minutes, and you can change all of it later.");
    }
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    if (look.primary(c, "Get started", .{ .size = .md })) a.onboardGo(.forward, .welcome);
}

/// The last step: setup is done, and the first thing to try.
fn done(a: *App, c: *ui.Context) void {
    {
        const hero = ui.div(c).row().wFull().gap(20).itemsCenter();
        defer hero.end();
        art.uni(c, .proud, 96);
        const words = ui.div(c).column().grow().minW(0).gap(8);
        defer words.end();
        look.title(c, "You're set");
        look.body(c, "Unbrowse is running. Ask your AI to do something on a website, and it uses Unbrowse by itself. If a site needs you, like a sign-in, this window asks.");
    }
    appsHeard(a, c);
    look.label(c, "Try asking your AI");
    look.well(c, try_this);
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    if (look.primary(c, "Open Unbrowse", .{ .size = .md })) a.onboardFinish();
    if (look.secondary(c, "Copy", .{})) {
        c.clipboard.write(c.clipboard.ctx, try_this);
        a.toaster.push(.{ .status = .success, .title = "Copied", .duration = 2 });
        a.cheer();
    }
}

/// The apps connected while setting up, each saying whether it has reached Unbrowse yet, and the first call once one
/// came: the owner sees setting up worked rather than taking it on trust. Each changes live, as the node says so.
fn appsHeard(a: *App, c: *ui.Context) void {
    const cs = a.clients() orelse return;
    var any = false;
    for (cs) |cl| {
        if (cl.found and cl.connected) any = true;
    }
    if (!any) return;
    const list = ui.div(c).column().wFull().gap(6);
    defer list.end();
    look.label(c, "Your AI apps");
    for (cs) |cl| {
        if (!cl.found or !cl.connected) continue;
        ui.key(c, cl.id);
        if (cl.heard != null) look.status(c, .ok, c.print("{s} reached Unbrowse", .{cl.name})) else look.status(c, .idle, c.print("{s}: open it to start using Unbrowse", .{cl.name}));
    }
    if (a.store.get(.setup_status)) |st| for (st.steps) |s| {
        if (std.mem.eql(u8, s.id, "first_call") and s.done) look.status(c, .ok, s.said);
    };
}

/// A first ask that works on any node, with no sign-in: a public site whose answer changes every day.
pub const try_this = "Use Unbrowse to find today's top story on Hacker News, and tell me what it's about.";

/// One point of a short list: its mark, and words that wrap under themselves rather than under the mark.
pub fn point(c: *ui.Context, words: []const u8) void {
    const r = ui.div(c).row().wFull().gap(10).itemsStart();
    defer r.end();
    {
        const mark = ui.div(c).w(6).h(6).offset(0, 8).roundedFull().bg(c.theme.accent);
        mark.end();
    }
    const w = ui.div(c).column().grow().minW(0);
    defer w.end();
    look.body(c, words);
}
