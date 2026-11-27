//! The sign-in step of setting up a new node (screens/onboarding.zig). It drives the website way of the node's one
//! sign-in flow (`login::Way::Website` in the node): `link_start` opens the sign-in page in the owner's browser and the
//! node waits on it; `link_status` says when the wallet is linked, and the node's `identity` event reads it again then.
//! Signing in is optional: Skip for now leaves the node as it is with no wallet linked, and Money links one later.
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const look = @import("../look.zig");
const App = @import("../app.zig").App;
const wallet = @import("wallet.zig");

pub const waiting_said = "Waiting for you to finish in your browser…";
pub const skip_said = "Skip for now";
pub const start_said = "Continue in your browser";

/// The sign-in step of setting up (screens/onboarding.zig): optional, so its way past is a button like any other.
pub fn body(a: *App, c: *ui.Context) void {
    if (!a.sign_in_asked) {
        a.sign_in_asked = true;
        a.store.fetch(.link_status);
    }
    const l = a.store.get(.link_status);
    const waiting = if (l) |s| s.waiting else false;
    {
        const words = ui.div(c).column().wFull().gap(8);
        defer words.end();
        look.title(c, "Sign in to Unbrowse");
        look.body(c, "Optional. Signing in links this computer to your Unbrowse account, so what it learns can earn for you. You sign in with email or Google in your browser, or later from the Money screen.");
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
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    ui.key(c, "sign-in-start");
    if (look.primary(c, if (waiting) "Start again" else start_said, .{ .size = .md, .loading = a.store.isBusy("link_start") })) a.startSignIn();
    ui.key(c, "sign-in-skip");
    if (look.secondary(c, skip_said, .{})) a.skipSignIn();
    if (waiting) look.status(c, .running, waiting_said);
}
