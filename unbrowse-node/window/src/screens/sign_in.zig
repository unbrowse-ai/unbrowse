//! First-run sign-in: right after a new node's terms are answered, before the window's screens. It drives the website
//! way of the node's one sign-in flow (`login::Way::Website` in the node): `link_start` opens the sign-in page in the
//! owner's browser and the node waits on it; `link_status` says when the wallet is linked, and the node's `identity`
//! event reads it again then. Signing in is optional, so the screen also has a way past it, kept quiet at its foot:
//! skipping leaves the node as it is with no wallet linked, and Money still links one later.
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const art = @import("../art.zig");
const App = @import("../app.zig").App;
const wallet = @import("wallet.zig");

pub const waiting_said = "Waiting for you to finish in your browser…";
pub const skip_said = "Skip for now";
pub const start_said = "Continue in your browser";

pub fn view(a: *App, c: *ui.Context) void {
    if (!a.sign_in_asked) {
        a.sign_in_asked = true;
        a.store.fetch(.link_status);
    }
    const x = look.x(c);
    const l = a.store.get(.link_status);
    const waiting = if (l) |s| s.waiting else false;
    const page = ui.div(c).column().sizeFull().bg(x.canvas).px(32).pt(46).pb(20).itemsCenter();
    defer page.end();
    const col = ui.div(c).column().wFull().maxW(480).grow().gap(20);
    defer col.end();
    {
        const brand = ui.div(c).row().gap(8).itemsCenter();
        defer brand.end();
        art.mark(c, 24);
        ui.text(c, "Unbrowse", .{ .size = 17, .weight = .semibold });
    }
    ui.spacer(c);
    {
        const words = ui.div(c).column().wFull().gap(6);
        defer words.end();
        look.title(c, "Sign in");
        look.body(c, "Your node lists and earns under the account you sign in with.");
    }
    {
        const r = ui.div(c).row().wFull().gap(12).itemsCenter();
        defer r.end();
        ui.key(c, "sign-in-start");
        if (look.primary(c, if (waiting) "Start again" else start_said, .{ .size = .md, .loading = a.store.isBusy("link_start") })) a.startSignIn();
        if (waiting) look.status(c, .running, waiting_said);
    }
    // The node couldn't open the browser: the page to open by hand.
    if (a.sign_in_page) |url| if (waiting) {
        const r = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer r.end();
        look.mono(c, look.clipTo(c, url, 72), null);
        wallet.copyButton(a, c, "Copy", url, "Copied the sign-in page");
    };
    if (l) |s| if (s.@"error") |e| look.failText(c, e);
    if (a.err.len > 0) look.failText(c, a.err.get());
    ui.spacer(c);
    // The way past it, quiet: small, faint, at the foot, with no button around it.
    const foot = ui.div(c).row().wFull();
    defer foot.end();
    ui.spacer(c);
    ui.key(c, "sign-in-skip");
    const skip = ui.div(c).px(4).py(2).control();
    defer skip.end();
    ui.text(c, skip_said, .{ .size = 11.5, .color = if (skip.hovered()) x.text2 else x.text3 });
    if (skip.clicked()) a.skipSignIn();
}
