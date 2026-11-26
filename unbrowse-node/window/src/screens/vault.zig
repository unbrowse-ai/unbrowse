//! Vault: logins agents get references to (never values) and
//! the live sessions on this node. A revealed password is held only while
//! shown, never logged, and wiped when hidden. A login can keep its site's
//! one-time code key, so agents fill the code by reference too. Payment cards
//! are typed in once and kept in the vault; only a card's label and last four
//! digits come back, and each card carries its own limits.
const std = @import("std");
const nanoui = @import("nanoui");
const handoff = @import("../handoff.zig");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const types = @import("../types.zig");
const App = @import("../app.zig").App;

const login_cols = [_]look.Col{
    .{ .name = "Site", .w = 180 },
    .{ .name = "Account" },
    .{ .name = "Kind", .w = 150 },
    .{ .name = "Password", .w = 170 },
    .{ .name = "", .w = 290, .end = true },
};

/// Narrower: the login (site, account and kind) in one column, the buttons one above the other.
const login_cols_narrow = [_]look.Col{
    .{ .name = "Login" },
    .{ .name = "Password", .w = 150 },
    .{ .name = "", .w = 130, .end = true },
};

/// Whether the logins' five columns fit the table's width (look.tableWidth).
fn loginsFit(c: *ui.Context) bool {
    return look.tableWidth(c) >= 940;
}

const session_cols = [_]look.Col{
    .{ .name = "Site" },
    .{ .name = "Cookies", .w = 72, .end = true },
    .{ .name = "Last refreshed", .w = 110, .end = true },
    .{ .name = "", .w = 220, .end = true },
};

const card_cols = [_]look.Col{
    .{ .name = "Card", .w = 150 },
    .{ .name = "Ending", .w = 100 },
    .{ .name = "Security code", .w = 130 },
    .{ .name = "Limits" },
    .{ .name = "", .w = 180, .end = true },
};

/// Narrower: the card with its ending and security code in one column, its limits one above the other, its buttons
/// stacked.
const card_cols_narrow = [_]look.Col{
    .{ .name = "Card" },
    .{ .name = "Limits", .w = 200 },
    .{ .name = "", .w = 90, .end = true },
};

/// Whether the cards' five columns fit the table's width (look.tableWidth).
fn cardsFit(c: *ui.Context) bool {
    return look.tableWidth(c) >= 940;
}

fn keyOf(c: *ui.Context, l: types.Login) []const u8 {
    return c.print("{s}|{s}", .{ l.site, l.account });
}

pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const x = look.x(c);
    {
        const h = look.header(c, "Vault", "Agents get a reference to a login, never its value. Sessions stay on this node; passwords stay in your Keychain or are derived and never stored.");
        defer h.end();
        if (look.secondary(c, "Import passwords", .{ .size = .md })) a.open(.import_logins);
        if (look.primary(c, "Add login", .{ .size = .md })) a.open(.add_login);
    }
    const logins = a.store.list(.vault_list);
    if (logins.len > 0) look.search(c, "logins-search", &a.logins_query, &a.logins_page, "Search logins by site or account", null);
    const query = std.mem.trim(u8, a.logins_query.text(), " \t\r\n");
    var found: std.ArrayList(types.Login) = .empty;
    for (logins) |l| if (look.findsAll(&.{ l.site, l.account }, query)) found.append(fa, l) catch {};
    const listed = found.items;
    const rows = look.pageRows(&a.logins_page, listed.len);
    {
        const wide = loginsFit(c);
        const t = look.tableHead(c, "Logins", look.countOf(c, listed.len, logins.len, query.len > 0), if (wide) &login_cols else &login_cols_narrow);
        defer t.end();
        if (logins.len == 0) {
            look.rule(c);
            look.empty(c, "No logins yet. A derived password is made for each site from your vault key and is never stored anywhere.");
        } else if (listed.len == 0) {
            look.rule(c);
            look.empty(c, c.print("No login matches \u{201C}{s}\u{201D}.", .{query}));
        }
        for (listed[rows.from..rows.to]) |l| {
            const k = keyOf(c, l);
            const shown = a.revealed != null and std.mem.eql(u8, a.revealed_key.get(), k);
            const derived = std.mem.eql(u8, l.kind, "derived");
            const tr = look.tableRow(c, k, false);
            defer tr.end();
            const kind = if (derived) c.print("Derived, version {d}", .{l.counter + 1}) else "Stored in Keychain";
            if (wide) {
                {
                    const cell = look.cellBox(c, login_cols[0]);
                    defer cell.end();
                    look.label(c, l.site);
                }
                {
                    const cell = look.cellBox(c, login_cols[1]);
                    defer cell.end();
                    ui.text(c, l.account, .{ .size = 13, .color = x.text2 });
                }
                const cell = look.cellBox(c, login_cols[2]);
                defer cell.end();
                const col = ui.div(c).column().gap(2);
                defer col.end();
                ui.text(c, kind, .{ .size = 12.5, .color = x.text2 });
                if (l.code) ui.text(c, "Two-step code: kept", .{ .size = 12, .color = x.text3 });
            } else {
                // The login in one column: on which site, whose, and how its password is kept.
                const cell = look.cellBox(c, login_cols_narrow[0]);
                defer cell.end();
                look.label(c, l.site);
                ui.text(c, l.account, .{ .size = 13, .color = x.text2, .wrap = true });
                ui.text(c, kind, .{ .size = 12, .color = x.text3, .wrap = true });
                if (l.code) ui.text(c, "Two-step code: kept", .{ .size = 12, .color = x.text3 });
            }
            {
                const cell = look.cellBox(c, if (wide) login_cols[3] else login_cols_narrow[1]);
                defer cell.end();
                if (shown) {
                    const sel = ui.div(c).column();
                    c.node(sel.index).style.selectable = true;
                    defer sel.end();
                    ui.text(c, a.revealed.?, .{ .size = 12, .mono = true });
                } else ui.text(c, "Hidden", .{ .size = 12.5, .color = x.text3 });
            }
            const cell = look.cellBox(c, if (wide) login_cols[4] else login_cols_narrow[2]);
            defer cell.end();
            // Side by side when there is room, else one above the other.
            const btns = if (wide) ui.div(c).row().gap(4) else ui.div(c).column().gap(4).itemsEnd();
            defer btns.end();
            if (look.secondary(c, if (shown) "Hide" else "Show", .{ .size = .xs, .loading = a.store.isBusy(k) })) {
                if (shown) a.hideReveal() else {
                    a.hideReveal();
                    a.revealed_key.set(k);
                    a.store.actWith(.vault_reveal, k, "vault_reveal", .{ .site = l.site, .account = l.account });
                }
            }
            if (look.ghost(c, if (l.code) "Replace code key" else "Add code key", .{})) {
                a.open(.code_key);
                a.target.set(l.site);
                a.target2.set(l.account);
                a.login_kind = @intFromBool(l.code);
            }
            if (derived and look.ghost(c, "Rotate", .{})) {
                a.open(.rotate_login);
                a.target.set(l.site);
                a.target2.set(l.account);
            }
            if (look.ghost(c, "Remove", .{})) {
                a.open(.remove_login);
                a.target.set(l.site);
                a.target2.set(l.account);
                a.login_kind = if (derived) 0 else 1;
            }
        }
    }
    look.pager(c, "logins-pages", &a.logins_page, rows, listed.len);
    cards(a, c);
    const sessions = a.store.list(.sessions);
    const srows = look.pageRows(&a.sessions_page, sessions.len);
    defer look.pager(c, "sessions-pages", &a.sessions_page, srows, sessions.len);
    var import_clicked = false;
    const t = look.tableHeadAction(c, "Live sessions on this node", fmt.count(fa, @floatFromInt(sessions.len)), &session_cols, "Import a site's session", &import_clicked);
    defer t.end();
    if (import_clicked) a.open(.import_session);
    if (sessions.len == 0) {
        look.rule(c);
        return look.empty(c, "No live sessions. The first call to a site walks it once and keeps the session here.");
    }
    for (sessions[srows.from..srows.to]) |s| {
        const tr = look.tableRow(c, s.host, false);
        defer tr.end();
        {
            const cell = look.cellBox(c, session_cols[0]);
            defer cell.end();
            look.label(c, s.host);
        }
        {
            const cell = look.cellBox(c, session_cols[1]);
            defer cell.end();
            look.figure(c, fmt.count(fa, s.cookies), false);
        }
        {
            const cell = look.cellBox(c, session_cols[2]);
            defer cell.end();
            look.figure(c, fmt.ago(fa, s.updated, a.now), false);
        }
        const cell = look.cellBox(c, session_cols[3]);
        defer cell.end();
        if (look.secondary(c, c.print("Sign out of {s}", .{s.host}), .{ .size = .xs })) {
            a.open(.forget_session);
            a.target.set(s.host);
        }
    }
}

/// The payment cards in the vault, each with what agents may pay with it on a site without asking. A card with no limit
/// asks on every payment.
fn cards(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const x = look.x(c);
    const all = a.store.list(.vault_cards);
    const limits = a.store.list(.card_limits);
    const rows = look.pageRows(&a.cards_page, all.len);
    defer look.pager(c, "cards-pages", &a.cards_page, rows, all.len);
    var add = false;
    const wide = cardsFit(c);
    const t = look.tableHeadAction(c, "Cards", fmt.count(fa, @floatFromInt(all.len)), if (wide) &card_cols else &card_cols_narrow, "Add card", &add);
    defer t.end();
    if (add) a.open(.add_card);
    if (all.len == 0) {
        look.rule(c);
        look.empty(c, "No cards yet. Add one and agents pay with it by reference, never seeing its number. Each payment asks you first.");
    }
    for (all[rows.from..rows.to]) |card| {
        const tr = look.tableRow(c, c.print("card|{s}", .{card.label}), false);
        defer tr.end();
        const ending = c.print("\u{2022}\u{2022}\u{2022}\u{2022} {s}", .{card.last4});
        const code = if (card.code) "Kept" else "Not kept";
        if (wide) {
            {
                const cell = look.cellBox(c, card_cols[0]);
                defer cell.end();
                look.label(c, card.label);
            }
            {
                const cell = look.cellBox(c, card_cols[1]);
                defer cell.end();
                look.figure(c, ending, false);
            }
            const cell = look.cellBox(c, card_cols[2]);
            defer cell.end();
            ui.text(c, code, .{ .size = 12.5, .color = x.text2 });
        } else {
            // The card in one column: its label, its ending, and whether its security code is kept.
            const cell = look.cellBox(c, card_cols_narrow[0]);
            defer cell.end();
            look.label(c, card.label);
            look.figure(c, ending, false);
            const r = ui.div(c).row().gap(4).itemsCenter();
            defer r.end();
            ui.text(c, "Security code:", .{ .size = 12, .color = x.text3 });
            ui.text(c, code, .{ .size = 12, .color = x.text2 });
        }
        {
            const cell = look.cellBox(c, if (wide) card_cols[3] else card_cols_narrow[1]);
            defer cell.end();
            var any = false;
            for (limits) |l| {
                if (!std.mem.eql(u8, l.card, card.label)) continue;
                any = true;
                // Beside its Remove when there is room, else above it; the words wrap in what is left.
                const line = if (wide) ui.div(c).row().wFull().gap(6).itemsCenter() else ui.div(c).column().wFull().gap(2).itemsStart();
                defer line.end();
                ui.key(c, c.print("limit|{s}|{s}", .{ l.card, l.site }));
                {
                    const words = if (wide) ui.div(c).grow().minW(0) else ui.div(c).wFull();
                    defer words.end();
                    ui.text(c, c.print("{s}: {d} a payment, {d} a day, {d} today", .{ l.site, l.per_payment, l.per_day, l.spent }), .{ .size = 12.5, .color = x.text2, .wrap = true });
                }
                if (look.ghost(c, "Remove limit", .{})) a.store.actWith(.card_limit, "limit", "card_limit", .{ .card = l.card, .site = l.site, .per_payment = @as(f64, 0), .per_day = @as(f64, 0) });
            }
            if (!any) ui.text(c, "None: every payment asks you", .{ .size = 12.5, .color = x.text3, .wrap = true });
        }
        const cell = look.cellBox(c, if (wide) card_cols[4] else card_cols_narrow[2]);
        defer cell.end();
        // Side by side when there is room, else one above the other.
        const btns = if (wide) ui.div(c).row().gap(4) else ui.div(c).column().gap(4).itemsEnd();
        defer btns.end();
        if (look.secondary(c, "Set limit", .{ .size = .xs })) {
            a.open(.card_limit);
            a.target.set(card.label);
        }
        if (look.ghost(c, "Remove", .{})) {
            a.open(.remove_card);
            a.target.set(card.label);
            a.target2.set(card.last4);
        }
    }
}

/// A dialog shut by Escape or a click outside wipes its fields, as Cancel does.
fn wipeIfShut(a: *App) void {
    if (a.dialog_open) return;
    for (&a.fields) |*f| if (f.len > 0) return a.wipeFields();
}

/// A card the owner types in. The node reads it as `vault card add` does and answers only its label and last four
/// digits; the security code is asked for only while the vault keeps codes (Settings, Card security codes).
fn addCard(a: *App, c: *ui.Context) void {
    const codes = if (a.store.get(.settings)) |st| st.keep_card_codes else false;
    const dialog = kit.dialog(c, "addcard", &a.dialog_open, .{
        .title = "Add a card",
        .description = "The card is kept in your vault. Agents fill it by reference and never see it, and each payment asks you first.",
        .ok = "",
        .cancel = "",
    });
    wipeIfShut(a);
    const d = dialog orelse return;
    inline for (.{ .{ 1, "Card number", "4242 4242 4242 4242" }, .{ 2, "Expiry", "MM/YY" }, .{ 3, "Name on card", "Ada Lovelace" } }) |f_of| {
        const f = look.field(c, f_of[1], .{});
        _ = ui.textField(c, &a.fields[f_of[0]], .{ .width = .fill, .placeholder = f_of[2] });
        f.end();
    }
    if (codes) {
        const f = look.field(c, "Security code", .{ .hint = "Kept beside the card, so agents can pay where a checkout asks for it." });
        _ = ui.textField(c, &a.fields[4], .{ .width = .fill, .password = true, .placeholder = "123" });
        f.end();
    }
    {
        const f = look.field(c, "Label", .{ .hint = "Letters, digits and dashes. Agents name the card by it." });
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill, .placeholder = "visa" });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    look.small(c, if (codes) "The vault keeps card security codes: you can change that in Settings." else "The vault keeps no security code: you type it at each checkout. Settings, Card security codes, keeps them.");
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const label = a.field(0);
        const number = a.field(1);
        const expiry = a.field(2);
        const name = a.field(3);
        const cvv = a.field(4);
        const ready = label.len > 0 and number.len > 0 and expiry.len > 0 and name.len > 0;
        if (look.primary(c, "Save card", .{ .size = .md, .disabled = !ready, .loading = a.store.isBusy("addcard") }))
            a.store.actWith(.close, "addcard", "vault_card_add", .{ .label = label, .number = number, .expiry = expiry, .name = name, .cvv = if (codes and cvv.len > 0) @as(?[]const u8, cvv) else null });
    }
    _ = d.end();
}

fn removeCard(a: *App, c: *ui.Context) void {
    const label = a.target.get();
    const d = kit.dialog(c, "removecard", &a.dialog_open, .{
        .title = c.print("Remove the card {s}, ending {s}?", .{ label, a.target2.get() }),
        .description = "The card and its limits are deleted from your vault and can't be brought back. Agents can't pay with it until you add it again.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Keep it", .{ .size = .md })) a.close();
        if (look.danger(c, "Remove card", .{ .loading = a.store.isBusy("removecard") })) a.store.actWith(.close, "removecard", "vault_card_remove", .{ .card = label });
    }
    _ = d.end();
}

/// A limit for one card, set from its row: on one site, agents may pay up to it without asking.
fn cardLimit(a: *App, c: *ui.Context) void {
    const card = a.target.get();
    const d = kit.dialog(c, "cardlimit", &a.dialog_open, .{
        .title = c.print("Set a limit for {s}", .{card}),
        .description = "Agents may pay up to this with the card on this site without asking you. The node can't see what a checkout really charges, so it goes by what the agent says: give a limit only to agents and sites you trust.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    inline for (.{ .{ 0, "Site", "shop.example" }, .{ 1, "Most for one payment", "20" }, .{ 2, "Most in a day", "50" } }) |f_of| {
        const f = look.field(c, f_of[1], .{});
        _ = ui.textField(c, &a.fields[f_of[0]], .{ .width = .fill, .placeholder = f_of[2] });
        f.end();
    }
    const one = a.number(1) orelse 0;
    const day = a.number(2) orelse one;
    if (a.err.len > 0) look.failText(c, a.err.get());
    look.small(c, "You'll be asked to confirm this. Past either amount, or when an agent doesn't say what it costs, the node asks you again.");
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const ready = card.len > 0 and a.field(0).len > 0 and one > 0 and day >= one;
        if (look.primary(c, "Save limit", .{ .size = .md, .disabled = !ready, .loading = a.store.isBusy("limit") }))
            a.store.actWith(.card_limit, "limit", "card_limit", .{ .card = card, .site = a.field(0), .per_payment = one, .per_day = day });
    }
    _ = d.end();
}

pub fn dialogs(a: *App, c: *ui.Context) void {
    switch (a.dialog) {
        .card_limit => cardLimit(a, c),
        .add_card => addCard(a, c),
        .remove_card => removeCard(a, c),
        .add_login => addLogin(a, c),
        .remove_login => removeLogin(a, c),
        .rotate_login => rotateLogin(a, c),
        .code_key => codeKey(a, c),
        .forget_session => forget(a, c),
        .import_logins => importLogins(a, c),
        .import_session => importSession(a, c),
        else => {},
    }
}

fn footer(c: *ui.Context) ui.Div {
    return ui.div(c).row().wFull().gap(8).justifyEnd().pt(4);
}

fn addLogin(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const stored = a.login_kind == 1;
    const d = kit.dialog(c, "addlogin", &a.dialog_open, .{
        .title = "Add a login",
        .description = if (stored) "For an account you already have: the password goes into your Keychain." else "For a new or reset account: the password is made from your vault key, the site and a counter. Nothing is stored.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    _ = kit.tabs(c, &.{ "Derived password", "Stored password" }, &a.login_kind, .{ .variant = .segmented, .size = .sm });
    {
        const f = look.field(c, "Site", .{});
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill, .placeholder = "github.com" });
        f.end();
    }
    {
        const f = look.field(c, "Account", .{});
        _ = ui.textField(c, &a.fields[1], .{ .width = .fill, .placeholder = "lewis@unbrowse.ai" });
        f.end();
    }
    if (stored) {
        const f = look.field(c, "Password", .{});
        _ = ui.textField(c, &a.fields[2], .{ .width = .fill, .password = true });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    look.small(c, c.print("Added {s}. Agents see only a reference to it.", .{fmt.date(fa, a.now)}));
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const site = a.field(0);
        const account = a.field(1);
        const pw = a.fields[2].text();
        if (look.primary(c, "Add login", .{ .size = .md, .disabled = site.len == 0 or account.len == 0 or (stored and pw.len == 0), .loading = a.store.isBusy("add") })) {
            a.store.actWith(.close, "add", "vault_add", .{ .site = site, .account = account, .kind = if (stored) "stored" else "derived", .password = if (stored) @as(?[]const u8, pw) else null });
        }
    }
    _ = d.end();
}

/// The key the site showed when two-step sign-in was turned on: the node keeps it in the Keychain and makes each code
/// when an agent fills `vault:code:<site>:<account>`.
fn codeKey(a: *App, c: *ui.Context) void {
    const site = a.target.get();
    const account = a.target2.get();
    const d = kit.dialog(c, "codekey", &a.dialog_open, .{
        .title = c.print("{s} code key for {s} on {s}", .{ if (a.login_kind == 1) "Replace the" else "Add a", account, site }),
        .description = "Paste the otpauth:// address or the secret the site showed when you turned on two-step sign-in. The key stays in your Keychain; agents fill the code by reference and never see it.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    {
        const f = look.field(c, "Code key", .{});
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill, .password = true, .placeholder = "otpauth://totp/… or JBSW Y3DP EHPK 3PXP" });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    look.small(c, c.print("Agents fill it as vault:code:{s}:{s}.", .{ site, account }));
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const key = a.field(0);
        if (look.primary(c, "Keep code key", .{ .size = .md, .disabled = key.len == 0, .loading = a.store.isBusy("code") }))
            a.store.actWith(.close, "code", "vault_code", .{ .site = site, .account = account, .key = key });
    }
    _ = d.end();
}

/// What rotating does, said before it is done: the vault's password moves on, and nothing tells the site (TRUST-12).
pub const rotate_said = "The vault makes a new password for this login. The site isn't told: it keeps the old one until you change it there, and agents signing in fail until you do. The old password can't be brought back, so show it and keep it until the site has the new one.";

fn rotateLogin(a: *App, c: *ui.Context) void {
    const site = a.target.get();
    const account = a.target2.get();
    const d = kit.dialog(c, "rotatelogin", &a.dialog_open, .{ .title = c.print("Rotate the password for {s} on {s}?", .{ account, site }), .description = rotate_said, .ok = "", .cancel = "" }) orelse return;
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Keep this password", .{ .size = .md })) a.close();
        if (look.danger(c, "Rotate password", .{ .loading = a.store.isBusy("rotate") })) {
            a.hideReveal();
            a.store.actWith(.close, "rotate", "vault_rotate", .{ .site = site, .account = account });
        }
    }
    _ = d.end();
}

fn removeLogin(a: *App, c: *ui.Context) void {
    const site = a.target.get();
    const account = a.target2.get();
    const d = kit.dialog(c, "removelogin", &a.dialog_open, .{
        .title = c.print("Remove {s} on {s}?", .{ account, site }),
        .description = if (a.login_kind == 1) "The stored password is deleted from your Keychain." else "Nothing is stored for a derived password; it can be made again by adding the login back.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Keep it", .{ .size = .md })) a.close();
        if (look.danger(c, "Remove login", .{ .loading = a.store.isBusy("remove") })) a.store.actWith(.close, "remove", "vault_remove", .{ .site = site, .account = account });
    }
    _ = d.end();
}

fn forget(a: *App, c: *ui.Context) void {
    const host = a.target.get();
    const d = kit.dialog(c, "forget", &a.dialog_open, .{
        .title = c.print("Sign out of {s}?", .{host}),
        .description = "The node drops this site's session. The next call your agents make walks the site in the browser once to sign in again.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Keep session", .{ .size = .md })) a.close();
        if (look.danger(c, c.print("Sign out of {s}", .{host}), .{ .loading = a.store.isBusy("forget") })) a.store.actWith(.close, "forget", "forget_session", .{ .host = host });
    }
    _ = d.end();
}

/// Where each exporter keeps its export. Any CSV with the site's address, the username and the password works.
const sources = [_][2][]const u8{
    .{ "Chrome, Edge, Brave, Arc", "Settings, then Passwords (or Password Manager), then Export passwords" },
    .{ "Firefox", "about:logins, then the menu, then Export passwords" },
    .{ "Safari", "File, then Export, then Passwords" },
    .{ "1Password, Bitwarden, LastPass, Dashlane, KeePass", "Export your vault or items as CSV" },
};

/// Imports a CSV a browser or password manager exported: each login goes into the Keychain, as the node reads it.
/// The file's name is kept in `target` to say what to delete after.
fn importLogins(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const done: ?types.VaultImport = if (a.imported) |raw| std.json.parseFromSliceLeaky(types.VaultImport, fa, raw, types.parse_options) catch null else null;
    const d = kit.dialog(c, "import", &a.dialog_open, .{
        .title = "Import passwords",
        .description = "Export your passwords as a CSV from your browser or password manager, then choose the file. Each login goes into your Keychain; agents only ever get a reference to it.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    const name = a.target.get();
    if (done) |r| {
        const codes = if (r.codes > 0) c.print(" {s} came with a two-step code key.", .{fmt.count(fa, r.codes)}) else "";
        const known = if (r.known > 0) c.print(" {s} already in the vault kept the vault's password.", .{fmt.count(fa, r.known)}) else "";
        ui.text(c, c.print("Imported {s} {s} from {s}.{s}{s}", .{ fmt.count(fa, r.added), if (r.added == 1) "login" else "logins", name, codes, known }), .{ .size = 13.5, .wrap = true, .leading = 1.25 });
        for (r.skipped) |sk| if (sk.count > 0) look.body(c, c.print("Left out {s}: {s}", .{ fmt.count(fa, sk.count), sk.why }));
        ui.text(c, c.print("Delete {s} now: it holds every password in plain text.", .{name}), .{ .size = 13.5, .wrap = true, .leading = 1.25 });
    } else for (sources) |src| {
        const col = ui.div(c).column().wFull();
        defer col.end();
        look.label(c, src[0]);
        look.body(c, src[1]);
    }
    if (done == null) look.body(c, "If you export a file and stop here, delete it: it holds every password in plain text.");
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (done != null) {
            if (look.primary(c, "Done", .{ .size = .md })) a.close();
        } else {
            if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
            if (look.primary(c, "Choose export file", .{ .size = .md, .loading = a.store.isBusy("import") })) handoff.toMain(a, pickExportLater);
        }
    }
    _ = d.end();
}

/// Import the owner's browser session for one site: the node copies that browser's cookie store into a throwaway
/// profile, opens it with no window, and keeps the cookies for this site alone as the node's session for it.
fn importSession(a: *App, c: *ui.Context) void {
    const d = kit.dialog(c, "importsession", &a.dialog_open, .{
        .title = "Import a site's session",
        .description = "Name a site you're signed in to in your browser. The node reads that browser's cookies for that one site and keeps them as its session, so its first call is already signed in. No window opens, and no other site's cookies are read.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    {
        const f = look.field(c, "Site", .{ .hint = "Read from your browsers on this computer: Chrome and the other Chromium browsers first, then Firefox and Safari." });
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill, .placeholder = "github.com" });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const host = a.field(0);
        if (look.primary(c, "Import session", .{ .size = .md, .disabled = host.len == 0, .loading = a.store.isBusy("importsession") }))
            a.store.actWith(.close, "importsession", "import_session", .{ .host = host });
    }
    _ = d.end();
}

/// Starts the import file chooser after the current frame, never inside it. The chooser runs a nested GTK loop; run
/// from a view it would re-enter the draw and corrupt it, so it is scheduled onto the main loop to run once the frame
/// has returned.
fn pickExportLater(ctx: ?*anyopaque) callconv(.c) void {
    pickExport(@ptrCast(@alignCast(ctx.?)));
}

fn pickExport(a: *App) void {
    const io = a.io orelse return;
    const w = a.window orelse return;
    if (w.app.flags.hidden) return;
    const paths = (nanoui.dialog.open(a.gpa, .{ .title = "Import passwords", .button = "Import", .extensions = &.{"csv"} }) catch null) orelse return;
    defer nanoui.dialog.freePaths(a.gpa, paths);
    if (paths.len == 0) return;
    const text = std.Io.Dir.cwd().readFileAlloc(io, paths[0], a.gpa, .limited(16 << 20)) catch {
        a.fail("That file couldn't be read.");
        return;
    };
    defer {
        std.crypto.secureZero(u8, text);
        a.gpa.free(text);
    }
    importText(a, std.fs.path.basename(paths[0]), text);
}

/// Sends an export's text to the node; `name` is what the dialog calls the file.
pub fn importText(a: *App, name: []const u8, text: []const u8) void {
    a.err.len = 0;
    a.target.set(name);
    a.store.actWith(.vault_import, "import", "vault_import", .{ .csv = text });
}
