//! The window driven by ui.Tester against canned answers shaped like the
//! node's: no network, no window. With UNB_SNAP_DIR set, each test also
//! writes its frame there as a PNG.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;
const App = @import("app.zig").App;
const shell = @import("shell.zig");
const look = @import("look.zig");

test {
    _ = @import("types.zig");
    _ = @import("links.zig");
    _ = @import("fmt.zig");
    _ = @import("api.zig");
    _ = @import("store.zig");
    _ = @import("handoff.zig");
    _ = @import("live.zig");
    _ = @import("burst.zig");
    _ = @import("picture.zig");
    _ = @import("png.zig");
    _ = @import("hands.zig");
    _ = @import("screens/lanes.zig");
    _ = @import("screens/access.zig");
    _ = @import("screens/move_to_apps.zig");
}

const canned = .{
    .{ .node_info, "{\"name\":\"studio-mac\",\"version\":\"0.1.0\",\"api_port\":7788,\"dev\":true,\"terms_version\":\"2026-11-01\"}" },
    .{ .settings, "{\"map_while_browsing\":true,\"hold_routes\":false,\"signed_in_calls\":false,\"paused\":false,\"api_port\":7788,\"storage_gb\":5,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"terms_accepted\":\"2026-11-01\"}" },
    .{ .chain_status, "{\"up\":true,\"error\":null,\"rpc\":\"http://127.0.0.1:8545\",\"deployment\":null,\"payments\":\"test\"}" },
    .{ .routes, "[{\"id\":\"r1\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"method\":\"GET\",\"path\":\"/api/v1/crates?q={q}\",\"root\":\"crates.io\",\"inputs\":[{\"name\":\"q\",\"secret\":false,\"default\":null}],\"steps\":1,\"browser_assisted\":false,\"write\":false,\"provisional\":false,\"learned_at\":1,\"stats\":{\"calls\":7,\"passed\":7,\"last_ms\":420,\"last_at\":1,\"last_error\":null},\"listing\":null}," ++
        "{\"id\":\"r2\",\"site\":\"www.npmjs.com\",\"what\":\"search npm packages\",\"method\":\"GET\",\"path\":\"/search?q={q}\",\"root\":\"www.npmjs.com\",\"inputs\":[],\"steps\":1,\"browser_assisted\":false,\"write\":false,\"provisional\":false,\"learned_at\":1,\"stats\":{\"calls\":3,\"passed\":1,\"last_ms\":311,\"last_at\":1,\"last_error\":\"the target answered, but not in the recorded shape\"},\"listing\":null}]" },
    .{ .sites, "[{\"host\":\"crates.io\",\"walked\":1},{\"host\":\"unbrowse.ai\",\"walked\":null}]" },
    .{ .wallet, "{\"address\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"earned\":{\"entries\":1.5,\"staking\":0.25,\"lines\":12,\"by_day\":[[20745,0.5],[20746,1.25]]},\"to_claim\":0}" },
};

fn load(a: *App) void {
    inline for (canned) |entry| a.store.put(entry[0], entry[1]);
}

fn snap(t: *ui.Tester, name: []const u8) void {
    const dir = std.c.getenv("UNB_SNAP_DIR") orelse return;
    var buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&buf, "{s}/{s}.png", .{ std.mem.span(dir), name }) catch return;
    t.screenshot(path) catch {};
}

fn scratch() std.heap.ArenaAllocator {
    return .init(std.testing.allocator);
}

const terms_text = "{\"version\":\"2026-11-01\",\"terms\":\"# Terms of Service\\n\\nThe node joins the Network.\\nIt runs on\\nyour machine.\",\"privacy\":\"# Privacy Policy\\n\\nWhat leaves this machine.\"}";
const settings_due = "{\"map_while_browsing\":true,\"hold_routes\":false,\"signed_in_calls\":false,\"paused\":false,\"api_port\":7788,\"storage_gb\":5,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"terms_accepted\":\"2026-10-29\",\"peer_network\":true}";
const settings_off = "{\"map_while_browsing\":true,\"hold_routes\":false,\"signed_in_calls\":false,\"paused\":false,\"api_port\":7788,\"storage_gb\":5,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"terms_accepted\":null,\"peer_network\":false}";

const settings_basic = "{\"map_while_browsing\":true,\"hold_routes\":false,\"signed_in_calls\":false,\"paused\":false,\"api_port\":7788,\"storage_gb\":5,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"terms_accepted\":\"2026-11-01\",\"advanced\":false}";

test "a newcomer's sidebar lists the basic screens, and the advanced ones come with the owner's switch" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, settings_basic);
    a.finish_due = false;
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.access);
    t.settle(1);
    for ([_][]const u8{ "Agents", "Money", "Vault", "Settings" }) |shown| try std.testing.expect(t.hasText(shown));
    for ([_][]const u8{ "Node", "Live", "My routes", "Activity", "Leaderboard", "Browser" }) |hidden| try std.testing.expect(!t.hasText(hidden));
    snap(&t, "test-sidebar-basic");
    // A screen's shortcut still opens it, and it is listed while it shows.
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(t.hasText("My routes"));
    // More screens, under the basic ones, turns the rest on; the switch in Settings is the same choice.
    try t.clickText("More screens");
    try std.testing.expect(std.mem.containsAtLeast(u8, a.store.lastLog(), 1, "\"advanced\":true"));
    a.go(.settings);
    t.settle(1);
    try std.testing.expect(t.hasText("Show advanced screens"));
    a.store.put(.settings, canned[1][1]);
    t.settle(1);
    for ([_][]const u8{ "Node", "Live", "My routes", "Activity", "Leaderboard" }) |shown| try std.testing.expect(t.hasText(shown));
    try std.testing.expect(!t.hasText("More screens"));
}

test "a newcomer's home says what Unbrowse does in plain words, and keeps keys, fees and addresses for the advanced screens" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, settings_basic);
    a.store.put(.identity, "{\"address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"created\":false}");
    a.store.put(.remote_status, "{\"on\":true,\"url\":\"https://unbrowse.ai/p/x/mcp\",\"public\":false,\"keys\":[]}");
    a.finish_due = false;
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 1600 });
    defer t.deinit();
    a.go(.access);
    a.clients_known = false;
    t.settle(1);
    // Still looking: no count that the list under it contradicts.
    try std.testing.expect(!t.containsText("0 agents found"));
    // No route fees, vouchers, MCP or shell for a newcomer: one line on what an answer can cost.
    try std.testing.expect(t.containsText("Some sites charge for an answer"));
    for ([_][]const u8{ "contributor", "voucher", "unb mcp", "Any other agent", "this node", "This node", "The node" }) |w| {
        if (t.containsText(w)) {
            std.debug.print("a newcomer's home still says {s}\n", .{w});
            return error.TestUnexpectedResult;
        }
    }
    try std.testing.expect(t.hasText("Your Unbrowse address"));
    // The wallet's address isn't in the sidebar.
    try std.testing.expect(!t.containsText("0x1234"));
    // Nothing connected (the owner passed the apps step by): Undo has nothing to put back, and a click sends nothing.
    a.connect_checked = true;
    a.connect_dismissed = true;
    putClients(a, "{\"clients\":[{\"id\":\"cursor\",\"name\":\"Cursor\",\"found\":true,\"connected\":false,\"path\":\"p\"}]}");
    t.settle(1);
    const before = a.store.lastLog();
    t.clickText("Undo") catch {};
    try std.testing.expectEqualStrings(before, a.store.lastLog());
    snap(&t, "test-home-basic-words");
}

test "a new node's window chooses the basic screens once, and a node from before keeps them all" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    // From before the choice: every screen, and nothing saved.
    try std.testing.expect(a.advanced());
    a.noteNewNode();
    try std.testing.expect(!std.mem.containsAtLeast(u8, a.store.lastLog(), 1, "advanced"));
    // A new node: the basic screens, kept by the node.
    a.new_node = null;
    a.store.put(.settings, settings_new);
    a.noteNewNode();
    try std.testing.expect(std.mem.containsAtLeast(u8, a.store.lastLog(), 1, "\"advanced\":false"));
}

test "the first-run screen stands before everything until the owner answers, and seeing it answers nothing" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, settings_due);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    try std.testing.expect(t.hasText("The short version"));
    try std.testing.expect(!t.hasText("Online"));
    // The full terms are a click away; they can't be answered before they can be read.
    try t.clickText("Read the full terms and privacy notice");
    t.settle(1);
    try std.testing.expect(t.hasText("Reading the terms…"));
    try t.clickText("Agree and continue");
    try std.testing.expectEqualStrings("", a.store.lastLog());
    a.store.put(.terms_text, terms_text);
    t.settle(1);
    try std.testing.expect(t.hasText("Version 2026-11-01"));
    try std.testing.expect(t.hasText("The node joins the Network. It runs on your machine."));
    try t.clickText("Privacy Policy");
    t.settle(1);
    try std.testing.expect(t.hasText("What leaves this machine."));
    snap(&t, "test-first-run");
    try std.testing.expectEqualStrings("", a.store.lastLog());
    try t.clickText("Agree and continue");
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":false}", a.store.lastLog());
    // The node's answer lifts it.
    a.store.put(.settings, canned[1][1]);
    t.settle(1);
    try std.testing.expect(!t.hasText("The short version"));
    try std.testing.expect(t.hasText("Online"));
}

test "keeping the node off on the first-run screen is the answer the node gets" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, settings_due);
    a.store.put(.terms_text, terms_text);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    try t.clickText("Share what my Unbrowse learns with other Unbrowse users");
    t.settle(1);
    try std.testing.expect(t.containsText("Everything stays on this computer"));
    try t.clickText("Agree and continue");
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":true}", a.store.lastLog());
}

test "an owner already off the network stays off when asked about new terms" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, settings_off);
    a.store.put(.terms_text, terms_text);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    // Never answered: a new node, welcomed first.
    try t.clickText("Get started");
    t.settle(1);
    try t.clickText("Agree and continue");
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":true}", a.store.lastLog());
}

const settings_new = "{\"map_while_browsing\":true,\"hold_routes\":false,\"signed_in_calls\":false,\"paused\":false,\"api_port\":7788,\"storage_gb\":5,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"terms_accepted\":null,\"peer_network\":true}";
const unlinked = "{\"owner\":null,\"waiting\":false,\"error\":null}";

/// A new node, its terms answered on the first-run screen: what stands in front of the window next.
fn answeredNew(a: *App, t: *ui.Tester, height: f32) !void {
    load(a);
    a.store.put(.settings, settings_new);
    a.store.put(.terms_text, terms_text);
    a.store.put(.link_status, unlinked);
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = height });
    t.settle(1);
    // A new node is welcomed first.
    try t.clickText("Get started");
    t.settle(1);
    try t.clickText("Agree and continue");
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":false}", a.store.lastLog());
    a.store.put(.settings, canned[1][1]);
    t.settle(1);
}

test "a new node's owner is asked to sign in once the terms are answered, and signing in lets them through" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    var t: ui.Tester = undefined;
    try answeredNew(a, &t, 780);
    defer t.deinit();
    try std.testing.expect(!t.hasText("The short version"));
    try std.testing.expect(t.hasText("Sign in"));
    try std.testing.expect(t.hasText("Skip for now"));
    // Nothing behind it yet: no sidebar, no node card.
    try std.testing.expect(!t.hasText("Online"));
    try std.testing.expect(!t.hasText("My routes"));
    snap(&t, "test-sign-in");
    // Seeing it sends nothing; Sign in opens the page through the node, as Money's Link a wallet does.
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":false}", a.store.lastLog());
    try t.clickText("Continue in your browser");
    try std.testing.expectEqualStrings("link_start {}", a.store.lastLog());
    // The node couldn't open the browser: the page is there to copy, while the node waits on it.
    var arena = scratch();
    defer arena.deinit();
    a.done(.{ .tag = .link_start, .label = "link_start", .ok = true, .text = "{\"url\":\"https://unbrowse.ai/link?nonce=n1\",\"opened\":false}", .arena = arena.allocator() });
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":true,\"error\":null}");
    t.settle(1);
    try std.testing.expect(t.hasText("Waiting for you to finish in your browser…"));
    try std.testing.expect(t.hasText("https://unbrowse.ai/link?nonce=n1"));
    try std.testing.expect(t.hasText("Start again"));
    // Why the last one failed shows where it was asked for.
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":\"the sign-in wasn't finished in 15 minutes; start it again\"}");
    t.settle(1);
    try std.testing.expect(t.hasText("the sign-in wasn't finished in 15 minutes; start it again"));
    try std.testing.expect(!t.hasText("https://unbrowse.ai/link?nonce=n1"));
    // The wallet lands (the node's identity event reads link_status again): the window, signed in.
    a.store.put(.link_status, "{\"owner\":\"0xfeedfacefeedfacefeedfacefeedfacefeedface\",\"waiting\":false,\"error\":null}");
    t.settle(2);
    try std.testing.expect(!t.hasText("Skip for now"));
    // A new node's setting up closes on You're set; Open Unbrowse goes on to the window.
    try std.testing.expect(t.hasText("You're set"));
    try t.clickText("Open Unbrowse");
    t.settle(1);
    try std.testing.expect(t.hasText("Online"));
    try std.testing.expect(t.hasText("Signed in"));
    try std.testing.expect(a.screen == .access);
    // It doesn't come back, linked or not.
    a.store.put(.link_status, unlinked);
    t.settle(1);
    try std.testing.expect(!t.hasText("Skip for now"));
}

test "skipping the first-run sign-in lands on the window with no wallet linked, and Money still links one" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    var t: ui.Tester = undefined;
    try answeredNew(a, &t, 3200);
    defer t.deinit();
    try t.clickText("Skip for now");
    t.settle(1);
    // Skipping asks the node for nothing: it is as it was, on its own wallet.
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":false}", a.store.lastLog());
    try std.testing.expect(!t.hasText("Skip for now"));
    try std.testing.expect(t.hasText("You're set"));
    try t.clickText("Open Unbrowse");
    t.settle(1);
    try std.testing.expect(t.hasText("Online"));
    try std.testing.expect(t.hasText("My routes"));
    try std.testing.expect(a.screen == .access);
    try std.testing.expect(!a.signInDue());
    a.go(.wallet);
    a.money_advanced = true;
    t.settle(1);
    try std.testing.expect(t.hasText("None, and none is needed: your node uses its own wallet"));
    try t.clickText("Sign in");
    try std.testing.expectEqualStrings("link_start {}", a.store.lastLog());
}

test "only a new node is asked to sign in: newer terms, or a wallet already linked, go straight to the window" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.link_status, unlinked);
    a.store.put(.settings, settings_due);
    a.acceptTerms();
    a.store.put(.settings, canned[1][1]);
    try std.testing.expect(!a.signInDue());
    // A new node whose wallet was linked before the window got there (the node's own `onboard`).
    a.store.put(.settings, settings_new);
    a.acceptTerms();
    a.store.put(.settings, canned[1][1]);
    a.store.put(.link_status, "{\"owner\":\"0xfeedfacefeedfacefeedfacefeedfacefeedface\",\"waiting\":false,\"error\":null}");
    try std.testing.expect(!a.signInDue());
}

test "a node older than the question asks nothing of the owner" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.node_info, "{\"name\":\"studio-mac\",\"version\":\"0.1.0\",\"api_port\":7788,\"dev\":true}");
    a.store.put(.settings, settings_due);
    try std.testing.expect(!a.termsDue());
}

test "overview shows the node, its routes and what needs a look" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("studio-mac"));
    try std.testing.expect(t.containsText("2 routes learned."));
    try std.testing.expect(t.hasText("search npm packages failed its last call"));
    // The route share its routes' paid uses sent, and apart, what its coin stakes earned.
    try std.testing.expect(t.hasText("$1.50"));
    try std.testing.expect(t.hasText("Your routes' share of 12 paid uses, all time"));
    try std.testing.expect(t.hasText("$0.25"));
    try std.testing.expect(!t.containsText("serving node"));
    try std.testing.expect(t.hasText("Online"));
    // Pause node saves the settings with paused set, keeping the rest.
    try t.clickText("Pause node");
    try std.testing.expect(std.mem.startsWith(u8, a.store.lastLog(), "save_settings {\"settings\":{"));
    try std.testing.expect(std.mem.indexOf(u8, a.store.lastLog(), "\"paused\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, a.store.lastLog(), "\"storage_gb\":5") != null);
    snap(&t, "test-overview");
}

const wallet_leaving = "{\"address\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"epoch\":10,\"held\":0,\"deposit\":30,\"pending_withdrawal\":20,\"withdraw_epoch\":12}";

test "asking to withdraw offers what isn't leaving already, and says the two days start over" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.wallet, wallet_leaving);
    a.money_advanced = true;
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3000 });
    defer t.deinit();
    a.go(.wallet);
    t.settle(1);
    try t.clickText("Ask to withdraw");
    t.settle(1);
    try std.testing.expect(t.containsText("10.00 USDC available."));
    try std.testing.expect(t.containsText("starts the two days over for all of it"));
}

test "a withdrawal ready to complete is said before asking again would move it" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.wallet, "{\"epoch\":12,\"held\":0,\"deposit\":30,\"pending_withdrawal\":20,\"withdraw_epoch\":12}");
    a.money_advanced = true;
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3000 });
    defer t.deinit();
    a.go(.wallet);
    t.settle(1);
    try t.clickText("Ask to withdraw");
    t.settle(1);
    try std.testing.expect(t.containsText("complete it first"));
}

test "a withdrawal says what is really left to go" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.wallet, "{\"epoch\":12,\"held\":0,\"deposit\":5,\"pending_withdrawal\":20,\"withdraw_epoch\":12}");
    a.money_advanced = true;
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3000 });
    defer t.deinit();
    a.go(.wallet);
    t.settle(1);
    try std.testing.expect(t.containsText("what's left to go"));
}

test "Rotate says what it does and moves nothing until the owner confirms" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.vault_list, "[{\"site\":\"shop.example\",\"account\":\"me\",\"kind\":\"derived\",\"counter\":0,\"created\":1,\"code\":false}]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    a.go(.vault);
    t.settle(1);
    try t.clickText("Rotate");
    t.settle(1);
    try std.testing.expectEqualStrings("", a.store.lastLog());
    try std.testing.expect(t.containsText("The site isn't told"));
    try t.clickText("Keep this password");
    t.settle(1);
    try std.testing.expectEqualStrings("", a.store.lastLog());
    try t.clickText("Rotate");
    t.settle(1);
    try t.clickText("Rotate password");
    try std.testing.expectEqualStrings("vault_rotate {\"site\":\"shop.example\",\"account\":\"me\"}", a.store.lastLog());
}

test "a field follows the node until the owner types in it" {
    var field: ui.TextBuffer = .{};
    var seen: @import("app.zig").Text = .{};
    App.seed(&field, &seen, "0.05");
    try std.testing.expectEqualStrings("0.05", field.text());
    // Changed in a shell: the field shows it, and Save stays off.
    App.seed(&field, &seen, "0.1");
    try std.testing.expectEqualStrings("0.1", field.text());
    // What the owner is typing stays.
    field.set("0.7");
    App.seed(&field, &seen, "0.2");
    try std.testing.expectEqualStrings("0.7", field.text());
}

test "an expired agent key says so on Agent access, and Money sends the owner there" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.money, "{\"balance\":\"5.00\",\"available_to_spend\":\"5.00\",\"needed_to_start\":\"0.00\",\"payments\":\"test\"}");
    a.store.put(.agents_list, "[{\"index\":1,\"name\":\"Old key\",\"address\":\"0xa\",\"cap_usdc\":5,\"expires\":1,\"created\":1,\"revoked\":false}]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2000 });
    defer t.deinit();
    a.go(.wallet);
    a.now = 1000;
    t.settle(1);
    // Money says what agents spent in a line; the keys are on Agent access.
    try std.testing.expect(t.hasText("No agents can reach this node yet."));
    try std.testing.expect(!t.hasText("Old key"));
    try t.clickText("Agent keys");
    t.settle(1);
    try std.testing.expectEqual(@import("app.zig").Screen.access, a.screen);
    try std.testing.expect(t.hasText("Old key"));
    try std.testing.expect(t.containsText("Expired: this key is refused"));
}

test "a cash-out with nothing waiting doesn't read as sent" {
    const cashedOut = @import("app.zig").cashedOut;
    // `collect_earnings` answers the transactions it sent: none when nothing was waiting.
    try std.testing.expectEqualStrings("Nothing was waiting to cash out.", cashedOut("[]"));
    try std.testing.expectEqualStrings("Nothing was waiting to cash out.", cashedOut(" [ ]\n"));
    try std.testing.expectEqualStrings("Sent.", cashedOut("[\"0xabc\"]"));
    try std.testing.expectEqualStrings("Sent.", cashedOut("[\"0xabc\",\"0xdef\"]"));
}

test "a grant running out is said on Money without opening Advanced" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.link_status, "{\"owner\":\"0xabcdef0123456789abcdef0123456789abcdef01\"}");
    a.store.put(.owner_nodes, "{\"wallet\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"deposit_usdc\":5,\"keys\":[],\"renew_by\":2000000000}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2000 });
    defer t.deinit();
    a.go(.wallet);
    t.settle(1);
    try std.testing.expect(!a.money_advanced);
    try std.testing.expect(t.containsText("After that they pay from this node's own balance."));
    try t.clickText("Renew");
    try std.testing.expectEqualStrings("wallet_renew {}", a.store.lastLog());
}

test "a walk under way when the line drops stops saying Walking, until it is heard from again" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 900 });
    defer t.deinit();
    a.go(.node);
    a.event("eye", "{\"kind\":\"started\",\"walk\":\"w1\",\"url\":\"https://shop.example/\",\"goal\":\"Search\",\"agent\":\"Claude Code\"}", s);
    t.settle(1);
    try std.testing.expect(t.hasText("Walking"));
    a.event("closed", "", s);
    t.settle(1);
    try std.testing.expect(!t.hasText("Walking"));
    try std.testing.expect(t.hasText("Lost sight of this walk"));
    a.event("eye", "{\"kind\":\"seen\",\"walk\":\"w1\",\"n\":1,\"method\":\"GET\",\"host\":\"shop.example\",\"path\":\"/\",\"status\":200,\"bytes\":100,\"sort\":\"page\"}", s);
    t.settle(1);
    try std.testing.expect(t.hasText("Walking"));
}

test "a late answer is for the dialog that asked, never the one that took its place" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    const x = arena.allocator();
    // A delete asked for, then its dialog left for another with something typed in it.
    a.open(.delete_route);
    const asked = a.store.stamp;
    a.close();
    a.open(.add_login);
    a.fields[0].set("shop.example");
    a.done(.{ .tag = .close, .label = "delete", .stamp = asked, .ok = true, .text = "null", .arena = x });
    try std.testing.expect(a.dialog_open);
    try std.testing.expectEqualStrings("shop.example", a.field(0));
    // Its failure isn't shown as this dialog's.
    a.done(.{ .tag = .close, .label = "delete", .stamp = asked, .ok = false, .text = "no such route", .arena = x });
    try std.testing.expectEqual(@as(usize, 0), a.err.len);
    // Its own answer closes it.
    a.done(.{ .tag = .close, .label = "add", .stamp = a.store.stamp, .ok = true, .text = "null", .arena = x });
    try std.testing.expect(!a.dialog_open);
}

test "a route's late answer never shows in another route's dialog" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    a.open(.run_route);
    a.target.set("r1");
    const asked = a.store.stamp;
    a.close();
    a.open(.run_route);
    a.target.set("r2");
    a.done(.{ .tag = .call_route, .label = "run", .stamp = asked, .ok = true, .text = "{\"ok\":true,\"ms\":10,\"data\":{\"from\":\"r1\"}}", .arena = arena.allocator() });
    try std.testing.expect(a.run == null);
}

test "a key made after its dialog was left still shows its setup, once" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.open(.new_key);
    const asked = a.store.stamp;
    a.close();
    a.open(.add_login);
    a.done(.{ .tag = .agent_create, .label = "create", .stamp = asked, .ok = true, .text = "{\"agent\":{\"index\":0,\"name\":\"Claude Code\"},\"setup\":\"unb_setup_string\"}", .arena = arena.allocator() });
    try std.testing.expect(a.dialog == .add_login);
    a.close();
    t.settle(1);
    try std.testing.expect(a.dialog == .new_key and a.dialog_open);
    try std.testing.expect(t.containsText("unb_setup_string"));
    // Seen and closed, the next new key opens on its form.
    a.close();
    a.open(.new_key);
    t.settle(1);
    try std.testing.expect(a.setup == null);
    try std.testing.expect(t.hasText("Add the agent"));
}

test "a failed action says so on whichever screen pressed it" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.routes);
    a.done(.{ .tag = .generic, .label = "share-r1", .ok = false, .text = "the route is gone", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.hasText("the route is gone"));
}

test "pressing Rotate twice before the node answers moves the password once" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.actWith(.generic, "rotate", "vault_rotate", .{ .site = "shop.example", .account = "me" });
    a.store.actWith(.generic, "rotate", "vault_rotate", .{ .site = "shop.example", .account = "me" });
    try std.testing.expectEqual(@as(usize, 1), a.store.log.items.len);
}

test "a route that may be listed can't be deleted on a stale or missing copy of the chain" {
    const mayDelete = @import("screens/routes.zig").mayDelete;
    const Listing = @import("types.zig").Listing;
    // Never listed: nothing to delist.
    try std.testing.expect(mayDelete(null, false, false));
    try std.testing.expect(mayDelete(null, false, true));
    // The chain says live.
    try std.testing.expect(!mayDelete(null, true, true));
    // The chain's copy is behind, or isn't there: the route's own record stands.
    try std.testing.expect(!mayDelete(Listing{ .live = true }, false, true));
    try std.testing.expect(!mayDelete(Listing{ .live = false }, false, false));
    // Delisted, and the chain read to say so.
    try std.testing.expect(mayDelete(Listing{ .live = false }, false, true));
}

test "the agent's eye follows a walk and the calls" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 900 });
    defer t.deinit();
    a.go(.node);
    a.event("eye", "{\"kind\":\"started\",\"walk\":\"w1\",\"url\":\"https://hn.algolia.com/?q=rust\",\"goal\":\"Search Hacker News stories\",\"agent\":\"Claude Code\"}", s);
    a.event("eye", "{\"kind\":\"seen\",\"walk\":\"w1\",\"n\":1,\"method\":\"GET\",\"host\":\"hn.algolia.com\",\"path\":\"/\",\"status\":200,\"bytes\":30000,\"sort\":\"page\"}", s);
    a.event("eye", "{\"kind\":\"seen\",\"walk\":\"w1\",\"n\":2,\"method\":\"POST\",\"host\":\"uj5wyc0l7x-dsn.algolia.net\",\"path\":\"/1/indexes/Item_dev/query\",\"status\":200,\"bytes\":48000,\"sort\":\"data\"}", s);
    a.event("eye", "{\"kind\":\"seen\",\"walk\":\"w1\",\"n\":3,\"method\":\"GET\",\"host\":\"px.ads\",\"path\":\"/ping\",\"status\":204,\"bytes\":0,\"sort\":\"noise\"}", s);
    t.settle(1);
    try std.testing.expect(t.hasText("Walking"));
    try std.testing.expect(t.hasText("Claude Code wants to search Hacker News stories"));
    try std.testing.expect(t.containsText("3 responses from hn.algolia.com: 1 with data"));
    a.event("eye", "{\"kind\":\"picked\",\"walk\":\"w1\",\"index\":1,\"method\":\"POST\",\"host\":\"uj5wyc0l7x-dsn.algolia.net\",\"path\":\"/1/indexes/Item_dev/query\",\"by\":\"the scorer\",\"reasons\":[\"its answer holds the query's words\",\"it is JSON\"]}", s);
    a.event("eye", "{\"kind\":\"saved\",\"walk\":\"w1\",\"route\":\"r9\",\"what\":\"search stories\",\"site\":\"hn.algolia.com\",\"steps\":1,\"inputs\":[\"q\"]}", s);
    a.event("call", "{\"phase\":\"start\",\"route\":\"r1\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"agent\":\"Claude Code\",\"agent_index\":0,\"ok\":null,\"ms\":null,\"paid_usdc\":null,\"at\":1}", s);
    t.settle(1);
    try std.testing.expect(t.hasText("Calling"));
    a.event("call", "{\"phase\":\"end\",\"route\":\"r1\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"agent\":\"Claude Code\",\"agent_index\":0,\"ok\":true,\"ms\":412,\"paid_usdc\":null,\"at\":2}", s);
    t.settle(1);
    try std.testing.expect(t.hasText("Kept a route"));
    try std.testing.expect(t.hasText("Kept, picked by the scorer"));
    try std.testing.expect(t.hasText("Its answer holds the query's words"));
    try std.testing.expect(t.hasText("Saved as a route: 1 step, takes q"));
    try std.testing.expect(t.hasText("412 ms"));
    snap(&t, "test-eye");
}

test "nothing waits on the owner: an older node's approval event brings no sheet" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.event("approval", "{\"id\":\"p1\",\"agent\":\"Claude Code\",\"site\":\"www.booking.com\",\"what\":\"book a room\",\"amount_usd\":42.5,\"threshold_usd\":25,\"asked_at\":990,\"expires_at\":2000000000}", arena.allocator());
    t.settle(1);
    try std.testing.expect(!t.containsText("wants to pay"));
    try std.testing.expect(!t.containsText("Review approval"));
    try std.testing.expect(t.hasText("Online"));
    a.go(.access);
    t.settle(1);
    try std.testing.expect(t.containsText("never waits for you"));
    try std.testing.expect(t.containsText("up to $0.05 a fetch"));
    try std.testing.expect(!t.containsText("Waiting on you"));
}

test "the first buy when launching my entries' coins is on at 1% by default, says the node spends it by itself, and saves through its own command" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3200 });
    defer t.deinit();
    a.go(.settings);
    // It sits under Settings' Advanced fold.
    t.settle(1);
    try std.testing.expect(!t.hasText("Launch my entries' coins"));
    a.settings_advanced = true;
    t.settle(1);
    // Settings that leave it out read as the node's default: on, at 1% (100 basis points).
    try std.testing.expectEqual(@as(u32, 100), a.store.get(.settings).?.coin_dev_buy_bps);
    try std.testing.expect(t.hasText("Launch my entries' coins"));
    try std.testing.expect(t.hasText("On: for each entry newly credited to you, the node launches its coin with a first buy of 1% of the UNB your wallet holds then, and stakes the coins for you, by itself."));
    try std.testing.expect(t.hasText(@import("screens/settings.zig").devBuySaid));
    try std.testing.expect(t.hasText("1, the default; 0 launches none."));
    try std.testing.expect(!t.containsText("security hold"));
    try std.testing.expect(!t.containsText("fraud"));
    a.dev_buy_field.set("2");
    t.settle(1);
    try t.clickText("Save first buy");
    // Its own command, never a settings save: the node asks the owner before it is raised past the default.
    try std.testing.expectEqualStrings("coin_dev_buy {\"bps\":200}", a.store.lastLog());
}

test "the per-fetch maximum shows in Settings and saves into the node's own settings" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 1400 });
    defer t.deinit();
    a.go(.settings);
    t.settle(1);
    // An older node's settings leave it out: the window reads the node's default.
    try std.testing.expectEqual(@as(f64, 0.05), a.store.get(.settings).?.max_fetch_usdc);
    try std.testing.expect(t.hasText("The most your node pays to fetch one route; 0 uses only free and your own routes"));
    try std.testing.expectEqualStrings("0.05", a.max_fetch_field.text());
    snap(&t, "test-max-fetch");
    a.max_fetch_field.set("0.2");
    t.settle(1);
    try t.clickText("Save maximum");
    const log = a.store.lastLog();
    try std.testing.expect(std.mem.startsWith(u8, log, "save_settings {\"settings\":{"));
    try std.testing.expect(std.mem.indexOf(u8, log, "\"max_fetch_usdc\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, log, "\"api_port\":7788") != null);
    // A value that isn't a sum of USDC, zero or more, is never sent.
    try std.testing.expectEqual(@as(?f64, 0), @import("screens/settings.zig").maxFetch("0"));
    try std.testing.expectEqual(@as(?f64, null), @import("screens/settings.zig").maxFetch("-1"));
    try std.testing.expectEqual(@as(?f64, null), @import("screens/settings.zig").maxFetch("lots"));
}

test "a new agent key's setup is shown once and wiped on close" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 1500 });
    defer t.deinit();
    a.go(.access);
    t.settle(1);
    try t.clickText("Add agent");
    t.settle(1);
    try t.clickText("Claude Code"); // the name field's placeholder
    t.typeText("Claude Code");
    try t.clickText("Add the agent");
    try std.testing.expect(std.mem.startsWith(u8, a.store.lastLog(), "agent_create {\"name\":\"Claude Code\",\"cap_usdc\":5,\"days\":30}"));
    a.done(.{ .tag = .agent_create, .label = "create", .ok = true, .text = "{\"agent\":{\"index\":0,\"name\":\"Claude Code\"},\"setup\":\"UNBROWSE_AGENT_TOKEN=secret-setup\"}", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.hasText("Claude Code is ready"));
    try std.testing.expect(t.containsText("secret-setup"));
    snap(&t, "test-new-key");
    t.settle(2);
    try t.clickText("Copy setup string");
    t.settle(0.5);
    try std.testing.expectEqualStrings("UNBROWSE_AGENT_TOKEN=secret-setup", t.clipboard.items);
    try t.clickText("Done");
    t.settle(1);
    try std.testing.expect(a.setup == null);
    try std.testing.expect(!t.containsText("secret-setup"));
}

test "a login's code key is kept by reference, and the toggle saves private_network" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.vault_list, "[{\"site\":\"github.com\",\"account\":\"me\",\"kind\":\"stored\",\"counter\":0,\"created\":1,\"code\":true},{\"site\":\"shop.example\",\"account\":\"me\",\"kind\":\"derived\",\"counter\":0,\"created\":1}]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    a.go(.vault);
    t.settle(1);
    // The node's answer carries `code`; an older one leaves it out.
    try std.testing.expect(a.store.list(.vault_list)[0].code);
    try std.testing.expect(!a.store.list(.vault_list)[1].code);
    try std.testing.expect(t.hasText("Two-step code: kept"));
    try std.testing.expect(t.hasText("Replace code key"));
    try t.clickText("Add code key");
    t.settle(1);
    try std.testing.expect(t.hasText("Agents fill it as vault:code:shop.example:me."));
    try t.clickText("otpauth://totp/… or JBSW Y3DP EHPK 3PXP");
    t.typeText("JBSWY3DPEHPK3PXP");
    try t.clickText("Keep code key");
    try std.testing.expectEqualStrings("vault_code {\"site\":\"shop.example\",\"account\":\"me\",\"key\":\"JBSWY3DPEHPK3PXP\"}", a.store.lastLog());
    snap(&t, "test-code-key");

    // Settings: old answers have no private_network; the toggle patches it in, keeping the rest.
    try std.testing.expect(!a.store.get(.settings).?.private_network);
    a.close();
    a.go(.settings);
    t.settle(1);
    try std.testing.expect(t.hasText("Reach private networks"));
}

test "the backup key is shown on ask in Settings, Security, and wiped on hide; a restore says what it kept" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 2800 });
    defer t.deinit();
    a.go(.settings);
    a.security_open = true;
    t.settle(1);
    try std.testing.expect(t.containsText("These words are your node's backup key."));
    try t.clickText("Show the words");
    try std.testing.expectEqualStrings("wallet_phrase {}", a.store.lastLog());
    const words = "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
    a.done(.{ .tag = .wallet_phrase, .label = "phrase", .ok = true, .text = "\"" ++ words ++ "\"", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.hasText("title"));
    try std.testing.expect(t.hasText("24"));
    try std.testing.expect(t.containsText("These 24 words are an older node's key."));
    snap(&t, "test-phrase");
    try t.clickText("Hide");
    t.settle(1);
    try std.testing.expect(a.phrase == null);
    try std.testing.expect(!t.hasText("title"));
    // A node made from seed words shows 12, and says they open its wallet in any wallet app. The public test phrase.
    a.done(.{ .tag = .wallet_phrase, .label = "phrase", .ok = true, .text = "\"test test test test test test test test test test test junk\"", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.hasText("junk"));
    try std.testing.expect(t.containsText("These 12 words are a standard wallet's seed words."));
    try t.clickText("Hide");
    t.settle(1);
    // Leaving the screen wipes a phrase left showing.
    a.done(.{ .tag = .wallet_phrase, .label = "phrase", .ok = true, .text = "\"" ++ words ++ "\"", .arena = arena.allocator() });
    a.go(.vault);
    try std.testing.expect(a.phrase == null);
    a.go(.settings);
    t.settle(1);

    try t.clickText("Restore from the words");
    t.settle(1);
    try std.testing.expect(t.hasText("Restoring replaces this node's key. The current one is kept in this computer's keychain, not deleted."));
    try t.clickText("word word word …");
    t.typeText(words);
    t.settle(1);
    try t.clickText("Replace this node's key");
    try std.testing.expect(std.mem.startsWith(u8, a.store.lastLog(), "wallet_restore {\"words\":\"legal winner"));
    // A wrong phrase: the node's reason stays in the dialog.
    a.done(.{ .tag = .wallet_restore, .label = "restore", .ok = false, .text = "the words don't check out: one of them is wrong or out of place", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.containsText("the words don't check out"));
    a.done(.{ .tag = .wallet_restore, .label = "restore", .ok = true, .text = "{\"address\":\"0xNEW\",\"previous\":\"0xOLD\"}", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(!a.dialog_open);
    try std.testing.expect(t.containsText("Restored 0xNEW"));
    try std.testing.expect(t.containsText("The key for 0xOLD is kept in your Keychain."));
}

// ---- Live ----

const site_hosts = [_][]const u8{ "crates.io", "crates.io", "static.crates.io", "crates.io", "www.googletagmanager.com", "fonts.gstatic.com", "static.crates.io", "plausible.io" };

/// A walk of crates.io's search as the node tells it: the page, its assets, its API calls, a tracker or two.
fn walkEvents(a: *App, s: std.mem.Allocator, upto: usize) void {
    a.event("eye", "{\"kind\":\"started\",\"walk\":\"w7\",\"url\":\"https://crates.io/search?q=tokio\",\"goal\":\"Search Rust crates\",\"agent\":\"Claude Code\"}", s);
    var buf: [400]u8 = undefined;
    for (0..upto) |i| {
        const host = site_hosts[(i * 5 + 3) % site_hosts.len];
        const sort = if (i == 0) "page" else if (i == 9 or i == 14) "data" else if (std.mem.eql(u8, host, "plausible.io") or std.mem.eql(u8, host, "www.googletagmanager.com")) "noise" else "asset";
        const path = if (i == 9) "/api/v1/crates" else if (i == 14) "/api/v1/summary" else if (i == 0) "/search" else "/assets/x.js";
        const bytes: usize = if (i == 9) 48000 else if (i == 14) 9000 else if (i == 0) 30000 else (i * 977) % 20000;
        const ev = std.fmt.bufPrint(&buf, "{{\"kind\":\"seen\",\"walk\":\"w7\",\"n\":{d},\"method\":\"GET\",\"host\":\"{s}\",\"path\":\"{s}\",\"status\":200,\"bytes\":{d},\"sort\":\"{s}\"}}", .{ i + 1, if (i == 9 or i == 14 or i == 0) "crates.io" else host, path, bytes, sort }) catch return;
        a.event("eye", ev, s);
    }
}

fn picture(a: *App) !void {
    const d = try @import("picture.zig").decode(std.testing.allocator, @import("picture.zig").test_frame);
    a.picture.put("w7", 3, false, d.bgra, d.w, d.h);
}

fn calls(a: *App, s: std.mem.Allocator, n: usize, answered: usize) void {
    var buf: [400]u8 = undefined;
    const routes = [_][]const u8{ "r1", "r2", "r1", "r3" };
    const whats = [_][]const u8{ "search Rust crates", "search npm packages", "search Rust crates", "search HN stories" };
    const sites = [_][]const u8{ "crates.io", "www.npmjs.com", "crates.io", "hn.algolia.com" };
    for (0..n) |i| {
        const k = i % routes.len;
        a.event("call", std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"start\",\"route\":\"{s}\",\"what\":\"{s}\",\"site\":\"{s}\",\"agent\":\"Claude Code\",\"at_ms\":{d}}}", .{ i + 1, routes[k], whats[k], sites[k], 100_000 + i * 35 }) catch return, s);
    }
    for (0..answered) |i| {
        const ms = 380 + (i * 137) % 420;
        const ok = i != 5;
        a.event("call", std.fmt.bufPrint(&buf, "{{\"id\":{d},\"phase\":\"end\",\"route\":\"{s}\",\"ok\":{},\"ms\":{d},\"at_ms\":{d}}}", .{ i + 1, routes[i % routes.len], ok, ms, 100_000 + i * 35 + ms }) catch return, s);
    }
}

fn liveApp(width: f32, height: f32, t: *ui.Tester) !*App {
    const a = try std.testing.allocator.create(App);
    a.init(std.testing.allocator, null, null);
    load(a);
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = width, .height = height });
    return a;
}

fn freeApp(a: *App) void {
    a.deinit();
    std.testing.allocator.destroy(a);
}

test "Live is quiet until something starts, and its sidebar item says so" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    t.settle(1);
    try t.clickText("Live");
    t.settle(1);
    try std.testing.expect(t.hasText("The node's browser shows here while it walks a page."));
    try std.testing.expect(t.containsText("When agents call routes"));
    snap(&t, "live-idle");
    a.go(.node);
    walkEvents(a, arena.allocator(), 3);
    try std.testing.expect(a.live_news);
    a.go(.live);
    try std.testing.expect(!a.live_news);
}

test "Live shows the walk landing, the browser's picture and calls in flight" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 1000, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.go(.live);
    walkEvents(a, s, 22);
    try picture(a);
    calls(a, s, 9, 4);
    a.now_ms = 100_000 + 640;
    t.settle(1.5);
    try std.testing.expect(t.hasText("Walking"));
    try std.testing.expect(t.hasText("Claude Code wants to search Rust crates"));
    try std.testing.expect(t.containsText("other hosts") or t.hasText("plausible.io"));
    try std.testing.expect(t.hasText("5 in flight"));
    snap(&t, "live-walking");
    try std.testing.expect(t.hasText("search npm packages"));
    try std.testing.expect(a.picture.of("w7"));
}

test "Live shows the calls weighed, the route kept with its slots, and the burst answered" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 1000, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.go(.live);
    walkEvents(a, s, 40);
    try picture(a);
    a.picture.settled = true;
    a.event("eye", "{\"kind\":\"scored\",\"walk\":\"w7\",\"exchanges\":40,\"candidates\":[{\"index\":9,\"method\":\"GET\",\"host\":\"crates.io\",\"path\":\"/api/v1/crates\",\"score\":21.4,\"noise\":false},{\"index\":14,\"method\":\"GET\",\"host\":\"crates.io\",\"path\":\"/api/v1/summary\",\"score\":9.2,\"noise\":false},{\"index\":0,\"method\":\"GET\",\"host\":\"crates.io\",\"path\":\"/search\",\"score\":6.1,\"noise\":false},{\"index\":3,\"method\":\"POST\",\"host\":\"plausible.io\",\"path\":\"/api/event\",\"score\":0,\"noise\":true}]}", s);
    a.event("eye", "{\"kind\":\"picked\",\"walk\":\"w7\",\"index\":9,\"method\":\"GET\",\"host\":\"crates.io\",\"path\":\"/api/v1/crates\",\"by\":\"the rule\",\"reasons\":[\"its path says crates\",\"it sends the page's \\\"tokio\\\"\",\"46 KB of data\"]}", s);
    t.settle(1.5);
    try std.testing.expect(t.hasText("Weighed 4 of 40 calls against the goal"));
    try std.testing.expect(t.hasText("21.4"));
    snap(&t, "live-weighed");
    a.event("eye", "{\"kind\":\"saved\",\"walk\":\"w7\",\"route\":\"r1\",\"what\":\"search Rust crates\",\"site\":\"crates.io\",\"steps\":1,\"inputs\":[\"q\"]}", s);
    calls(a, s, 9, 9);
    a.now_ms = 100_000 + 2000;
    t.settle(1.5);
    try std.testing.expect(t.hasText("Kept as a route"));
    try std.testing.expect(t.hasText("/api/v1/crates?q="));
    try std.testing.expect(t.hasText("q"));
    try std.testing.expect(t.hasText("Answered"));
    try std.testing.expect(t.containsText("faster at once"));
    try std.testing.expect(t.hasText("1 failed"));
    snap(&t, "live-kept");
}

test "Live fits a narrow window" {
    var t: ui.Tester = undefined;
    const a = try liveApp(900, 1300, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.go(.live);
    walkEvents(a, s, 30);
    try picture(a);
    calls(a, s, 6, 6);
    a.now_ms = 100_000 + 2000;
    t.settle(1.5);
    try std.testing.expect(t.hasText("The walk"));
    snap(&t, "live-narrow");
}

/// The picture's place on the Browser screen, as last laid out.
fn pictureRect(t: *ui.Tester) ?ui.Rect {
    for (t.ctx.nodes.items) |n| switch (n.content) {
        .texture => return n.rect,
        else => {},
    };
    return null;
}

/// The value of a number field in the store log's last JSON body.
fn logged(a: *App, s: std.mem.Allocator, field: []const u8) ?f64 {
    const line = a.store.lastLog();
    const sp = std.mem.indexOfScalar(u8, line, ' ') orelse return null;
    const v = std.json.parseFromSliceLeaky(std.json.Value, s, line[sp + 1 ..], .{}) catch return null;
    return switch (v.object.get(field) orelse return null) {
        .float => |f| f,
        .integer => |i| @floatFromInt(i),
        else => null,
    };
}

test "an agent's ask brings the owner to the page: clicks and keys on its picture go to it, and Done gives it back" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.now = 1000;
    const ask = "{\"id\":\"ask-1\",\"site\":\"linkedin.com\",\"why\":\"sign in to LinkedIn\",\"agent\":\"Claude Code\",\"asked_at\":990,\"expires_at\":1290}";
    a.store.put(.hands, "{\"browsers\":[{\"site\":\"linkedin.com\",\"url\":\"https://www.linkedin.com/login\",\"held\":false,\"walk\":\"hands:linkedin.com\"}],\"asks\":[" ++ ask ++ "],\"watching\":null}");
    a.event("hands", "{\"kind\":\"ask\",\"site\":\"linkedin.com\",\"ask\":" ++ ask ++ "}", s);
    t.settle(1);
    // From any screen, the top bar says who needs the owner, and takes them there.
    try std.testing.expect(t.hasText("Claude Code needs you on linkedin.com"));
    try t.clickText("Claude Code needs you on linkedin.com");
    t.settle(1);
    try std.testing.expect(a.screen == .hands);
    try std.testing.expectEqualStrings("hands_watch {\"site\":\"linkedin.com\"}", a.store.lastLog());
    try std.testing.expect(t.hasText("Claude Code asks you to sign in to LinkedIn"));
    try std.testing.expect(t.containsText("waits 4:50 more"));
    try std.testing.expect(t.hasText("Waiting for the page's picture."));
    const d = try @import("picture.zig").decode(std.testing.allocator, @import("picture.zig").test_frame);
    a.hands_pic.put("hands:linkedin.com", 1, false, d.bgra, d.w, d.h);
    t.settle(1);
    const r = pictureRect(&t) orelse return error.NoPicture;
    // A click a quarter of the way across and three quarters down is that point on the page.
    t.click(r.x + r.w * 0.25, r.y + r.h * 0.75);
    t.settle(0.2);
    try std.testing.expect(std.mem.startsWith(u8, a.store.lastLog(), "hands_input {\"site\":\"linkedin.com\",\"kind\":\"click\""));
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), logged(a, s, "x").?, 0.01);
    try std.testing.expectApproxEqAbs(@as(f64, 0.75), logged(a, s, "y").?, 0.01);
    try std.testing.expect(t.containsText("Typing goes to the page"));
    // The click focused the picture: typing and keys go to the page.
    t.typeText("me@example.com");
    try std.testing.expectEqualStrings("hands_input {\"site\":\"linkedin.com\",\"kind\":\"text\",\"text\":\"me@example.com\"}", a.store.lastLog());
    t.key(.tab);
    try std.testing.expectEqualStrings("hands_input {\"site\":\"linkedin.com\",\"kind\":\"key\",\"key\":\"Tab\"}", a.store.lastLog());
    t.key(.backspace);
    try std.testing.expectEqualStrings("hands_input {\"site\":\"linkedin.com\",\"kind\":\"key\",\"key\":\"Backspace\"}", a.store.lastLog());
    t.key(.enter);
    try std.testing.expectEqualStrings("hands_input {\"site\":\"linkedin.com\",\"kind\":\"key\",\"key\":\"Enter\"}", a.store.lastLog());
    // The wheel over the picture scrolls the page, not the window.
    t.scroll(r.x + r.w * 0.5, r.y + r.h * 0.5, -40);
    try std.testing.expect(std.mem.indexOf(u8, a.store.lastLog(), "\"kind\":\"scroll\"") != null);
    try std.testing.expect(logged(a, s, "dy").? > 0);
    snap(&t, "hands-ask");
    // The node says the owner has the page now; Done gives it back and offers to keep the login.
    a.store.put(.hands, "{\"browsers\":[{\"site\":\"linkedin.com\",\"url\":\"https://www.linkedin.com/feed/\",\"held\":true,\"walk\":\"hands:linkedin.com\"}],\"asks\":[" ++ ask ++ "],\"watching\":\"linkedin.com\"}");
    t.settle(0.5);
    try std.testing.expect(t.hasText("You have the page"));
    try t.clickText("Done, give it back");
    t.settle(0.5);
    try std.testing.expectEqualStrings("hands_give_back {\"site\":\"linkedin.com\",\"done\":true}", a.store.lastLog());
    a.store.put(.hands, "{\"browsers\":[{\"site\":\"linkedin.com\",\"url\":\"https://www.linkedin.com/feed/\",\"held\":false,\"walk\":\"hands:linkedin.com\"}],\"asks\":[],\"watching\":\"linkedin.com\"}");
    t.settle(0.5);
    try std.testing.expect(t.hasText("Keep this login for linkedin.com?"));
    try t.clickText("Save login");
    t.settle(0.5);
    try std.testing.expect(a.dialog == .add_login and a.dialog_open);
    try std.testing.expectEqualStrings("linkedin.com", a.fields[0].text());
    try std.testing.expect(a.login_kind == 1);
    // Leaving the screen stops the picture.
    a.close();
    a.go(.node);
    try std.testing.expectEqualStrings("hands_stop {}", a.store.lastLog());
}

test "an agent's ask stays in its note for as long as it waits, and goes when it lapses" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.now = 1000;
    // The node's list of asks isn't read yet: only the note can say it.
    a.store.put(.hands, "{\"browsers\":[],\"asks\":[],\"watching\":null}");
    const ask = "{\"id\":\"ask-1\",\"site\":\"linkedin.com\",\"why\":\"sign in to LinkedIn\",\"agent\":\"Claude Code\",\"asked_at\":1000,\"expires_at\":1300}";
    a.event("hands", "{\"kind\":\"ask\",\"site\":\"linkedin.com\",\"ask\":" ++ ask ++ "}", s);
    t.settle(1);
    try std.testing.expect(t.hasText("Claude Code needs you on linkedin.com"));
    // Twelve seconds on, the ask still waits, and its note is still there (it used to go after ten).
    t.advance(12);
    t.settle(1);
    try std.testing.expect(t.hasText("Claude Code needs you on linkedin.com"));
    // No one answered: the node says it lapsed, and the note goes.
    a.event("hands", "{\"kind\":\"lapsed\",\"site\":\"linkedin.com\"}", s);
    t.advance(1);
    t.settle(2);
    try std.testing.expect(!t.hasText("Claude Code needs you on linkedin.com"));
    // An ask whose end can't be read stays the ten seconds it always did.
    try std.testing.expectEqual(@as(f32, 10), @import("app.zig").askNoteSeconds(null, 1000));
    try std.testing.expectEqual(@as(f32, 10), @import("app.zig").askNoteSeconds(.{ .expires_at = 1300 }, 0));
    try std.testing.expectEqual(@as(f32, 300), @import("app.zig").askNoteSeconds(.{ .expires_at = 1300 }, 1000));
}

test "an agent's ask for a login opens the vault's own form, never the agent's chat" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.now = 1000;
    const ask = "{\"id\":\"ask-2\",\"site\":\"ticketing.example\",\"why\":\"add the login for me@example.com on ticketing.example to the vault\",\"agent\":\"Claude Code\",\"asked_at\":990,\"expires_at\":1290,\"login\":{\"site\":\"ticketing.example\",\"account\":\"me@example.com\"}}";
    a.store.put(.hands, "{\"browsers\":[{\"site\":\"ticketing.example\",\"url\":\"https://ticketing.example/login\",\"held\":false,\"walk\":\"hands:ticketing.example\"}],\"asks\":[" ++ ask ++ "],\"watching\":null}");
    a.event("hands", "{\"kind\":\"ask\",\"site\":\"ticketing.example\",\"ask\":" ++ ask ++ "}", s);
    t.settle(1);
    try t.clickText("Claude Code needs you on ticketing.example");
    t.settle(1);
    try std.testing.expect(t.hasText("Claude Code needs your login for me@example.com on ticketing.example"));
    snap(&t, "hands-ask-login");
    try t.clickText("Enter password");
    t.settle(0.5);
    // The vault's Add login form, the password the owner's to type: a stored login for that site and account.
    try std.testing.expect(a.dialog == .add_login and a.dialog_open);
    try std.testing.expectEqualStrings("ticketing.example", a.fields[0].text());
    try std.testing.expectEqualStrings("me@example.com", a.fields[1].text());
    try std.testing.expect(a.login_kind == 1);
    a.close();
    t.settle(0.5);
    // Can't do it tells the agent no.
    try t.clickText("Can't do it");
    t.settle(0.5);
    try std.testing.expectEqualStrings("hands_give_back {\"site\":\"ticketing.example\",\"done\":false}", a.store.lastLog());
}

test "Browser with no browser open says how one opens" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    a.store.put(.hands, "{\"browsers\":[],\"asks\":[],\"watching\":null}");
    try t.clickText("Browser");
    t.settle(1);
    try std.testing.expect(a.screen == .hands);
    try std.testing.expect(t.containsText("A site's browser opens when an agent browses it"));
}

test "every screen renders" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    // An agent with a key that has called a route: Uni stands in the city, a chalk arc to the door it used. The record
    // is an older node's, with the threshold keys no longer carry: it still reads.
    a.store.put(.agents_list, "[{\"index\":1,\"name\":\"Claude Code\",\"address\":\"0xa1c7\",\"cap_usdc\":10,\"expires\":4102444800,\"approval_usd\":5,\"created\":1,\"revoked\":false}]");
    a.store.put(.activity, "[{\"at\":1,\"who\":\"Claude Code\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"kind\":\"call\",\"result\":\"passed\",\"ms\":420}]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    for (std.enums.values(@import("app.zig").Screen)) |s| {
        a.go(s);
        t.settle(1);
        var buf: [64]u8 = undefined;
        snap(&t, std.fmt.bufPrint(&buf, "screen-{s}", .{@tagName(s)}) catch unreachable);
    }
}

test "settings choose the browser; an import says what it kept and what to delete" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var arena = scratch();
    defer arena.deinit();
    a.store.put(.browsers, "{\"using\":\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\",\"chosen\":null,\"found\":[" ++
        "{\"name\":\"Google Chrome\",\"path\":\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\",\"downloaded\":false}," ++
        "{\"name\":\"Brave\",\"path\":\"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\",\"downloaded\":false}],\"downloading\":false,\"download_error\":null}");
    var t: ui.Tester = undefined;
    // Tall enough for every section down to the browser's, sharing's included.
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2600 });
    defer t.deinit();
    a.store.put(.update_status, "{\"running\":\"13.1.0\",\"enabled\":true,\"latest\":\"13.2.0\",\"min_version\":\"13.0.0\",\"outdated\":false,\"checking\":false,\"ready\":\"13.2.0\",\"error\":null}");
    a.go(.settings);
    t.settle(1);
    try std.testing.expect(t.containsText("Version 13.2.0 is ready: the node restarts into it once no call is running."));
    try std.testing.expect(t.hasText("In use"));
    try std.testing.expect(t.hasText("Download Chrome for Testing"));
    try std.testing.expect(!t.hasText("Let the node pick"));
    snap(&t, "test-browser");
    try t.clickText("Use Brave");
    try std.testing.expectEqualStrings("choose_browser {\"path\":\"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\"}", a.store.lastLog());
    a.store.running_n = 0;
    // The owner's choice: it says so, and the node can be given the pick back.
    a.store.put(.browsers, "{\"using\":\"/b\",\"chosen\":\"/b\",\"found\":[{\"name\":\"Brave\",\"path\":\"/b\",\"downloaded\":false},{\"name\":\"Chrome for Testing\",\"path\":\"/t\",\"downloaded\":true}],\"downloading\":false,\"download_error\":null}");
    t.settle(1);
    try std.testing.expect(t.hasText("In use, your choice"));
    try std.testing.expect(!t.hasText("Download Chrome for Testing"));
    try t.clickText("Let the node pick");
    try std.testing.expectEqualStrings("choose_browser {\"path\":null}", a.store.lastLog());
    a.store.running_n = 0;

    a.go(.vault);
    t.settle(1);
    try t.clickText("Import passwords");
    t.settle(1);
    try std.testing.expect(t.hasText("Firefox"));
    @import("screens/vault.zig").importText(a, "Chrome Passwords.csv", "url,username,password\nhttps://x.example,me,pw\n");
    try std.testing.expectEqualStrings("vault_import {\"csv\":\"url,username,password\\nhttps://x.example,me,pw\\n\"}", a.store.lastLog());
    a.done(.{ .tag = .vault_import, .label = "import", .ok = true, .text = "{\"added\":12,\"codes\":1,\"known\":2,\"skipped\":[{\"why\":\"no address on the web\",\"count\":3}]}", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.containsText("Imported 12 logins from Chrome Passwords.csv."));
    try std.testing.expect(t.hasText("Left out 3: no address on the web"));
    try std.testing.expect(t.hasText("Delete Chrome Passwords.csv now: it holds every password in plain text."));
    snap(&t, "test-import");
    t.settle(2);
    try t.clickText("Done");
    t.settle(1);
    try std.testing.expect(!a.dialog_open);
}

test "routes say whether each is shared and why one waits; a route can be kept off" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.share_status, "{\"mode\":\"used\",\"per_day\":5,\"listed_today\":1,\"blocked\":null,\"routes\":[" ++
        "{\"id\":\"r1\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"share\":null,\"passed\":7,\"days\":4,\"why\":\"listed\"}," ++
        "{\"id\":\"r2\",\"site\":\"www.npmjs.com\",\"what\":\"search npm packages\",\"share\":null,\"passed\":1,\"days\":1,\"why\":\"below_threshold\",\"runs\":1,\"days_needed\":3,\"runs_needed\":5}]}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 900 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(t.hasText("Shared"));
    try std.testing.expect(t.hasText("Not yet"));
    try std.testing.expect(t.containsText("Shared once used on 3 days or 5 times"));
    try t.clickText("Keep off the network");
    try std.testing.expectEqualStrings("share_route {\"id\":\"r2\",\"on\":false}", a.store.lastLog());
}

test "a listed route offers its delist and promises no other way off the network" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    // A route of the owner's own browsing, listed by the node by itself.
    a.store.put(.routes, "[{\"id\":\"r1\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"method\":\"GET\",\"path\":\"/q\",\"root\":\"crates.io\",\"inputs\":[],\"steps\":1,\"yours\":true,\"browser_assisted\":false,\"write\":false,\"provisional\":false,\"learned_at\":1,\"stats\":{\"calls\":7,\"passed\":7,\"last_ms\":420,\"last_at\":1,\"last_error\":null},\"listing\":null}]");
    a.store.put(.routes_on_chain, "[{\"id\":\"r1\",\"listed\":true,\"live\":true,\"fee\":0.02}]");
    a.store.put(.chain_status, "{\"up\":true,\"error\":null}");
    a.store.put(.share_status, "{\"mode\":\"used\",\"routes\":[{\"id\":\"r1\",\"share\":false,\"why\":\"listed\"}]}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 900 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(!t.hasText("Keep off the network"));
    try std.testing.expect(t.containsText("until you delist it"));
    try t.clickText("Manage");
    t.settle(1);
    try std.testing.expect(t.hasText("Delist"));
}

test "routes waiting to be shared say so, and only pressing lets them go" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.share_status, "{\"mode\":\"used\",\"routes\":[{\"id\":\"r1\",\"why\":\"preview\"},{\"id\":\"r2\",\"why\":\"local\"}]}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 900 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(t.hasText("Will be shared"));
    try std.testing.expect(t.hasText("On this computer"));
    try std.testing.expect(!t.containsText("Can't be shared"));
    try std.testing.expect(t.containsText("1 route will be shared within a day"));
    try std.testing.expectEqualStrings("", a.store.lastLog());
    try t.clickText("Share them now");
    try std.testing.expectEqualStrings("share_approve {}", a.store.lastLog());
}

/// `n` routes as the node lists them, "route 00" on: the even ones on crates.io, the odd ones on www.npmjs.com, and
/// route 07 the one whose input is named `keyword`.
fn manyRoutes(gpa: std.mem.Allocator, n: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.append(gpa, '[');
    for (0..n) |i| {
        if (i > 0) try out.append(gpa, ',');
        try out.print(gpa, "{{\"id\":\"r{d}\",\"site\":\"{s}\",\"what\":\"route {d:0>2}\",\"method\":\"GET\",\"path\":\"/p{d}\",\"root\":\"x\"," ++
            "\"inputs\":[{{\"name\":\"{s}\",\"secret\":false,\"default\":null}}],\"steps\":1,\"browser_assisted\":false,\"write\":false," ++
            "\"provisional\":false,\"learned_at\":1,\"stats\":{{\"calls\":7,\"passed\":7,\"last_ms\":420,\"last_at\":1,\"last_error\":null}},\"listing\":null}}", .{
            i, if (i % 2 == 0) "crates.io" else "www.npmjs.com", i, i, if (i == 7) "keyword" else "q",
        });
    }
    try out.append(gpa, ']');
    return out.toOwnedSlice(gpa);
}

const search_hint = "Search by what a route does, its site, path or inputs";

test "a list pages at its own size: a page past the end becomes the last, and none is none" {
    var page: usize = 0;
    try std.testing.expectEqual(@as(usize, 3), look.pagesBy(11, 5));
    try std.testing.expectEqual(@as(usize, 0), look.pagesBy(0, 5));
    try std.testing.expectEqual(look.Rows{ .from = 0, .to = 5 }, look.pageRowsBy(&page, 11, 5));
    page = 2;
    try std.testing.expectEqual(look.Rows{ .from = 10, .to = 11 }, look.pageRowsBy(&page, 11, 5));
    page = 9;
    try std.testing.expectEqual(look.Rows{ .from = 50, .to = 55 }, look.pageRowsBy(&page, 55, 50));
    try std.testing.expectEqual(@as(usize, 1), page);
    page = 4;
    try std.testing.expectEqual(look.Rows{ .from = 0, .to = 0 }, look.pageRowsBy(&page, 0, 8));
    try std.testing.expectEqual(look.pageRows(&page, 30), look.pageRowsBy(&page, 30, look.per_page));
}

test "Needs a look shows five failed routes to a page, its asks above them" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const many = try manyRoutes(std.testing.allocator, 12);
    defer std.testing.allocator.free(many);
    const failed = try std.mem.replaceOwned(u8, std.testing.allocator, many, "\"last_error\":null", "\"last_error\":\"the site answered 500\"");
    defer std.testing.allocator.free(failed);
    a.store.put(.routes, failed);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 2600 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("route 00 failed its last call") and t.hasText("route 04 failed its last call"));
    try std.testing.expect(!t.hasText("route 05 failed its last call"));
    try std.testing.expect(t.hasText("Showing 1\u{2013}5 of 12"));
    try t.clickText("3");
    t.settle(1);
    try std.testing.expect(!t.hasText("route 00 failed its last call"));
    try std.testing.expect(t.hasText("route 10 failed its last call") and t.hasText("route 11 failed its last call"));
    try std.testing.expect(t.hasText("Showing 11\u{2013}12 of 12"));
}

test "My routes shows 25 to a page, and the pager moves through the rest" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const thirty = try manyRoutes(std.testing.allocator, 30);
    defer std.testing.allocator.free(thirty);
    a.store.put(.routes, thirty);
    var t: ui.Tester = undefined;
    // Tall enough that the pager under the 25 rows is on screen to click.
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 2600 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(t.containsText("30 routes learned"));
    try std.testing.expect(t.hasText("route 00") and t.hasText("route 24"));
    try std.testing.expect(!t.hasText("route 25"));
    try std.testing.expect(t.hasText("Showing 1\u{2013}25 of 30"));
    snap(&t, "test-routes-page-1");
    try t.clickText("2");
    t.settle(1);
    try std.testing.expect(!t.hasText("route 00") and !t.hasText("route 24"));
    try std.testing.expect(t.hasText("route 25") and t.hasText("route 29"));
    try std.testing.expect(t.hasText("Showing 26\u{2013}30 of 30"));
    // Routes deleted from under the second page: the last page there is shows, and one page needs no pager.
    const twenty = try manyRoutes(std.testing.allocator, 20);
    defer std.testing.allocator.free(twenty);
    a.store.put(.routes, twenty);
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 0), a.routes_page);
    try std.testing.expect(t.hasText("route 00") and t.hasText("route 19"));
    try std.testing.expect(!t.containsText("Showing"));
}

test "a search on My routes finds every word, starts again on the first page, and says when nothing matches" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const thirty = try manyRoutes(std.testing.allocator, 30);
    defer std.testing.allocator.free(thirty);
    a.store.put(.routes, thirty);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 2600 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try t.clickText("2");
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 1), a.routes_page);
    // The site, in another case: the 15 on npm, on one page, from the first.
    try t.clickText(search_hint);
    t.typeText("NPMJS");
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 0), a.routes_page);
    try std.testing.expect(t.hasText("route 01") and t.hasText("route 29"));
    try std.testing.expect(!t.hasText("route 00"));
    try std.testing.expect(t.hasText("15 of 30"));
    try std.testing.expect(!t.containsText("Showing"));
    snap(&t, "test-routes-search");
    // Every word must be found: the site and what the route does.
    t.typeText(" route 13");
    t.settle(1);
    try std.testing.expect(t.hasText("route 13") and !t.hasText("route 01"));
    try std.testing.expect(t.hasText("1 of 30"));
    // An input's name finds its route; Clear shows them all again.
    try t.clickText("Clear");
    t.settle(1);
    try std.testing.expect(t.hasText("route 00") and t.hasText("Showing 1\u{2013}25 of 30"));
    try t.clickText(search_hint);
    t.typeText("keyword");
    t.settle(1);
    try std.testing.expect(t.hasText("route 07") and !t.hasText("route 00"));
    t.typeText("s");
    t.settle(1);
    try std.testing.expect(t.hasText("No route matches \u{201C}keywords\u{201D}."));
    try std.testing.expect(t.hasText("0 of 30"));
}

test "a route's search reads what it does, its site, method, path, inputs and id, in any case" {
    const matches = @import("screens/routes.zig").matches;
    const r: @import("types.zig").Route = .{ .id = "ab12", .site = "crates.io", .what = "search Rust crates", .method = "GET", .path = "/api/v1/crates?q={q}", .inputs = &.{.{ .name = "query" }} };
    try std.testing.expect(matches(r, ""));
    try std.testing.expect(matches(r, "  "));
    try std.testing.expect(matches(r, "RUST crates.io"));
    try std.testing.expect(matches(r, "get /api/v1"));
    try std.testing.expect(matches(r, "query"));
    try std.testing.expect(matches(r, "AB12"));
    try std.testing.expect(!matches(r, "rust npm"));
}

test "a node that can't start yet says the one amount that starts it; sharing is announced once" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, "{\"terms_accepted\":\"2026-11-01\",\"map_while_browsing\":true,\"paused\":false,\"api_port\":7788,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":false}");
    // As the node's `money` answers for an empty node: one amount, no breakdown.
    a.store.put(.money, money_empty);
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":null,\"funds\":null}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 1400 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("Sharing is on"));
    try std.testing.expect(t.hasText("Add $0.80 to start"));
    try std.testing.expect(!t.containsText("gas"));
    try t.clickText("Add funds");
    try std.testing.expectEqualStrings("add_funds {}", a.store.lastLog());
    try t.clickText("Got it");
    try std.testing.expect(std.mem.indexOf(u8, a.store.lastLog(), "\"share_notice_seen\":true") != null);
}

const money_empty = "{\"balance\":\"0.00\",\"available_to_spend\":\"0.00\",\"needed_to_start\":\"0.80\",\"add_funds_url\":\"https://unbrowse.ai/fund/#node=0x1234567890abcdef1234567890abcdef12345678&chain=5042002&min=0.80&nonce=n1\",\"payments\":\"open\"," ++
    "\"parts\":{\"at_address\":\"0.00\",\"kept_for_fees\":\"0.00\",\"deposit\":\"0.00\",\"account_deposit\":null,\"signed\":\"0.00\"},\"agents\":[],\"earnings\":{\"available\":\"0.00\"}}";

test "the node's address shows and copies with no Settlement deployed, from Money's Advanced, the sidebar and Already have USDC?" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const me = "0x1234567890abcdef1234567890abcdef12345678";
    a.store.put(.identity, "{\"address\":\"" ++ me ++ "\",\"created\":false}");
    // A live network with no Settlement: the chain's wallet reply has nothing, and the funding step asks for gas.
    a.store.put(.wallet, "{}");
    a.store.put(.chain_status, "{\"up\":true,\"error\":null,\"rpc\":\"https://rpc.testnet.arc.io\",\"network\":\"arc-testnet\",\"deployment\":null,\"payments\":\"open\"}");
    a.store.put(.money, money_empty);
    a.store.put(.link_status, "{\"owner\":\"0xfeedfacefeedfacefeedfacefeedfacefeedface\",\"waiting\":false,\"error\":null,\"funds\":null}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 1400 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    // "Already have USDC?" on the overview's start step names the address to send it to, and the sidebar shows it
    // shortened.
    try t.clickText("Already have USDC?");
    t.settle(1);
    try std.testing.expect(t.hasText(me));
    try std.testing.expect(t.hasText("0x1234…5678"));
    try t.clickText("0x1234…5678");
    t.settle(0.5);
    try std.testing.expectEqualStrings(me, t.clipboard.items);
    a.go(.wallet);
    a.money_advanced = true;
    t.settle(1);
    try std.testing.expect(t.hasText("This node's wallet"));
    try std.testing.expect(t.hasText(me));
    try std.testing.expect(t.hasText("0xfeedfacefeedfacefeedfacefeedfacefeedface"));
    // With the chain down the identity still shows.
    a.store.put(.chain_status, "{\"up\":false,\"error\":\"no answer\",\"rpc\":\"https://rpc.testnet.arc.io\",\"deployment\":null,\"payments\":\"offline\"}");
    t.settle(1);
    try std.testing.expect(t.hasText(me));
    try std.testing.expect(t.hasText("This node's wallet"));
}

test "the price dialog quotes the split the node states, fees in USDC" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    // A split unlike the contract's, so the text can only have come from the node's answer.
    a.store.put(.wallet, "{\"address\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"fee\":0.5,\"split\":{\"contributor\":60,\"site\":35,\"platform\":0,\"serving\":0,\"burn\":5}}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 900 });
    defer t.deinit();
    a.go(.wallet);
    a.money_advanced = true;
    t.settle(1);
    try std.testing.expect(t.containsText("0.500 USDC a fetch"));
    a.open(.pricing);
    a.fields[0].set("0.5");
    t.settle(1);
    try std.testing.expect(t.containsText("60% goes to the route's coin, paying whoever stakes it, or to you while the route has no coin; 35% goes to the site and 5% is a network fee"));
    try std.testing.expect(t.containsText("0.3000 USDC of it goes to the route's coin each time an agent's fetch passes"));
    try std.testing.expect(!t.containsText("UNB a fetch"));
}

test "a link shows what it names in its lister's words, and offers nothing but Close" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    a.openLink("unbrowse://example.com/0xab");
    try std.testing.expect(std.mem.indexOf(u8, a.store.lastLog(), "open_link") != null);
    t.settle(1);
    try std.testing.expect(t.containsText("Nothing has been called or paid."));
    try std.testing.expect(t.containsText("Looking on the network"));

    a.link = try a.gpa.dupe(u8,
        \\{"link":"unbrowse://example.com/0xab","site":"example.com","routes":[{"id":"0xab","remote":true,"fee":0.5,"contributor":"0xc0ffee",
        \\"listed_as":{"site":"example.com","what":"Search flights"}}],"next":"Nothing was called or paid."}
    );
    t.settle(1);
    try std.testing.expect(t.containsText("Search flights"));
    try std.testing.expect(t.containsText("unchecked"));
    try std.testing.expect(t.containsText("Close"));
    try std.testing.expect(!t.containsText("Call the route"));
    // It stays until the owner closes it: nothing in the view takes it down.
    t.settle(600);
    try std.testing.expect(a.dialog_open and t.containsText("Search flights"));

    a.wipeLink();
    a.link = try a.gpa.dupe(u8,
        \\{"link":"unbrowse://example.com","site":"example.com","routes":[],"unavailable":"Settlement isn't deployed here","next":""}
    );
    t.settle(1);
    try std.testing.expect(t.containsText("can't prove other nodes' routes"));
    try std.testing.expect(!t.containsText("No route on the network"));
    a.close();
}

const code_hint = "Kept beside the card, so agents can pay where a checkout asks for it.";
const cards_two = "[{\"label\":\"visa\",\"last4\":\"4242\",\"created\":1,\"code\":false},{\"label\":\"work-amex\",\"last4\":\"0005\",\"created\":2,\"code\":true}]";

test "the vault lists its cards, each with its ending, its code and its own limits, set from its row" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1400, 1600, &t);
    defer freeApp(a);
    defer t.deinit();
    a.store.put(.vault_list, "[]");
    a.store.put(.sessions, "[]");
    a.go(.vault);
    t.settle(1);
    try std.testing.expect(t.hasText("Add card"));
    try std.testing.expect(!t.containsText("Add card limit"));
    try std.testing.expect(t.containsText("No cards yet."));
    a.store.put(.vault_cards, cards_two);
    a.store.put(.card_limits, "[{\"card\":\"visa\",\"site\":\"shop.example\",\"per_payment\":20,\"per_day\":50,\"day\":1,\"spent\":12.5}]");
    t.settle(1);
    try std.testing.expect(t.hasText("visa") and t.hasText("work-amex"));
    try std.testing.expect(t.hasText("\u{2022}\u{2022}\u{2022}\u{2022} 4242") and t.hasText("\u{2022}\u{2022}\u{2022}\u{2022} 0005"));
    try std.testing.expect(t.hasText("Kept") and t.hasText("Not kept"));
    // A card's limits sit in its own row; a card with none says every payment asks.
    try std.testing.expect(t.hasText("shop.example: 20 a payment, 50 a day, 12.5 today"));
    try std.testing.expect(t.hasText("None: every payment asks you"));
    snap(&t, "test-vault-cards");
    try t.clickText("Remove limit");
    try std.testing.expectEqualStrings("card_limit {\"card\":\"visa\",\"site\":\"shop.example\",\"per_payment\":0,\"per_day\":0}", a.store.lastLog());
    a.store.running_n = 0;
    // Set limit on the second card: the dialog is for that card, and the limit goes to the node to confirm.
    a.open(.card_limit);
    a.target.set("work-amex");
    t.settle(1);
    try std.testing.expect(t.hasText("Set a limit for work-amex"));
    try std.testing.expect(t.containsText("can't see what a checkout really charges"));
    a.fields[0].set("other.example");
    a.fields[1].set("10");
    a.fields[2].set("30");
    t.settle(1);
    try t.clickText("Save limit");
    t.settle(1);
    try std.testing.expectEqualStrings("card_limit {\"card\":\"work-amex\",\"site\":\"other.example\",\"per_payment\":10,\"per_day\":30}", a.store.lastLog());
    a.close();
}

test "a card's Set limit opens the limit for that card" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1400, 1600, &t);
    defer freeApp(a);
    defer t.deinit();
    a.store.put(.vault_list, "[]");
    a.store.put(.sessions, "[]");
    a.store.put(.vault_cards, cards_two);
    a.go(.vault);
    t.settle(1);
    try t.clickText("Set limit");
    t.settle(1);
    try std.testing.expect(a.dialog == .card_limit);
    try std.testing.expectEqualStrings("visa", a.target.get());
    try std.testing.expect(t.hasText("Set a limit for visa"));
}

test "Add card sends the card to the node once and wipes its fields; the security code is asked only while the vault keeps codes" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1400, 1600, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    a.store.put(.vault_list, "[]");
    a.store.put(.sessions, "[]");
    a.go(.vault);
    t.settle(1);
    try t.clickText("Add card");
    t.settle(1);
    try std.testing.expect(a.dialog == .add_card);
    try std.testing.expect(!t.containsText(code_hint));
    try std.testing.expect(t.containsText("The vault keeps no security code"));
    inline for (.{ .{ "4242 4242 4242 4242", "4242 4242 4242 4242" }, .{ "MM/YY", "01/30" }, .{ "Ada Lovelace", "Ada Lovelace" }, .{ "visa", "visa" } }) |typed| {
        try t.clickText(typed[0]); // the field's placeholder
        t.typeText(typed[1]);
    }
    t.settle(1);
    try t.clickText("Save card");
    try std.testing.expectEqualStrings("vault_card_add {\"label\":\"visa\",\"number\":\"4242 4242 4242 4242\",\"expiry\":\"01/30\",\"name\":\"Ada Lovelace\",\"cvv\":null}", a.store.lastLog());
    // Pressed again while it is on its way: nothing more is sent.
    const sent = a.store.log.items.len;
    try t.clickText("Save card");
    try std.testing.expectEqual(sent, a.store.log.items.len);
    a.done(.{ .tag = .close, .label = "addcard", .ok = true, .text = "{\"label\":\"visa\",\"last4\":\"4242\",\"created\":1,\"code\":false}", .arena = arena.allocator() });
    a.store.running_n = 0;
    t.settle(1);
    try std.testing.expect(!a.dialog_open);
    // Nothing the owner typed is left in a field: the bytes past what was typed were never written, so only what was is read.
    for (a.fields) |f| {
        try std.testing.expect(f.len == 0);
        for ([_][]const u8{ "4242", "01/30", "Ada", "visa" }) |typed| try std.testing.expect(std.mem.indexOf(u8, &f.buf, typed) == null);
    }

    // Kept codes on: the dialog asks for the code, masked, and sends it.
    a.store.put(.settings, "{\"terms_accepted\":\"2026-11-01\",\"map_while_browsing\":true,\"paused\":false,\"api_port\":7788,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"keep_card_codes\":true}");
    a.open(.add_card);
    t.settle(1);
    try std.testing.expect(t.containsText(code_hint));
    a.fields[0].set("mc");
    a.fields[1].set("5555555555554444");
    a.fields[2].set("02/31");
    a.fields[3].set("Ada Lovelace");
    try t.clickText("123");
    t.typeText("987");
    t.settle(1);
    try std.testing.expect(!t.containsText("987"));
    try t.clickText("Save card");
    try std.testing.expectEqualStrings("vault_card_add {\"label\":\"mc\",\"number\":\"5555555555554444\",\"expiry\":\"02/31\",\"name\":\"Ada Lovelace\",\"cvv\":\"987\"}", a.store.lastLog());
    a.store.running_n = 0;

    // Shut by Escape or a click outside, not Cancel: the fields are wiped all the same.
    a.open(.add_card);
    a.fields[1].set("4242424242424242");
    t.settle(1);
    a.dialog_open = false;
    t.settle(1);
    try std.testing.expect(a.fields[1].len == 0 and std.mem.allEqual(u8, a.fields[1].buf[0..16], 0));
    // Cancel wipes them too.
    a.open(.add_card);
    a.fields[1].set("4242424242424242");
    t.settle(1);
    try t.clickText("Cancel");
    try std.testing.expect(a.fields[1].len == 0 and std.mem.allEqual(u8, a.fields[1].buf[0..16], 0));
}

test "Remove on a card asks first, then sends only its label" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1400, 1600, &t);
    defer freeApp(a);
    defer t.deinit();
    a.store.put(.vault_list, "[]");
    a.store.put(.sessions, "[]");
    a.store.put(.vault_cards, cards_two);
    a.go(.vault);
    t.settle(1);
    try t.clickText("Remove");
    t.settle(1);
    try std.testing.expect(t.hasText("Remove the card visa, ending 4242?"));
    try std.testing.expectEqualStrings("", a.store.lastLog());
    try t.clickText("Keep it");
    t.settle(1);
    try std.testing.expectEqualStrings("", a.store.lastLog());
    try t.clickText("Remove");
    t.settle(1);
    try t.clickText("Remove card");
    try std.testing.expectEqualStrings("vault_card_remove {\"card\":\"visa\"}", a.store.lastLog());
}

test "a payment ask shows the card and the site it goes to, and Approve answers it" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.now = 1000;
    const ask = "{\"id\":\"ask-2\",\"site\":\"shop.example\",\"why\":\"approve paying with visa (card ending 4242) on shop.example\",\"agent\":\"Claude Code\",\"asked_at\":990,\"expires_at\":1290,\"pay\":{\"card\":\"visa (card ending 4242)\",\"merchant\":\"shop.example\"}}";
    a.store.put(.hands, "{\"browsers\":[{\"site\":\"shop.example\",\"url\":\"https://shop.example/checkout\",\"held\":false,\"walk\":\"hands:shop.example\"}],\"asks\":[" ++ ask ++ "],\"watching\":null}");
    a.event("hands", "{\"kind\":\"ask\",\"site\":\"shop.example\",\"ask\":" ++ ask ++ "}", s);
    t.settle(1);
    try t.clickText("Claude Code needs you on shop.example");
    t.settle(1);
    try std.testing.expectEqualStrings("hands_watch {\"site\":\"shop.example\"}", a.store.lastLog());
    try std.testing.expect(t.hasText("Claude Code wants to pay with visa (card ending 4242) on shop.example"));
    try std.testing.expect(t.containsText("Check the amount on the page below"));
    try t.clickText("Approve payment");
    t.settle(0.5);
    try std.testing.expectEqualStrings("hands_give_back {\"site\":\"shop.example\",\"done\":true}", a.store.lastLog());
}

test "a route call's payment has no page: the ask shows what the call sends, and no picture is asked for" {
    var t: ui.Tester = undefined;
    const a = try liveApp(1180, 860, &t);
    defer freeApp(a);
    defer t.deinit();
    var arena = scratch();
    defer arena.deinit();
    const s = arena.allocator();
    a.now = 1000;
    const ask = "{\"id\":\"ask-3\",\"site\":\"shop.example\",\"why\":\"approve paying with visa (card ending 4242) on shop.example\",\"agent\":\"Claude Code\",\"asked_at\":990,\"expires_at\":1290,\"pay\":{\"card\":\"visa (card ending 4242)\",\"merchant\":\"shop.example\",\"route\":\"buy tickets\",\"inputs\":[\"qty: 2\"]}}";
    a.store.put(.hands, "{\"browsers\":[],\"asks\":[" ++ ask ++ "],\"watching\":null}");
    a.event("hands", "{\"kind\":\"ask\",\"site\":\"shop.example\",\"ask\":" ++ ask ++ "}", s);
    t.settle(1);
    try t.clickText("Claude Code needs you on shop.example");
    t.settle(1);
    try std.testing.expect(a.screen == .hands);
    try std.testing.expect(std.mem.indexOf(u8, a.store.lastLog(), "hands_watch") == null);
    try std.testing.expect(t.hasText("The call: buy tickets"));
    try std.testing.expect(t.hasText("qty: 2"));
    try std.testing.expect(!t.hasText("Waiting for the page's picture."));
    try t.clickText("Decline");
    t.settle(0.5);
    try std.testing.expectEqualStrings("hands_give_back {\"site\":\"shop.example\",\"done\":false}", a.store.lastLog());
}

test "a node with no linked wallet says it is on the network with its own, and offers linking one as optional" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":null}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3200 });
    defer t.deinit();
    t.settle(1);
    // No sign-in step on the overview: the node joins on its own wallet (spec §86).
    try std.testing.expect(!t.hasText("Sign in with email or Google"));
    try std.testing.expect(!t.hasText("Sign in"));
    // Money's Advanced names the node's own wallet, says no link is needed, and offers one.
    a.go(.wallet);
    a.money_advanced = true;
    t.settle(1);
    try std.testing.expect(t.hasText("This node's wallet"));
    try std.testing.expect(t.hasText("None, and none is needed: your node uses its own wallet"));
    // Before linking, it says plainly that a linked wallet signs every listing, and nothing is shared until it does.
    try std.testing.expect(t.containsText("every listing waits for you to approve it"));
    try t.clickText("Sign in");
    try std.testing.expectEqualStrings("link_start {}", a.store.lastLog());
    // Waiting on the browser, with why the last one failed: the owner can start again.
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":true,\"error\":\"the sign-in wasn't finished in 15 minutes; start it again\"}");
    t.settle(1);
    try std.testing.expect(t.hasText("Waiting for you to finish in your browser…"));
    try std.testing.expect(t.hasText("the sign-in wasn't finished in 15 minutes; start it again"));
    try t.clickText("Start again");
    try std.testing.expectEqualStrings("link_start {}", a.store.lastLog());
    // Linked: the wallet shows, with a way to unlink, on Settings too.
    a.store.put(.link_status, "{\"owner\":\"0xfeedfacefeedfacefeedfacefeedfacefeedface\",\"waiting\":false,\"error\":null}");
    t.settle(1);
    try std.testing.expect(!t.hasText("Sign in"));
    try std.testing.expect(t.hasText("0xfeedfacefeedfacefeedfacefeedfacefeedface"));
    a.go(.settings);
    t.settle(1);
    try t.clickText("Sign out");
    try std.testing.expectEqualStrings("unlink {}", a.store.lastLog());
}

test "the first buy starts at 0, goes up only with a number the owner gives, and 0 launches none again" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, "{\"terms_accepted\":\"2026-11-01\",\"map_while_browsing\":true,\"paused\":false,\"api_port\":7788,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"coin_dev_buy_bps\":100}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2800 });
    defer t.deinit();
    a.go(.settings);
    a.settings_advanced = true;
    t.settle(1);
    try std.testing.expectEqualStrings("1", a.dev_buy_field.text());
    const before = a.store.log.items.len;
    // At what the node has already, and at what isn't a number, nothing is sent.
    _ = t.clickText("Save first buy") catch {};
    try std.testing.expectEqual(before, a.store.log.items.len);
    a.dev_buy_field.set("lots");
    t.settle(1);
    _ = t.clickText("Save first buy") catch {};
    try std.testing.expectEqual(before, a.store.log.items.len);
    a.dev_buy_field.set("150");
    t.settle(1);
    _ = t.clickText("Save first buy") catch {};
    try std.testing.expectEqual(before, a.store.log.items.len);
    a.dev_buy_field.set("2.5");
    t.settle(1);
    try t.clickText("Save first buy");
    try std.testing.expectEqualStrings("coin_dev_buy {\"bps\":250}", a.store.lastLog());
    // The node's answer: a larger share, and it says plainly that the node spends it by itself, for each new entry.
    a.store.put(.settings, "{\"terms_accepted\":\"2026-11-01\",\"map_while_browsing\":true,\"paused\":false,\"api_port\":7788,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"coin_dev_buy_bps\":250}");
    a.store.running_n = 0;
    t.settle(1);
    try std.testing.expect(t.containsText("a first buy of 2.5% of the UNB your wallet holds then"));
    // 0 turns it off.
    a.dev_buy_field.set("0");
    t.settle(1);
    try t.clickText("Save first buy");
    try std.testing.expectEqualStrings("coin_dev_buy {\"bps\":0}", a.store.lastLog());
}

test "Keeping card security codes is off until the owner turns it on, and says what it costs" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, "{\"terms_accepted\":\"2026-11-01\",\"map_while_browsing\":true,\"paused\":false,\"api_port\":7788,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2400 });
    defer t.deinit();
    a.go(.settings);
    t.settle(1);
    // A node from before the setting says nothing of it: off.
    try std.testing.expect(!a.store.get(.settings).?.keep_card_codes);
    try std.testing.expect(t.hasText("Off: the vault keeps no code, and you type it at each checkout."));
    try std.testing.expect(t.hasText(@import("screens/settings.zig").codesCost));
    // Its own command, never a settings save: the node asks the owner before it goes on.
    try t.clickText("Keep the codes");
    try std.testing.expectEqualStrings("keep_card_codes {\"on\":true}", a.store.lastLog());
    a.store.put(.settings, "{\"terms_accepted\":\"2026-11-01\",\"map_while_browsing\":true,\"paused\":false,\"api_port\":7788,\"excluded\":[],\"share_routes\":\"used\",\"share_notice_seen\":true,\"keep_card_codes\":true}");
    a.store.running_n = 0;
    t.settle(1);
    try std.testing.expect(t.hasText(@import("screens/settings.zig").codesCost));
    try t.clickText("Forget every code and stop keeping them");
    try std.testing.expectEqualStrings("keep_card_codes {\"on\":false}", a.store.lastLog());
}

const earnings_some = "{\"staking\":{\"earned\":0.0165,\"claimed\":0.0045,\"to_claim\":0.012},\"contributor\":{\"earned\":0.0033,\"claimed\":0,\"to_claim\":0.0033}," ++
    "\"routes_paid\":0.05,\"to_claim\":0.0153}";

test "earnings show staking and contributing apart, paid whole, and Cash out takes everything waiting" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.earnings, earnings_some);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2600 });
    defer t.deinit();
    a.go(.wallet);
    a.store.put(.earnings, earnings_some);
    t.settle(1);
    // On the main path, without opening Advanced: what is ready to cash out, and nothing on hold.
    try std.testing.expect(!a.money_advanced);
    try std.testing.expect(t.hasText("Ready to cash out"));
    // An owner who holds no route coins sees no coin and no UNB on the main path: earnings are their routes' share.
    try std.testing.expect(!t.hasText("Route coins"));
    try std.testing.expect(!t.containsText("UNB"));
    try std.testing.expect(t.hasText("Cash out adds all of it to your balance."));
    try std.testing.expect(t.hasText("$0.02"));
    try std.testing.expect(!t.hasText("On hold"));
    try std.testing.expect(!t.hasText("Security hold"));
    try t.clickText("Cash out");
    try std.testing.expectEqualStrings("collect_earnings {}", a.store.lastLog());
    a.store.running_n = 0;
    a.money_advanced = true;
    t.settle(1);
    try std.testing.expect(t.hasText("From staking route coins"));
    try std.testing.expect(t.hasText("As contributor"));
    try std.testing.expect(t.hasText("0.0120"));
    try std.testing.expect(t.hasText("0.0033"));
    try std.testing.expect(t.containsText("nothing is on hold and nothing vests"));
    try std.testing.expect(t.containsText("Your entries' paid fetches sent 0.0500 USDC to their coins"));
    // One Cash out, on the main path: Advanced has no second one.
    try std.testing.expect(!t.hasText("Collect"));
    // All taken: nothing waits, and Cash out has nothing to send.
    a.store.put(.earnings, "{\"staking\":{\"earned\":0.0165,\"claimed\":0.0165,\"to_claim\":0},\"contributor\":{\"earned\":0.0033,\"claimed\":0.0033,\"to_claim\":0},\"to_claim\":0}");
    t.settle(1);
    try std.testing.expect(t.hasText("$0.00"));
    const before = a.store.log.items.len;
    _ = t.clickText("Cash out") catch {};
    try std.testing.expectEqual(before, a.store.log.items.len);
}

const entry_one = "0x1111111111111111111111111111111111111111111111111111111111111111";
const holdings_some = "{\"wallet\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"coins\":[{\"coin\":\"0x00000000000000000000000000000000000c0101\",\"entry\":\"" ++ entry_one ++ "\"," ++
    "\"state\":\"trading\",\"held\":250,\"lots\":[{\"delay\":86400,\"earning\":1200,\"pending\":300,\"unstaking\":0,\"ready_at\":0}," ++
    "{\"delay\":604800,\"earning\":0,\"pending\":0,\"unstaking\":400,\"ready_at\":1000}],\"owed_usdc\":0.012," ++
    "\"parked_usdc\":0.5,\"checked\":true,\"latest_passed\":true,\"price\":0.002,\"value_unb\":4.3,\"value_usd\":2.15}],\"owed_as_contributor_usdc\":0.0033,\"fetch_delay\":86400,\"unb_usd\":0.5}";
const holdings_unchecked = "{\"coins\":[{\"coin\":\"0x00000000000000000000000000000000000c0101\",\"entry\":\"" ++ entry_one ++ "\",\"state\":\"trading\"," ++
    "\"lots\":[{\"delay\":604800,\"earning\":0,\"pending\":0,\"unstaking\":400,\"ready_at\":1000}],\"checked\":false,\"latest_passed\":false}],\"fetch_delay\":86400}";

test "route coins are listed under Advanced in place of the security hold: what is staked, asked back, earned and parked" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.coin_holdings, holdings_some);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3200 });
    defer t.deinit();
    a.go(.wallet);
    a.store.put(.coin_holdings, holdings_some);
    a.now = 2000;
    t.settle(1);
    // The main path says what the coins are worth; the list waits under Advanced.
    try std.testing.expect(t.hasText("4.30"));
    // Beside their UNB, an estimate in dollars at the UNB pool's steady price (R1.30).
    try std.testing.expect(t.hasText("1 route coin, staked or not, at today's prices, about $2.15. Their value can change"));
    try std.testing.expect(!t.hasText("0x1111…1111"));
    a.money_advanced = true;
    t.settle(1);
    try std.testing.expect(t.hasText("0x1111…1111"));
    try std.testing.expect(t.hasText("Trading"));
    try std.testing.expect(t.containsText("4.30 UNB at today's prices, about $2.15"));
    try std.testing.expect(t.hasText("250.00 coins not staked"));
    // Staked, with its lot's exit delay; asked back, ready, and taken back here.
    try std.testing.expect(t.hasText("1,500.00"));
    try std.testing.expect(t.hasText("1 day exit delay"));
    try std.testing.expect(t.hasText("400.00"));
    try std.testing.expect(t.hasText("Ready now"));
    try std.testing.expect(t.hasText("0.0120 USDC"));
    try std.testing.expect(t.hasText("0.5000 USDC"));
    try std.testing.expect(!t.containsText("Not earning"));
    try std.testing.expect(t.hasText("The coins your paid fetches buy are staked with a 1 day exit delay."));
    try std.testing.expect(t.containsText("Coins you ask back stop earning at once"));
    try std.testing.expect(!t.containsText("Security hold"));
    try std.testing.expect(!t.containsText("security hold"));
    try std.testing.expect(!t.hasText("Staked on routes"));
    try t.clickText("Take back");
    try std.testing.expectEqualStrings("coin_withdraw {\"entry\":\"" ++ entry_one ++ "\",\"delay\":604800}", a.store.lastLog());
    // Not ready yet: nothing to take back. Not checked: it says why the stake earns nothing.
    a.store.running_n = 0;
    a.now = 500;
    a.store.put(.coin_holdings, holdings_unchecked);
    t.settle(1);
    try std.testing.expect(!t.hasText("Ready now"));
    try std.testing.expect(!t.hasText("Take back"));
    try std.testing.expect(t.containsText("Not earning: its stake earns once you have checked the entry"));
    // With no steady price from the UNB pool there is no dollar estimate: nothing is guessed.
    try std.testing.expect(!t.containsText("about $"));
}

test "before the account's permission runs out, Money's Advanced asks to renew it in one step" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":null}");
    a.store.put(.owner_nodes, "{\"wallet\":\"0xfeed\",\"deposit_usdc\":10,\"keys\":[],\"renew_by\":1796090401}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2600 });
    defer t.deinit();
    a.go(.wallet);
    a.money_advanced = true;
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":null}");
    a.store.put(.owner_nodes, "{\"wallet\":\"0xfeed\",\"deposit_usdc\":10,\"keys\":[],\"renew_by\":1796090401}");
    t.settle(1);
    try std.testing.expect(!t.containsText("runs out on"));
    a.store.put(.link_status, "{\"owner\":\"0xfeedfacefeedfacefeedfacefeedfacefeedface\",\"waiting\":false,\"error\":null}");
    t.settle(1);
    try std.testing.expect(t.containsText("Your account's permission for this node's agents to spend from it runs out on"));
    try std.testing.expect(t.containsText("After that they pay from this node's own balance."));
    try t.clickText("Renew");
    try std.testing.expectEqualStrings("wallet_renew {}", a.store.lastLog());
    a.store.put(.owner_nodes, "{\"wallet\":\"0xfeed\",\"deposit_usdc\":10,\"keys\":[],\"renew_by\":null}");
    t.settle(1);
    try std.testing.expect(!t.containsText("runs out on"));
}

test "Money shows the listings waiting for the owner's wallet, in plain words, and signs them only in the browser" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 2600 });
    defer t.deinit();
    a.go(.wallet);
    a.store.put(.listings_to_sign, "[]");
    t.settle(1);
    try std.testing.expect(!t.containsText("A listing to approve"));
    a.store.put(.listings_to_sign, "[{\"id\":\"0x01\",\"route_id\":\"r1\",\"site\":\"shop.example\",\"description\":\"Search items\",\"version\":1,\"price_usdc\":0.01,\"wallet\":\"0xfeed\",\"what\":\"Share your route on shop.example, \\\"Search items\\\", under your wallet's identity.\",\"typed_data\":{}}]");
    t.settle(1);
    try std.testing.expect(t.containsText("A listing to approve"));
    try std.testing.expect(t.containsText("Share your route on shop.example"));
    try std.testing.expect(t.containsText("no agent key can"));
    try t.clickText("Approve in my browser");
    try std.testing.expectEqualStrings("listings_sign {}", a.store.lastLog());
}

/// The node's own answers, when UNB_CANNED_DIR names a folder of them (`<resource>.json`), in place of the canned ones.
fn loadReal(a: *App) void {
    const dir = std.c.getenv("UNB_CANNED_DIR") orelse return;
    inline for (.{ .wallet, .earnings, .coin_holdings, .owner_nodes, .settings, .link_status, .identity, .chain_status, .agents_list, .agents_spend, .funding }) |r| {
        var buf: [512]u8 = undefined;
        if (std.fmt.bufPrint(&buf, "{s}/{s}.json", .{ std.mem.span(dir), @tagName(r) })) |path| {
            if (std.Io.Dir.cwd().readFileAlloc(std.testing.io, path, std.testing.allocator, .limited(1 << 20))) |bytes| {
                defer std.testing.allocator.free(bytes);
                a.store.put(r, bytes);
            } else |_| {}
        } else |_| {}
    }
}

const real_earnings = "{\"staking\":{\"earned\":0.0165,\"claimed\":0,\"to_claim\":0.0165},\"contributor\":{\"earned\":0.0033,\"claimed\":0,\"to_claim\":0.0033}," ++
    "\"routes_paid\":0.0198,\"to_claim\":0.0198}";

test "the wallet's earnings and route coins, and the first buy setting, as a node answers them (snapped with UNB_SNAP_DIR)" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.earnings, real_earnings);
    a.store.put(.coin_holdings, holdings_some);
    a.store.put(.link_status, "{\"owner\":\"0x7c6db736a3cf25060d6139455b24e5fdba6a7871\",\"waiting\":false,\"error\":null}");
    a.store.put(.owner_nodes, "{\"wallet\":\"0x7C6db736A3cF25060d6139455B24E5FDbA6a7871\",\"deposit_usdc\":10,\"keys\":[],\"renew_by\":null}");
    loadReal(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 3200 });
    defer t.deinit();
    a.go(.wallet);
    a.money_advanced = true;
    a.store.put(.earnings, real_earnings);
    a.store.put(.coin_holdings, holdings_some);
    loadReal(a);
    t.settle(1);
    try std.testing.expect(t.hasText("Earnings"));
    try std.testing.expect(t.hasText("Route coins"));
    try std.testing.expect(t.hasText("From staking route coins"));
    snap(&t, "wallet-earnings");
    a.go(.settings);
    a.settings_advanced = true;
    loadReal(a);
    t.settle(1);
    try std.testing.expect(t.hasText("Launch my entries' coins"));
    snap(&t, "settings-coin-dev-buy");
}

test "a failing route's error as long as a page is shown cut short, so the Node screen draws at once" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    // A site that answered a failed call with a whole page: the node keeps all of it as the route's last error.
    const page = try std.testing.allocator.alloc(u8, 300_000);
    defer std.testing.allocator.free(page);
    @memset(page, 'x');
    @memcpy(page[0..10], "<html>The ");
    const routes = try std.fmt.allocPrint(std.testing.allocator, "[{{\"id\":\"r1\",\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"method\":\"GET\",\"path\":\"/q\",\"root\":\"crates.io\",\"inputs\":[],\"steps\":1,\"browser_assisted\":false,\"write\":false,\"provisional\":false,\"learned_at\":1,\"stats\":{{\"calls\":3,\"passed\":1,\"last_ms\":311,\"last_at\":1,\"last_error\":\"{s}\"}},\"listing\":null}}]", .{page});
    defer std.testing.allocator.free(routes);
    a.store.put(.routes, routes);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("search Rust crates failed its last call"));
    try std.testing.expect(t.containsText("<html>The xxx"));
    const most = @import("look.zig").most_shown;
    for (t.ctx.nodes.items) |n| switch (n.content) {
        .text => |tx| try std.testing.expect(tx.str.len <= most + "\u{2026}".len),
        else => {},
    };
}

test "an agent waiting on the owner leads Needs a look on the Node screen, with its time left and Open" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.now = 1000;
    a.store.put(.hands, "{\"browsers\":[],\"asks\":[{\"id\":\"k1\",\"site\":\"linkedin.com\",\"why\":\"sign in to LinkedIn\",\"agent\":\"Claude Code\",\"asked_at\":990,\"expires_at\":1290}],\"watching\":null}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("Claude Code asks you to sign in to LinkedIn"));
    try std.testing.expect(t.hasText("On linkedin.com. Waits 4:50 more"));
    // Above the fold: the ask sits in the first row, beside the city.
    const ask = t.findText("Claude Code asks you to sign in to LinkedIn").?;
    try std.testing.expect(ask.y + ask.h < 900);
    // The broken route of the canned data follows it, and the count holds both.
    try std.testing.expect(t.containsText("search npm packages failed its last call"));
    try std.testing.expect(t.hasText("2"));
    snap(&t, "test-node-ask");
    try t.clickText("Open");
    t.settle(1);
    try std.testing.expectEqual(@import("app.zig").Screen.hands, a.screen);
}

test "Command with a digit opens that screen, Command-F finds a route, and a dialog keeps its keys" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    const Screen = @import("app.zig").Screen;
    t.settle(1);
    try std.testing.expect(t.shortcut(.{ .key = '6', .cmd = true }));
    try std.testing.expectEqual(Screen.wallet, a.screen);
    try std.testing.expect(t.shortcut(.{ .key = '0', .cmd = true }));
    try std.testing.expectEqual(Screen.settings, a.screen);
    // Command-F: to My routes, and typing goes into its search.
    try std.testing.expect(t.shortcut(.{ .key = 'f', .cmd = true }));
    t.settle(1);
    try std.testing.expectEqual(Screen.routes, a.screen);
    t.typeText("npm");
    t.settle(1);
    try std.testing.expectEqualStrings("npm", a.routes_query.text());
    try std.testing.expect(t.hasText("1 of 2"));
    // With a dialog open, Command-1 is the dialog's, not a screen change.
    try t.clickText("Try it");
    t.settle(1);
    try std.testing.expect(a.dialog_open);
    _ = t.shortcut(.{ .key = '1', .cmd = true });
    try std.testing.expectEqual(Screen.routes, a.screen);
}

test "a failed route says why in a line and offers Try it, from the Node screen and from My routes" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("the target answered, but not in the recorded shape"));
    try t.clickText("Try it");
    t.settle(1);
    // The route's own dialog, on My routes, where the reason shows under its name too.
    try std.testing.expectEqual(@import("app.zig").Screen.routes, a.screen);
    try std.testing.expect(a.dialog_open);
    try std.testing.expect(t.hasText("Call the route"));
    try std.testing.expect(t.hasText("the target answered, but not in the recorded shape"));
}

test "a screen arrives as the landing's do: rising into place, then still; with reduced motion, at once" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 900 });
    defer t.deinit();
    t.settle(1);
    a.go(.routes);
    t.frame();
    // The first frame: the table is still below its place, rising.
    const early = t.findText("Routes").?.y;
    try std.testing.expect(t.ctx.animating);
    t.settle(2);
    const rest = t.findText("Routes").?.y;
    try std.testing.expect(early > rest + 4);
    // Settled, nothing asks for another frame: an open window at rest draws nothing.
    try std.testing.expect(!t.ctx.animating);
    // Reduced motion: the next screen is in place on its first frame.
    t.ctx.reduced_motion = true;
    a.go(.access);
    t.frame();
    const first = t.findText("On this Mac").?.y;
    t.settle(2);
    try std.testing.expectEqual(first, t.findText("On this Mac").?.y);
}

/// One sign-in state, drawn at `w` by `h` and snapped as `name` (with UNB_SNAP_DIR), light or dark.
fn signInShot(name: []const u8, dark: bool, w: f32, h: f32, setup: *const fn (a: *App) void) !void {
    return signInShotAt(name, dark, w, h, setup, "");
}

/// `signInShot`, the page scrolled until `to` sits near the top of the sheet.
fn signInShotAt(name: []const u8, dark: bool, w: f32, h: f32, setup: *const fn (a: *App) void, to: []const u8) !void {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.identity, "{\"address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"created\":false}");
    a.store.put(.money, money_funded);
    a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":null}");
    setup(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = w, .height = h, .dark = dark });
    defer t.deinit();
    t.settle(1.5);
    if (to.len > 0) {
        var i: usize = 0;
        while (i < 80) : (i += 1) {
            const r = t.findText(to) orelse break;
            if (r.y < 160) break;
            t.scroll(w * 0.6, h * 0.5, -40);
        }
        t.settle(1.5);
    }
    var buf: [96]u8 = undefined;
    const shot = try std.fmt.bufPrint(&buf, "unb160-{s}{s}", .{ name, if (dark) "-dark" else "" });
    snap(&t, shot);
    if (std.c.getenv("UNB_SNAP_DIR") != null) count(&t, shot, w, h);
}

/// simple-surface's counts for what the frame shows: visible words, text blocks and controls.
fn count(t: *ui.Tester, name: []const u8, w: f32, h: f32) void {
    var words: usize = 0;
    var blocks: usize = 0;
    var controls: usize = 0;
    for (t.ctx.nodes.items) |n| {
        const r = n.rect;
        if (r.x + r.w <= 0 or r.y + r.h <= 0 or r.x >= w or r.y >= h) continue;
        if (n.style.control) controls += 1;
        switch (n.content) {
            .text => |tx| {
                blocks += 1;
                var it = std.mem.tokenizeAny(u8, tx.str, " \n\t");
                while (it.next()) |_| words += 1;
            },
            else => {},
        }
    }
    std.debug.print("UNB160-COUNT {s} words={d} blocks={d} controls={d}\n", .{ name, words, blocks, controls });
}

const money_funded = "{\"balance\":\"4.20\",\"available_to_spend\":\"4.20\",\"needed_to_start\":\"0.00\",\"add_funds_url\":\"https://unbrowse.ai/fund/#node=0x1234567890abcdef1234567890abcdef12345678&chain=5042002&min=0.00&nonce=n2\",\"payments\":\"open\"," ++
    "\"parts\":{\"at_address\":\"0.40\",\"kept_for_fees\":\"0.05\",\"deposit\":\"3.80\",\"account_deposit\":null,\"signed\":\"0.12\"},\"agents\":[{\"index\":0,\"spent_today\":\"0.12\",\"pays_from\":\"node\"}],\"earnings\":{\"available\":\"0.00\",\"on_hold\":\"0.31\",\"security_hold\":\"0.00\"}}";

const S = struct {
    fn firstRunReading(a: *App) void {
        a.store.put(.settings, settings_due);
    }
    fn firstRun(a: *App) void {
        a.store.put(.settings, settings_due);
        a.store.put(.terms_text, terms_text_long);
    }
    fn firstRunOff(a: *App) void {
        firstRun(a);
        a.keep_off = true;
    }
    fn firstRunFailed(a: *App) void {
        firstRun(a);
        a.fail("The node didn't answer: it may have stopped. Try again.");
    }
    fn moneyEmpty(a: *App) void {
        a.store.put(.money, money_empty);
        a.go(.wallet);
    }
    fn money(a: *App) void {
        a.go(.wallet);
    }
    fn moneyDown(a: *App) void {
        a.store.put(.chain_status, "{\"up\":false,\"error\":\"no answer from https://rpc.testnet.arc.io\",\"rpc\":\"https://rpc.testnet.arc.io\",\"deployment\":null,\"payments\":\"offline\"}");
        a.go(.wallet);
    }
    fn settingsLink(a: *App) void {
        a.go(.settings);
    }
    fn settingsWaiting(a: *App) void {
        a.store.put(.link_status, "{\"owner\":null,\"waiting\":true,\"error\":null}");
        a.go(.settings);
    }
    fn settingsFailed(a: *App) void {
        a.store.put(.link_status, "{\"owner\":null,\"waiting\":false,\"error\":\"the sign-in wasn't finished in 15 minutes; start it again\"}");
        a.go(.settings);
    }
    fn settingsLinked(a: *App) void {
        a.store.put(.link_status, "{\"owner\":\"0xfeedfacefeedfacefeedfacefeedfacefeedface\",\"waiting\":false,\"error\":null}");
        a.go(.settings);
    }
    fn moneyAdvanced(a: *App) void {
        a.go(.wallet);
        a.money_advanced = true;
    }
};

const terms_text_long = "{\"version\":\"2026-11-01\",\"terms\":\"# Terms of Service\\n\\nYour node runs on your computer and joins a network of nodes run by other people. Routes go straight between nodes.\\n\\nWhat your node shares, serves and calls is your responsibility.\\n\\n- You keep your node's key.\\n- You can leave the network at any time in Settings.\",\"privacy\":\"# Privacy Policy\\n\\nWhat leaves this machine.\"}";

test "the sign-in screens in every state, at the window's size (snapped with UNB_SNAP_DIR, UNB-160)" {
    const W = 1180;
    const H = 780;
    try signInShot("first-run-reading", false, W, H, S.firstRunReading);
    try signInShot("first-run", false, W, H, S.firstRun);
    try signInShot("first-run", true, W, H, S.firstRun);
    try signInShot("first-run-off", false, W, H, S.firstRunOff);
    try signInShot("first-run-failed", false, W, H, S.firstRunFailed);
    try signInShot("money-empty", false, W, H, S.moneyEmpty);
    try signInShot("money", false, W, H, S.money);
    try signInShot("money", true, W, H, S.money);
    try signInShot("money-chain-down", false, W, H, S.moneyDown);
    try signInShotAt("money-addresses", false, W, H, S.moneyAdvanced, "Addresses");
    // The whole of Money's Advanced at once, so counts compare the same content.
    try signInShot("money-advanced-full", false, W, 3600, S.moneyAdvanced);
    try signInShotAt("settings-link", false, W, H, S.settingsLink, "Your account");
    try signInShotAt("settings-link", true, W, H, S.settingsLink, "Your account");
    try signInShotAt("settings-link-waiting", false, W, H, S.settingsWaiting, "Your account");
    try signInShotAt("settings-link-failed", false, W, H, S.settingsFailed, "Your account");
    try signInShotAt("settings-linked", false, W, H, S.settingsLinked, "Your account");
}

/// `n` logins as the node lists them: "site-00.example" on, the even ones for "ann", the odd ones for "bob".
fn manyLogins(gpa: std.mem.Allocator, n: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.append(gpa, '[');
    for (0..n) |i| {
        if (i > 0) try out.append(gpa, ',');
        try out.print(gpa, "{{\"site\":\"site-{d:0>2}.example\",\"account\":\"{s}\",\"kind\":\"derived\",\"counter\":0,\"created\":1,\"code\":false}}", .{ i, if (i % 2 == 0) "ann" else "bob" });
    }
    try out.append(gpa, ']');
    return out.toOwnedSlice(gpa);
}

/// `n` live sessions as the node lists them: "host-00.example" on.
fn manySessions(gpa: std.mem.Allocator, n: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.append(gpa, '[');
    for (0..n) |i| {
        if (i > 0) try out.append(gpa, ',');
        try out.print(gpa, "{{\"host\":\"host-{d:0>2}.example\",\"cookies\":3,\"updated\":1}}", .{i});
    }
    try out.append(gpa, ']');
    return out.toOwnedSlice(gpa);
}

const logins_hint = "Search logins by site or account";

test "the vault shows 25 logins to a page, and the pager moves through the rest" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const thirty = try manyLogins(std.testing.allocator, 30);
    defer std.testing.allocator.free(thirty);
    a.store.put(.vault_list, thirty);
    a.store.put(.sessions, "[]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 3200 });
    defer t.deinit();
    a.go(.vault);
    t.settle(1);
    try std.testing.expect(t.hasText("site-00.example") and t.hasText("site-24.example"));
    try std.testing.expect(!t.hasText("site-25.example"));
    try std.testing.expect(t.hasText("Showing 1\u{2013}25 of 30"));
    snap(&t, "test-vault-page-1");
    try t.clickText("2");
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 1), a.logins_page);
    try std.testing.expect(!t.hasText("site-00.example"));
    try std.testing.expect(t.hasText("site-25.example") and t.hasText("site-29.example"));
    try std.testing.expect(t.hasText("Showing 26\u{2013}30 of 30"));
    // Logins removed from under the second page: the last page there is shows, and one page needs no pager.
    const ten = try manyLogins(std.testing.allocator, 10);
    defer std.testing.allocator.free(ten);
    a.store.put(.vault_list, ten);
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 0), a.logins_page);
    try std.testing.expect(t.hasText("site-09.example"));
    try std.testing.expect(!t.containsText("Showing"));
}

test "a search of the vault's logins finds a site or an account, starts again on the first page, and says when nothing matches" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const thirty = try manyLogins(std.testing.allocator, 30);
    defer std.testing.allocator.free(thirty);
    a.store.put(.vault_list, thirty);
    a.store.put(.sessions, "[]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 3200 });
    defer t.deinit();
    a.go(.vault);
    t.settle(1);
    try t.clickText("2");
    t.settle(1);
    try t.clickText(logins_hint);
    t.typeText("BOB");
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 0), a.logins_page);
    try std.testing.expect(t.hasText("site-01.example") and t.hasText("site-29.example"));
    try std.testing.expect(!t.hasText("site-00.example"));
    try std.testing.expect(t.hasText("15 of 30"));
    try std.testing.expect(!t.containsText("Showing"));
    t.typeText(" site-13");
    t.settle(1);
    try std.testing.expect(t.hasText("site-13.example") and !t.hasText("site-01.example"));
    try std.testing.expect(t.hasText("1 of 30"));
    try t.clickText("Clear");
    t.settle(1);
    try std.testing.expect(t.hasText("site-00.example") and t.hasText("Showing 1\u{2013}25 of 30"));
    try t.clickText(logins_hint);
    t.typeText("nobody");
    t.settle(1);
    try std.testing.expect(t.hasText("No login matches \u{201C}nobody\u{201D}."));
    try std.testing.expect(t.hasText("0 of 30"));
}

test "the vault's live sessions show 25 to a page" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.vault_list, "[]");
    const thirty = try manySessions(std.testing.allocator, 30);
    defer std.testing.allocator.free(thirty);
    a.store.put(.sessions, thirty);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 3200 });
    defer t.deinit();
    a.go(.vault);
    t.settle(1);
    try std.testing.expect(t.hasText("host-00.example") and t.hasText("host-24.example"));
    try std.testing.expect(!t.hasText("host-25.example"));
    try std.testing.expect(t.hasText("Showing 1\u{2013}25 of 30"));
    try t.clickText("2");
    t.settle(1);
    try std.testing.expectEqual(@as(usize, 1), a.sessions_page);
    try std.testing.expect(t.hasText("host-25.example") and !t.hasText("host-00.example"));
}

/// The window's narrowest: main.zig's min_width.
const narrowest: f32 = 860;

/// Every screen's wide tables with rows in them: contributors and the network's routes on the Leaderboard, logins,
/// cards with their limits and sessions in the Vault, and each route's sharing on My routes.
fn loadTables(a: *App) void {
    load(a);
    a.store.put(.board, "[{\"contributor\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"entries\":3,\"lines\":1200,\"earned\":12.5,\"sites\":2}," ++
        "{\"contributor\":\"0x1111111111111111111111111111111111111111\",\"entries\":1,\"lines\":40,\"earned\":0.4,\"sites\":1}]");
    a.store.put(.entries, "[{\"site\":\"crates.io\",\"what\":\"search Rust crates\",\"default\":\"e1\",\"entries\":[" ++
        "{\"id\":\"0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1\",\"contributor\":\"0xabcdef0123456789abcdef0123456789abcdef01\",\"fee\":0.002,\"yours\":true,\"default\":true,\"unverified\":false,\"counted_uses\":42,\"pass_rate\":0.97}," ++
        "{\"id\":\"0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2\",\"contributor\":\"0x1111111111111111111111111111111111111111\",\"fee\":0.001,\"unverified\":true,\"unavailable\":true,\"counted_uses\":3,\"pass_rate\":0.5}]}]");
    a.store.put(.vault_list, "[{\"site\":\"github.com\",\"account\":\"ada.lovelace@example.com\",\"kind\":\"stored\",\"counter\":0,\"created\":1,\"code\":true}," ++
        "{\"site\":\"shop.example\",\"account\":\"me\",\"kind\":\"derived\",\"counter\":2,\"created\":1}]");
    a.store.put(.vault_cards, cards_two);
    a.store.put(.card_limits, "[{\"card\":\"visa\",\"site\":\"shop.example\",\"per_payment\":20,\"per_day\":50,\"day\":1,\"spent\":12.5}]");
    a.store.put(.sessions, "[{\"host\":\"github.com\",\"cookies\":12,\"updated\":1}]");
    a.store.put(.share_status, "{\"mode\":\"used\",\"per_day\":5,\"listed_today\":1,\"blocked\":null,\"routes\":[" ++
        "{\"id\":\"r1\",\"why\":\"listed\"},{\"id\":\"r2\",\"why\":\"below_threshold\",\"days\":1,\"runs\":1,\"days_needed\":3,\"runs_needed\":5}]}");
}

/// The furthest right anything in the last frame reaches, and what it is when it is text.
fn reach(t: *ui.Tester) struct { x: f32, what: []const u8 } {
    var worst: f32 = 0;
    var what: []const u8 = "";
    for (t.ctx.nodes.items) |n| if (n.rect.x + n.rect.w > worst) {
        worst = n.rect.x + n.rect.w;
        what = switch (n.content) {
            .text => |tx| tx.str,
            else => "",
        };
    };
    return .{ .x = worst, .what = what };
}

/// Nothing in the last frame reaches past the window's right edge, and each of `shown` is on screen whole.
fn fits(t: *ui.Tester, w: f32, name: []const u8, shown: []const []const u8) !void {
    const r = reach(t);
    if (r.x > w + 0.5) std.debug.print("{s} at {d}: reaches {d} (\"{s}\")\n", .{ name, w, r.x, r.what });
    try std.testing.expect(r.x <= w + 0.5);
    for (shown) |s| {
        const at = t.findText(s) orelse {
            std.debug.print("{s} at {d}: \"{s}\" isn't drawn\n", .{ name, w, s });
            return error.TestUnexpectedResult;
        };
        try std.testing.expect(at.w > 0 and at.x >= 0 and at.x + at.w <= w + 0.5);
    }
}

test "My routes fits the window at every width, the route's name always readable" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    loadTables(a);
    for ([_]f32{ narrowest, 1000, 1180, 1700 }) |w| {
        var t: ui.Tester = undefined;
        try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = w, .height = 1400 });
        defer t.deinit();
        a.go(.routes);
        t.settle(2);
        // The route's own name keeps its room: never squeezed to a sliver beside the other columns.
        try std.testing.expect(t.findText("search Rust crates").?.w > 100);
        try fits(&t, w, "My routes", &.{ "search Rust crates", "Calls", "State", "Try it", "Delete", "Shared", "Not yet" });
        // The last call and the sharing are still said at every width, under the calls and the state when narrow.
        try std.testing.expect(t.containsText("ms,") or t.hasText("Last call"));
        try std.testing.expect(t.containsText("1 day, 1 run so far"));
        var buf: [64]u8 = undefined;
        snap(&t, std.fmt.bufPrint(&buf, "routes-{d}", .{@as(u32, @intFromFloat(w))}) catch unreachable);
    }
}

/// The widths a screen is checked at: the narrowest, either side of where a table changes its columns, and wide.
const widths = [_]f32{ narrowest, 1000, 1180, 1280, 1700 };

test "the Leaderboard fits the window at every width: narrow, rank, contributor, paid fetches and earned; each entry under its route" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    loadTables(a);
    for (widths) |w| {
        var t: ui.Tester = undefined;
        try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = w, .height = 1400 });
        defer t.deinit();
        a.go(.board);
        t.settle(2);
        try fits(&t, w, "Leaderboard", &.{ "Rank", "Contributor", "Paid fetches", "Earned", "$12.500", "search Rust crates", "Counted uses", "Fee", "Default", "Unavailable" });
        if (w == narrowest) {
            // Entries listed and sites drop out; the pass rate is still said, under the counted uses.
            try std.testing.expect(!t.hasText("Entries listed") and !t.hasText("Pass rate"));
            try std.testing.expect(t.hasText("97% passed"));
            snap(&t, "board-narrow");
        }
        if (w == 1700) try std.testing.expect(t.hasText("Entries listed") and t.hasText("Sites") and t.hasText("Pass rate") and t.hasText("97%"));
    }
}

test "the Vault fits the window at every width: each login, card and session with its buttons on screen" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    loadTables(a);
    for (widths) |w| {
        var t: ui.Tester = undefined;
        try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = w, .height = 1800 });
        defer t.deinit();
        a.go(.vault);
        t.settle(2);
        try fits(&t, w, "Vault", &.{
            "github.com",                   "ada.lovelace@example.com",              "Stored in Keychain",     "Derived, version 3", "Two-step code: kept",
            "Hidden",                       "Show",                                  "Replace code key",       "Rotate",             "Remove",
            "visa",                         "\u{2022}\u{2022}\u{2022}\u{2022} 4242", "Kept",                   "Not kept",           "Set limit",
            "None: every payment asks you", "Remove limit",                          "Sign out of github.com",
        });
        try std.testing.expect(t.containsText("20 a payment, 50 a day, 12.5 today"));
        if (w == narrowest) {
            // A login in one column, a card with its ending and code in one column.
            try std.testing.expect(t.hasText("Login") and !t.hasText("Account") and !t.hasText("Ending"));
            snap(&t, "vault-narrow");
        }
        if (w == 1700) try std.testing.expect(t.hasText("Account") and t.hasText("Kind") and t.hasText("Ending") and t.hasText("Security code"));
    }
}

test "Settings fits the window at every width: narrow, each section's words above its controls" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    loadTables(a);
    for (widths) |w| {
        var t: ui.Tester = undefined;
        try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = w, .height = 4000 });
        defer t.deinit();
        a.go(.settings);
        t.settle(2);
        try fits(&t, w, "Settings", &.{ "Agents and the network", "Paused", "Share routes I learn", "Delist every route", "Exclude" });
        // Narrow, a section's title is above its controls; wide, beside them.
        const title = t.findText("Agents and the network").?;
        const control = t.findText("Paused").?;
        if (w == narrowest) {
            try std.testing.expect(control.y > title.y + title.h);
            snap(&t, "settings-narrow");
        }
        if (w == 1700) try std.testing.expect(control.x > title.x + title.w);
    }
}

test "no screen reaches past the narrowest window" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    loadTables(a);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = narrowest, .height = 900 });
    defer t.deinit();
    var over: usize = 0;
    for (std.enums.values(@import("app.zig").Screen)) |s| {
        a.go(s);
        t.settle(2);
        const r = reach(&t);
        if (r.x > narrowest + 0.5) {
            std.debug.print("{s} reaches {d} (\"{s}\")\n", .{ @tagName(s), r.x, r.what });
            over += 1;
        }
        var buf: [64]u8 = undefined;
        snap(&t, std.fmt.bufPrint(&buf, "narrow-{s}", .{@tagName(s)}) catch unreachable);
    }
    try std.testing.expectEqual(@as(usize, 0), over);
}

test "My routes shows only routes the node sent: none before it answers or when it has none, and each one it sends" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    // The node's facts but its routes: the window has nothing of its own to show in their place.
    inline for (canned) |entry| if (entry[0] != .routes) a.store.put(entry[0], entry[1]);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1400, .height = 1400 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(t.containsText("No routes yet."));
    try std.testing.expect(t.hasText("Nothing learned yet."));
    try std.testing.expect(!t.containsText("route learned") and !t.containsText("routes learned"));
    // The node answers none: the same.
    a.store.put(.routes, "[]");
    t.settle(1);
    try std.testing.expect(t.containsText("No routes yet.") and t.hasText("Nothing learned yet."));
    // The node answers one: that one, by what the node named it, and no other.
    a.store.put(.routes, "[{\"id\":\"w01\",\"site\":\"w01.example\",\"what\":\"a route only the node named\",\"method\":\"GET\",\"path\":\"/w01\",\"root\":\"w01.example\",\"inputs\":[],\"steps\":1,\"browser_assisted\":false,\"write\":false,\"provisional\":false,\"learned_at\":1,\"stats\":{\"calls\":0,\"passed\":0,\"last_ms\":null,\"last_at\":null,\"last_error\":null},\"listing\":null}]");
    t.settle(1);
    try std.testing.expect(t.containsText("a route only the node named"));
    try std.testing.expect(t.containsText("1 route learned"));
    try std.testing.expect(!t.containsText("No routes yet.") and !t.hasText("Nothing learned yet."));
    try std.testing.expect(!t.containsText("search Rust crates") and !t.containsText("search npm packages"));
}

// ---------------------------------------------------------------- Connect your agents, and the move to Applications

const clients_found = "{\"clients\":[" ++
    "{\"id\":\"claude_code\",\"name\":\"Claude Code\",\"found\":true,\"connected\":false,\"path\":\"/Users/x/.claude.json\"}," ++
    "{\"id\":\"claude_desktop\",\"name\":\"Claude Desktop\",\"found\":true,\"connected\":false,\"path\":\"/Users/x/Library/Application Support/Claude/claude_desktop_config.json\",\"note\":null}," ++
    "{\"id\":\"cursor\",\"name\":\"Cursor\",\"found\":true,\"connected\":false,\"path\":\"/Users/x/.cursor/mcp.json\",\"note\":\"An unbrowse entry that is not ours is there.\"}," ++
    "{\"id\":\"codex\",\"name\":\"Codex\",\"found\":false,\"connected\":false,\"path\":\"\"}]}";
const clients_none = "{\"clients\":[{\"id\":\"codex\",\"name\":\"Codex\",\"found\":false,\"connected\":false,\"path\":\"\"}]}";
const clients_one_connected = "{\"clients\":[{\"id\":\"cursor\",\"name\":\"Cursor\",\"found\":true,\"connected\":true,\"path\":\"/Users/x/.cursor/mcp.json\"}]}";

/// An answer of the node to a command the window sent, taken in as the store would hand it over.
fn answer(a: *App, tag: @import("store.zig").Tag, ok: bool, text: []const u8, arena: std.mem.Allocator) void {
    a.done(.{ .tag = tag, .label = @tagName(tag), .ok = ok, .text = text, .arena = arena });
}

/// The node's answer to `agent_clients`, taken in.
fn putClients(a: *App, json: []const u8) void {
    var arena = scratch();
    defer arena.deinit();
    answer(a, .agent_clients, true, json, arena.allocator());
}

test "the connect screen lists the clients found, each ticked, and sends the ticked ones" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_found);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    try std.testing.expect(t.hasText("Connect your AI apps"));
    try std.testing.expect(t.hasText("Claude Code"));
    try std.testing.expect(t.hasText("Claude Desktop"));
    try std.testing.expect(t.hasText("Cursor"));
    try std.testing.expect(t.hasText("An unbrowse entry that is not ours is there."));
    // Codex wasn't found on this Mac: no row for it.
    try std.testing.expect(!t.hasText("Codex"));
    try std.testing.expect(!t.hasText("Online"));
    // Each is ticked until the owner unticks it.
    try std.testing.expect(a.connectTicked(0) and a.connectTicked(1) and a.connectTicked(2));
    try t.clickText("Claude Code");
    t.settle(1);
    try std.testing.expect(!a.connectTicked(0));
    snap(&t, "test-connect");
    try t.clickText("Connect");
    try std.testing.expectEqualStrings("agent_connect {\"clients\":[\"claude_desktop\",\"cursor\"]}", a.store.lastLog());
}

test "after the node answers, each row says what happened in plain words" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_found);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    answer(a, .agent_connect, true,
        \\{"results":[{"id":"claude_code","name":"Claude Code","ok":true,"restart_needed":false,"error":null},
        \\{"id":"claude_desktop","name":"Claude Desktop","ok":true,"restart_needed":true,"error":null},
        \\{"id":"cursor","name":"Cursor","ok":false,"restart_needed":false,"error":"Cursor's config file isn't valid JSON, so nothing was changed."}]}
    , arena.allocator());
    // The node now says Claude Code is connected: the screen stays for the owner to read the rows.
    putClients(a, "{\"clients\":[{\"id\":\"claude_code\",\"name\":\"Claude Code\",\"found\":true,\"connected\":true,\"path\":\"p\"},{\"id\":\"claude_desktop\",\"name\":\"Claude Desktop\",\"found\":true,\"connected\":true,\"path\":\"q\"},{\"id\":\"cursor\",\"name\":\"Cursor\",\"found\":true,\"connected\":false,\"path\":\"r\"}]}");
    t.settle(1);
    try std.testing.expect(t.hasText("Connect your AI apps"));
    try std.testing.expect(t.hasText("Connected: open Claude Code to start using it"));
    try std.testing.expect(t.hasText("Connected: quit and reopen Claude Desktop"));
    try std.testing.expect(t.hasText("Cursor's config file isn't valid JSON, so nothing was changed."));
    snap(&t, "test-connect-results");
    // Something connected: Next goes on to ChatGPT and Claude on the web, Not now leaves, and the screen doesn't come
    // back.
    try t.clickText("Next");
    t.settle(1);
    try std.testing.expect(t.hasText("Use ChatGPT or Claude on the web?"));
    try std.testing.expect(!t.hasText("Connect your AI apps"));
    try t.clickText("Not now");
    t.settle(1);
    try std.testing.expect(!t.hasText("Use ChatGPT or Claude on the web?"));
    // Setting up closes on You're set, with the first thing to try, and Open Unbrowse goes to the window.
    try std.testing.expect(t.hasText("You're set"));
    try t.clickText("Open Unbrowse");
    t.settle(1);
    try std.testing.expect(t.hasText("Online"));
    try std.testing.expect(!a.connectDue());
}

test "a connected app says whether it has reached Unbrowse, here and on You're set" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    // Claude Code was opened since it was connected and said so at MCP initialize (`heard`); Codex hasn't been.
    putClients(a, "{\"clients\":[{\"id\":\"claude_code\",\"name\":\"Claude Code\",\"found\":true,\"connected\":true,\"path\":\"p\",\"heard\":1795347861},{\"id\":\"codex\",\"name\":\"Codex\",\"found\":true,\"connected\":true,\"path\":\"q\"}]}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.access);
    t.settle(1);
    try std.testing.expect(t.hasText("Connected: it reached Unbrowse"));
    try std.testing.expect(t.hasText("Connected: open Codex to start using it"));
    snap(&t, "test-connect-heard");
    // Setting up closes on You're set, which says the same of each app, so the owner sees it worked.
    a.finish_due = true;
    t.settle(1);
    try std.testing.expect(t.hasText("You're set"));
    try std.testing.expect(t.containsText("Claude Code reached Unbrowse"));
    try std.testing.expect(t.containsText("Codex: open it to start using Unbrowse"));
    snap(&t, "test-done-heard");
}

test "a connect the node refuses shows its words on the screen and leaves the rows to try again" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_found);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    answer(a, .agent_connect, false, "You said no to changing your agents' files.", arena.allocator());
    t.settle(1);
    try std.testing.expect(t.hasText("You said no to changing your agents' files."));
    try std.testing.expect(t.hasText("Connect your AI apps"));
    // Still there to press again.
    try t.clickText("Connect");
    try std.testing.expectEqualStrings("agent_connect {\"clients\":[\"claude_code\",\"claude_desktop\",\"cursor\"]}", a.store.lastLog());
}

test "with no agent found the connect screen says so in a line and goes on to ChatGPT and Claude on the web" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_none);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    try std.testing.expect(t.containsText("No AI app was found on this computer"));
    try std.testing.expect(!t.hasText("Connect"));
    try t.clickText("Next");
    t.settle(1);
    try std.testing.expect(t.hasText("Use ChatGPT or Claude on the web?"));
    try t.clickText("Not now");
    t.settle(1);
    try std.testing.expect(!t.hasText("Connect your AI apps") and !t.hasText("Use ChatGPT or Claude on the web?"));
    try std.testing.expect(t.hasText("You're set"));
    try t.clickText("Open Unbrowse");
    t.settle(1);
    try std.testing.expect(t.hasText("Online"));
}

test "an agent set up per project is named with how, never ticked or sent" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, "{\"clients\":[{\"id\":\"hermes\",\"name\":\"Hermes Agent\",\"found\":true,\"connected\":false,\"path\":\"/Users/x/.hermes/config.yaml\"}," ++
        "{\"id\":\"elizaos\",\"name\":\"ElizaOS\",\"found\":true,\"connected\":false,\"path\":\"\",\"manual\":true,\"note\":\"set up in each project: add @unbrowse/plugin-unbrowse to your character's plugins (integrations/elizaos)\"}]}");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    try std.testing.expect(t.hasText("Hermes Agent") and t.hasText("ElizaOS"));
    try std.testing.expect(t.containsText("add @unbrowse/plugin-unbrowse to your character's plugins"));
    try std.testing.expect(!a.connectable(a.client_list[1]));
    snap(&t, "test-connect-manual");
    try t.clickText("Connect");
    try std.testing.expectEqualStrings("agent_connect {\"clients\":[\"hermes\"]}", a.store.lastLog());
}

const remote_off = "{\"on\":false,\"public\":false,\"gateway\":\"https://unbrowse.ai\",\"url\":\"https://unbrowse.ai/p/12D3KooWExampleNodePeer/mcp\",\"peer\":\"12D3KooWExampleNodePeer\",\"keys\":[]}";
const remote_on = "{\"on\":true,\"public\":false,\"gateway\":\"https://unbrowse.ai\",\"url\":\"https://unbrowse.ai/p/12D3KooWExampleNodePeer/mcp\",\"peer\":\"12D3KooWExampleNodePeer\",\"keys\":[]}";

test "the first run's web step turns the address on, then gives it with Claude's and ChatGPT's steps" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_found);
    a.store.put(.remote_status, remote_off);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 900 });
    defer t.deinit();
    t.settle(1);
    // Skipping the agents on this Mac goes on to the web, not out.
    try t.clickText("Skip");
    t.settle(1);
    try std.testing.expect(t.hasText("Use ChatGPT or Claude on the web?"));
    try std.testing.expect(t.containsText("If you chat with ChatGPT or Claude in a browser or on your phone"));
    // Off: one button, and the address isn't shown until it is on.
    try std.testing.expect(!t.containsText("12D3KooWExampleNodePeer"));
    snap(&t, "test-connect-web-off");
    try t.clickText("Turn on the address");
    try std.testing.expectEqualStrings("remote_set {\"on\":true}", a.store.lastLog());
    a.store.put(.remote_status, remote_on);
    t.settle(1);
    try std.testing.expect(t.hasText("https://unbrowse.ai/p/12D3KooWExampleNodePeer/mcp"));
    try std.testing.expect(t.hasText("Copy address"));
    // Claude's steps first, then ChatGPT's, each with what its plan allows.
    try std.testing.expect(t.hasText("Click +, then Add custom connector."));
    try std.testing.expect(t.containsText("A free plan can add one custom connector."));
    snap(&t, "test-connect-web-claude");
    try t.clickText("ChatGPT");
    t.settle(1);
    try std.testing.expect(t.hasText("Click +, then Add custom MCP server."));
    try std.testing.expect(t.hasText("In a new chat, type @ and pick Unbrowse."));
    try std.testing.expect(t.containsText("Business, Enterprise and Edu"));
    try std.testing.expect(!t.hasText("Click +, then Add custom connector."));
    snap(&t, "test-connect-web-chatgpt");
    // The node can be linked to the owner's Unbrowse account instead, so ChatGPT and Claude signed in to Unbrowse reach
    // it with no address to paste; it lets a sign-in ask too, for an owner who comes back to it later.
    try t.clickText("Link to my Unbrowse account");
    try std.testing.expectEqualStrings("remote_link {}", a.store.lastLog());
    try t.clickText("Next");
    t.settle(1);
    try std.testing.expect(!a.connectDue());
    try std.testing.expect(t.hasText("You're set"));
    try std.testing.expect(t.hasText(@import("screens/onboarding.zig").try_this));
    try t.clickText("Open Unbrowse");
    t.settle(1);
    // Open Unbrowse lands on the home screen, Agents, which holds the same panel.
    try std.testing.expectEqual(@import("app.zig").Screen.access, a.screen);
    try std.testing.expect(t.hasText("ChatGPT and Claude on the web"));
    try std.testing.expect(t.hasText("Address on"));
}

test "the window opens on Agents: the agents on this Mac, ChatGPT and Claude on the web, then the keys" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_one_connected);
    a.store.put(.remote_status, remote_off);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1280, .height = 1400 });
    defer t.deinit();
    t.settle(1);
    try std.testing.expectEqual(@import("app.zig").Screen.access, a.screen);
    try std.testing.expect(t.hasText("Agents"));
    try std.testing.expect(t.hasText("On this Mac"));
    try std.testing.expect(t.hasText("1 agent found"));
    try std.testing.expect(t.hasText("ChatGPT and Claude on the web"));
    try std.testing.expect(t.hasText("Address off"));
    try std.testing.expect(t.hasText("Turn on the address"));
    try std.testing.expect(t.hasText("Any other agent"));
    // The panels come in that order, top to bottom.
    const mac = t.findText("On this Mac").?.y;
    const web = t.findText("ChatGPT and Claude on the web").?.y;
    const other = t.findText("Any other agent").?.y;
    try std.testing.expect(mac < web and web < other);
    snap(&t, "test-home-agents");
    // Command-1 is Agents, Command-2 the Node screen.
    try std.testing.expect(t.shortcut(.{ .key = '2', .cmd = true }));
    try std.testing.expectEqual(@import("app.zig").Screen.node, a.screen);
    try std.testing.expect(t.shortcut(.{ .key = '1', .cmd = true }));
    try std.testing.expectEqual(@import("app.zig").Screen.access, a.screen);
}

test "the window stands the move, the terms, signing in and Connect in that order, then the normal screens" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    const Front = shell.Front;
    // Nothing is known of the agents yet: no Connect screen to flash.
    try std.testing.expectEqual(Front.none, shell.front(a));
    putClients(a, clients_found);
    try std.testing.expectEqual(Front.connect, shell.front(a));
    a.store.put(.settings, settings_due);
    try std.testing.expectEqual(Front.terms, shell.front(a));
    // Run from the disk image on a Mac: the move comes before the terms.
    a.mac = true;
    a.exe_dir = "/Volumes/Unbrowse/Unbrowse.app/Contents/MacOS";
    try std.testing.expectEqual(Front.move, shell.front(a));
    // The same path on any other system is nothing to move.
    a.mac = false;
    try std.testing.expectEqual(Front.terms, shell.front(a));
    a.mac = true;
    a.exe_dir = "/Applications/Unbrowse.app/Contents/MacOS";
    try std.testing.expectEqual(Front.terms, shell.front(a));
    a.store.put(.settings, canned[1][1]);
    try std.testing.expectEqual(Front.connect, shell.front(a));
    // A new node, its terms answered for the first time: signing in stands before Connect; skipped, Connect follows.
    a.store.put(.link_status, unlinked);
    a.store.put(.settings, settings_new);
    a.acceptTerms();
    a.store.put(.settings, canned[1][1]);
    try std.testing.expectEqual(Front.sign_in, shell.front(a));
    a.skipSignIn();
    try std.testing.expectEqual(Front.connect, shell.front(a));
    // An agent already connected means nothing is asked.
    putClients(a, clients_one_connected);
    try std.testing.expectEqual(Front.none, shell.front(a));
    // Dismissed: not again, however the node's list changes.
    putClients(a, clients_found);
    try std.testing.expectEqual(Front.connect, shell.front(a));
    a.dismissConnect();
    // Setting up closes on You're set; past it, the normal screens.
    try std.testing.expectEqual(Front.done, shell.front(a));
    a.onboardFinish();
    try std.testing.expectEqual(Front.none, shell.front(a));
}

test "the move screen has one line and one button, and nothing else of the window" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.mac = true;
    a.exe_dir = "/private/var/folders/x/AppTranslocation/y/d/Unbrowse.app/Contents/MacOS";
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(1);
    try std.testing.expect(t.containsText("has to live in your Applications folder"));
    try std.testing.expect(t.hasText("Move to Applications"));
    try std.testing.expect(!t.hasText("Online"));
    snap(&t, "test-move-to-apps");
}

test "the agent access screen lists the same clients with Connect and Undo, and no copy-paste claude line" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    putClients(a, clients_one_connected);
    var arena = scratch();
    defer arena.deinit();
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.access);
    t.settle(1);
    try std.testing.expect(t.hasText("Cursor"));
    try std.testing.expect(t.hasText("Connected: open Cursor to start using it"));
    try std.testing.expect(t.hasText("Undo"));
    try std.testing.expect(t.hasText("Copy example requests"));
    try std.testing.expect(!t.containsText("claude mcp add"));
    try t.clickText("Undo");
    try std.testing.expectEqualStrings("agent_connect_undo {}", a.store.lastLog());
    answer(a, .agent_undo, true, "{\"restored\":[{\"id\":\"cursor\",\"name\":\"Cursor\",\"path\":\"/Users/x/.cursor/mcp.json\"}]}", arena.allocator());
    t.settle(1);
    try std.testing.expect(t.hasText("Put back Cursor."));
}

const setup_left = "{\"steps\":[{\"id\":\"terms\",\"done\":false,\"optional\":false,\"said\":\"this node stays off the peer network until its owner acknowledges terms 2026-11-01, which the Unbrowse app asks for when it opens\",\"next\":{\"tool\":\"unbrowse_setup\",\"args\":{\"do\":\"accept_terms\"}}}," ++
    "{\"id\":\"apps\",\"done\":true,\"optional\":true,\"said\":\"connected: Claude Code and Codex\",\"next\":null}," ++
    "{\"id\":\"sites\",\"done\":false,\"optional\":true,\"said\":\"no site's sign-in kept yet\",\"next\":{\"tool\":\"unbrowse_setup\",\"args\":{\"do\":\"connect_site\"}}}],\"left\":[\"terms\"]}";
const setup_done = "{\"steps\":[{\"id\":\"terms\",\"done\":true,\"optional\":false,\"said\":\"terms 2026-11-01 acknowledged\",\"next\":null}],\"left\":[]}";

test "the Agents screen shows the node's own setup list while anything is left, and nothing once all is done" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.setup_status, setup_left);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 1500 });
    defer t.deinit();
    a.go(.access);
    t.settle(1);
    try std.testing.expect(t.hasText("Your setup"));
    try std.testing.expect(t.hasText("1 step left"));
    try std.testing.expect(t.hasText("Terms") and t.hasText("Agent apps") and t.hasText("Sites"));
    try std.testing.expect(t.containsText("which the Unbrowse app asks for when it opens"));
    try std.testing.expect(t.containsText("never ask you to type a command"));
    snap(&t, "test-agents-setup");
    a.store.put(.setup_status, setup_done);
    t.settle(1);
    try std.testing.expect(!t.hasText("Your setup"));
}

test "a site is connected from the Agents screen by its host, its sign-in taken from the owner's own browser" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.sessions, "[{\"host\":\"news.ycombinator.com\",\"cookies\":3,\"updated\":1}]");
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 1800 });
    defer t.deinit();
    a.go(.access);
    t.settle(1);
    try std.testing.expect(t.hasText("Sites your agents can use"));
    try std.testing.expect(t.containsText("Connected: news.ycombinator.com"));
    try t.clickText("github.com"); // the field's placeholder
    t.typeText("https://GitHub.com/settings");
    try t.clickText("Connect site");
    // The host alone, as a site is named: the node reads only that site's cookies.
    try std.testing.expectEqualStrings("import_session {\"host\":\"github.com\"}", a.store.lastLog());
    // A site that didn't connect says why under its own field, and nowhere else.
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    a.done(.{ .tag = .site_connect, .label = "site_connect", .ok = false, .text = "no cookies for github.com in your browsers", .arena = arena.allocator() });
    t.settle(1);
    try std.testing.expect(t.containsText("no cookies for github.com in your browsers"));
    try std.testing.expectEqual(@as(usize, 0), a.err.len);
    snap(&t, "test-agents-sites");
}

test "setting up a new node goes step by step, its stepper filling and each step sliding in from the way it goes" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.settings, settings_new);
    a.store.put(.terms_text, terms_text);
    a.store.put(.link_status, unlinked);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 900 });
    defer t.deinit();
    t.settle(1);
    // Welcome first: what Unbrowse does for the owner and how long setting up takes, with the steps ahead.
    try std.testing.expect(t.hasText("Let your AI use any website"));
    try std.testing.expect(t.containsText("about two minutes"));
    for ([_][]const u8{ "Welcome", "Terms", "Sign in", "Your AI apps", "ChatGPT and Claude", "Done" }) |step| try std.testing.expect(t.hasText(step));
    snap(&t, "test-onboard-welcome");
    try t.clickText("Get started");
    t.frame();
    // The terms arrive moving, from the right, and come to rest still: nothing animates once settled.
    try std.testing.expect(t.ctx.animating);
    const early = t.findText("The short version").?.x;
    t.settle(2);
    try std.testing.expect(early > t.findText("The short version").?.x + 4);
    try std.testing.expect(!t.ctx.animating);
    try std.testing.expect(t.hasText("\u{2713}"));
    snap(&t, "test-onboard-terms");
    // Back goes back to Welcome, from the left.
    try t.clickText("Back");
    t.settle(2);
    try std.testing.expect(t.hasText("Let your AI use any website"));
    try std.testing.expectEqual(@as(f32, -1), a.onboard_dir);
    try t.clickText("Get started");
    t.settle(2);
    try t.clickText("Agree and continue");
    try std.testing.expectEqualStrings("accept_terms {\"keep_off\":false}", a.store.lastLog());
    a.store.put(.settings, canned[1][1]);
    t.settle(2);
    // Signing in is a step of its own, with an ordinary way past it.
    try std.testing.expect(t.hasText("Sign in to Unbrowse"));
    snap(&t, "test-onboard-sign-in");
    try t.clickText("Skip for now");
    t.settle(2);
    try std.testing.expect(!a.signInDue());
}

test "the last step of setting up gives the first thing to try, ready to copy" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.new_node = true;
    a.finish_due = true;
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    t.settle(2);
    try std.testing.expect(t.hasText("You're set"));
    try std.testing.expect(t.hasText(@import("screens/onboarding.zig").try_this));
    snap(&t, "test-onboard-done");
    try t.clickText("Copy");
    try std.testing.expectEqualStrings(@import("screens/onboarding.zig").try_this, t.clipboard.items);
    try t.clickText("Open Unbrowse");
    t.settle(1);
    try std.testing.expect(t.hasText("Online"));
}

/// A balance with a top-up page: what a node on a live network or the devnet answers with while payments run.
const money_top_up = "{\"balance\":\"4.20\",\"available_to_spend\":\"4.20\",\"needed_to_start\":\"0.00\",\"add_funds_url\":\"https://unbrowse.ai/fund/#node=0x1234567890abcdef1234567890abcdef12345678&chain=5042002&min=0.00&nonce=n3\",\"payments\":\"open\"," ++
    "\"parts\":{\"at_address\":\"4.20\",\"kept_for_fees\":\"0.00\",\"deposit\":\"0.00\",\"account_deposit\":null,\"signed\":\"0.00\"},\"agents\":[],\"earnings\":{\"available\":\"0.00\"}}";

/// The same after a top-up landed: the count the badge must show next.
const money_topped = "{\"balance\":\"6.20\",\"available_to_spend\":\"6.20\",\"needed_to_start\":\"0.00\",\"add_funds_url\":\"https://unbrowse.ai/fund/#node=0x1234567890abcdef1234567890abcdef12345678&chain=5042002&min=0.00&nonce=n4\",\"payments\":\"open\"," ++
    "\"parts\":{\"at_address\":\"6.20\",\"kept_for_fees\":\"0.00\",\"deposit\":\"0.00\",\"account_deposit\":null,\"signed\":\"0.00\"},\"agents\":[],\"earnings\":{\"available\":\"0.00\"}}";

/// A live network whose Settlement isn't deployed: no payments, so no top-up page to link.
const money_closed = "{\"balance\":\"0.00\",\"available_to_spend\":\"0.00\",\"needed_to_start\":\"0.00\",\"add_funds_url\":null,\"payments\":\"not_open\"," ++
    "\"parts\":{\"at_address\":\"0.00\",\"kept_for_fees\":\"0.00\",\"deposit\":\"0.00\",\"account_deposit\":null,\"signed\":\"0.00\"},\"agents\":[],\"earnings\":{\"available\":\"0.00\"}}";

test "the balance badge sits on every screen, tops up, and shows a top-up that lands" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.money, money_top_up);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.node);
    t.settle(1);
    try std.testing.expect(t.hasText("$4.20  Top up"));
    // Settings doesn't ask the node for money: the badge is there because the frame around every screen reads it.
    a.go(.settings);
    t.settle(1);
    try std.testing.expect(t.hasText("$4.20  Top up"));
    snap(&t, "test-credit-badge");
    // One press is Money's Add funds, from wherever the owner stands.
    try t.clickText("$4.20  Top up");
    try std.testing.expectEqualStrings("add_funds {}", a.store.lastLog());
    // A top-up that lands moves the badge without the owner leaving the screen.
    a.store.put(.money, money_topped);
    t.frame();
    try std.testing.expect(t.hasText("$6.20  Top up"));
    try std.testing.expect(!t.hasText("$4.20  Top up"));
}

test "with payments not open the badge shows the count and no dead top-up" {
    const a = try std.testing.allocator.create(App);
    defer std.testing.allocator.destroy(a);
    a.init(std.testing.allocator, null, null);
    defer a.deinit();
    load(a);
    a.store.put(.chain_status, "{\"up\":true,\"error\":null,\"rpc\":\"https://rpc.testnet.arc.io\",\"deployment\":null,\"payments\":\"not_open\"}");
    a.store.put(.money, money_closed);
    var t: ui.Tester = undefined;
    try t.init(std.testing.allocator, .init(a, shell.view), .{ .width = 1180, .height = 780 });
    defer t.deinit();
    a.go(.routes);
    t.settle(1);
    try std.testing.expect(t.hasText("$0.00"));
    try std.testing.expect(t.hasText("Payments not open yet"));
    try std.testing.expect(!t.containsText("Top up"));
    try std.testing.expectError(error.TextNotFound, t.clickText("$0.00  Top up"));
    try std.testing.expectEqualStrings("", a.store.lastLog());
}
