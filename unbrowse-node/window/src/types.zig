//! The node's payloads, as core.ts and the Rust core shape them. Every field
//! a screen reads is here; fields the node adds later are ignored, and a
//! field it leaves out takes its default.
const std = @import("std");
/// The node's types, generated from agent-api.json (unbrowse-sdk/codegen/generate.py). The structs here are the
/// window's views of them: the fields a screen reads, with the defaults it shows before the node answers. The test
/// at the end holds each view to its node type.
pub const wire = @import("wire.zig");

pub const Identity = wire.Identity;
/// `terms_version` is the version the node asks its owner about; a node older than the question answers none.
pub const NodeInfo = struct { name: []const u8 = "this node", version: []const u8 = "", api_port: u16 = 7788, dev: bool = false, terms_version: []const u8 = "" };
/// The terms the owner is asked about, as the node carries them.
pub const TermsText = wire.TermsText;
pub const Site = wire.Site;
pub const Session = wire.Session;

pub const Settings = struct {
    map_while_browsing: bool = true,
    hold_routes: bool = false,
    signed_in_calls: bool = false,
    paused: bool = false,
    api_port: u16 = 7788,
    storage_gb: f64 = 0,
    excluded: []const []const u8 = &.{},
    /// Which routes the node lists by itself: "used" (those agents keep using), "all" or "off".
    share_routes: []const u8 = "used",
    /// The owner has seen, once, that the node shares what it learns and how to stop it.
    share_notice_seen: bool = false,
    /// The most routes listed by itself in a day; null is the mode's own.
    list_per_day: ?f64 = null,
    /// Calls may follow a public name to an address inside this network.
    private_network: bool = false,
    /// The version of the terms the owner acknowledged.
    terms_accepted: ?[]const u8 = null,
    /// The window shows its advanced screens. Null: never chosen, as on a node from before the choice.
    advanced: ?bool = null,
    /// The owner lets the node join the peer network.
    peer_network: bool = true,
    /// The node fetches newer releases and restarts into them.
    auto_update: bool = true,
    /// The vault keeps website passkeys and signs in with them: a site the node signs in to may get one (on unless
    /// the owner turns it off).
    passkeys: bool = true,
    /// Sites the node never enrols a passkey on, nor signs in to with one. Kept so a save from the window keeps them.
    passkeys_never: []const []const u8 = &.{},
    /// The most the node pays, in USDC, to fetch one route another contributor lists: agents spend up to it on their
    /// own, and a route that costs more is passed over. 0: only free routes and the node's own.
    max_fetch_usdc: f64 = 0.05,
    /// The listing's first buy: the share of the wallet's UNB, in basis points, the node launches the route coin of each
    /// entry newly credited to the wallet with, and stakes what it buys, by itself. 100 (1%) by default; 0 is none.
    /// Changed only through its own command (`coin_dev_buy`), which asks the owner before raising it past the default.
    coin_dev_buy_bps: u32 = 100,
    /// The node takes the bounty steps for the owner as its agent judges (spec §88): off until the owner turns them on.
    bounty_auto: bool = false,
    /// The vault keeps cards' security codes, so agents pay where a checkout asks for one without the owner: off until
    /// the owner turns it on (#185), through its own command (`keep_card_codes`), never a settings save.
    keep_card_codes: bool = false,
};

/// Where the node's updates stand (update.rs).
pub const UpdateStatus = struct {
    running: []const u8 = "",
    /// This build updates itself, and the owner hasn't turned that off.
    enabled: bool = false,
    latest: ?[]const u8 = null,
    min_version: ?[]const u8 = null,
    /// Older than the network takes.
    outdated: bool = false,
    checking: bool = false,
    /// A newer version unpacked, which the node restarts into once no call is running.
    ready: ?[]const u8 = null,
    @"error": ?[]const u8 = null,
};

pub const RouteInput = struct { name: []const u8 = "", secret: bool = false, default: ?[]const u8 = null };
pub const Stats = struct { calls: f64 = 0, passed: f64 = 0, last_ms: ?f64 = null, last_at: ?f64 = null, last_error: ?[]const u8 = null };
pub const Listing = struct { entry_id: []const u8 = "", tx: []const u8 = "", listed_at: f64 = 0, live: bool = false };
pub const Route = struct {
    id: []const u8 = "",
    site: []const u8 = "",
    what: []const u8 = "",
    method: []const u8 = "",
    path: []const u8 = "",
    root: []const u8 = "",
    inputs: []const RouteInput = &.{},
    steps: f64 = 0,
    browser_assisted: bool = false,
    write: bool = false,
    provisional: bool = false,
    learned_at: f64 = 0,
    stats: Stats = .{},
    listing: ?Listing = null,
    /// Learned from the owner's own browsing: it acts as them, so it is never listed.
    yours: bool = false,
    /// The owner's say on sharing it: null follows the setting, false keeps it off, true shares it.
    share: ?bool = null,

    pub fn broken(r: Route) bool {
        return r.stats.calls > 0 and r.stats.last_error != null;
    }
};
pub const RouteChain = struct { id: []const u8 = "", listed: bool = false, live: bool = false, fee: f64 = 0, held: bool = false };

pub const CallResult = struct { ok: bool = false, ms: f64 = 0, data: std.json.Value = .null, @"error": ?[]const u8 = null };

pub const Activity = wire.Activity;

pub const Agent = struct {
    index: u32 = 0,
    name: []const u8 = "",
    address: []const u8 = "",
    cap_usdc: f64 = 0,
    expires: f64 = 0,
    created: f64 = 0,
    revoked: bool = false,
    tx: ?[]const u8 = null,
};
pub const AgentSpend = wire.AgentSpend;
pub const NewAgent = wire.NewAgent;
/// This node's own remote MCP address at a gateway, and a remote key made for it (`remote.rs`).
pub const Remote = wire.Remote;
/// The node's setup as one list (`setup_status`), the same an agent reads with unbrowse_setup.
pub const SetupStatus = wire.SetupStatus;
pub const NewRemoteKey = wire.NewRemoteKey;

/// `code`: the Keychain keeps the login's one-time code key (two-step sign-in).
pub const Login = struct { site: []const u8 = "", account: []const u8 = "", kind: []const u8 = "derived", counter: f64 = 0, created: f64 = 0, code: bool = false };

/// What `wallet_restore` did: `previous` is the key it replaced, kept in the Keychain; null when the words were this
/// node's key already.
pub const Restored = wire.Restored;

pub const Deployment = struct { unb: []const u8 = "", settlement: []const u8 = "", chain_id: f64 = 0, block: f64 = 0 };
pub const ChainStatus = struct { up: bool = false, @"error": ?[]const u8 = null, rpc: []const u8 = "", network: []const u8 = "devnet", deployment: ?Deployment = null, settlement_missing: bool = false, payments: []const u8 = "starting" };
/// What the wallet's routes and stake earned, all time: `entries`, the route share its entries' paid fetches sent to
/// their coins (or to the wallet, for an entry with no coin), by day in `by_day`; `staking`, what its coin stakes earned;
/// `lines`, its entries' paid fetches. In USDC.
pub const Earned = struct { entries: f64 = 0, staking: f64 = 0, lines: f64 = 0, by_day: []const [2]f64 = &.{} };
pub const Wallet = struct {
    address: []const u8 = "",
    chain_id: f64 = 0,
    block: f64 = 0,
    epoch: f64 = 0,
    epoch_ends_in: f64 = 0,
    unb: []const u8 = "",
    settlement: []const u8 = "",
    held: f64 = 0,
    unb_held: f64 = 0,
    deposit: f64 = 0,
    pending_withdrawal: f64 = 0,
    withdraw_epoch: f64 = 0,
    earned: Earned = .{},
    /// USDC waiting on the chain for the wallet to take (`collect_earnings`): its coin stakes' earnings and what the fetch
    /// owes it as a contributor. Paid whole: nothing vests.
    to_claim: f64 = 0,
    /// The node's detail fee, for every route it lists.
    fee: f64 = 0,
    pricing: Pricing = .{},
    /// How each fee is split, as the node states it (`chain::SPLIT`).
    split: Split = .{},
};
/// How the contract splits each fee, in percent. The node sends it with the wallet; these defaults are the node's
/// (`chain::SPLIT`: the route's share to its coin, the site's, the burn; no platform or serving share), shown only
/// until the node's answer arrives.
pub const Split = struct { contributor: f64 = 65, site: f64 = 30, platform: f64 = 0, serving: f64 = 0, burn: f64 = 5 };
/// How the node's fee moves: by hand, or with demand once an epoch between a floor and a ceiling.
pub const Pricing = struct { auto: bool = false, floor: f64 = 0.01, ceiling: f64 = 1, epoch: f64 = 0, block: f64 = 0, lines: f64 = 0 };
pub const BoardRow = wire.BoardRow;
/// One live entry of a route, as the node ranks it from the chain (R3.36): `unverified` under the evidence floor,
/// `unavailable` when no node served it lately.
pub const EntryStanding = struct {
    id: []const u8 = "",
    contributor: []const u8 = "",
    fee: f64 = 0,
    yours: bool = false,
    default: bool = false,
    unverified: bool = true,
    unavailable: bool = false,
    counted_uses: f64 = 0,
    pass_rate: f64 = 0,
};
/// A route listed on the chain with its live entries, the default first.
pub const RouteEntries = struct { site: []const u8 = "", what: []const u8 = "", default: ?[]const u8 = null, entries: []const EntryStanding = &.{} };

/// One event of the agent's eye: every kind's fields, those it lacks left at their defaults.
pub const Scored = struct { index: f64 = 0, method: []const u8 = "", host: []const u8 = "", path: []const u8 = "", score: f64 = 0, noise: bool = false };
pub const Eye = struct {
    kind: []const u8 = "",
    walk: []const u8 = "",
    url: []const u8 = "",
    goal: []const u8 = "",
    agent: []const u8 = "",
    n: f64 = 0,
    method: []const u8 = "",
    host: []const u8 = "",
    path: []const u8 = "",
    status: f64 = 0,
    bytes: f64 = 0,
    sort: []const u8 = "",
    exchanges: f64 = 0,
    candidates: []const Scored = &.{},
    index: f64 = 0,
    by: []const u8 = "",
    reasons: []const []const u8 = &.{},
    route: []const u8 = "",
    what: []const u8 = "",
    site: []const u8 = "",
    steps: f64 = 0,
    inputs: []const []const u8 = &.{},
    @"error": []const u8 = "",
};

pub const CallEvent = struct {
    /// The same on a call's start and end (0 from an older node).
    id: f64 = 0,
    phase: []const u8 = "",
    route: []const u8 = "",
    site: []const u8 = "",
    what: []const u8 = "",
    agent: []const u8 = "",
    agent_index: ?u32 = null,
    ok: ?bool = null,
    ms: ?f64 = null,
    paid_usdc: ?f64 = null,
    at: f64 = 0,
    /// Milliseconds since the epoch (0 from an older node: `at` then).
    at_ms: f64 = 0,
};

/// A picture of a walk is ready to fetch (`GET /owner/frame?walk=`).
pub const FrameNote = struct { walk: []const u8 = "", seq: f64 = 0, w: f64 = 0, h: f64 = 0, settled: bool = false };

/// A browser the node can drive (browsers.rs): a Chromium app here, or Chrome for Testing it downloaded.
pub const Browser = struct { name: []const u8 = "", path: []const u8 = "", downloaded: bool = false };
/// The browser in use, the owner's choice, the ones to choose from, and the download.
pub const Browsers = struct {
    using: ?[]const u8 = null,
    chosen: ?[]const u8 = null,
    found: []const Browser = &.{},
    downloading: bool = false,
    download_error: ?[]const u8 = null,
};

/// What a password import did. Rows it left out are counted by why, never listed: a row is a password.
pub const VaultImport = struct {
    added: f64 = 0,
    codes: f64 = 0,
    known: f64 = 0,
    skipped: []const struct { why: []const u8 = "", count: f64 = 0 } = &.{},
};

/// A site's browser the owner can take over (hands.rs): the page it shows, and whether the owner has it.
pub const HandsBrowser = wire.HandsBrowser;
/// A payment with a card from the vault the owner is asked to approve (hands.rs `Pay`): the card and the site it goes
/// to, and for a route call, which has no page, what the route does and the values it sends.
/// A payment an agent asks the owner to approve (the node's `HandsAsk.pay`).
pub const HandsPay = wire.HandsAsk.Pay;
/// A login an agent asks the owner to add to the vault (`vault:ask:`): its site and account, never a password.
pub const HandsLogin = wire.HandsAsk.HandsAskLogin;
/// An agent asking for the owner on a site's page (`ask_owner`): what it needs, and until when it waits. `pay` when
/// it asks them to approve a payment.
pub const HandsAsk = wire.HandsAsk;
pub const Hands = wire.Hands;
/// What the node says happened on a site's page: an ask, the owner taking it or giving it back, the page moving on.
pub const HandsEvent = struct { kind: []const u8 = "", site: []const u8 = "", url: []const u8 = "", ask: ?HandsAsk = null };

/// Where one route stands for sharing (autolist.rs), flattened as the node sends it: `why` names the standing, and
/// the fields it carries are filled.
pub const ShareRoute = struct {
    id: []const u8 = "",
    why: []const u8 = "",
    share: ?bool = null,
    passed: f64 = 0,
    days: f64 = 0,
    runs: f64 = 0,
    days_needed: f64 = 0,
    runs_needed: f64 = 0,
    per_day: f64 = 0,
    poster: bool = false,
    host: []const u8 = "",
    reason: std.json.Value = .null,
    @"error": []const u8 = "",
};
pub const ShareStatus = struct { mode: []const u8 = "used", per_day: f64 = 0, listed_today: f64 = 0, routes: []const ShareRoute = &.{} };
/// What the node's key lacks for gas on a live chain.
pub const GasShort = wire.GasShort;
/// What the node's own key needs in USDC on a live chain (no sponsor, spec §76): `short` is null on the devnet and
/// whenever it can pay; `identity_usdc` is what its identity needs once; `fund_usdc` what to send for its deposit.
pub const Funding = struct { live: ?[]const u8 = null, short: ?GasShort = null, identity_usdc: ?f64 = null, deposit_floor_usdc: f64 = 0, fund_usdc: ?f64 = null };
/// One source's earnings, in USDC (`earnings`): credited, of it still vesting, ready to withdraw, withdrawn, withheld
/// into the bond, still to collect from a pool or a vault, and held with stake a fraud proof froze.
pub const EarningsLine = wire.EarningsLine;
/// What the wallet earned, by where it came from, and its own vesting and withdrawable totals.
pub const Earnings = wire.Earnings;
/// One staked lot of a route coin (`coin_holdings`): its exit delay in seconds; coins earning now, and coins staked this
/// epoch that earn from the next; coins asked back, and when they are ready to take back (seconds since the epoch, 0
/// when none are).
pub const CoinLot = struct { delay: f64 = 0, earning: f64 = 0, pending: f64 = 0, unstaking: f64 = 0, ready_at: f64 = 0 };
/// What the owner's wallet holds of one route coin: its entry, the coin's state ("trading" or "not launched"),
/// unstaked coins, each staked lot, what its stake earned and hasn't claimed (USDC),
/// USDC a fetch paid whose buy is parked, whether the wallet checked the entry and its latest paid call
/// on it passed (both needed for its stake to earn), and the coin's price and what the wallet's coins are worth, in UNB.
pub const Holding = struct {
    coin: []const u8 = "",
    entry: []const u8 = "",
    state: []const u8 = "",
    held: f64 = 0,
    lots: []const CoinLot = &.{},
    owed_usdc: f64 = 0,
    parked_usdc: f64 = 0,
    checked: bool = false,
    latest_passed: bool = false,
    price: f64 = 0,
    value_unb: f64 = 0,
    /// That value in dollars, estimated at the UNB pool's steady price (R1.30); none while the pool says nothing.
    value_usd: ?f64 = null,
};
/// The owner's route coins (`coin_holdings`), what the fetch owes it as a contributor, and the exit delay, in seconds,
/// the coins its paid fetches buy are staked with.
pub const Holdings = struct { wallet: []const u8 = "", coins: []const Holding = &.{}, owed_as_contributor_usdc: f64 = 0, fetch_delay: f64 = 0, unb_usd: ?f64 = null };
/// One key the owner's wallet granted, on this node or another.
pub const WalletKey = struct { agent: []const u8 = "", cap_usdc: f64 = 0, expiry: f64 = 0, revoked: bool = false, spent_usdc: f64 = 0, this_node: bool = false, name: ?[]const u8 = null };
/// The owner's wallet, its deposit, every key it granted, and when its grant to this node's keys runs out, once that
/// is within a week (`owner_nodes`).
pub const OwnerNodes = wire.OwnerNodes;
/// A listing this node keeps for the owner's wallet to sign (`listings_to_sign`): the node lists under the wallet's
/// identity and doesn't hold its key. `what` says what signing it does, in plain words.
pub const ListingToSign = struct { id: []const u8 = "", site: []const u8 = "", description: []const u8 = "", wallet: []const u8 = "", what: []const u8 = "" };

/// The Money screen, in dollars (`money`): every sum a decimal string of USDC.
pub const MoneyAgent = struct { index: u32 = 0, name: []const u8 = "", daily_limit: []const u8 = "0.00", spent_today: []const u8 = "0.00", pays_from: []const u8 = "node" };
pub const MoneyParts = struct { at_address: []const u8 = "0.00", kept_for_fees: []const u8 = "0.00", deposit: []const u8 = "0.00", account_deposit: ?[]const u8 = null, signed: []const u8 = "0.00" };
/// `available`: route shares the fetch owes the owner as a contributor, ready to take. Coin stakes' earnings are in
/// `earnings` and `coin_holdings`.
pub const MoneyEarnings = struct { available: []const u8 = "0.00" };
pub const Money = struct {
    balance: []const u8 = "0.00",
    available_to_spend: []const u8 = "0.00",
    needed_to_start: []const u8 = "0.00",
    add_funds_url: ?[]const u8 = null,
    payments: []const u8 = "starting",
    parts: MoneyParts = .{},
    agents: []const MoneyAgent = &.{},
    earnings: MoneyEarnings = .{},
};

/// The owner's wallet linked to this node, and a sign-in waited on.
pub const OwnerLink = wire.OwnerLink;
pub const LinkStart = wire.LinkStart;

/// One agent app the node looked for on this Mac (`agent_clients`): whether it is installed (`found`), whether it already
/// carries the node's `unbrowse` entry (`connected`), the config file that would hold it, and a word of caution when an
/// `unbrowse` entry that is not the node's own is there.
pub const AgentClient = struct {
    id: []const u8 = "",
    name: []const u8 = "",
    found: bool = false,
    connected: bool = false,
    path: []const u8 = "",
    note: ?[]const u8 = null,
    /// Set up per project (ElizaOS): named with how, never ticked or written.
    manual: bool = false,
    /// When the app last reached the node (unix seconds), by the name it gives at MCP initialize: null until it has.
    heard: ?f64 = null,
};
pub const AgentClients = struct { clients: []const AgentClient = &.{} };

/// What `agent_connect` did for one client. `restart_needed`: the app reads its config only when it starts.
pub const ConnectResult = struct {
    id: []const u8 = "",
    name: []const u8 = "",
    ok: bool = false,
    restart_needed: bool = false,
    @"error": ?[]const u8 = null,
};
pub const ConnectAnswer = struct { results: []const ConnectResult = &.{} };

/// A client `agent_connect_undo` put back as it was.
pub const UndoneClient = struct { id: []const u8 = "", name: []const u8 = "", path: []const u8 = "" };
pub const UndoAnswer = struct { restored: []const UndoneClient = &.{} };

/// The node's resources the window reads, each a command with no arguments
/// (activity takes its limit).
pub const Res = enum {
    node_info,
    identity,
    settings,
    chain_status,
    routes,
    sites,
    activity,
    wallet,
    agents_spend,
    agents_list,
    routes_on_chain,
    sessions,
    vault_list,
    vault_cards,
    card_limits,
    board,
    entries,
    browsers,
    update_status,
    hands,
    share_status,
    funding,
    link_status,
    remote_status,
    earnings,
    owner_nodes,
    listings_to_sign,
    money,
    terms_text,
    coin_holdings,
    setup_status,

    pub fn Type(comptime r: Res) type {
        return switch (r) {
            .node_info => NodeInfo,
            .identity => Identity,
            .settings => Settings,
            .chain_status => ChainStatus,
            .routes => []const Route,
            .sites => []const Site,
            .activity => []const Activity,
            .wallet => Wallet,
            .agents_spend => []const AgentSpend,
            .agents_list => []const Agent,
            .routes_on_chain => []const RouteChain,
            .sessions => []const Session,
            .vault_list => []const Login,
            .vault_cards => []const Card,
            .card_limits => []const CardLimit,
            .board => []const BoardRow,
            .entries => []const RouteEntries,
            .browsers => Browsers,
            .update_status => UpdateStatus,
            .hands => Hands,
            .share_status => ShareStatus,
            .funding => Funding,
            .link_status => OwnerLink,
            .remote_status => Remote,
            .earnings => Earnings,
            .owner_nodes => OwnerNodes,
            .listings_to_sign => []const ListingToSign,
            .money => Money,
            .terms_text => TermsText,
            .coin_holdings => Holdings,
            .setup_status => SetupStatus,
        };
    }

    pub fn body(r: Res) []const u8 {
        return if (r == .activity) "{\"limit\":500}" else "{}";
    }
};

/// A payment card in the vault, as `vault_cards` lists it: never its number, expiry, name or code. `code` is whether it
/// is kept with its security code.
pub const Card = struct { label: []const u8 = "", last4: []const u8 = "", created: f64 = 0, code: bool = false };

/// What agents may pay with a card on a site without asking the owner (spec §103).
pub const CardLimit = struct {
    card: []const u8 = "",
    site: []const u8 = "",
    per_payment: f64 = 0,
    per_day: f64 = 0,
    spent: f64 = 0,
};

/// One route an `unbrowse://` link names: this node's own, or another's (`listed_as`, in its lister's words).
pub const LinkRoute = struct {
    pub const Listed = struct { site: []const u8 = "", what: []const u8 = "" };
    id: []const u8 = "",
    what: []const u8 = "",
    remote: bool = false,
    fee: f64 = 0,
    contributor: []const u8 = "",
    listed_as: Listed = .{},
};

/// What the node answers for a link.
pub const LinkPreview = struct {
    link: []const u8 = "",
    site: []const u8 = "",
    routes: []const LinkRoute = &.{},
    unavailable: ?[]const u8 = null,
};

pub const parse_options: std.json.ParseOptions = .{ .ignore_unknown_fields = true, .allocate = .alloc_always };

test "parse a route and an eye event" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rs = try std.json.parseFromSliceLeaky([]const Route, a,
        \\[{"id":"r1","site":"hn","what":"Search stories","method":"GET","path":"/api","root":"x","inputs":[{"name":"q","secret":false,"default":null}],
        \\"steps":1,"browser_assisted":false,"write":false,"provisional":true,"learned_at":1,"stats":{"calls":2,"passed":1,"last_ms":120,"last_at":5,"last_error":"502"},"listing":null,"extra":1}]
    , parse_options);
    try std.testing.expect(rs[0].broken());
    try std.testing.expectEqualStrings("q", rs[0].inputs[0].name);
    const e = try std.json.parseFromSliceLeaky(Eye, a, "{\"kind\":\"seen\",\"walk\":\"w\",\"n\":3,\"method\":\"GET\",\"host\":\"h\",\"path\":\"/p\",\"status\":200,\"bytes\":10,\"sort\":\"data\"}", parse_options);
    try std.testing.expectEqualStrings("data", e.sort);
}

// ---------------------------------------------------------------- the views, held to the node's types

/// Where a window view `V` reads something the node's type `W` doesn't send, or sends as another kind: a message
/// naming the path, or null when `V` reads only what `W` sends. A field the node may send as null must be optional
/// here, or the whole answer fails to parse. Decls and methods of `V` are its own; `std.json.Value` on either side is
/// read as anything.
pub fn misread(comptime V: type, comptime W: type, comptime path: []const u8) ?[]const u8 {
    if (V == W or V == std.json.Value or W == std.json.Value) return null;
    const vi = @typeInfo(V);
    const wi = @typeInfo(W);
    if (wi == .optional) {
        if (vi != .optional) return path ++ ": the node may send null, and the window's " ++ @typeName(V) ++ " is not optional";
        return misread(vi.optional.child, wi.optional.child, path);
    }
    if (vi == .optional) return misread(vi.optional.child, W, path);
    switch (vi) {
        .int, .float => return if (wi == .float or wi == .int) null else path ++ ": a number here, a " ++ @typeName(W) ++ " from the node",
        .bool => return if (W == bool) null else path ++ ": a bool here, a " ++ @typeName(W) ++ " from the node",
        .@"enum" => return if (W == []const u8) null else path ++ ": an enum here, a " ++ @typeName(W) ++ " from the node",
        .array => |a| {
            if (wi != .pointer) return path ++ ": a list here, a " ++ @typeName(W) ++ " from the node";
            return misread(a.child, wi.pointer.child, path ++ "[]");
        },
        .pointer => |pv| {
            if (wi != .pointer) return path ++ ": " ++ @typeName(V) ++ " here, " ++ @typeName(W) ++ " from the node";
            if (pv.child == u8 or wi.pointer.child == u8) {
                return if (pv.child == wi.pointer.child) null else path ++ ": " ++ @typeName(V) ++ " here, " ++ @typeName(W) ++ " from the node";
            }
            return misread(pv.child, wi.pointer.child, path ++ "[]");
        },
        .@"struct" => |sv| {
            if (wi != .@"struct") return path ++ ": an object here, a " ++ @typeName(W) ++ " from the node";
            if (@hasDecl(W, "KV") and !@hasDecl(V, "KV")) return path ++ ": an object here, a map from the node";
            for (sv.field_names, sv.field_types) |name, t| {
                if (!@hasField(W, name)) return path ++ "." ++ name ++ ": the window reads it and the node never sends it";
                if (misread(t, @FieldType(W, name), path ++ "." ++ name)) |m| return m;
            }
            return null;
        },
        else => return path ++ ": " ++ @typeName(V) ++ " here, " ++ @typeName(W) ++ " from the node",
    }
}

/// The node's name for a view whose name the window gives it otherwise.
fn nodeName(comptime name: []const u8) []const u8 {
    if (std.mem.eql(u8, name, "Route")) return "KeptRoute";
    if (std.mem.eql(u8, name, "Login")) return "VaultLogin";
    if (std.mem.eql(u8, name, "Card")) return "VaultCard";
    return name;
}

test "a view is told where it misreads the node" {
    const W = wire.Activity;
    comptime {
        if (misread(struct { at: f64 = 0, site: []const u8 = "" }, W, "A") != null) @compileError("a plain view was refused");
        if (misread(struct { ms: ?f64 = null }, W, "A") != null) @compileError("an optional view of a nullable field was refused");
        const never = misread(struct { colour: []const u8 = "" }, W, "A") orelse @compileError("a field the node never sends passed");
        if (!std.mem.endsWith(u8, never, "the node never sends it")) @compileError(never);
        const nullable = misread(struct { ms: f64 = 0 }, W, "A") orelse @compileError("a non-optional view of a nullable field passed");
        if (!std.mem.endsWith(u8, nullable, "is not optional")) @compileError(nullable);
        if (misread(struct { site: f64 = 0 }, W, "A") == null) @compileError("a number read from a string passed");
    }
}

test "every view reads only what the node sends" {
    comptime {
        @setEvalBranchQuota(200_000);
        for (@typeInfo(@This()).@"struct".decl_names) |name| {
            const node = nodeName(name);
            if (!@hasDecl(wire, node)) continue;
            const V = @field(@This(), name);
            if (@TypeOf(V) != type or @typeInfo(V) != .@"struct") continue;
            if (misread(V, @field(wire, node), name)) |m| @compileError(m);
        }
    }
}

test "every resource is a view of what its command answers" {
    comptime {
        @setEvalBranchQuota(200_000);
        for (std.enums.values(Res)) |r| {
            const cmd = std.meta.stringToEnum(wire.Command, @tagName(r)) orelse @compileError(@tagName(r) ++ ": no owner command of that name");
            if (misread(r.Type(), wire.Returns(cmd), @tagName(r))) |m| @compileError(m);
        }
    }
}

test "every command's answer parses from nothing to its defaults" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    inline for (comptime std.enums.values(wire.Command)) |c| {
        const T = wire.Returns(c);
        const empty = switch (@typeInfo(T)) {
            .pointer => "[]",
            .@"struct" => if (T == std.json.Value) "null" else "{}",
            .optional => "null",
            else => continue,
        };
        _ = try std.json.parseFromSliceLeaky(T, arena.allocator(), empty, parse_options);
    }
}
