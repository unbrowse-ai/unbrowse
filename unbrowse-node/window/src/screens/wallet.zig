//! Money: one balance in dollars with Add funds, each agent's
//! daily limit, earnings with Cash out, and an Advanced fold for the
//! deposit, the route coins, the price and the addresses.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const kit = nanoui.kit;
const look = @import("../look.zig");
const fmt = @import("../fmt.zig");
const types = @import("../types.zig");
const app_mod = @import("../app.zig");
const App = app_mod.App;
const Move = app_mod.Move;

const description = "Your agents pay for other people's routes from this balance, each up to its daily limit. Network fees are included in each price.";

/// A decimal string of USDC from the node, as dollars.
fn dollars(c: *ui.Context, s: []const u8) []const u8 {
    return c.print("${s}", .{s});
}

fn num(s: []const u8) f64 {
    return std.fmt.parseFloat(f64, s) catch 0;
}

/// USDC as cents, or to four places when it is less than a cent but not nothing: earnings come a fraction of a fee at a
/// time.
fn cents(a: std.mem.Allocator, n: f64) []const u8 {
    return fmt.usdcd(a, n, if (n > 0 and n < 0.01) 4 else 2);
}

/// What `coins` are worth in dollars, estimated at the UNB pool's steady price (R1.30): none when a coin has no estimate.
fn coinsUsd(coins: []const types.Holding) ?f64 {
    var usd: f64 = 0;
    for (coins) |h| usd += h.value_usd orelse return null;
    return usd;
}

/// ", about $X" for `coins`' dollar estimate, said beside their value in UNB; nothing when there is none to say.
fn aboutUsd(c: *ui.Context, coins: []const types.Holding) []const u8 {
    if (coins.len == 0) return "";
    const usd = coinsUsd(coins) orelse return "";
    return c.print(", about {s}", .{dollars(c, cents(c.alloc(), usd))});
}

/// Money: one balance in dollars with Add funds and "Add $X to start", each agent's daily limit, earnings
/// with Cash out, and an Advanced fold for everything that withdraws or puts money at risk. No control on the main
/// path withdraws the balance.
pub fn view(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    if (!a.chainUp()) {
        const h = look.header(c, "Money", description);
        h.end();
        look.body(c, if (a.chainError()) |e| c.print("{s}: {s}", .{ a.chainDownWord(), e }) else a.chainDownWord());
        // The node's address doesn't wait on the chain: it can be copied to send USDC to.
        advancedFold(a, c);
        if (a.money_advanced) identity(a, c, "", "");
        return;
    }
    const m = a.store.get(.money) orelse types.Money{};
    const w = a.store.get(.wallet) orelse types.Wallet{};
    const test_mode = a.devnet();
    {
        const h = look.header(c, "Money", description);
        defer h.end();
        if (test_mode and look.secondary(c, "Add test funds", .{ .size = .md })) openMove(a, .faucet, w);
        if (look.primary(c, "Add funds", .{ .size = .md, .loading = a.store.isBusy("add") })) a.store.act(.generic, "add", "add_funds", "{}");
    }
    if (a.store.err(.money)) |e| if (!a.store.keychain) look.failText(c, e);
    // A rise in the balance between two reads is a top-up that landed: said for a minute.
    const now = num(m.balance);
    if (a.store.get(.money) != null) {
        if (a.money_seen >= 0 and now > a.money_seen + 0.004) {
            a.money_arrived = now - a.money_seen;
            a.money_arrived_at = a.now;
        }
        a.money_seen = now;
    }
    {
        const r = ui.div(c).row().wFull().gap(16).itemsStart();
        defer r.end();
        card(c);
        // The balance counts to its new figure when funds arrive or go.
        const balance = ui.motion.number(c, "balance", @floatCast(num(m.balance)), look.change);
        look.stat(c, "Balance", dollars(c, c.print("{d:.2}", .{balance})), "", c.print("{s} available to spend now", .{dollars(c, m.available_to_spend)}), true);
        c.end();
    }
    if (a.money_arrived > 0 and a.now - a.money_arrived_at < 60) look.status(c, .ok, c.print("Your balance rose by ${s}.", .{fmt.usdcd(fa, a.money_arrived, 2)}));
    if (num(m.needed_to_start) > 0) {
        look.label(c, c.print("Add {s} to start.", .{dollars(c, m.needed_to_start)}));
        look.small(c, "It covers your node's one-time registration and what your agents pay from.");
    }
    if (look.ghost(c, "Already have USDC?", .{})) a.money_own = !a.money_own;
    if (a.money_own) {
        const me = if (a.store.get(.identity)) |i| i.address else "";
        look.small(c, "Send only USDC, and only on the Arc network, to your node's address: USDC sent on another network doesn't reach this balance. It counts as soon as it lands, and the node keeps a little of it for network fees.");
        const r = ui.div(c).row().gap(8).itemsCenter();
        defer r.end();
        look.mono(c, if (me.len > 0) me else "Reading the address…", null);
        copyButton(a, c, "Copy", me, "Copied the node's address");
    }
    // Above the fold: past that date agents quietly pay from this node's own balance instead.
    renewBanner(a, c);
    signBanner(a, c);
    agentsSummary(a, c, m);
    earningsSummary(a, c, w);
    advancedFold(a, c);
    if (!a.money_advanced) return;
    details(a, c, m, w);
    {
        const p = look.panel(c, "Earned by day", "From your routes other agents use");
        defer p.end();
        look.panelBody(c);
        const b = look.pad(c);
        defer b.end();
        const days = w.earned.by_day;
        if (days.len > 0) {
            const n = @min(days.len, 14);
            const vals = fa.alloc(f64, n) catch return;
            const labels = fa.alloc([]const u8, n) catch return;
            for (days[days.len - n ..], 0..) |d, i| {
                vals[i] = d[1];
                labels[i] = fmt.day(fa, d[0] * 86400);
            }
            look.bars(c, vals, labels, 110);
        } else look.body(c, c.print("Nothing earned yet. List a route on My routes; each paid fetch an agent makes sends {d}% of its fee to the route's coin, or to you while it has none.", .{w.split.contributor}));
        kvRow(c, c.print("Your routes' share ({d}% of each fee)", .{w.split.contributor}), c.print("{s} USDC", .{fmt.usdcd(fa, w.earned.entries, 3)}));
        kvRow(c, "From staking route coins", c.print("{s} USDC", .{fmt.usdcd(fa, w.earned.staking, 3)}));
    }
    routeCoins(a, c);
    earnings(a, c);
    price(a, c, w);
    withdrawPanel(a, c, w);
    identity(a, c, if (w.chain_id > 0) c.print("Chain {d}, block {s}", .{ w.chain_id, fmt.count(fa, w.block) }) else "", w.settlement);
}

/// The Advanced fold's toggle: everything under it stays closed until the owner opens it.
fn advancedFold(a: *App, c: *ui.Context) void {
    look.rule(c);
    const r = ui.div(c).row().wFull().gap(8).itemsCenter();
    defer r.end();
    if (look.ghost(c, if (a.money_advanced) "Advanced  ▾" else "Advanced  ›", .{})) a.money_advanced = !a.money_advanced;
    look.small(c, "Where the balance sits, the deposit, your route coins, your price and paying from your account");
}

/// Earnings in plain words: what is ready to take (`earnings`), paid whole, with Cash out (`collect_earnings`), and what
/// the owner's route coins are worth in UNB (`coin_holdings`).
fn earningsSummary(a: *App, c: *ui.Context, w: types.Wallet) void {
    const fa = c.alloc();
    const ready = if (a.store.get(.earnings)) |e| e.to_claim else w.to_claim;
    const coins = (a.store.get(.coin_holdings) orelse types.Holdings{}).coins;
    var worth: f64 = 0;
    for (coins) |h| worth += h.value_unb;
    // Route coins show here only once the owner holds some; before that, earnings are their routes' share alone.
    const has_coins = coins.len > 0;
    const p = look.panel(c, "Earnings", if (has_coins) "From other agents using your routes, and your route coins" else "From other agents using your routes");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    {
        const r = ui.div(c).row().wFull().gap(20).itemsStart();
        defer r.end();
        look.stat(c, "Ready to cash out", dollars(c, cents(fa, ready)), "", if (has_coins) "Your routes' share of paid calls, and what your route coins earned. Nothing is on hold" else "Your routes' share of other agents' paid calls. Nothing is on hold", false);
        if (has_coins) look.stat(c, "Route coins", fmt.unb(fa, worth), "UNB", c.print("{s}, staked or not, at today's prices{s}. Their value can change", .{ fmt.plural(fa, @floatFromInt(coins.len), "route coin"), aboutUsd(c, coins) }), false);
    }
    const r = ui.div(c).row().gap(12).itemsCenter();
    defer r.end();
    if (look.primary(c, "Cash out", .{ .disabled = ready <= 0, .loading = a.store.isBusy("collect") })) a.store.act(.cash_out, "collect", "collect_earnings", "{}");
    look.small(c, "Cash out adds all of it to your balance.");
}

/// Advanced: where the balance sits, in USDC on Arc, and the chain's day.
fn details(a: *App, c: *ui.Context, m: types.Money, w: types.Wallet) void {
    const fa = c.alloc();
    const p = look.panel(c, "Where the balance sits", "USDC on Arc, one dollar each");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    kvRow(c, "At this node's address", c.print("{s} USDC", .{m.parts.at_address}));
    kvRow(c, "Of that, kept for network fees", c.print("{s} USDC", .{m.parts.kept_for_fees}));
    kvRow(c, "In the Settlement deposit agents pay from", c.print("{s} USDC", .{m.parts.deposit}));
    if (m.parts.account_deposit) |d| kvRow(c, "In your account's deposit", c.print("{s} USDC", .{d}));
    kvRow(c, "Used by agents, collected automatically", c.print("{s} USDC", .{m.parts.signed}));
    kvRow(c, c.print("Today (epoch {d}) ends in", .{w.epoch}), fmt.duration(fa, w.epoch_ends_in));
    if (look.secondary(c, "Collect usage now", .{ .loading = a.store.isBusy("claim") })) a.store.act(.generic, "claim", "claim_now", "{}");
}

/// Advanced: withdrawing from the Settlement deposit, which takes two days. The main path never offers it.
fn withdrawPanel(a: *App, c: *ui.Context, w: types.Wallet) void {
    const fa = c.alloc();
    const withdraw_ready = withdrawReady(w);
    const p = look.panel(c, "Withdraw from the deposit", if (w.pending_withdrawal > 0) c.print("{s} USDC leaving{s}", .{ fmt.usdc(fa, leaving(w)), if (withdraw_ready) ", ready now" else c.print(" from epoch {d}", .{w.withdraw_epoch}) }) else "");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.body(c, "A withdrawal completes two days after you ask, so no agent's payment is left without funds. It goes to your linked wallet; with none linked, it stays at this node's own address. USDC you bought by card is meant to be spent on calls.");
    if (leaving(w) < w.pending_withdrawal) look.status(c, .warn, c.print("Agents' payments used part of the deposit since you asked: {s} USDC is what's left to go, not the {s} you asked for.", .{ fmt.usdc(fa, leaving(w)), fmt.usdc(fa, w.pending_withdrawal) }));
    const r2 = ui.div(c).row().gap(8);
    defer r2.end();
    if (look.secondary(c, "Move to the deposit", .{ .disabled = w.held <= 0 })) openMove(a, .deposit, w);
    if (look.secondary(c, "Ask to withdraw", .{ .disabled = askable(w) <= 0 })) openMove(a, .withdraw, w);
    if (withdraw_ready and look.primary(c, "Complete withdrawal", .{ .loading = a.store.isBusy("withdraw") })) a.store.act(.generic, "withdraw", "withdraw", "{}");
    const dev = if (a.store.get(.node_info)) |i| i.dev else false;
    if (dev and look.ghost(c, "Advance a day (devnet)", .{ .size = .sm })) a.store.act(.generic, "day", "advance_day", "{}");
}

/// Whether a withdrawal asked for can be completed now.
fn withdrawReady(w: types.Wallet) bool {
    return w.pending_withdrawal > 0 and w.epoch >= w.withdraw_epoch;
}

/// The most a new request can ask for: the contract takes only what isn't already leaving (`requestWithdraw`).
fn askable(w: types.Wallet) f64 {
    return @max(0, w.deposit - w.pending_withdrawal);
}

/// What completing pays: claims made meanwhile can draw the deposit below what was asked for, and only what is left goes
/// (`withdraw`).
fn leaving(w: types.Wallet) f64 {
    return @min(w.pending_withdrawal, w.deposit);
}

/// Lines of plain explanation, one a bullet.
pub fn bullets(c: *ui.Context, lines: []const []const u8) void {
    const col = ui.div(c).column().wFull().gap(4);
    defer col.end();
    for (lines) |l| look.small(c, c.print("•  {s}", .{l}));
}

const coin_cols = [_]look.Col{
    .{ .name = "Entry" },
    .{ .name = "Staked", .w = 150, .end = true },
    .{ .name = "Asked back", .w = 170, .end = true },
    .{ .name = "To claim", .w = 110, .end = true },
    .{ .name = "Parked", .w = 96, .end = true },
};

/// Route coins, said plainly: what buys them, what makes their stake earn, and how they come back.
pub const coins_said = [_][]const u8{
    "A paid fetch your agents make on an entry with a coin buys some of it and stakes it for you, by itself.",
    "Staked coins earn their entry's share of each paid fetch once you have checked the entry, while your own latest paid call on it passed.",
    "Coins you ask back stop earning at once, and are yours to take back after their lot's exit delay. Their value can change.",
    "Parked is what a paid fetch put towards a buy that couldn't go through at once; the node completes it on a later pass.",
};

/// An exit delay in words: "1 day", "7 days", else hours and minutes.
fn delayWord(a: std.mem.Allocator, secs: f64) []const u8 {
    if (secs >= 86400 and @mod(secs, 86400) == 0) return fmt.plural(a, secs / 86400, "day");
    return fmt.duration(a, secs);
}

/// Advanced: the owner's route coins (`coin_holdings`), in place of the bond, route stakes and vesting: per coin, its
/// entry, the coins staked in each lot with its exit delay, the coins asked back and when they are ready (taken back
/// here once they are, `coin_withdraw`), what its stake earned to claim, and USDC a fetch paid whose buy is parked.
fn routeCoins(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const h = a.store.get(.coin_holdings) orelse types.Holdings{};
    var worth: f64 = 0;
    for (h.coins) |x| worth += x.value_unb;
    const t = look.tableHead(c, "Route coins", if (h.coins.len > 0) c.print("{s} UNB at today's prices{s}", .{ fmt.unb(fa, worth), aboutUsd(c, h.coins) }) else "", &coin_cols);
    defer t.end();
    if (a.store.err(.coin_holdings)) |e| if (!a.store.loaded(.coin_holdings)) {
        look.rule(c);
        const d = ui.div(c).wFull().p(16);
        defer d.end();
        look.failText(c, e);
    };
    if (h.coins.len == 0 and a.store.loaded(.coin_holdings)) {
        look.rule(c);
        look.empty(c, "No route coins yet. A paid fetch your agents make on an entry with a coin buys some and stakes it for you.");
    }
    const muted = look.x(c).text3;
    for (h.coins) |x| {
        const tr = look.tableRow(c, x.entry, false);
        defer tr.end();
        {
            const cell = look.cellBox(c, coin_cols[0]);
            defer cell.end();
            {
                const rr = ui.div(c).row().gap(8).itemsCenter();
                defer rr.end();
                look.mono(c, fmt.short(fa, x.entry), c.theme.text);
                if (x.state.len > 0) look.chip(c, fmt.capital(fa, x.state), false);
            }
            if (x.held > 0) look.small(c, c.print("{s} coins not staked", .{fmt.unb(fa, x.held)}));
            if (!x.checked or !x.latest_passed) look.small(c, "Not earning: its stake earns once you have checked the entry, while your latest paid call on it passed.");
        }
        {
            const cell = look.cellBox(c, coin_cols[1]);
            defer cell.end();
            var any = false;
            for (x.lots) |l| if (l.earning + l.pending > 0) {
                any = true;
                look.figure(c, fmt.unb(fa, l.earning + l.pending), false);
                ui.text(c, c.print("{s} exit delay", .{delayWord(fa, l.delay)}), .{ .size = 11.5, .color = muted });
            };
            if (!any) look.figure(c, "None", true);
        }
        {
            const cell = look.cellBox(c, coin_cols[2]);
            defer cell.end();
            var any = false;
            for (x.lots) |l| if (l.unstaking > 0) {
                any = true;
                ui.key(c, c.print("out-{d}", .{l.delay}));
                const lot = ui.div(c).column().gap(2).itemsEnd();
                defer lot.end();
                look.figure(c, fmt.unb(fa, l.unstaking), false);
                const ready = l.ready_at <= a.now;
                ui.text(c, if (ready) "Ready now" else c.print("Ready {s}, {s}", .{ fmt.date(fa, l.ready_at), fmt.clock(fa, l.ready_at) }), .{ .size = 11.5, .color = muted });
                const label = c.print("take-{s}-{d}", .{ x.entry, l.delay });
                if (ready and look.secondary(c, "Take back", .{ .size = .xs, .loading = a.store.isBusy(label) }))
                    a.store.actWith(.generic, label, "coin_withdraw", .{ .entry = x.entry, .delay = @as(u64, @intFromFloat(l.delay)) });
            };
            if (!any) look.figure(c, "None", true);
        }
        {
            const cell = look.cellBox(c, coin_cols[3]);
            defer cell.end();
            look.figure(c, c.print("{s} USDC", .{fmt.usdcd(fa, x.owed_usdc, 4)}), x.owed_usdc <= 0);
        }
        const cell = look.cellBox(c, coin_cols[4]);
        defer cell.end();
        look.figure(c, c.print("{s} USDC", .{fmt.usdcd(fa, x.parked_usdc, 4)}), x.parked_usdc <= 0);
    }
    look.rule(c);
    const b = look.pad(c);
    defer b.end();
    bullets(c, &coins_said);
    look.small(c, c.print("The coins your paid fetches buy are staked with a {s} exit delay.", .{delayWord(fa, h.fetch_delay)}));
}

/// Where earnings come from (`earnings`).
const Source = struct { label: []const u8, said: []const u8 };
const sources = [_]Source{
    .{ .label = "From staking route coins", .said = "Your staked, checked coins' part of each paid fetch of their entries" },
    .{ .label = "As contributor", .said = "Your entries' share of paid fetches while they had no coin" },
};

const earn_cols = [_]look.Col{
    .{ .name = "Where from" },
    .{ .name = "Earned", .w = 96, .end = true },
    .{ .name = "Taken", .w = 96, .end = true },
    .{ .name = "Ready", .w = 110, .end = true },
};

pub const earnings_note = "In USDC, paid whole: nothing is on hold and nothing vests. Cash out, above, adds everything ready to your balance.";

/// Earnings by where they came from (`earnings`): staking route coins and as a contributor, each apart, with what was
/// taken and what is ready to take; and what the owner's entries sent to their coins.
fn earnings(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const e = a.store.get(.earnings) orelse types.Earnings{};
    const lines = [_]types.EarningsLine{ e.staking, e.contributor };
    const t = look.tableHead(c, "Earnings by where they came from", c.print("{s} USDC ready to cash out", .{fmt.usdcd(fa, e.to_claim, 4)}), &earn_cols);
    defer t.end();
    for (sources, lines, 0..) |src, l, i| {
        const tr = look.tableRow(c, c.print("earn-{d}", .{i}), false);
        defer tr.end();
        {
            const cell = look.cellBox(c, earn_cols[0]);
            defer cell.end();
            look.label(c, src.label);
            look.small(c, src.said);
        }
        const vals = [_]f64{ l.earned, l.claimed, l.to_claim };
        for (vals, 1..) |n, k| {
            const cell = look.cellBox(c, earn_cols[k]);
            defer cell.end();
            look.figure(c, fmt.usdcd(fa, n, 4), n <= 0);
        }
    }
    look.rule(c);
    const b = look.pad(c);
    defer b.end();
    if (e.routes_paid > 0) look.small(c, c.print("Your entries' paid fetches sent {s} USDC to their coins, which pays whoever stakes them.", .{fmt.usdcd(fa, e.routes_paid, 4)}));
    look.small(c, earnings_note);
}

/// Asked before the wallet's grant to this node's agents runs out (§76.2 item 3): renew it in one step.
fn renewBanner(a: *App, c: *ui.Context) void {
    const signed = if (a.store.get(.link_status)) |l| l.owner != null else false;
    if (!signed) return;
    const n = a.store.get(.owner_nodes) orelse return;
    const by = n.renew_by orelse return;
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    look.status(c, .warn, c.print("Your account's permission for this node's agents to spend from it runs out on {s}. After that they pay from this node's own balance.", .{fmt.date(c.alloc(), by)}));
    if (look.primary(c, "Renew", .{ .loading = a.store.isBusy("renew") })) a.store.act(.generic, "renew", "wallet_renew", "{}");
}

/// The listings this node keeps for the owner's wallet to sign (`listings_to_sign`): it lists under the wallet's
/// identity and doesn't hold its key, and no agent key signs for it, so the wallet signs each one on the sign-in page,
/// as it sends its grants. Each is said as the node words it, and nothing spreads before it is signed.
fn signBanner(a: *App, c: *ui.Context) void {
    const all = a.store.get(.listings_to_sign) orelse return;
    if (all.len == 0) return;
    const p = look.panel(c, if (all.len == 1) "A listing to approve" else c.print("{d} listings to approve", .{all.len}), "Only you can approve them; no agent key can");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    for (all) |l| look.small(c, l.what);
    look.small(c, "You approve each one in your browser, with the account you signed in with. It sends nothing and costs nothing. Until you approve them, nobody else can find these routes.");
    if (look.primary(c, "Approve in my browser", .{ .loading = a.store.isBusy("sign_listings") })) a.store.act(.generic, "sign_listings", "listings_sign", "{}");
}

/// The node's own address (the key that signs its writes and pays their gas) and the owner's wallet linked to it,
/// read from `identity` and `link_status` rather than the chain's wallet reply, so both show while Settlement isn't
/// deployed: when the owner needs the address to fund it. Settlement's address, once there is one.
fn identity(a: *App, c: *ui.Context, meta: []const u8, settlement: []const u8) void {
    const p = look.panel(c, "Addresses", meta);
    defer p.end();
    look.panelBody(c);
    {
        const it = look.item(c, "node-address", "This node's wallet", "An Arc wallet made from this node's own key. The node joins the network with it and pays its network fees from it, with no sign-in. With no wallet of yours linked, it also signs its listings and earns into it; once you link one, it lists and earns under your wallet, which signs each listing. USDC sent here counts in your balance.");
        defer it.end();
        const me = if (a.store.get(.identity)) |i| i.address else "";
        look.mono(c, if (me.len > 0) me else "Reading the key", null);
        it.right();
        copyButton(a, c, "Copy", me, "Copied the node's address");
    }
    look.rule(c);
    // The linked wallet in one row: what it is, or that none is needed, with the one thing to do about it on the right.
    if (a.store.get(.link_status)) |l| {
        const owner = l.owner orelse "";
        const it = look.item(c, "owner-wallet", "Linked wallet", if (owner.len > 0) "Withdrawals from the deposit go here" else if (l.waiting) "" else none_linked);
        defer it.end();
        if (owner.len > 0) look.mono(c, owner, null) else {
            if (l.waiting) look.status(c, .running, waiting_said) else look.small(c, LINK_HOLDS_LISTINGS);
            if (l.@"error") |e| look.failText(c, e);
        }
        it.right();
        if (owner.len > 0) {
            copyButton(a, c, "Copy", owner, "Copied the linked wallet's address");
            if (look.ghost(c, "Unlink", .{ .disabled = a.store.isBusy("unlink") })) a.store.act(.generic, "unlink", "unlink", "{}");
        } else linkButton(a, c, l.waiting);
    }
    if (settlement.len > 0) {
        look.rule(c);
        const it = look.item(c, "settlement", "Settlement contract", "");
        defer it.end();
        look.mono(c, settlement, null);
        it.right();
    }
}

const none_linked = "None, and none is needed: your node uses its own wallet";
const waiting_said = "Waiting for you to finish in your browser…";

/// What linking a wallet does to listing, said before the owner links one and while one is linked: the node lists
/// under the wallet's identity, and only the wallet signs a listing, so each one waits for the owner (R1.12, #184).
pub const LINK_HOLDS_LISTINGS = "Once you sign in, your node lists and earns under your account, and every listing waits for you to approve it under Money, in your browser: nothing is shared until you do.";

/// Linking a wallet, which is optional: the node is on the network with its own wallet (spec §86). One row: not linked,
/// or waiting on the website's sign-in in the owner's browser (`link_start`), with the button that starts it or starts
/// it again; why the last one failed under it. The node says when the link lands (its `identity` event), and the window
/// reads `link_status` again then. Nothing once a wallet is linked.
pub fn signIn(a: *App, c: *ui.Context) void {
    const l = a.store.get(.link_status) orelse return;
    if (l.owner != null) return;
    ui.key(c, "sign-in");
    const col = ui.div(c).column().wFull().gap(8);
    defer col.end();
    {
        const r = ui.div(c).row().wFull().gap(8).itemsCenter();
        defer r.end();
        if (l.waiting) look.status(c, .running, waiting_said) else look.label(c, "Not signed in");
        ui.spacer(c);
        linkButton(a, c, l.waiting);
    }
    if (!l.waiting) look.small(c, LINK_HOLDS_LISTINGS);
    if (l.@"error") |e| look.failText(c, e);
}

/// Link a wallet, or Start again while the browser's sign-in is open: both open it anew.
fn linkButton(a: *App, c: *ui.Context, waiting: bool) void {
    if (look.secondary(c, if (waiting) "Start again" else "Sign in", .{ .loading = a.store.isBusy("link_start") })) a.store.act(.generic, "link_start", "link_start", "{}");
}

/// A copy button labelled `label` for `value`, when there is one: it goes to the clipboard and a toast says so.
pub fn copyButton(a: *App, c: *ui.Context, label: []const u8, value: []const u8, said: []const u8) void {
    if (value.len > 0 and look.ghost(c, label, .{})) {
        c.clipboard.write(c.clipboard.ctx, value);
        a.toaster.push(.{ .status = .success, .title = said, .duration = 2 });
        a.cheer();
    }
}

/// The node's address, shortened, for the sidebar: a click away from any screen. The address is its own Copy button,
/// so the sidebar's narrow card never cuts a label short.
pub fn shortAddress(a: *App, c: *ui.Context) void {
    const me = if (a.store.get(.identity)) |i| i.address else "";
    if (me.len == 0) return;
    ui.key(c, "sidebar-address");
    const b = ui.div(c).row().px(4).py(1).offset(-4, 0).gap(6).itemsCenter().rounded(5).control().hover(c.theme.surface_hover);
    defer b.end();
    look.mono(c, fmt.short(c.alloc(), me), null);
    if (b.hovered()) ui.text(c, "Copy", .{ .size = 11.5, .weight = .medium, .color = look.x(c).text3 });
    if (b.clicked()) {
        c.clipboard.write(c.clipboard.ctx, me);
        a.toaster.push(.{ .status = .success, .title = "Copied the node's address", .duration = 2 });
        a.cheer();
    }
}

/// The node's recovery phrase: 12 seed words for a node made from them, which open its wallet in any wallet app, or 24
/// words for an older node, which bring back this node only. The word count says which. Shown only while asked for,
/// never kept anywhere but on screen, wiped on hide.
pub fn recovery(a: *App, c: *ui.Context) void {
    const p = look.panel(c, "Recovery phrase", "Settings, Security");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    look.body(c, "These words are your node's backup key. Everything comes from it: its balance, every agent, every derived password. Write them down and keep them off this computer: anyone with them has all of it.");
    if (a.phrase) |words| {
        var count = std.mem.tokenizeScalar(u8, words, ' ');
        var shown: usize = 0;
        while (count.next()) |_| shown += 1;
        look.small(c, if (shown == 12)
            "These 12 words are a standard wallet's seed words. They open this node's wallet, the same address, in MetaMask, Rabby or any other wallet app, and bring this node back here or on another computer."
        else
            "These 24 words are an older node's key. They bring back this node only: another wallet app reading them makes a different address. To open this node's wallet in a wallet app, export an encrypted backup of its key and import that.");
    } else look.small(c, "A node made with seed words shows 12, which open its wallet in any wallet app. An older node shows 24, which bring back this node only.");
    if (a.phrase) |words| {
        const grid = ui.div(c).row().wFull().gap(12).p(12).rounded(10).border(look.x(c).frame);
        defer grid.end();
        c.node(grid.index).style.selectable = true;
        var it = std.mem.tokenizeScalar(u8, words, ' ');
        var all: [24][]const u8 = undefined;
        var n: usize = 0;
        while (it.next()) |w| : (n += 1) {
            if (n == all.len) break;
            all[n] = w;
        }
        const rows = (n + 3) / 4;
        for (0..4) |col_i| {
            const col = ui.div(c).column().grow().gap(6);
            defer col.end();
            for (0..rows) |r| {
                const i = col_i * rows + r;
                if (i >= n) break;
                const line = ui.div(c).row().gap(8);
                defer line.end();
                ui.text(c, c.print("{d}", .{i + 1}), .{ .size = 12, .color = look.x(c).text3, .mono = true });
                ui.text(c, all[i], .{ .size = 13, .mono = true });
            }
        }
    }
    const r = ui.div(c).row().gap(8);
    defer r.end();
    if (a.phrase != null) {
        if (look.secondary(c, "Hide", .{})) a.hidePhrase();
    } else if (look.secondary(c, "Show the words", .{ .loading = a.store.isBusy("phrase") })) a.store.act(.wallet_phrase, "phrase", "wallet_phrase", "{}");
    if (look.ghost(c, "Restore from the words", .{})) a.open(.restore_key);
}

fn restoreKey(a: *App, c: *ui.Context) void {
    const d = kit.dialog(c, "restorekey", &a.dialog_open, .{
        .title = "Restore from your words",
        .description = "Restoring replaces this node's key. The current one is kept in this computer's keychain, not deleted.",
        .ok = "",
        .cancel = "",
    }) orelse return;
    {
        const f = look.field(c, "Your 12 or 24 words", .{});
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill, .multiline = true, .max_lines = 4, .placeholder = "word word word …" });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const words = a.field(0);
        if (look.danger(c, "Replace this node's key", .{ .disabled = words.len == 0, .loading = a.store.isBusy("restore") }))
            a.store.actWith(.wallet_restore, "restore", "wallet_restore", .{ .words = words });
    }
    _ = d.end();
}

/// The node's price: one fee for every route it lists, set by hand or moved with demand once an epoch.
fn price(a: *App, c: *ui.Context, w: types.Wallet) void {
    const fa = c.alloc();
    const p = look.panel(c, "Your price", if (w.pricing.auto) c.print("Follows demand and the market between {s} and {s} USDC", .{ fmt.usdcd(fa, w.pricing.floor, 4), fmt.usdcd(fa, w.pricing.ceiling, 4) }) else "Set by you");
    defer p.end();
    look.panelBody(c);
    const b = look.pad(c);
    defer b.end();
    const r = ui.div(c).row().wFull().gap(16).itemsCenter();
    defer r.end();
    const col = ui.div(c).column().grow().gap(2);
    look.label(c, if (w.fee > 0) c.print("{s} USDC a fetch, for every route you list", .{fmt.usdcd(fa, w.fee, 3)}) else "No fee set on the chain: each listing carries its own price");
    look.small(c, if (w.pricing.auto) c.print("Each new day the fee moves up a tenth if more paid fetches came than the day before, down a tenth if fewer or none. Yesterday: {d} paid fetches.", .{w.pricing.lines}) else "One write on the chain reprices every listed route at once.");
    col.end();
    if (look.secondary(c, if (w.fee > 0) "Change price" else "Set price", .{})) {
        a.open(.pricing);
        a.auto_fee = w.pricing.auto;
        var buf: [32]u8 = undefined;
        a.fields[0].set(std.fmt.bufPrint(&buf, "{d}", .{if (w.fee > 0) w.fee else 0.1}) catch "");
        a.fields[1].set(std.fmt.bufPrint(&buf, "{d}", .{w.pricing.floor}) catch "");
        a.fields[2].set(std.fmt.bufPrint(&buf, "{d}", .{w.pricing.ceiling}) catch "");
    }
}

fn pricingDialog(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const split = (a.store.get(.wallet) orelse types.Wallet{}).split;
    const d = kit.dialog(c, "pricing", &a.dialog_open, .{ .title = "Your price", .description = c.print("Agents pay this fee per detail fetch that passes, on every route your node lists. {d}% goes to the route's coin, paying whoever stakes it, or to you while the route has no coin; {d}% goes to the site and {d}% is a network fee.", .{ split.contributor, split.site, split.burn }), .ok = "", .cancel = "", .width = 500 }) orelse return;
    const fee = a.number(0) orelse 0;
    const floor = a.number(1) orelse 0;
    const ceiling = a.number(2) orelse 0;
    {
        const f = look.field(c, "Detail fee per fetch, USDC", .{ .hint = if (fee > 0) c.print("{s} USDC of it goes to the route's coin each time an agent's fetch passes, or to you while it has none. A failed call is never charged.", .{fmt.usdcd(fa, fee * split.contributor / 100, 4)}) else "Set a fee above zero." });
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill });
        f.end();
    }
    {
        const r = ui.div(c).row().wFull().gap(16).itemsStart();
        defer r.end();
        const w = ui.div(c).column().grow().gap(2);
        look.label(c, "Adjust with demand");
        look.small(c, "Once a day: up a tenth when more paid fetches came than the day before, down a tenth when fewer or none, never past your bounds.");
        w.end();
        _ = look.toggle(c, &a.auto_fee);
    }
    const bad_bounds = a.auto_fee and (floor <= 0 or ceiling < floor);
    if (a.auto_fee) {
        const r = ui.div(c).row().wFull().gap(12);
        defer r.end();
        inline for (.{ .{ 1, "Floor, USDC" }, .{ 2, "Ceiling, USDC" } }) |fl| {
            const col = ui.div(c).column().grow().minW(0);
            defer col.end();
            const f = look.field(c, fl[1], .{});
            _ = ui.textField(c, &a.fields[fl[0]], .{ .width = .fill });
            f.end();
        }
    }
    if (bad_bounds) look.failText(c, "Set a floor above zero and a ceiling at or above it.");
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        if (look.primary(c, "Save price", .{ .size = .md, .disabled = !(fee > 0) or bad_bounds, .loading = a.store.isBusy("price") }))
            a.store.actWith(.close, "price", "set_pricing", .{ .fee = fee, .auto = a.auto_fee, .floor = if (a.auto_fee) floor else 0.01, .ceiling = if (a.auto_fee) ceiling else 1 });
    }
    _ = d.end();
}

fn card(c: *ui.Context) void {
    _ = ui.div(c).row().grow().minW(0).gap(20).p(16).rounded(12).border(look.x(c).frame);
}

fn kvRow(c: *ui.Context, k: []const u8, v: []const u8) void {
    const r = ui.div(c).row().wFull().gap(12);
    defer r.end();
    ui.text(c, k, .{ .size = 13, .color = look.x(c).text2 });
    ui.spacer(c);
    ui.text(c, v, .{ .size = 13, .mono = true });
}

const key_cols = [_]look.Col{
    .{ .name = "Agent" },
    .{ .name = "Spent today", .w = 104, .end = true },
    .{ .name = "Daily limit", .w = 96, .end = true },
    .{ .name = "", .w = 72, .end = true },
};

/// What agents spent today, in a line; their keys are kept on Agent access.
fn agentsSummary(a: *App, c: *ui.Context, m: types.Money) void {
    const fa = c.alloc();
    var n: f64 = 0;
    for (a.store.list(.agents_list)) |ag| n += @floatFromInt(@intFromBool(!ag.revoked and ag.expires > a.now));
    var spent: f64 = 0;
    for (m.agents) |x| spent += num(x.spent_today);
    const r = ui.div(c).row().wFull().gap(12).itemsCenter();
    defer r.end();
    look.body(c, if (n == 0) "No agents can reach this node yet." else c.print("{s} spent {s} today, each within its daily limit.", .{ fmt.plural(fa, n, "agent"), dollars(c, c.print("{d:.2}", .{spent})) }));
    ui.spacer(c);
    if (look.secondary(c, "Agent keys", .{})) a.go(.access);
}

/// Each agent with its daily limit and what it spent today, as `money` says; add one, or revoke one. On Agent access.
pub fn keys(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const m = a.store.get(.money) orelse types.Money{};
    const agents = a.store.list(.agents_list);
    var live: f64 = 0;
    var usable: f64 = 0;
    for (agents) |ag| {
        live += @floatFromInt(@intFromBool(!ag.revoked));
        usable += @floatFromInt(@intFromBool(!ag.revoked and ag.expires > a.now));
    }
    var new_key = false;
    const t = look.tableHeadAction(c, "Agents", fmt.count(fa, usable), &key_cols, "Add agent", &new_key);
    defer t.end();
    if (new_key) a.open(.new_key);
    if (live == 0) {
        look.rule(c);
        return look.empty(c, "No agents yet. Your node makes your first one by itself; add another for each agent you want to keep apart.");
    }
    for (agents) |ag| {
        if (ag.revoked) continue;
        const tr = look.tableRow(c, c.print("key-{d}", .{ag.index}), false);
        defer tr.end();
        var said: ?types.MoneyAgent = null;
        for (m.agents) |x| if (x.index == ag.index) {
            said = x;
        };
        {
            const cell = look.cellBox(c, key_cols[0]);
            defer cell.end();
            look.label(c, ag.name);
            if (ag.expires <= a.now) look.status(c, .warn, "Expired: this key is refused");
            if (said) |x| if (std.mem.eql(u8, x.pays_from, "account")) look.small(c, "Pays from your account");
        }
        {
            const cell = look.cellBox(c, key_cols[1]);
            defer cell.end();
            if (said) |x| look.figure(c, dollars(c, x.spent_today), false) else look.figure(c, "None", true);
        }
        {
            const cell = look.cellBox(c, key_cols[2]);
            defer cell.end();
            look.figure(c, c.print("${s}", .{fmt.usdcd(fa, ag.cap_usdc, 2)}), false);
        }
        const cell = look.cellBox(c, key_cols[3]);
        defer cell.end();
        if (look.ghost(c, "Revoke", .{})) {
            a.open(.revoke);
            a.index = ag.index;
            a.target.set(ag.name);
        }
    }
}

/// Each move, the token it moves and the command that makes it.
const MoveText = struct { title: []const u8, description: []const u8, cmd: []const u8, button: []const u8, unit: []const u8 };

fn moveText(m: Move) MoveText {
    return switch (m) {
        .faucet => .{ .title = "Add test funds", .description = "Test mode: the local chain's faucets mint this much test money at this node's address. It is worth nothing and never leaves this computer.", .cmd = "faucet", .button = "Add test funds", .unit = "of each" },
        .deposit => .{ .title = "Move to the deposit", .description = "Moves USDC from this node's address into the Settlement deposit agents pay from. The node does this by itself up to the floor in Settings.", .cmd = "deposit", .button = "Move", .unit = "USDC" },
        .withdraw => .{ .title = "Ask to withdraw", .description = "The amount leaves the deposit two days from now. Until then it still backs what your agents used.", .cmd = "request_withdraw", .button = "Ask to withdraw", .unit = "USDC" },
    };
}

fn maxOf(m: Move, w: types.Wallet) ?f64 {
    return switch (m) {
        .deposit => w.held, // deposit is USDC
        .withdraw => askable(w),
        .faucet => null,
    };
}

fn openMove(a: *App, m: Move, w: types.Wallet) void {
    a.open(.move);
    a.move = m;
    var buf: [32]u8 = undefined;
    const start: ?f64 = if (m == .faucet) 300000 else if (maxOf(m, w)) |mx| @floor(mx) else null;
    if (start) |s| if (s > 0) a.fields[0].set(std.fmt.bufPrint(&buf, "{d}", .{s}) catch "");
}

pub fn dialogs(a: *App, c: *ui.Context) void {
    switch (a.dialog) {
        .move => moveDialog(a, c),
        .new_key => newKey(a, c),
        .revoke => revoke(a, c),
        .pricing => pricingDialog(a, c),
        .restore_key => restoreKey(a, c),
        else => {},
    }
}

fn footer(c: *ui.Context) ui.Div {
    return ui.div(c).row().wFull().gap(8).justifyEnd().pt(4);
}

fn moveDialog(a: *App, c: *ui.Context) void {
    const fa = c.alloc();
    const m = moveText(a.move);
    const w = a.store.get(.wallet) orelse types.Wallet{};
    const max = maxOf(a.move, w);
    const d = kit.dialog(c, "move", &a.dialog_open, .{ .title = m.title, .description = m.description, .ok = "", .cancel = "" }) orelse return;
    const n = a.number(0) orelse 0;
    const too_much = if (max) |mx| n > mx else false;
    {
        const f = look.field(c, c.print("Amount, {s}", .{m.unit}), .{ .hint = if (max) |mx| c.print("{s} {s} available.", .{ fmt.fixed(fa, mx, 2), m.unit }) else "" });
        _ = ui.textField(c, &a.fields[0], .{ .width = .fill });
        f.end();
    }
    if (too_much) look.failText(c, "That's more than you have.");
    // A new request moves the date of everything already leaving (`requestWithdraw` sets it for the whole amount).
    if (a.move == .withdraw and w.pending_withdrawal > 0) {
        look.status(c, .warn, if (withdrawReady(w))
            c.print("{s} USDC is ready to complete now. Asking again starts the two days over for all of it: complete it first.", .{fmt.usdc(fa, leaving(w))})
        else
            c.print("{s} USDC is already leaving. Asking again adds to it and starts the two days over for all of it.", .{fmt.usdc(fa, leaving(w))}));
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        if (look.primary(c, m.button, .{ .size = .md, .disabled = !(n > 0) or too_much, .loading = a.store.isBusy("go") })) a.store.actWith(.close, "go", m.cmd, .{ .amount = n });
    }
    _ = d.end();
}

/// US-004: a key per agent, its cap and expiry set on the chain. The setup
/// string is shown once, then wiped from this window's memory.
fn newKey(a: *App, c: *ui.Context) void {
    if (a.setup) |setup| {
        const d = kit.dialog(c, "newkey", &a.dialog_open, .{ .title = c.print("{s} is ready", .{a.target.get()}), .description = "Give the agent this setup once. It won't be shown again; a lost one means adding the agent again.", .ok = "", .cancel = "", .width = 520 }) orelse return;
        look.well(c, setup);
        if (look.secondary(c, "Copy setup string", .{})) {
            c.clipboard.write(c.clipboard.ctx, setup);
            a.toaster.push(.{ .status = .success, .title = "Copied the setup string", .duration = 2 });
        }
        look.small(c, "The agent then says what it wants and the node does it, learning routes as it goes: tools unbrowse_do, unbrowse_browse, unbrowse_search and unbrowse_call.");
        {
            const f = footer(c);
            defer f.end();
            if (look.primary(c, "Done", .{ .size = .md })) a.close();
        }
        _ = d.end();
        return;
    }
    const d = kit.dialog(c, "newkey", &a.dialog_open, .{ .title = "Add an agent", .description = "Each agent gets its own key, made from your node's, with a daily limit it can't spend past.", .ok = "", .cancel = "", .width = 480 }) orelse return;
    if (a.fields[1].len == 0 and a.fields[2].len == 0) {
        a.fields[1].set("5");
        a.fields[2].set("30");
    }
    const rows = [_]struct { []const u8, []const u8, []const u8 }{
        .{ "Agent name", "Claude Code", "" },
        .{ "Daily limit, $", "", "Spending past it is refused before anything is paid." },
        .{ "Expires after, days", "", "" },
    };
    for (rows, 0..) |r, i| {
        ui.key(c, c.print("kf-{d}", .{i}));
        const f = look.field(c, r[0], .{ .hint = r[2] });
        _ = ui.textField(c, &a.fields[i], .{ .width = .fill, .placeholder = r[1] });
        f.end();
    }
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Cancel", .{ .size = .md })) a.close();
        const name = a.field(0);
        if (look.primary(c, "Add the agent", .{ .size = .md, .disabled = name.len == 0, .loading = a.store.isBusy("create") })) {
            a.target.set(name);
            a.store.actWith(.agent_create, "create", "agent_create", .{
                .name = name,
                .cap_usdc = a.number(1) orelse 0,
                .days = @as(u64, @intFromFloat(@max(0, a.number(2) orelse 0))),
            });
        }
    }
    _ = d.end();
}

fn revoke(a: *App, c: *ui.Context) void {
    const name = a.target.get();
    const d = kit.dialog(c, "revoke", &a.dialog_open, .{ .title = c.print("Revoke {s}?", .{name}), .description = "It stops working at once. What it already used is still paid; nothing it asks for after is.", .ok = "", .cancel = "" }) orelse return;
    if (a.err.len > 0) look.failText(c, a.err.get());
    {
        const f = footer(c);
        defer f.end();
        if (look.secondary(c, "Keep the key", .{ .size = .md })) a.close();
        if (look.danger(c, c.print("Revoke {s}", .{name}), .{ .loading = a.store.isBusy("revoke") })) a.store.actWith(.close, "revoke", "agent_revoke", .{ .index = a.index });
    }
    _ = d.end();
}
