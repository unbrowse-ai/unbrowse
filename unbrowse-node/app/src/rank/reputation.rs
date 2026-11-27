//! Reputation from paid, passed uses (spec §5): which entry of a route is its default, which entries are unverified,
//! and which one gets an exploration pick. Every node computes it itself from the same chain events
//! (`chain::reputation_history`), read up to the chain's final block and counted over closed epochs only, so two nodes
//! that read one chain pick the same default and no node is trusted for a score.
//!
//! This is version 1 of the ranking function (R5.20). Its rules, as properties of the chain's own record:
//!
//! - **A use is a claimed line that passed, paid from a deposit.** Settlement claims only passed lines, each from its
//!   payer's deposit, so every claim on chain is a passed use.
//! - **A payer is linked to a contributor when the contributor reaches it.** That means it is the contributor, or the
//!   payment graph has a path from the contributor to it of at most `LINK_HOPS` edges (R5.18, R6.13). The edges are
//!   what the chain shows. A claimed line runs from its payer to the entry's contributor. USDC sent between two wallets
//!   Settlement knows runs from the sender to the receiver. An agent key runs both ways with each wallet that
//!   authorised it or paid through it. The use being judged runs from the payer to the contributor, the other way, so
//!   paying a stranger never links a payer to it. A contributor's money or keys reaching the payer do.
//! - **A payer's standing is earned only by paying strangers.** Its weight `w(j)` when it pays (R5.2) comes from its
//!   independent lines before that epoch: lines on entries of contributors it isn't linked to. It is zero for a payer
//!   with no record (§5 terms): fewer than `RECORD_LINES` such lines in the `RECORD_WINDOW` epochs before the use's
//!   epoch (`refund.min_lines`, `refund.window`; the old site and age counts were retired by spec §70). Otherwise it is
//!   the geometric mean of `x / (x + h)` over three things: the payer's age in epochs (h `AGE_HALF`), its spend in USDC
//!   (h `SPEND_HALF`) and its spread, the distinct routes and sites it paid for (h `SPREAD_HALF`). Each is increasing,
//!   and each must be there for any weight; `g`'s shape is the client's default while `rating.payer_weight` is OPEN. A
//!   ring that pays only itself earns no standing.
//! - **A passed use counts in shared reputation from any payer with standing** (R5.3), weighted by `w(j)`, unless the
//!   payer is serving a canary penalty or the line was a canary. Those sums are the entry's `P`, its pass rate and the
//!   incumbent default's evidence. **Switch evidence** (R5.18) is the same uses less those by payers linked to the
//!   entry's contributor: a challenger's `P_c` and `F_c`, and its counted uses. An entry with fewer than
//!   `UNVERIFIED_USES` counted uses is unverified (R3.36).
//! - **A failure counts only from a verified person** (R1.33, R5.4), at most once per person per route per epoch,
//!   weighted the same way, and in switch evidence only from one not linked to the contributor. No proof of
//!   personhood is chosen yet (R1.34), so the hook (`Personhood`) verifies nobody, and failures reach shared reputation
//!   from nobody. A failure this node saw demotes the entry in this node only, for `LOCAL_DEMOTION` (`Demoted`).
//! - **The pass rate** is `θ̂ = (a₀ + P) / (a₀ + b₀ + P + F)` (R5.16), with `P` and `F` each use's weight, decayed by
//!   `δ` per epoch (`decay`, a half-life of `HALF_LIFE` epochs). Volume enters only as evidence, never as a term.
//! - **The default** is a route's earliest live listing until a challenger shows `P(θ_c − θ_i > SWITCH_MARGIN) ≥
//!   SWITCH_CONFIDENCE` under the Beta posteriors, tested at every epoch (R5.17): any live entry may challenge, with no
//!   evidence floor, since the posterior already shrinks thin evidence. Ties keep the earlier listing. An entry that
//!   stops being live loses the default to the live entry with the best switch evidence, the earlier listing on a tie.
//! - **Exploration**: `EXPLORATION_SHARE` of read picks go to an unverified entry, chosen in proportion to its
//!   contributor's travelling pass rate (R3.4, R5.5): only uses on domains whose escrow a wallet other than the
//!   contributor claimed travel; uses on the contributor's own domain lift only its entries there, and uses on a
//!   domain nobody claimed count for nobody.
//! - **Canaries** are the disclosed operator's test calls (R5.8 to R5.10). A revealed set counts once its epoch has
//!   closed, when the operator committed to it first. A payer that passed a known-bad canary or failed a known-good one
//!   has no standing for `CANARY_PENALTY` epochs.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::time::Duration;

use alloy::primitives::{keccak256, Address, B256};

/// The ranking function's version (R5.20): two clients on the same version, reading the same chain, pick the same
/// default.
pub const VERSION: u32 = 1;
/// The Beta prior of the pass rate (R5.16, `ranking.prior_a`, `ranking.prior_b`).
pub const PRIOR_A: f64 = 2.0;
pub const PRIOR_B: f64 = 2.0;
/// What a challenger's pass rate must beat the default's by, and how sure the test must be (R5.17,
/// `ranking.switch_margin`, `ranking.switch_confidence`).
pub const SWITCH_MARGIN: f64 = 0.02;
pub const SWITCH_CONFIDENCE: f64 = 0.95;
/// How far along the payment graph a contributor's reach links a payer to it (R5.18, `ranking.link_hops`).
pub const LINK_HOPS: usize = 2;
/// Counted uses below which an entry is unverified (R3.36, `ranking.unverified_uses`).
pub const UNVERIFIED_USES: u64 = 30;
/// The share of read picks that go to an unverified entry (R3.4, `ranking.exploration_share`).
pub const EXPLORATION_SHARE: f64 = 0.05;
/// Epochs over which a use's weight halves (`rating.decay`: δ = 0.5^(1/7) ≈ 0.906 an epoch).
pub const HALF_LIFE: f64 = 7.0;
/// A payer with a record (§5 terms): at least `RECORD_LINES` paid lines over the last `RECORD_WINDOW` epochs
/// (`refund.min_lines`, `refund.window`).
pub const RECORD_LINES: u64 = 20;
pub const RECORD_WINDOW: u64 = 30;
/// Where each part of a payer's standing reaches half (`rating.payer_weight`): age in epochs, spend in USDC, spread in
/// distinct routes and sites paid for (R5.2).
pub const AGE_HALF: f64 = 7.0;
pub const SPEND_HALF: f64 = 0.5;
pub const SPREAD_HALF: f64 = 5.0;
/// Epochs a payer that misreported a canary has no standing (R5.10, `rating.canary_penalty`): the refund window.
pub const CANARY_PENALTY: u64 = 30;
/// Failures that count per verified person per route per epoch (R5.4, `rating.complaints_per_day`).
pub const COMPLAINTS_PER_DAY: usize = 1;
/// How long a failure that doesn't count in shared reputation demotes an entry in this node (`rating.local_demotion`).
pub const LOCAL_DEMOTION: Duration = Duration::from_secs(2 * 3600);
// One complaint per person per route per epoch is what `standings` keeps (`complained`).
const _: () = assert!(COMPLAINTS_PER_DAY == 1);
/// Cells of the grid the switch test integrates over: the margin is a whole number of them.
const GRID: usize = 5000;

/// δ: what a use's weight is multiplied by each epoch.
pub fn decay() -> f64 {
    0.5f64.powf(1.0 / HALF_LIFE)
}

/// What the chain shows about entries and their uses: the input every node reads the same way.
#[derive(Clone, Debug, Default)]
pub struct History {
    pub entries: Vec<Listed>,
    pub uses: Vec<Use>,
    pub links: Vec<Link>,
    /// Failed uses the chain shows: claimed lines whose event marks them failed. A failed line pays nobody and
    /// Settlement emits `Claimed` only for passed lines, so a failure of this Settlement never reaches the chain.
    pub failures: Vec<Failure>,
    /// The disclosed canary operator (R5.9): the platform.
    pub canary_operator: Option<Address>,
    pub canary_commitments: Vec<CanaryCommitment>,
    pub canary_reveals: Vec<CanaryReveal>,
    /// Each site whose domain's escrow was claimed (`Domains.EscrowClaimed`), and the wallet that claimed it: what
    /// decides where a contributor's reputation travels (R5.5). A site missing here is unclaimed.
    pub escrow_claimed: HashMap<String, Address>,
}

/// An entry as its listing put it on the chain.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub id: B256,
    pub contributor: Address,
    /// The registrable site its domain is on. With what it does, it names the route it is an entry of.
    pub site: String,
    /// What it does, in its contributor's words.
    pub what: String,
    /// Its contributor's fee, in USDC.
    pub fee: f64,
    /// Where its listing sits on the chain: its block, then its log's place in the block. On a tie, the earlier
    /// listing keeps the default (R5.17).
    pub listed_at: (u64, u64),
    pub listed_epoch: u64,
    /// The epoch it stopped being live in (delisted, or its contributor left), if it has.
    pub ended_epoch: Option<u64>,
}

/// A claimed line: a passed use, paid from the payer's deposit.
#[derive(Clone, Debug, PartialEq)]
pub struct Use {
    pub entry: B256,
    pub payer: Address,
    /// The agent key that signed the line's voucher.
    pub agent: Address,
    /// What it paid, in USDC.
    pub amount: f64,
    pub epoch: u64,
}

/// An edge of the payment graph that isn't a use.
#[derive(Clone, Debug, PartialEq)]
pub enum Link {
    /// USDC sent from one wallet Settlement knows to another.
    Sent { from: Address, to: Address },
    /// An agent key a wallet authorised: the key is the wallet's.
    Key { wallet: Address, agent: Address },
}

/// A payer's report that a use of an entry failed.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub entry: B256,
    pub payer: Address,
    pub epoch: u64,
}

/// The canary operator's commitment to an epoch's canary set, made before the epoch (R5.8).
#[derive(Clone, Debug, PartialEq)]
pub struct CanaryCommitment {
    pub epoch: u64,
    pub by: Address,
    pub hash: B256,
}

/// An epoch's canary set, revealed after the epoch closed.
#[derive(Clone, Debug, PartialEq)]
pub struct CanaryReveal {
    pub epoch: u64,
    pub by: Address,
    pub salt: B256,
    pub canaries: Vec<Canary>,
}

/// One canary: a fetch of a public route whose answer was known good or known bad, and what its payer reported.
#[derive(Clone, Debug, PartialEq)]
pub struct Canary {
    pub entry: B256,
    pub payer: Address,
    pub good: bool,
    pub passed: bool,
}

impl CanaryReveal {
    /// The hash the operator commits to before the epoch: Keccak-256 over the epoch (8 bytes, big-endian), the salt,
    /// then each canary's entry, payer, and known-good and passed bytes, in order.
    pub fn commitment(&self) -> B256 {
        let mut b = Vec::with_capacity(40 + self.canaries.len() * 54);
        b.extend_from_slice(&self.epoch.to_be_bytes());
        b.extend_from_slice(self.salt.as_slice());
        for c in &self.canaries {
            b.extend_from_slice(c.entry.as_slice());
            b.extend_from_slice(c.payer.as_slice());
            b.push(c.good as u8);
            b.push(c.passed as u8);
        }
        keccak256(b)
    }
}

impl Canary {
    /// Whether the payer reported it wrong: passed a known-bad answer, or failed a known-good one.
    pub fn misreported(&self) -> bool {
        self.good != self.passed
    }
}

/// Which payers are verified persons (R1.33). Which proofs count, and how a person is bound to a wallet, are OPEN
/// (R1.34): this is where they plug in.
pub trait Personhood {
    fn verified(&self, payer: Address) -> bool;
}

/// No proof of personhood is chosen yet: nobody is verified, so failures reach shared reputation from nobody.
pub struct NoProofYet;

impl Personhood for NoProofYet {
    fn verified(&self, _: Address) -> bool {
        false
    }
}

/// One entry's standing among its route's entries.
#[derive(Clone, Debug, PartialEq)]
pub struct Standing {
    pub entry: B256,
    pub contributor: Address,
    pub fee: f64,
    pub live: bool,
    pub counted_uses: u64,
    /// The decayed, weighted passes and failures (`P`, `F`).
    pub passes: f64,
    pub fails: f64,
    /// `θ̂`.
    pub pass_rate: f64,
    pub default: bool,
    pub unverified: bool,
    pub listed_at: (u64, u64),
}

/// A route's entries, the default first.
#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    pub site: String,
    pub what: String,
    pub default: Option<B256>,
    pub entries: Vec<Standing>,
}

/// Every route's standings at one epoch.
#[derive(Clone, Debug, Default)]
pub struct Standings {
    pub epoch: u64,
    pub routes: Vec<Route>,
    by_entry: HashMap<B256, (usize, usize)>,
    /// Each contributor's pooled passes and failures that may lift its entries (R5.5).
    contributors: HashMap<Address, Pooled>,
}

/// A contributor's reputation as it travels (R5.5): passes and failures on domains whose escrow another wallet
/// claimed, which lift its entries anywhere, and those on domains it claimed itself, which lift only its entries
/// there. Uses on a domain nobody claimed are in neither.
#[derive(Clone, Debug, Default)]
struct Pooled {
    travels: (f64, f64),
    own: HashMap<String, (f64, f64)>,
}

impl Standings {
    pub fn of(&self, entry: B256) -> Option<&Standing> {
        self.by_entry.get(&entry).map(|&(r, i)| &self.routes[r].entries[i])
    }

    /// Which route an entry is of, among `routes`, and its place in that route's order.
    pub fn place(&self, entry: B256) -> Option<(usize, usize)> {
        self.by_entry.get(&entry).copied()
    }

    #[cfg(test)]
    pub fn route_of(&self, entry: B256) -> Option<&Route> {
        self.by_entry.get(&entry).map(|&(r, _)| &self.routes[r])
    }

    /// Contributor `a`'s pass rate for an entry on `site` (R5.5): its passes and failures on domains whose escrow
    /// another wallet claimed, with those on `site` too when `a` claimed `site` itself. The prior's mean for one with
    /// no such evidence, so a new contributor still gets explored.
    pub fn contributor_rate(&self, a: Address, site: &str) -> f64 {
        let Some(c) = self.contributors.get(&a) else { return rate(0.0, 0.0) };
        let (p, f) = c.travels;
        let (op, of) = c.own.get(&site.to_lowercase()).copied().unwrap_or_default();
        rate(p + op, f + of)
    }
}

/// `θ̂` for `p` passes and `f` failures (R5.16): the Beta posterior's mean.
pub fn rate(p: f64, f: f64) -> f64 {
    (PRIOR_A + p) / (PRIOR_A + PRIOR_B + p + f)
}

/// `P(θ_c − θ_i > SWITCH_MARGIN)` for a challenger with passes and failures `c` against an incumbent with `i`, under
/// their Beta posteriors (R5.17). It integrates over a fixed grid, so every client gets the same number.
pub fn beats(c: (f64, f64), i: (f64, f64)) -> f64 {
    let m = (SWITCH_MARGIN * GRID as f64).round() as usize;
    let (pc, pi) = (mass(c), mass(i));
    let (mut below, mut total) = (0.0, 0.0);
    for k in m..GRID {
        let j = k - m;
        total += pc[k] * (below + 0.5 * pi[j]);
        below += pi[j];
    }
    total.clamp(0.0, 1.0)
}

/// The posterior's mass in each grid cell, summing to 1.
fn mass((p, f): (f64, f64)) -> Vec<f64> {
    let (a, b) = (PRIOR_A + p, PRIOR_B + f);
    let logs: Vec<f64> = (0..GRID)
        .map(|k| {
            let x = (k as f64 + 0.5) / GRID as f64;
            (a - 1.0) * x.ln() + (b - 1.0) * (1.0 - x).ln()
        })
        .collect();
    let top = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let cells: Vec<f64> = logs.iter().map(|l| (l - top).exp()).collect();
    let sum: f64 = cells.iter().sum();
    cells.into_iter().map(|c| c / sum).collect()
}

/// The route an entry is an entry of: its site and the words of what it does, in any order and case, as a goal
/// finds it (`unbrowse_learn::goal::words`).
fn route_key(site: &str, what: &str) -> (String, BTreeSet<String>) {
    (site.to_lowercase(), unbrowse_learn::goal::words(what))
}

/// The route `e` is an entry of. The chain keeps a hash of a site and none of the words, so an entry whose listing this
/// node hasn't read has neither here (`chain::reputation_history`): it stands alone until it does, or every such entry,
/// on every site, would be one route with one default.
fn route_of_entry(e: &Listed) -> (String, BTreeSet<String>) {
    match e.site.is_empty() && e.what.is_empty() {
        true => (String::new(), BTreeSet::from([format!("{:#x}", e.id)])),
        false => route_key(&e.site, &e.what),
    }
}

/// The payment graph: who each wallet reaches in one edge.
struct Graph(HashMap<Address, Vec<Address>>);

impl Graph {
    fn of(h: &History, contributor_of: &HashMap<B256, Address>) -> Graph {
        let mut out: HashMap<Address, BTreeSet<Address>> = HashMap::new();
        let mut edge = |a: Address, b: Address| {
            if a != b {
                out.entry(a).or_default().insert(b);
            }
        };
        for u in &h.uses {
            if let Some(&c) = contributor_of.get(&u.entry) {
                edge(u.payer, c);
            }
            edge(u.payer, u.agent);
            edge(u.agent, u.payer);
        }
        for l in &h.links {
            match *l {
                Link::Sent { from, to } => edge(from, to),
                Link::Key { wallet, agent } => {
                    edge(wallet, agent);
                    edge(agent, wallet);
                }
            }
        }
        Graph(out.into_iter().map(|(a, b)| (a, b.into_iter().collect())).collect())
    }

    /// Every wallet `from` reaches in at most `hops` edges, itself among them.
    fn within(&self, from: Address, hops: usize) -> HashSet<Address> {
        let mut seen = HashSet::from([from]);
        let mut queue = VecDeque::from([(from, 0)]);
        while let Some((a, d)) = queue.pop_front() {
            if d == hops {
                continue;
            }
            for &b in self.0.get(&a).into_iter().flatten() {
                if seen.insert(b) {
                    queue.push_back((b, d + 1));
                }
            }
        }
        seen
    }
}

/// Who each contributor reaches, worked out once per contributor.
struct Links {
    graph: Graph,
    near: HashMap<Address, HashSet<Address>>,
}

impl Links {
    fn linked(&mut self, payer: Address, contributor: Address) -> bool {
        let graph = &self.graph;
        self.near.entry(contributor).or_insert_with(|| graph.within(contributor, LINK_HOPS)).contains(&payer)
    }
}

/// A payer's independent lines so far.
#[derive(Default)]
struct Record {
    /// Lines by the epoch they were paid in: a record counts only the last `RECORD_WINDOW` epochs.
    lines: BTreeMap<u64, u64>,
    spend: f64,
    /// The distinct sites and routes it paid for (R5.2's spread).
    sites: HashSet<String>,
    routes: HashSet<usize>,
    first: Option<u64>,
}

impl Record {
    /// Whether the payer has a record at `epoch` (§5 terms): at least `RECORD_LINES` lines in the `RECORD_WINDOW`
    /// epochs before it.
    fn has_record(&self, epoch: u64) -> bool {
        self.lines.range(epoch.saturating_sub(RECORD_WINDOW)..epoch).map(|(_, n)| n).sum::<u64>() >= RECORD_LINES
    }

    /// `w(j)` at `epoch` (R5.2): zero without a record, else the geometric mean of its age, spend and spread (distinct
    /// routes and sites paid for), each as `x / (x + h)`.
    fn weight(&self, epoch: u64) -> f64 {
        let Some(first) = self.first else { return 0.0 };
        if !self.has_record(epoch) {
            return 0.0;
        }
        let age = epoch.saturating_sub(first);
        let spread = (self.routes.len() + self.sites.len()) as f64;
        let s = |x: f64, h: f64| x / (x + h);
        (s(age as f64, AGE_HALF) * s(self.spend, SPEND_HALF) * s(spread, SPREAD_HALF)).cbrt()
    }
}

/// Every route's standings at epoch `now`, from history `h`, with `people` saying who is a verified person.
pub fn standings(h: &History, now: u64, people: &dyn Personhood) -> Standings {
    let entries = &h.entries;
    let index: HashMap<B256, usize> = entries.iter().enumerate().map(|(i, e)| (e.id, i)).collect();
    let contributor_of: HashMap<B256, Address> = entries.iter().map(|e| (e.id, e.contributor)).collect();
    let mut links = Links { graph: Graph::of(h, &contributor_of), near: HashMap::new() };

    // Canary sets count once their epoch has closed, from the disclosed operator, matching the first commitment it
    // made for that epoch.
    let mut committed: BTreeMap<u64, B256> = BTreeMap::new();
    for c in &h.canary_commitments {
        if Some(c.by) == h.canary_operator {
            committed.entry(c.epoch).or_insert(c.hash);
        }
    }
    let mut canary_lines: HashSet<(Address, B256, u64)> = HashSet::new();
    let mut misreported: HashMap<Address, Vec<u64>> = HashMap::new();
    let mut revealed: HashSet<u64> = HashSet::new();
    for r in &h.canary_reveals {
        let counts = Some(r.by) == h.canary_operator && r.epoch < now && committed.get(&r.epoch) == Some(&r.commitment());
        if !counts || !revealed.insert(r.epoch) {
            continue;
        }
        for c in &r.canaries {
            canary_lines.insert((c.payer, c.entry, r.epoch));
            if c.misreported() {
                misreported.entry(c.payer).or_default().push(r.epoch);
            }
        }
    }
    let penalised = |payer: Address, epoch: u64| misreported.get(&payer).is_some_and(|at| at.iter().any(|&m| m <= epoch && epoch < m + CANARY_PENALTY));

    // The routes: entries grouped by site and the words of what they do, in listing order.
    let mut keys: Vec<(String, BTreeSet<String>)> = Vec::new();
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut route_of = vec![0usize; entries.len()];
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by_key(|&i| (entries[i].listed_at, entries[i].id));
    for &i in &order {
        let key = route_of_entry(&entries[i]);
        let r = match keys.iter().position(|k| *k == key) {
            Some(r) => r,
            None => {
                keys.push(key);
                members.push(Vec::new());
                keys.len() - 1
            }
        };
        members[r].push(i);
        route_of[i] = r;
    }

    // The evidence, epoch by epoch, in one order whatever order the chain's logs came in: the weights and sums are the
    // same on every node.
    let mut uses: Vec<&Use> = h.uses.iter().filter(|u| index.contains_key(&u.entry)).collect();
    uses.sort_by(|a, b| (a.epoch, a.entry, a.payer, a.agent).cmp(&(b.epoch, b.entry, b.payer, b.agent)).then(a.amount.total_cmp(&b.amount)));
    let mut failures: Vec<&Failure> = h.failures.iter().filter(|f| index.contains_key(&f.entry)).collect();
    failures.sort_by_key(|f| (f.epoch, f.entry, f.payer));
    let mut records: HashMap<Address, Record> = HashMap::new();
    // epoch => (entry, weight, whether its payer isn't linked to the entry's contributor) for each use that counts in
    // shared reputation (R5.3), and for each failure that does (R5.4). The unlinked ones are also switch evidence
    // (R5.18).
    let mut passes_in: BTreeMap<u64, Vec<(usize, f64, bool)>> = BTreeMap::new();
    let mut fails_in: BTreeMap<u64, Vec<(usize, f64, bool)>> = BTreeMap::new();
    let (mut u, mut f) = (0, 0);
    let mut complained: HashSet<(Address, usize, u64)> = HashSet::new();
    while u < uses.len() || f < failures.len() {
        let epoch = match (uses.get(u), failures.get(f)) {
            (Some(a), Some(b)) => a.epoch.min(b.epoch),
            (Some(a), None) => a.epoch,
            (None, Some(b)) => b.epoch,
            (None, None) => break,
        };
        // Weights come from the record before this epoch; this epoch's lines join the record after.
        let mut joining = Vec::new();
        while let Some(x) = uses.get(u).filter(|x| x.epoch == epoch) {
            let i = index[&x.entry];
            let independent = !links.linked(x.payer, entries[i].contributor);
            let w = records.get(&x.payer).map_or(0.0, |r| r.weight(epoch));
            let canary = canary_lines.contains(&(x.payer, x.entry, epoch));
            if w > 0.0 && !canary && !penalised(x.payer, epoch) {
                passes_in.entry(epoch).or_default().push((i, w, independent));
            }
            if independent && !canary {
                joining.push((x.payer, x.amount, entries[i].site.clone(), route_of[i]));
            }
            u += 1;
        }
        while let Some(x) = failures.get(f).filter(|x| x.epoch == epoch) {
            let i = index[&x.entry];
            let w = records.get(&x.payer).map_or(0.0, |r| r.weight(epoch));
            let counts = people.verified(x.payer) && w > 0.0 && !penalised(x.payer, epoch) && complained.insert((x.payer, route_of[i], epoch));
            if counts {
                let independent = !links.linked(x.payer, entries[i].contributor);
                fails_in.entry(epoch).or_default().push((i, w, independent));
            }
            f += 1;
        }
        for (payer, amount, site, route) in joining {
            let r = records.entry(payer).or_default();
            *r.lines.entry(epoch).or_default() += 1;
            r.spend += amount;
            r.sites.insert(site);
            r.routes.insert(route);
            r.first.get_or_insert(epoch);
        }
    }

    // Replayed epoch by epoch, so the default's history is the chain's, not this node's: each epoch the evidence of
    // the one before it enters, decayed with the rest, and the default is tested.
    let delta = decay();
    let n = entries.len();
    // Shared reputation from every payer (R5.3), and the switch evidence from payers not linked to the contributor
    // (R5.18), with the uses it counts (R3.36).
    let (mut p, mut fl) = (vec![0.0f64; n], vec![0.0f64; n]);
    let (mut pu, mut fu, mut counted) = (vec![0.0f64; n], vec![0.0f64; n], vec![0u64; n]);
    let mut default: Vec<Option<usize>> = vec![None; keys.len()];
    let start = entries.iter().map(|e| e.listed_epoch).chain(uses.iter().map(|u| u.epoch)).chain(failures.iter().map(|f| f.epoch)).min();
    let live_at = |i: usize, e: u64| entries[i].listed_epoch <= e && entries[i].ended_epoch.is_none_or(|x| e < x);
    if let Some(start) = start.filter(|&s| s <= now) {
        for e in start..=now {
            for x in p.iter_mut().chain(fl.iter_mut()).chain(pu.iter_mut()).chain(fu.iter_mut()) {
                *x *= delta;
            }
            if let Some(closed) = e.checked_sub(1) {
                for &(i, w, unlinked) in passes_in.get(&closed).into_iter().flatten() {
                    p[i] += w;
                    if unlinked {
                        pu[i] += w;
                        counted[i] += 1;
                    }
                }
                for &(i, w, unlinked) in fails_in.get(&closed).into_iter().flatten() {
                    fl[i] += w;
                    if unlinked {
                        fu[i] += w;
                    }
                }
            }
            for (r, d) in default.iter_mut().enumerate() {
                let live: Vec<usize> = members[r].iter().copied().filter(|&i| live_at(i, e)).collect();
                *d = next_default(*d, &live, (&p, &fl), (&pu, &fu));
            }
        }
    }

    // Where each contributor's reputation travels (R5.5): from a domain another wallet claimed, to its entries on
    // every site; from its own domain, to its entries there only; from an unclaimed domain, nowhere.
    let mut contributors: HashMap<Address, Pooled> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        let site = e.site.to_lowercase();
        let Some(&claimant) = h.escrow_claimed.get(&site) else { continue };
        let c = contributors.entry(e.contributor).or_default();
        let into = if claimant == e.contributor { c.own.entry(site).or_default() } else { &mut c.travels };
        into.0 += p[i];
        into.1 += fl[i];
    }
    let mut routes = Vec::with_capacity(keys.len());
    let mut by_entry = HashMap::new();
    for (r, key) in keys.iter().enumerate() {
        let mut standing: Vec<Standing> = members[r]
            .iter()
            .map(|&i| {
                let e = &entries[i];
                Standing {
                    entry: e.id,
                    contributor: e.contributor,
                    fee: e.fee,
                    live: live_at(i, now),
                    counted_uses: counted[i],
                    passes: p[i],
                    fails: fl[i],
                    pass_rate: rate(p[i], fl[i]),
                    default: default[r] == Some(i),
                    unverified: counted[i] < UNVERIFIED_USES,
                    listed_at: e.listed_at,
                }
            })
            .collect();
        standing.sort_by(shown_order);
        for (k, s) in standing.iter().enumerate() {
            by_entry.insert(s.entry, (r, k));
        }
        let first = &entries[members[r][0]];
        routes.push(Route { site: key.0.clone(), what: first.what.clone(), default: default[r].map(|i| entries[i].id), entries: standing });
    }
    Standings { epoch: now, routes, by_entry, contributors }
}

/// The order a route's entries are shown and tried in: the default, then the live ones, then by pass rate, counted
/// uses, fee and listing.
fn shown_order(a: &Standing, b: &Standing) -> std::cmp::Ordering {
    b.default
        .cmp(&a.default)
        .then(b.live.cmp(&a.live))
        .then(b.pass_rate.total_cmp(&a.pass_rate))
        .then(b.counted_uses.cmp(&a.counted_uses))
        .then(a.fee.total_cmp(&b.fee))
        .then(a.listed_at.cmp(&b.listed_at))
}

/// The default after one epoch's test (R5.17), given the route's live entries in listing order, each entry's shared
/// evidence `all` (R5.3) and its switch evidence `unlinked` (R5.18). Any live entry may challenge: the incumbent keeps
/// the default unless a challenger's switch evidence beats the incumbent's evidence by the margin at the test's
/// confidence, and the most confident such challenger takes it. With no live incumbent (a new route, or a default that
/// stopped being live), the live entry with the best switch evidence takes it, the earlier listing on a tie, so a new
/// route's default is its earliest listing.
fn next_default(incumbent: Option<usize>, live: &[usize], all: (&[f64], &[f64]), unlinked: (&[f64], &[f64])) -> Option<usize> {
    let (pa, fa) = all;
    let (pu, fu) = unlinked;
    let best_by_rate = || live.iter().copied().fold(None, |best: Option<usize>, i| match best {
        Some(b) if rate(pu[b], fu[b]) >= rate(pu[i], fu[i]) => Some(b),
        _ => Some(i),
    });
    let Some(i) = incumbent.filter(|i| live.contains(i)) else { return best_by_rate() };
    let held = (pa[i], fa[i]);
    let mut winner: Option<(usize, f64)> = None;
    for &c in live {
        // A challenger whose pass rate isn't above the default's can't be ahead of it by the margin.
        if c == i || rate(pu[c], fu[c]) <= rate(held.0, held.1) {
            continue;
        }
        let sure = beats((pu[c], fu[c]), held);
        if sure >= SWITCH_CONFIDENCE && winner.is_none_or(|(_, w)| sure > w) {
            winner = Some((c, sure));
        }
    }
    Some(winner.map_or(i, |(c, _)| c))
}

/// A candidate's order in a pick, and whether an exploration pick put an unverified entry first.
pub struct Pick<T> {
    pub order: Vec<T>,
    pub explored: Option<B256>,
}

/// How a candidate is known to a pick: its entry, its contributor, the registrable site it is on, and its fee.
pub struct Candidate {
    pub entry: B256,
    pub contributor: Address,
    pub site: String,
    pub fee: f64,
}

/// The order to try `found` in for one goal (R3.4, R3.8, R5.4): the route's default first, then the rest as they're
/// shown. For a goal that only reads, `draws.0` below `EXPLORATION_SHARE` puts one unverified entry first instead,
/// chosen by `draws.1` in proportion to its contributor's pass rate for its site (R5.5, `contributor_rate`), when there
/// is a verified entry to explore away from. An entry demoted here (`demoted`) goes last, whatever it is. An entry the chain doesn't show yet is
/// unverified, with no evidence.
pub fn order<T>(s: &Standings, found: Vec<T>, of: impl Fn(&T) -> Candidate, reads: bool, draws: (f64, f64), demoted: impl Fn(B256) -> bool) -> Pick<T> {
    let standing = |c: &Candidate| {
        s.of(c.entry).cloned().unwrap_or(Standing {
            entry: c.entry,
            contributor: c.contributor,
            fee: c.fee,
            live: true,
            counted_uses: 0,
            passes: 0.0,
            fails: 0.0,
            pass_rate: rate(0.0, 0.0),
            default: false,
            unverified: true,
            listed_at: (u64::MAX, u64::MAX),
        })
    };
    let mut ranked: Vec<(Standing, String, T)> = found
        .into_iter()
        .map(|t| {
            let c = of(&t);
            let mut st = standing(&c);
            // The fee a candidate is offered at now is the one it costs.
            st.fee = c.fee;
            (st, c.site, t)
        })
        .collect();
    ranked.sort_by(|a, b| shown_order(&a.0, &b.0));
    let mut explored = None;
    let some_verified = ranked.iter().any(|(st, _, _)| !st.unverified);
    let unverified: Vec<usize> = (0..ranked.len()).filter(|&k| ranked[k].0.unverified).collect();
    if reads && draws.0 < EXPLORATION_SHARE && some_verified && !unverified.is_empty() {
        let weights: Vec<f64> = unverified.iter().map(|&k| s.contributor_rate(ranked[k].0.contributor, &ranked[k].1)).collect();
        let total: f64 = weights.iter().sum();
        let mut at = draws.1.clamp(0.0, 1.0) * total;
        let mut chosen = *unverified.last().unwrap();
        for (k, w) in unverified.iter().zip(&weights) {
            if at < *w {
                chosen = *k;
                break;
            }
            at -= w;
        }
        let picked = ranked.remove(chosen);
        explored = Some(picked.0.entry);
        ranked.insert(0, picked);
    }
    let (fresh, failed): (Vec<_>, Vec<_>) = ranked.into_iter().partition(|(st, _, _)| !demoted(st.entry));
    if explored.is_some_and(&demoted) {
        explored = None;
    }
    Pick { order: fresh.into_iter().chain(failed).map(|(_, _, t)| t).collect(), explored }
}

/// Two numbers in [0, 1) for a pick: whether it explores, and which unverified entry.
pub fn draws() -> (f64, f64) {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the OS gives no randomness");
    let unit = |x: [u8; 8]| (u64::from_le_bytes(x) >> 11) as f64 / (1u64 << 53) as f64;
    (unit(b[..8].try_into().unwrap()), unit(b[8..].try_into().unwrap()))
}

/// Entries that failed in this node, and when, in seconds (R5.4): a failure that doesn't count in shared reputation
/// demotes the entry here only, for `LOCAL_DEMOTION`. Kept under the node's home like the dark set, so a restart inside
/// those two hours doesn't pick the entry first again.
#[derive(Clone, Debug, Default)]
pub struct Demoted {
    entries: HashMap<B256, u64>,
    /// The file they are kept in, if any.
    kept: Option<std::path::PathBuf>,
}

/// One demotion, as the file keeps it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct KeptDemotion {
    entry: B256,
    at: u64,
}

impl Demoted {
    /// The demotions kept at `path` (`unbrowse_net::load_kept`), saved there on every change.
    pub fn open(path: std::path::PathBuf) -> Demoted {
        let entries = unbrowse_net::load_kept::<KeptDemotion>(&path, &unbrowse_files::DEMOTED).into_iter().map(|k| (k.entry, k.at)).collect();
        Demoted { entries, kept: Some(path) }
    }

    /// `entry` failed at `now`. Those whose time has run out go, so the file holds two hours of failures.
    pub fn demote(&mut self, entry: B256, now: u64) {
        self.entries.retain(|_, at| now.saturating_sub(*at) < LOCAL_DEMOTION.as_secs());
        self.entries.insert(entry, now);
        let Some(path) = &self.kept else { return };
        let items: Vec<KeptDemotion> = self.entries.iter().map(|(e, at)| KeptDemotion { entry: *e, at: *at }).collect();
        unbrowse_net::save_kept(path, &unbrowse_files::DEMOTED, &items);
    }

    pub fn demoted(&self, entry: B256, now: u64) -> bool {
        self.entries.get(&entry).is_some_and(|at| now.saturating_sub(*at) < LOCAL_DEMOTION.as_secs())
    }
}

/// Test only: a history in which `entries` of one route are listed in order at epoch 1, and forty payers with records
/// use `default` in epochs 5 to 10, so it takes the default from the earliest listing by epoch 11 (R5.17).
#[cfg(test)]
pub(crate) fn history_with_default(site: &str, what: &str, entries: &[(B256, Address)], default: B256) -> History {
    let at = |n: u64| Address::from_word(B256::from(alloy::primitives::U256::from(n)));
    let mut h = History::default();
    let mut list = |id: B256, contributor: Address, site: &str, what: &str, n: u64| {
        h.entries.push(Listed { id, contributor, site: site.into(), what: what.into(), fee: 0.01, listed_at: (n, 0), listed_epoch: 1, ended_epoch: None })
    };
    let strangers: Vec<B256> = (0..3u64).map(|k| B256::from(alloy::primitives::U256::from(900 + k))).collect();
    for (k, id) in strangers.iter().enumerate() {
        list(*id, at(90 + k as u64), &format!("{k}.stranger.example"), "list things", k as u64);
    }
    for (k, (id, contributor)) in entries.iter().enumerate() {
        list(*id, *contributor, site, what, 10 + k as u64);
    }
    for j in 10_000..10_040u64 {
        let agent = at(j + 1_000_000);
        for e in 0..3 {
            for k in 0..7 {
                h.uses.push(Use { entry: strangers[k % 3], payer: at(j), agent, amount: 0.01, epoch: e });
            }
        }
        for e in 5..=10 {
            h.uses.push(Use { entry: default, payer: at(j), agent, amount: 0.01, epoch: e });
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(n: u64) -> Address {
        Address::from_word(B256::from(alloy::primitives::U256::from(n)))
    }

    fn id(n: u64) -> B256 {
        B256::from(alloy::primitives::U256::from(n))
    }

    /// A chain history built step by step, as a test scripts it.
    #[derive(Default)]
    struct Script {
        h: History,
        next: u64,
    }

    const FEE: f64 = 0.01;
    /// Payers count from here, contributors below.
    const PAYERS: u64 = 10_000;

    impl Script {
        fn list(&mut self, entry: u64, contributor: u64, site: &str, what: &str, epoch: u64) -> B256 {
            self.next += 1;
            self.h.entries.push(Listed {
                id: id(entry),
                contributor: wallet(contributor),
                site: site.into(),
                what: what.into(),
                fee: FEE,
                listed_at: (epoch * 1000 + self.next, 0),
                listed_epoch: epoch,
                ended_epoch: None,
            });
            id(entry)
        }

        fn pay(&mut self, payer: u64, entry: B256, epoch: u64) {
            // Each payer signs with an agent key of its own.
            self.h.uses.push(Use { entry, payer: wallet(payer), agent: wallet(payer + 1_000_000), amount: FEE, epoch });
        }

        /// Three strangers' entries on three sites, which payers build their records on.
        fn strangers(&mut self) -> [B256; 3] {
            [self.list(901, 91, "a.example", "list news", 0), self.list(902, 92, "b.example", "list jobs", 0), self.list(903, 93, "c.example", "list films", 0)]
        }

        /// Payers `from..to` each build a record on the strangers' entries in epochs 0 to 2: 21 lines, 3 sites.
        fn honest_payers(&mut self, from: u64, to: u64) {
            let s = self.strangers_or_list();
            for j in from..to {
                for e in 0..3 {
                    for k in 0..7 {
                        self.pay(j, s[k % 3], e);
                    }
                }
            }
        }

        fn strangers_or_list(&mut self) -> [B256; 3] {
            if self.h.entries.iter().any(|e| e.id == id(901)) {
                [id(901), id(902), id(903)]
            } else {
                self.strangers()
            }
        }

        fn at(&self, epoch: u64) -> Standings {
            standings(&self.h, epoch, &NoProofYet)
        }
    }

    /// The chain keeps a hash of an entry's site and none of its words, so an entry this node read no listing of has no
    /// name here. Two of those on different sites aren't one route: they would compete for one default, and the first
    /// listed would stand in for every entry nobody here has read.
    #[test]
    fn entries_with_no_listing_read_are_never_one_route() {
        let mut t = Script::default();
        let (a, b) = (t.list(1, 1, "", "", 1), t.list(2, 2, "", "", 1));
        let s = standings(&t.h, 5, &NoProofYet);
        assert_eq!(s.routes.len(), 2);
        assert_ne!(s.route_of(a).map(|r| r.entries[0].entry), s.route_of(b).map(|r| r.entries[0].entry));
    }

    fn default_of(s: &Standings, entry: B256) -> Option<B256> {
        s.route_of(entry).and_then(|r| r.default)
    }

    #[test]
    fn the_default_follows_passed_independent_use() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        let y = s.list(2, 2, "shop.example", "Search ITEMS", 2);
        // X is used by forty independent payers in epochs 5 to 10.
        for e in 5..=10 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, x, e);
            }
        }
        let early = s.at(5);
        assert_eq!(default_of(&early, x), Some(x), "the earliest listing is the default before any evidence (R5.17)");
        assert!(early.of(x).unwrap().unverified && early.of(y).unwrap().unverified);
        let s11 = s.at(11);
        assert_eq!(default_of(&s11, x), Some(x), "and keeps it while it is used");
        assert_eq!(s11.route_of(x).unwrap().entries[0].entry, x, "and is shown first");
        assert!(!s11.of(x).unwrap().unverified && s11.of(y).unwrap().unverified);
        // X breaks: from epoch 11 the same payers use Y instead.
        for e in 11..=60 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, y, e);
            }
        }
        let s13 = s.at(13);
        assert!(!s13.of(y).unwrap().unverified, "Y is past the floor");
        assert_eq!(default_of(&s13, x), Some(x), "the incumbent keeps the default until the test is sure");
        let switched = (12..=60).find(|&e| default_of(&s.at(e), x) == Some(y)).expect("Y takes the default as X's evidence decays and Y's grows");
        println!("Y became the default at epoch {switched}");
        let last = s.at(61);
        assert_eq!(default_of(&last, x), Some(y));
        assert_eq!(last.route_of(x).unwrap().entries[0].entry, y, "the default is shown first");
        assert!(last.of(y).unwrap().pass_rate > last.of(x).unwrap().pass_rate);
    }

    #[test]
    fn a_sybil_ring_paying_itself_does_not_move_the_default() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        for e in 5..=60 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, x, e);
            }
        }
        let y = s.list(2, 2, "shop.example", "search items", 2);
        let before = s.at(61);
        assert_eq!(default_of(&before, x), Some(x));

        // The challenger's contributor (wallet 2) runs a ring of 300 wallets three ways at once.
        let ring = 50_000u64;
        // a. Wallets it funded, which build records on the ring's own entries on three sites and pay Y.
        let ring_sites = [s.list(801, 2, "r1.example", "list a", 1), s.list(802, 2, "r2.example", "list b", 1), s.list(803, 2, "r3.example", "list c", 1)];
        for j in ring..ring + 100 {
            s.h.links.push(Link::Sent { from: wallet(2), to: wallet(j) });
        }
        // b. Wallets funded through a go-between it funded: two hops.
        s.h.links.push(Link::Sent { from: wallet(2), to: wallet(777) });
        for j in ring + 100..ring + 200 {
            s.h.links.push(Link::Sent { from: wallet(777), to: wallet(j) });
        }
        // c. Wallets that pay each other's entries, and Y, with keys the contributor authorised.
        for j in ring + 200..ring + 300 {
            s.h.links.push(Link::Key { wallet: wallet(2), agent: wallet(j + 1_000_000) });
        }
        for j in ring..ring + 300 {
            for e in 10..13 {
                for k in 0..7 {
                    s.pay(j, ring_sites[k % 3], e);
                }
            }
            for e in 14..=60 {
                for _ in 0..5 {
                    s.pay(j, y, e);
                }
            }
        }
        // d. And the contributor pays its own entry.
        for e in 14..=60 {
            for _ in 0..100 {
                s.pay(2, y, e);
            }
        }
        let after = s.at(61);
        assert_eq!(default_of(&after, x), Some(x), "the ring doesn't move the default");
        assert_eq!(after.of(y).unwrap().counted_uses, 0, "none of its uses count");
        assert!(after.of(y).unwrap().unverified);
        assert_eq!(after.of(x).unwrap().counted_uses, before.of(x).unwrap().counted_uses, "nor do they touch the default's evidence");
        // Its wallets have no standing to lend elsewhere either: their lines were all on entries of the contributor
        // that reaches them.
        let z = s.list(3, 3, "shop.example", "search items", 61);
        for e in 61..=64 {
            for j in ring..ring + 300 {
                s.pay(j, z, e);
            }
        }
        assert_eq!(s.at(65).of(z).unwrap().counted_uses, 0, "a ring's wallets earn no standing by paying themselves");
    }

    #[test]
    fn paying_a_stranger_never_links_a_payer_to_it() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 30);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        for e in 5..=6 {
            for j in PAYERS..PAYERS + 30 {
                s.pay(j, x, e);
            }
        }
        assert_eq!(s.at(7).of(x).unwrap().counted_uses, 60, "each payer's line on the entry runs from it to the contributor, never back");
    }

    #[test]
    fn a_payer_with_no_record_counts_for_nothing() {
        let mut s = Script::default();
        let x = s.list(1, 1, "shop.example", "search items", 0);
        // One line an epoch for 19 epochs: under 20 lines in the window, so no record yet.
        for e in 0..19 {
            for j in PAYERS..PAYERS + 50 {
                s.pay(j, x, e);
            }
        }
        let st = s.at(20);
        assert_eq!(st.of(x).unwrap().counted_uses, 0);
        assert_eq!(st.of(x).unwrap().pass_rate, rate(0.0, 0.0));
    }

    /// A payer with a record has at least 20 paid lines over the last 30 epochs (§5 terms, `refund.min_lines`,
    /// `refund.window`), on one site or many and however recently it began: the old site and age counts are retired
    /// (spec §70). Lines older than the window stop counting.
    #[test]
    fn a_record_is_twenty_paid_lines_in_the_last_thirty_epochs() {
        let mut s = Script::default();
        let a = s.list(901, 91, "a.example", "list news", 0);
        let x = s.list(1, 1, "shop.example", "search items", 0);
        // Twenty lines on one site in one epoch: a record from the next epoch on.
        for j in PAYERS..PAYERS + 10 {
            for _ in 0..RECORD_LINES {
                s.pay(j, a, 0);
            }
            s.pay(j, x, 1);
        }
        assert_eq!(s.at(2).of(x).unwrap().counted_uses, 10, "one site and one epoch are enough");
        // Thirty epochs on, those lines are out of the window: a use then counts for nothing.
        let mut late = Script { h: s.h.clone(), next: s.next };
        for j in PAYERS..PAYERS + 10 {
            late.pay(j, x, RECORD_WINDOW + 1);
        }
        assert_eq!(late.at(RECORD_WINDOW + 2).of(x).unwrap().counted_uses, 10, "the late uses add nothing");
        // Nineteen lines in the window are not a record.
        let mut short = Script::default();
        let a = short.list(901, 91, "a.example", "list news", 0);
        let x = short.list(1, 1, "shop.example", "search items", 0);
        for j in PAYERS..PAYERS + 10 {
            for _ in 0..RECORD_LINES - 1 {
                short.pay(j, a, 0);
            }
            short.pay(j, x, 1);
        }
        assert_eq!(short.at(2).of(x).unwrap().counted_uses, 0);
    }

    /// A payer's spread is the distinct routes and sites it paid for (R5.2): two routes on one site weigh more than
    /// one.
    #[test]
    fn spread_counts_routes_as_well_as_sites() {
        let one = Record { lines: [(0, 20)].into(), spend: 0.2, sites: ["a.example".to_string()].into(), routes: [0].into(), first: Some(0) };
        let two = Record { routes: [0, 1].into(), ..Record { lines: [(0, 20)].into(), spend: 0.2, sites: ["a.example".to_string()].into(), routes: HashSet::new(), first: Some(0) } };
        assert!(one.weight(1) > 0.0);
        assert!(two.weight(1) > one.weight(1), "{} vs {}", two.weight(1), one.weight(1));
    }

    /// A passed line counts in shared reputation from any payer with a record (R5.3), linked or not; only switch
    /// evidence leaves out payers linked to the challenger's contributor (R5.18), so their uses never move the default
    /// nor count towards leaving unverified (R3.36).
    #[test]
    fn a_linked_payer_lifts_the_pass_rate_but_never_the_switch() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        let y = s.list(2, 2, "shop.example", "search items", 1);
        // Y's contributor funded every payer, so each is linked to Y, not to X; they use only Y.
        for j in PAYERS..PAYERS + 40 {
            s.h.links.push(Link::Sent { from: wallet(2), to: wallet(j) });
        }
        for e in 5..=20 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, y, e);
            }
        }
        let st = s.at(21);
        let sy = st.of(y).unwrap();
        assert!(sy.passes > 0.0 && sy.pass_rate > rate(0.0, 0.0), "linked payers' passes count in shared reputation");
        assert_eq!(sy.counted_uses, 0, "but not as switch evidence");
        assert!(sy.unverified);
        assert_eq!(default_of(&st, x), Some(x), "so Y never takes the default");
    }

    /// Any live entry may challenge the default (R5.17): with no evidence floor, a challenger with fewer than 30
    /// counted uses takes the default as soon as the test is sure, and a new route's default is its earliest listing.
    #[test]
    fn a_challenger_needs_no_evidence_floor_to_switch() {
        let mut s = Script::default();
        let x = s.list(1, 1, "shop.example", "search items", 1);
        s.list(2, 2, "shop.example", "search items", 1);
        assert_eq!(default_of(&s.at(1), x), Some(x), "the earliest listing, with no evidence at all");
        // Twenty passes of weight one for the challenger, none for the incumbent: under the old floor of 30.
        let (p, f) = (vec![0.0, 20.0], vec![0.0, 0.0]);
        assert!(beats((20.0, 0.0), (0.0, 0.0)) >= SWITCH_CONFIDENCE);
        assert_eq!(next_default(Some(0), &[0, 1], (&p, &f), (&p, &f)), Some(1), "the test alone decides");
        // Switch evidence is the challenger's unlinked evidence only (R5.18): the same passes from linked payers move
        // nothing.
        let none = vec![0.0, 0.0];
        assert_eq!(next_default(Some(0), &[0, 1], (&p, &f), (&none, &f)), Some(0));
    }

    /// Reputation travels (R5.5) only from domains whose escrow a wallet other than the contributor claimed. Uses on
    /// its own domain lift only its entries there; uses on a domain nobody claimed lift none.
    #[test]
    fn reputation_travels_only_from_domains_another_wallet_claimed() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let claimed = s.list(1, 1, "claimed.example", "list a", 1);
        let own = s.list(2, 1, "own.example", "list b", 1);
        let open = s.list(3, 1, "open.example", "list c", 1);
        for e in 5..=10 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, claimed, e);
                s.pay(j, own, e);
                s.pay(j, open, e);
            }
        }
        let prior = rate(0.0, 0.0);
        assert_eq!(s.at(11).contributor_rate(wallet(1), "elsewhere.example"), prior, "no domain claimed: nothing travels");
        s.h.escrow_claimed.insert("claimed.example".into(), wallet(77));
        s.h.escrow_claimed.insert("own.example".into(), wallet(1));
        let st = s.at(11);
        let (p, f) = (st.of(claimed).unwrap().passes, st.of(claimed).unwrap().fails);
        assert_eq!(st.contributor_rate(wallet(1), "elsewhere.example"), rate(p, f), "only the domain another wallet claimed travels");
        let (op, of) = (st.of(own).unwrap().passes, st.of(own).unwrap().fails);
        assert_eq!(st.contributor_rate(wallet(1), "own.example"), rate(p + op, f + of), "its own domain lifts its entries there");
        assert!(st.of(open).unwrap().passes > 0.0, "the unclaimed domain's uses are real, and travel nowhere");
    }

    #[test]
    fn unverified_entries_still_get_explored() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        let y = s.list(2, 2, "shop.example", "search items", 2);
        let z = s.list(3, 3, "shop.example", "search items", 2);
        for e in 5..=10 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, x, e);
            }
        }
        let st = s.at(11);
        assert_eq!(default_of(&st, x), Some(x));
        let found = || vec![(z, wallet(3)), (y, wallet(2)), (x, wallet(1))];
        let of = |t: &(B256, Address)| Candidate { entry: t.0, contributor: t.1, site: "shop.example".into(), fee: FEE };
        // A fixed sequence of draws, so the test always sees the same picks.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut firsts, n) = (HashMap::<B256, u32>::new(), 20_000);
        for _ in 0..n {
            let p = order(&st, found(), of, true, (next(), next()), |_| false);
            *firsts.entry(p.order[0].0).or_default() += 1;
            assert_eq!(p.explored.is_some(), p.order[0].0 != x);
            assert_eq!(p.order.len(), 3, "every entry stays a candidate");
        }
        let explored = (firsts.get(&y).copied().unwrap_or(0) + firsts.get(&z).copied().unwrap_or(0)) as f64 / n as f64;
        assert!((explored - EXPLORATION_SHARE).abs() < 0.01, "about 5% of read picks explore: {explored}");
        assert!(firsts.get(&y).copied().unwrap_or(0) > 0 && firsts.get(&z).copied().unwrap_or(0) > 0, "each unverified entry is explored: {firsts:?}");
        // A goal that changes something never explores.
        for _ in 0..2_000 {
            let p = order(&st, found(), of, false, (next(), next()), |_| false);
            assert_eq!(p.order[0].0, x);
            assert!(p.explored.is_none());
        }
        // An entry the chain doesn't show yet is unverified too, and can be explored.
        let fresh = id(77);
        let p = order(&st, vec![(x, wallet(1)), (fresh, wallet(7))], of, true, (0.0, 0.5), |_| false);
        assert_eq!(p.explored, Some(fresh));
    }

    #[test]
    fn with_no_verified_entry_every_pick_follows_the_pass_rate() {
        let mut s = Script::default();
        let y = s.list(2, 2, "shop.example", "search items", 2);
        let z = s.list(3, 3, "shop.example", "search items", 1);
        let w = s.list(4, 4, "shop.example", "search items", 2);
        let st = s.at(3);
        let of = |t: &(B256, Address, f64)| Candidate { entry: t.0, contributor: t.1, site: "shop.example".into(), fee: t.2 };
        let p = order(&st, vec![(y, wallet(2), 0.01), (z, wallet(3), 0.02), (w, wallet(4), 0.005)], of, true, (0.0, 0.0), |_| false);
        assert!(p.explored.is_none(), "nothing to explore away from");
        let firsts: Vec<B256> = p.order.iter().map(|t| t.0).collect();
        assert_eq!(firsts, vec![z, w, y], "the earliest listing is the default (R5.17); then, with equal evidence, the cheaper first");
    }

    #[test]
    fn an_entry_that_failed_here_goes_last_for_two_hours() {
        let st = Standings::default();
        let (a, b) = (id(4242), id(4343));
        let now = 1_000_000u64;
        let mut demotions = Demoted::default();
        demotions.demote(a, now);
        assert!(demotions.demoted(a, now + 3600));
        assert!(!demotions.demoted(a, now + LOCAL_DEMOTION.as_secs()));
        assert!(!demotions.demoted(b, now));
        let of = |t: &B256| Candidate { entry: *t, contributor: wallet(1), site: "shop.example".into(), fee: FEE };
        let p = order(&st, vec![a, b], of, true, (1.0, 0.0), |e| demotions.demoted(e, now));
        assert_eq!(p.order, vec![b, a]);
    }

    #[test]
    fn a_failure_counts_only_from_a_verified_person_once_a_route_a_day() {
        struct Only(Address);
        impl Personhood for Only {
            fn verified(&self, payer: Address) -> bool {
                payer == self.0
            }
        }
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 2);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        for _ in 0..5 {
            s.h.failures.push(Failure { entry: x, payer: wallet(PAYERS), epoch: 4 });
            s.h.failures.push(Failure { entry: x, payer: wallet(PAYERS + 1), epoch: 4 });
        }
        assert_eq!(standings(&s.h, 5, &NoProofYet).of(x).unwrap().fails, 0.0, "nobody is verified yet");
        let verified = standings(&s.h, 5, &Only(wallet(PAYERS)));
        let one = Record { lines: [(0, 7), (1, 7), (2, 7)].into(), spend: 0.21, sites: ["a.example", "b.example", "c.example"].map(String::from).into(), routes: [0, 1, 2].into(), first: Some(0) }.weight(4);
        assert!((verified.of(x).unwrap().fails - one).abs() < 1e-12, "one complaint, from the verified person: {}", verified.of(x).unwrap().fails);
        assert!(verified.of(x).unwrap().pass_rate < rate(0.0, 0.0));
    }

    #[test]
    fn a_payer_that_misreports_a_canary_has_no_standing_for_the_penalty() {
        let operator = wallet(5);
        let mut s = Script::default();
        s.h.canary_operator = Some(operator);
        s.honest_payers(PAYERS, PAYERS + 30);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        for e in 5..=6 {
            for j in PAYERS..PAYERS + 30 {
                s.pay(j, x, e);
            }
        }
        let clean = s.at(7).of(x).unwrap().counted_uses;
        assert_eq!(clean, 60);
        let reveal = CanaryReveal { epoch: 4, by: operator, salt: id(9), canaries: vec![Canary { entry: x, payer: wallet(PAYERS), good: false, passed: true }] };
        let mut cheat = s.h.clone();
        cheat.canary_commitments.push(CanaryCommitment { epoch: 4, by: operator, hash: reveal.commitment() });
        cheat.canary_reveals.push(reveal.clone());
        assert_eq!(standings(&cheat, 7, &NoProofYet).of(x).unwrap().counted_uses, 58, "the payer that passed a known-bad answer counts for nothing");
        assert_eq!(standings(&cheat, 4, &NoProofYet).of(x).unwrap().counted_uses, 0, "nothing yet: x's uses come later");
        // Past the penalty, it counts again, once it has a record in the window again.
        let mut later = cheat.clone();
        for k in 0..RECORD_LINES {
            later.uses.push(Use { entry: id(901 + k % 3), payer: wallet(PAYERS), agent: wallet(PAYERS + 1_000_000), amount: FEE, epoch: 4 + CANARY_PENALTY - 1 });
        }
        for e in 4 + CANARY_PENALTY..4 + CANARY_PENALTY + 2 {
            later.uses.push(Use { entry: x, payer: wallet(PAYERS), agent: wallet(PAYERS + 1_000_000), amount: FEE, epoch: e });
        }
        assert_eq!(standings(&later, 4 + CANARY_PENALTY + 2, &NoProofYet).of(x).unwrap().counted_uses, 60);
        // A reveal that doesn't match the first commitment, or comes from anyone but the operator, changes nothing.
        let mut wrong = s.h.clone();
        wrong.canary_commitments.push(CanaryCommitment { epoch: 4, by: operator, hash: id(1) });
        wrong.canary_commitments.push(CanaryCommitment { epoch: 4, by: operator, hash: reveal.commitment() });
        wrong.canary_reveals.push(reveal.clone());
        assert_eq!(standings(&wrong, 7, &NoProofYet).of(x).unwrap().counted_uses, clean);
        let mut stranger = s.h.clone();
        let theirs = CanaryReveal { by: wallet(6), ..reveal.clone() };
        stranger.canary_commitments.push(CanaryCommitment { epoch: 4, by: wallet(6), hash: theirs.commitment() });
        stranger.canary_reveals.push(theirs);
        assert_eq!(standings(&stranger, 7, &NoProofYet).of(x).unwrap().counted_uses, clean);
        // A canary line is the operator's test, never a use of the entry.
        let mut planted = s.h.clone();
        let good = CanaryReveal { epoch: 5, by: operator, salt: id(3), canaries: vec![Canary { entry: x, payer: wallet(PAYERS + 1), good: true, passed: true }] };
        planted.canary_commitments.push(CanaryCommitment { epoch: 5, by: operator, hash: good.commitment() });
        planted.canary_reveals.push(good);
        assert_eq!(standings(&planted, 6, &NoProofYet).of(x).unwrap().counted_uses, 29);
        assert_eq!(standings(&planted, 7, &NoProofYet).of(x).unwrap().counted_uses, 59);
    }

    #[test]
    fn the_switch_test_is_monotone_and_ties_keep_the_incumbent() {
        // More passes for a challenger never lose a switch it had won.
        let mut last = 0.0;
        for p in (0..400).step_by(10) {
            let b = beats((p as f64, 0.0), (5.0, 0.0));
            assert!(b + 1e-12 >= last, "passes {p}: {b} after {last}");
            last = b;
        }
        assert!(last >= SWITCH_CONFIDENCE, "enough passes win: {last}");
        // A better incumbent never makes switching easier.
        let mut last = 1.0;
        for p in (0..400).step_by(10) {
            let b = beats((100.0, 0.0), (p as f64, 0.0));
            assert!(b <= last + 1e-12, "incumbent passes {p}: {b} after {last}");
            last = b;
        }
        assert!(beats((10.0, 0.0), (10.0, 0.0)) < 0.5, "equal evidence never switches");
        // Two entries with the same evidence: the earlier listing keeps the default.
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let y = s.list(2, 2, "shop.example", "search items", 1);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        for e in 5..=10 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, x, e);
                s.pay(j, y, e);
            }
        }
        assert_eq!(default_of(&s.at(11), x), Some(y), "listed first");
    }

    #[test]
    fn a_default_that_stops_being_live_hands_over_to_the_best_left() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        let y = s.list(2, 2, "shop.example", "search items", 1);
        for e in 5..=10 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, x, e);
                if j < PAYERS + 30 {
                    s.pay(j, y, e);
                }
            }
        }
        assert_eq!(default_of(&s.at(11), x), Some(x));
        s.h.entries[3].ended_epoch = Some(12);
        let st = s.at(12);
        assert_eq!(default_of(&st, x), Some(y));
        assert!(!st.of(x).unwrap().live);
        assert_eq!(st.route_of(x).unwrap().entries.last().unwrap().entry, x, "shown, last, as not live");
    }

    #[test]
    fn every_node_reading_the_chain_gets_the_same_standings_whatever_order_the_logs_came_in() {
        let mut s = Script::default();
        s.honest_payers(PAYERS, PAYERS + 40);
        let x = s.list(1, 1, "shop.example", "search items", 1);
        let y = s.list(2, 2, "shop.example", "search items", 2);
        for e in 5..=30 {
            for j in PAYERS..PAYERS + 40 {
                s.pay(j, if e < 12 { x } else { y }, e);
            }
        }
        let one = s.at(31);
        let mut shuffled = s.h.clone();
        shuffled.uses.reverse();
        shuffled.entries.reverse();
        let two = standings(&shuffled, 31, &NoProofYet);
        assert_eq!(one.routes, two.routes);
    }

    /// Anyone may list an entry for a route: contributors who are not the route's first builder are shown beside it in
    /// the route's standings and stay candidates in a pick, the first builder's entry ahead only as the earlier listing
    /// (R5.17), and none of them is left out for being someone else's.
    #[test]
    fn entries_of_unrelated_contributors_for_one_route_all_stay_candidates_in_a_pick() {
        let mut s = Script::default();
        let first = s.list(1, 1, "shop.example", "search items", 1);
        let (second, third) = (s.list(2, 2, "shop.example", "search items", 2), s.list(3, 3, "shop.example", "search items", 3));
        let st = s.at(4);
        let route = st.route_of(second).expect("the second contributor's entry is on the route");
        assert_eq!(route.entries.iter().map(|e| e.entry).collect::<Vec<_>>(), vec![first, second, third], "one route, three contributors");
        assert_eq!(st.route_of(third).map(|r| r.entries.len()), Some(3));
        let of = |t: &(B256, Address)| Candidate { entry: t.0, contributor: t.1, site: "shop.example".into(), fee: FEE };
        let found = vec![(third, wallet(3)), (second, wallet(2)), (first, wallet(1))];
        let p = order(&st, found.clone(), of, false, (1.0, 0.0), |_| false);
        assert_eq!(p.order.iter().map(|t| t.0).collect::<Vec<_>>(), vec![first, second, third], "all three, by the earliest listing");
        // The first builder's entry failing here hands the pick to the others, in their order: a fallback has somewhere to go.
        let p = order(&st, found, of, false, (1.0, 0.0), |e| e == first);
        assert_eq!(p.order.iter().map(|t| t.0).collect::<Vec<_>>(), vec![second, third, first]);
    }

    /// A pick's two draws are numbers in [0, 1) and are two draws: not one number twice.
    #[test]
    fn a_picks_two_draws_are_numbers_below_one_and_not_the_same_number() {
        let mut apart = 0;
        for _ in 0..32 {
            let (explore, which) = draws();
            assert!((0.0..1.0).contains(&explore) && (0.0..1.0).contains(&which), "{explore} {which}");
            apart += usize::from(explore != which);
        }
        assert!(apart > 0, "the second draw is not the first");
    }

    /// A failure kept on disk survives a restart for two hours, and what has run out is dropped from the file when the
    /// next failure is kept.
    #[test]
    fn a_demotion_kept_on_disk_survives_a_restart_and_the_expired_are_dropped() {
        let dir = std::env::temp_dir().join(format!("share-demoted-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demoted.json");
        let (a, b) = (id(4242), id(4343));
        let t0 = 1_000_000u64;
        let mut kept = Demoted::open(path.clone());
        kept.demote(a, t0);
        let reopened = Demoted::open(path.clone());
        assert!(reopened.demoted(a, t0 + 60), "a restart inside the two hours still has it");
        assert!(!reopened.demoted(a, t0 + LOCAL_DEMOTION.as_secs()), "and not after them");
        kept.demote(b, t0 + LOCAL_DEMOTION.as_secs() + 1);
        let later = Demoted::open(path);
        assert_eq!(later.entries.len(), 1, "the one that ran out went from the file");
        assert!(later.demoted(b, t0 + LOCAL_DEMOTION.as_secs() + 2) && !later.demoted(a, t0 + LOCAL_DEMOTION.as_secs() + 2));
        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
#[path = "reputation_cov_tests.rs"]
mod reputation_cov_tests;
