// The node's own records, as the owner's commands answer them. These keep the node's snake case: a record the window
// reads is often one it sends back (settings), and it goes back as it came.
//
// Each is the node's own schema, generated into generated.ts from agent-api.json, under the name it has always had
// here; what the node sends changes there, never by hand. The live events below aren't commands, so they're written
// here.

import type * as W from "./generated.js";

export type Identity = W.Identity;
/** The owner's wallet, linked to this node by signing in with Privy on the website, and a sign-in being waited on. */
export type OwnerLink = W.OwnerLink;
/** A sign-in started: the page the node opened in the owner's browser, and whether it could open it. */
export type LinkStart = W.LinkStart;
/** What the node's key lacks for gas on a live chain, and what the owner is told. */
export type GasShort = W.GasShort;
/**
 * What the node's own key needs in USDC on Arc, which is also its gas (no sponsor, spec §76): `short` is null on the
 * devnet and whenever it can pay; `identity_usdc` is what its identity registration needs once, a few cents; its
 * deposit against the floor it keeps and what to send to reach it; and how USDC on another chain reaches it.
 */
export type Funding = W.Funding;
/**
 * The Money screen, in dollars: one balance, what agents can spend, the smallest top-up that starts the node, each
 * agent's daily limit and spend today, the earnings available, and the page that adds funds. Every sum is a decimal
 * string of USDC.
 */
export type Money = W.Money;
/** The page that adds funds, opened in the owner's browser. */
export type AddFunds = W.AddFunds;
/** Which routes the node lists by itself: those agents keep using, every one, or none. */
export type ShareMode = W.ShareMode;
/** What keeps the node from listing anything now. */
export type ShareBlocked = W.ShareBlocked;
/** Where one route stands for sharing, and why it waits if it does. */
export type ShareStanding = W.ShareStanding;
export type ShareRoute = W.ShareRoute;
export type ShareStatus = W.ShareStatus;
export type NodeInfo = W.NodeInfo;
/** A site the node has walked. */
export type Site = W.Site;
/** A site's kept session: how many cookies, and when they were last refreshed. */
export type Session = W.Session;
/**
 * The owner's settings. `max_fetch_usdc` is the most the node pays, in USDC, to fetch one route another contributor
 * lists: agents spend up to it on their own, and 0 uses only free routes and the node's own. `share_routes` says which
 * routes the node lists by itself; `list_per_day` caps them (unset: the mode's own).
 */
export type Settings = W.Settings;

export type KeptRouteInput = W.KeptRouteInput;
/**
 * A route as the node keeps it: its steps, its record of calls, and its listing on the network (the fee is the node's
 * one fee, `wallet().fee`). `yours`: learned from the owner's own browsing, so theirs alone and never listed;
 * `fetched`: made from another contributor's listed body; `share`: the owner's say on sharing it.
 */
export type KeptRoute = W.KeptRoute;
/** The listing a route made from another contributor's body came from. */
export type FetchedFrom = W.FetchedFrom;
/** What the chain says of a kept route: listed, live, its fee, its entry's route coin, the owner's coins of it and its rank. */
export type RouteChain = W.RouteChain;

/** What a route the owner called answered, in the node's words. */
export type OwnerCallResult = W.OwnerCallResult;

/**
 * A line of the node's activity. `unb` is the amount that moved, signed, in USDC (a fee, a deposit, a claim). The name
 * is the node's own, from before fees were USDC.
 */
export type Activity = W.Activity;

/** An agent key. `cap_usdc` is the most it spends a day, in USDC; `cap_unb` is the same amount under its deprecated name. */
export type Agent = W.Agent;
/** A new agent key: its setup, which names the agent and never its token, and the token, on this answer alone. */
export type NewAgent = W.NewAgent;
export type AgentSpend = W.AgentSpend;

/**
 * A login in the vault. The password stays in the Keychain; `vaultReveal` is the one way to read it. `code` says the
 * Keychain also holds its one-time code key, which agents fill as `vault:code:<site>:<account>`.
 */
export type VaultLogin = W.VaultLogin;
/** What an import did. Rows it left out are counted by why, never listed. */
export type VaultImport = W.VaultImport;
/** A Chromium browser on this Mac the node can drive. `downloaded`: the Chrome for Testing the node downloaded. */
export type BrowserFound = W.BrowserFound;
/**
 * The browser the node walks and browses in: the one in `using`, which is the owner's `chosen` one when set and
 * otherwise the node's own pick (the downloaded Chrome for Testing, then Chrome, then any other Chromium browser).
 * `using` is null when the Mac has none; the node then downloads Chrome for Testing (`downloading`).
 */
export type Browsers = W.Browsers;
/** What a restore from the recovery phrase did: `previous` is the key it replaced, kept in the Keychain. */
export type Restored = W.Restored;
/** An encrypted backup of the node's key: a keystore file (JSON) under the owner's passphrase, and its address. */
export type KeyBackup = W.KeyBackup;
/** What the owner's wallet sends so this node's agent keys pay from its deposit: one `authorizeAgent` call each. */
export type WalletGrant = W.WalletGrant;
/** The owner's wallet, its deposit, and every agent key it granted on this node and its others. */
export type OwnerNodes = W.OwnerNodes;
/** What the owner's wallet renews in one step before its grants run out. */
export type WalletRenew = W.WalletRenew;
/**
 * What the wallet earned, in USDC, by where it came from: staking route coins and as a contributor; the
 * route share its entries' lines sent to their coins; and what waits to claim.
 */
export type Earnings = W.Earnings;
/** One source's earnings, in USDC: earned, claimed, and still to claim. Claims are paid whole: nothing vests. */
export type EarningsLine = W.EarningsLine;
/**
 * What the wallet holds in route coins (`coinHoldings`): each coin with its entry, state, unstaked coins, staked lots,
 * what its stake earned to claim and its price; what the fetch owes it as a contributor; and the exit delay its
 * fetches stake with.
 */
export type Holdings = W.Holdings;
export type Holding = W.Holding;
/** One staked lot of a coin, by its exit delay in seconds: earning, pending, asked back, and when it is ready. */
export type CoinLot = W.CoinLot;
/** What a coin command sent: its transaction, the coin, the entry and the amount. */
export type CoinDone = W.CoinDone;
/**
 * A bounty: UNB posted for a site (`site`), with the most it pays a coin (`limit_price`), its deadline and `state`;
 * what use by others reserved, and what its poster may take back (`refundable`).
 */
export type BountyView = W.BountyView;
/** What a bounty command sent: its transaction and the bounty's id. */
export type BountyDone = W.BountyDone;

/** A passkey the node keeps for a site. Its credential and key never leave the vault. */
export type Passkey = W.Passkey;
export type Passkeys = W.Passkeys;
/** An enrolment armed: the next passkey `site` makes in that browser before `until` (ms) is kept. */
export type PasskeyArmed = W.PasskeyArmed;
/** The node's own updates: the version running, the newest out, and one unpacked and waiting for a quiet moment. */
export type UpdateStatus = W.UpdateStatus;

/** The contracts a network runs on: the fee token (USDC), UNB, their pool, Settlement and the route coins' contracts. */
export type Deployment = W.Deployment;
/** `network` is `devnet` or the live network's name. */
export type ChainStatus = W.ChainStatus;
/**
 * The owner's wallet on the chain. Fees, deposits, earnings (`earned`, `to_claim`) and the fee are USDC (`held` is the
 * wallet's USDC); `unb_held` is UNB.
 */
export type Wallet = W.Wallet;
/** How each fee is split, in percent: the contributor, the site's escrow, the platform, the serving nodes and the burn. */
export type Split = W.Split;
/** How the node's fee moves: by hand, or with demand once an epoch between `floor` and `ceiling` (USDC). */
export type Pricing = W.Pricing;
export type BoardRow = W.BoardRow;
/** A route listed on the chain, with its live entries in the order the node tries them: the default first. */
export type RouteEntries = W.RouteEntries;
/** One entry's standing in its route: `unverified` under the evidence floor, `unavailable` when no node served it lately. */
export type EntryStanding = W.EntryStanding;

/** A site's browser the owner can take over: the page it shows, and whether the owner has it now. */
export type HandsBrowser = W.HandsBrowser;
/** An agent asking for the owner on a site's page (`ask_owner`), until `expires_at`. */
export type HandsAsk = W.HandsAsk;
export type Hands = W.Hands;
/** The page being watched: its address, its picture's walk (`frame(walk)`), its viewport in CSS pixels. */
export type HandsPage = W.HandsPage;
/** What the owner does on the picture. `x` and `y` are fractions of the picture from its top left. */
export type HandsInput = W.HandsInput;

/** How a request the node's browser saw was sorted while learning. */
export type Sort = "page" | "data" | "asset" | "gate" | "noise";
export type Scored = { index: number; method: string; host: string; path: string; score: number; noise: boolean };
/** What the node's browser sees while a learn runs: paths, statuses and sizes, never headers or bodies. */
export type Eye =
  | { kind: "started"; walk: string; url: string; goal: string; agent: string }
  | { kind: "seen"; walk: string; n: number; method: string; host: string; path: string; status: number; bytes: number; sort: Sort }
  | { kind: "scored"; walk: string; exchanges: number; candidates: Scored[] }
  | { kind: "picked"; walk: string; index: number; method: string; host: string; path: string; by: string; reasons: string[] }
  | { kind: "saved"; walk: string; route: string; what: string; site: string; steps: number; inputs: string[] }
  | { kind: "failed"; walk: string; error: string }
  /** The calls the walk's door took before any was a candidate, each with why (refused, another site's page, a page of script the walk went past). */
  | { kind: "door"; walk: string; took: number; assets: number; calls: DoorTaken[] };
/** One call the walk's door took, and the main document (`by`, an index into the walk) that held it there. */
export type DoorTaken = { index: number; method: string; host: string; path: string; why: "refused" | "another_site" | "went_past"; by: number };

/** A new picture of a walk. `settled` marks the page as the walk settled: the walk's poster. */
export type FrameNote = { walk: string; seq: number; w: number; h: number; settled: boolean };

/** A call: the light leaves the agent on start, the door answers on end. */
export type CallEvent = {
  phase: "start" | "end";
  route: string;
  site: string;
  what: string;
  agent: string;
  agent_index: number | null;
  ok: boolean | null;
  ms: number | null;
  /** What the call paid, in USDC. */
  paid_usdc: number | null;
  /** @deprecated The same amount as `paid_usdc` (USDC, despite the name); kept for older readers. */
  paid_unb: number | null;
  at: number;
};

/** The node's live events, by name, with what each carries. `open` is the stream's own: it (re)connected. */
export type OwnerEvents = {
  /** Something changed: a learn, a call, a setting. Refetch what you show. */
  activity: null;
  /** The chain came up or went down: refetch `chainStatus`. */
  chain: null;
  /** The Keychain handed over the root key: refetch `identity`. */
  identity: null;
  eye: Eye;
  call: CallEvent;
  /** A new picture of a walk: fetch it with `frame(walk)`. */
  frame: FrameNote;
  /** A browser download started or ended: refetch `browsers`. */
  browser: null;
  /** A check for a release started or ended, or one is ready: refetch `updateStatus`. */
  update: null;
  /** A site's page changed hands: an agent asked for the owner, the owner took it or gave it back, it moved on. Refetch `hands`. */
  hands: { kind: "ask" | "held" | "given_back" | "lapsed" | "page" | "stopped"; site: string; url?: string; ask?: HandsAsk };
  /** A new picture of the watched page: fetch it with `frame(walk)`. */
  hands_frame: FrameNote;
  open: null;
};
