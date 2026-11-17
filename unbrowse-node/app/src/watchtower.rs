//! Watchtowers for unclaimed lines (Lightning's, roadmap item 1, R3.28). A voucher for epoch e can be claimed only
//! through e + 1, and an agent's receipt lines live on its node, so a payer whose node is off for two epochs would
//! lose the contributor, the site and the server what its lines pay them. A claim is authorised by the payer agent's
//! signature on the voucher, not by who sends it, so:
//!
//! - **hand over**: as a stream grows, a node hands its signed running voucher and its passed, unclaimed lines
//!   (`chain::stream`) to watchtowers: the site's tower (`{site}/tower/v1`) on a live network, and `TOWERS` peers of
//!   distinct identities from its routing table over `/unbrowse/tower/1`. It hands a stream again only once it has
//!   changed, so a node stopped mid-epoch has already handed over every line it signed before it stopped.
//! - **hold**: every node is a watchtower for its peers. It checks what it is handed (`chain::check_stream`) and keeps
//!   it in a bounded store, `MAX_LINES` lines in all and `MAX_LINES_PER_PAYER` for any one payer; a node in light
//!   mode watches for no one.
//! - **claim**: a tower does nothing until the last stretch of a line's window (`due`, `tower_lead` before it closes),
//!   after the serving node's claim (once its lines are worth its gas) and the payer's backstop (half way through epoch
//!   e + 1, `chain::backstop_due`). Then it claims whatever is still unclaimed, from its own gas, and only when the gas is no more than the lines pay out.
//!   A line already claimed is seen spent and dropped without a transaction.
//!
//! A tower can only cause a claim to be made. It can't redirect a payment or change a line: the contract checks the
//! agent's signature and the line's proof, and pays the lines' own payees, never the submitter.

use std::sync::{Arc, Mutex};

use alloy::primitives::U256;
use unbrowse_net::{PeerId, Standing, Towers};

use crate::chain::{self, PaidLine};
use crate::rpc::ProviderBuilder;
use crate::store::{self, Activity};
use crate::{agents, Node};
use crate::sync::Locked;

/// The site's watchtower on a live network, `{site}/tower/v1`: the first site the node knows (`link::sites`).
fn site_tower() -> Option<String> {
    crate::chain::live()?;
    Some(format!("{}/tower/v1", crate::link::sites()[0]))
}

/// Peers of distinct identities a node hands each stream to, besides the site's tower.
pub const TOWERS: usize = 2;
/// Lines a tower holds for others, in all and for any one payer: past either, a hand-over of new lines is refused and
/// its node hands them to another tower.
pub const MAX_LINES: usize = 4096;
pub const MAX_LINES_PER_PAYER: usize = 512;
/// Lines in one hand-over: well inside `unbrowse_net::MAX_HANDED_BYTES`, at about a kilobyte a line.
pub const PART: usize = 128;
/// How long before a line's window closes its towers claim it: the last quarter of the window's last epoch, which
/// leaves the serving node's claim and the payer's backstop (half way through that epoch) to go first.
pub fn tower_lead(length: u64) -> u64 {
    length / 4
}

/// Whether a line of voucher epoch `epoch` is a tower's to claim at block `at`, on epochs of `length` blocks: in the last
/// `tower_lead` of its window, which closes as epoch `epoch + 2` begins.
pub fn due(epoch: u64, at: u64, length: u64) -> bool {
    at >= epoch.saturating_add(2).saturating_mul(length).saturating_sub(tower_lead(length))
}

fn held_path() -> std::path::PathBuf {
    chain::dir().join("watching.json")
}

fn handed_path() -> std::path::PathBuf {
    chain::dir().join("handed.json")
}

/// One writer at a time for the tower's store.
static HELD: Mutex<()> = Mutex::new(());

/// The store's lock, this process's and every process's on the chain's folder, held together for one change.
fn lock() -> Result<(std::sync::MutexGuard<'static, ()>, store::FileHeld), String> {
    let one = HELD.locked();
    let file = store::hold_money_file(&held_path(), store::MONEY_LOCK_WAIT)?;
    Ok((one, file))
}

/// The lines this node holds for other nodes' payers.
pub fn held() -> Result<Vec<PaidLine>, String> {
    store::read_json_strict(&held_path(), &unbrowse_files::WATCHING)
}

/// Keeps checked lines of one stream, in epoch `now`. A line already held is replaced by the same line under a newer
/// voucher (a larger total), which a claim can always use; lines whose window has closed are let go. New lines past
/// the store's bounds refuse the whole hand-over, and nothing is written.
fn keep(lines: Vec<PaidLine>, seen: Option<u64>) -> Result<(), String> {
    let _one = lock()?;
    let mut all = held()?;
    // Lines go by a witnessed epoch (`seen`) only, never the one RPC's (R7 sweep): the store's bounds hold it meanwhile.
    all.retain(|o| !crate::network::past_by_witness(o.epoch, seen));
    let mut fresh: Vec<PaidLine> = Vec::new();
    for l in lines {
        match all.iter_mut().find(|o| chain::owed_key(o) == chain::owed_key(&l)) {
            Some(o) if l.cumulative >= o.cumulative => *o = l,
            Some(_) => {}
            None if !fresh.iter().any(|f| chain::owed_key(f) == chain::owed_key(&l)) => fresh.push(l),
            None => {}
        }
    }
    if let Some(payer) = fresh.first().map(|l| l.payer) {
        let theirs = all.iter().filter(|o| o.payer == payer).count();
        if all.len() + fresh.len() > MAX_LINES || theirs + fresh.len() > MAX_LINES_PER_PAYER {
            return Err("this tower holds as many lines as it keeps; hand them to another".into());
        }
    }
    all.extend(fresh);
    store::write_json(&held_path(), &unbrowse_files::WATCHING, &all)
}

/// Lets go of lines claimed or that can't be any more, leaving every other line, kept since or not.
fn forget(gone: &[(alloy::primitives::Address, alloy::primitives::Address, u64, U256)]) -> Result<(), String> {
    let _one = lock()?;
    let mut all = held()?;
    all.retain(|o| !gone.contains(&chain::owed_key(o)));
    store::write_json(&held_path(), &unbrowse_files::WATCHING, &all)
}

/// Checks lines a node handed this one and keeps them to claim if their payer doesn't.
pub async fn hold(chain: &chain::Chain, lines: Vec<PaidLine>) -> Result<(), String> {
    if lines.len() > PART {
        return Err(format!("a hand-over is at most {PART} lines"));
    }
    chain::check_stream(chain, &lines).await?;
    chain::witness_epoch(chain).await?;
    keep(lines, chain::seen_epoch())
}

/// The node's side of `/unbrowse/tower/1`: what a peer hands it is one stream's lines, as JSON.
pub struct Watch(pub Arc<Node>);

impl Towers for Watch {
    async fn hold(&self, _from: PeerId, handed: &[u8]) -> Result<(), String> {
        // A node in light mode serves nothing for others (R1.11), watching included.
        if store::load_settings().light {
            return Err("a node in light mode watches for no one".into());
        }
        let lines: Vec<PaidLine> = serde_json::from_slice(handed).map_err(|e| format!("the hand-over doesn't read: {e}"))?;
        // A line paying one of this node's own listings is its receipt, handed over by a payer on another machine
        // (`network::hand_receipt`): it is kept to claim as the node's own, checked as a receipt is. The rest it
        // watches for its peers.
        let (own, others) = mine(lines, |entry| crate::listing::load_book(&self.0.chain).of_entry(entry).is_some());
        for paid in &own {
            crate::network::accept_receipt(&self.0.chain, self.0.keys.as_ref(), paid).await?;
        }
        if others.is_empty() {
            return Ok(());
        }
        hold(&self.0.chain, others).await
    }
}

/// The lines that pay one of this node's own listings (`is_mine`, by entry), and the rest.
fn mine(lines: Vec<PaidLine>, is_mine: impl Fn(alloy::primitives::FixedBytes<32>) -> bool) -> (Vec<PaidLine>, Vec<PaidLine>) {
    lines.into_iter().partition(|p| is_mine(p.line().entryId))
}

/// The most of its own gas a tower spends in one epoch claiming any one payer's lines by itself, in USDC (the chain's
/// gas). A tower is paid nothing for a claim, so a payer and a contributor who share an interest can't make it spend
/// more than this on them an epoch, however many small lines they hand it; the owner's daily gas budget bounds them all.
pub const TOWER_GAS_PER_PAYER_USDC: f64 = 0.05;

/// Gas the tower has spent of its own claiming each payer's lines in `epoch`, in whole USDC: kept on disk
/// (`<chain>/tower-gas.json`), so a restart in the epoch starts from what was spent, not from nothing.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct TowerGas {
    pub epoch: u64,
    pub spent: Vec<(alloy::primitives::Address, f64)>,
}

fn tower_gas_path() -> std::path::PathBuf {
    chain::dir().join("tower-gas.json")
}

/// Takes the whole of what is left of `payer`'s allowance for epoch `now` before a claim for it is sent, under the
/// file's lock across processes: what is left, in whole USDC (none when it is spent). The claim's writes are held to
/// it by their signed most (`rpc::within_budget`), and `settle_tower` then counts what they took; a node that stops
/// between the two finds the whole allowance spent, never a fresh one.
fn reserve_tower(now: u64, payer: alloy::primitives::Address) -> Result<f64, String> {
    let _file = store::hold_money_file(&tower_gas_path(), store::MONEY_LOCK_WAIT)?;
    let mut book: TowerGas = store::read_json_strict(&tower_gas_path(), &unbrowse_files::TOWER_GAS)?;
    if book.epoch != now {
        book = TowerGas { epoch: now, spent: Vec::new() };
    }
    let spent = book.spent.iter().find(|(p, _)| *p == payer).map(|(_, c)| *c).unwrap_or(0.0);
    let left = (TOWER_GAS_PER_PAYER_USDC - spent).max(0.0);
    match book.spent.iter_mut().find(|(p, _)| *p == payer) {
        Some((_, c)) => *c = TOWER_GAS_PER_PAYER_USDC,
        None => book.spent.push((payer, TOWER_GAS_PER_PAYER_USDC)),
    }
    store::write_json(&tower_gas_path(), &unbrowse_files::TOWER_GAS, &book)?;
    Ok(left)
}

/// Counts what a claim for `payer` took (`used`, in whole USDC, its writes' signed most) of the `left` it reserved, and
/// gives the rest back.
fn settle_tower(now: u64, payer: alloy::primitives::Address, left: f64, used: f64) -> Result<(), String> {
    let _file = store::hold_money_file(&tower_gas_path(), store::MONEY_LOCK_WAIT)?;
    let mut book: TowerGas = store::read_json_strict(&tower_gas_path(), &unbrowse_files::TOWER_GAS)?;
    if book.epoch != now {
        return Ok(());
    }
    if let Some((_, c)) = book.spent.iter_mut().find(|(p, _)| *p == payer) {
        *c = (*c - (left - used).max(0.0)).max(0.0);
    }
    store::write_json(&tower_gas_path(), &unbrowse_files::TOWER_GAS, &book)
}



/// Whether claiming `lines` costs no more in gas, at `price` wei a unit, than they pay out: by the claim gas model,
/// one call per `CLAIM_BATCH` lines. A tower pays for a claim that isn't its own, so it never pays more than it saves.
fn worth(lines: &[PaidLine], price: u128, usdc: impl Fn(U256) -> f64) -> bool {
    let n = lines.len();
    let calls = n.div_ceil(chain::CLAIM_BATCH).max(1) as u64;
    let ls: Vec<_> = lines.iter().map(PaidLine::line).collect();
    let gas = chain::CLAIM_GAS.of(n, chain::earners(&ls)).saturating_add(chain::CLAIM_GAS.call.saturating_mul(calls - 1));
    let cost = chain::gas_f(U256::from(price) * U256::from(gas));
    cost <= lines.iter().map(|o| usdc(o.amount)).sum::<f64>()
}

/// `lines` split into those whose window is open at `now` (the one RPC's epoch: a claim is only tried there) and the
/// keys of those a witnessed epoch (`seen`, `chain::seen_epoch`) puts past their window: no claim pays one of the
/// second, so it is let go, and never counted as paying for a claim's gas. A line only the one RPC says is past its
/// window is neither tried nor let go (R7 sweep): it stays in the tower's bounded store until a witness reads it.
fn by_window(lines: Vec<PaidLine>, now: u64, seen: Option<u64>) -> (Vec<PaidLine>, Vec<(alloy::primitives::Address, alloy::primitives::Address, u64, U256)>) {
    let closed: Vec<_> = lines.iter().filter(|o| crate::network::past_by_witness(o.epoch, seen)).map(chain::owed_key).collect();
    let open = lines.into_iter().filter(|o| chain::claimable(o.epoch, now) && !crate::network::past_by_witness(o.epoch, seen)).collect();
    (open, closed)
}

/// Whether someone has claimed line `o` already, which pays this tower nothing to do again.
async fn spent(d: &chain::Deployment, o: &PaidLine) -> Result<bool, String> {
    let p = ProviderBuilder::new().connect_http(chain::url());
    let key = chain::spent_key(&o.voucher(), chain::line_leaf(&o.line()));
    chain::LeanSettlement::new(d.settlement, &p).spentLine(key).call().await.map_err(|e| e.to_string())
}

/// Claims the lines this node holds for others whose window is in its last stretch (`due`), or all of them when the
/// owner asks. Lines already claimed, or past their window, are let go, and neither counts toward what a claim is
/// worth: the tower pays the gas, and only an unclaimed line in its window pays anyone for it.
pub async fn claim_watched(node: &Node, when: chain::ClaimWhen) -> Result<Option<String>, String> {
    let all = held()?;
    if all.is_empty() {
        return Ok(None);
    }
    let d = node.chain.deployed()?;
    let (at, length) = (chain::chain_block(&node.chain).await?, d.blocks_per_epoch());
    chain::witness_epoch(&node.chain).await?;
    let seen = chain::seen_epoch();
    let (open, closed) = by_window(all, chain::current_epoch(&node.chain).await?, seen);
    if !closed.is_empty() {
        forget(&closed)?;
    }
    let due: Vec<PaidLine> = open.into_iter().filter(|o| when == chain::ClaimWhen::Now || due(o.epoch, at, length)).collect();
    if due.is_empty() {
        return Ok(None);
    }
    if let chain::ClaimWhen::Worth(_) = when {
        // With none left to pay, the pass below sends nothing and lets the claimed lines go.
        let mut unclaimed = Vec::new();
        let mut claimed = Vec::new();
        // One head for the pass's witnessed readings (`rpc::Head`).
        let p = ProviderBuilder::new().connect_http(chain::url());
        let mut head = crate::rpc::Head::follow(&p).await?;
        for o in &due {
            head.renew(&p).await?;
            if spent(&d, o).await? {
                // Let go only once more than the one RPC's word reads it spent (R5-CHAIN-1); until then it is kept, not
                // sent, and read again on the next pass.
                if chain::spent_at(&head, &p, d.settlement, chain::spent_key(&o.voucher(), chain::line_leaf(&o.line()))).await? == Some(true) {
                    claimed.push(chain::owed_key(o));
                }
            } else {
                unclaimed.push(o.clone());
            }
        }
        // A line someone claimed pays nobody to do again: it is let go here, with no gas.
        if !claimed.is_empty() {
            forget(&claimed)?;
        }
        let price = crate::chain::gas_price(&ProviderBuilder::new().connect_http(chain::url())).await?;
        if !unclaimed.is_empty() && !worth(&unclaimed, price, |x| d.usdc_f(x)) {
            return Ok(None);
        }
        // What it claims by itself for any one payer is held to its gas allowance for that payer this epoch, by the
        // signed most of every write the claim makes (`rpc::within_budget`): cold storage, a first listing shown and a
        // batch split into single lines all count as they are signed, not as a model guessed them.
        let now = chain::current_epoch(&node.chain).await?;
        let mut payers: Vec<alloy::primitives::Address> = unclaimed.iter().map(|o| o.payer).collect();
        payers.sort();
        payers.dedup();
        let mut last = None;
        for payer in payers {
            let left = reserve_tower(now, payer)?;
            if left <= 0.0 {
                continue;
            }
            let theirs: Vec<PaidLine> = unclaimed.iter().filter(|o| o.payer == payer).cloned().collect();
            let (paid, used) = crate::rpc::within_budget(chain::gas_units(left), chain::claim_for_others(&node.chain, node.key()?, theirs)).await;
            settle_tower(now, payer, left, chain::gas_f(used))?;
            if let Ok(tx) = finish(&d, paid?) {
                last = tx.or(last);
            }
        }
        return Ok(last);
    }
    let paid = chain::claim_for_others(&node.chain, node.key()?, due).await?;
    finish(&d, paid)
}

/// Lets go of what a tower's claim settled, and logs it: its transaction, if it sent one.
fn finish(d: &chain::Deployment, paid: chain::Paid) -> Result<Option<String>, String> {
    // What a claim's receipt alone says it paid is kept until more than that one RPC reads it spent (`Paid::settled`). A
    // line only the one RPC says is past its window goes, as every line past it does from a tower's bounded store: the
    // lines are another node's, and their payer's node still holds them.
    forget(&paid.gone.iter().chain(&paid.settled).copied().chain(paid.set_aside.iter().map(chain::owed_key)).collect::<Vec<_>>())?;
    if let (None, Some(e)) = (&paid.tx, paid.failed) {
        return Err(e);
    }
    if let Some(tx) = &paid.tx {
        let n = paid.claimed.len();
        store::log_activity(&Activity {
            at: store::now(),
            who: "Node".into(),
            site: "Settlement".into(),
            what: format!("Claimed {n} line{} for payers whose nodes were away", if n == 1 { "" } else { "s" }),
            kind: "claim".into(),
            result: "done".into(),
            ms: None,
            unb: Some(paid.claimed.iter().map(|o| d.usdc_f(o.amount)).sum()),
            tx: Some(tx.clone()),
            note: Some("As their watchtower: the lines pay the payees they name, and this node only paid the gas".into()),
        });
    }
    Ok(paid.tx)
}

/// What this node last handed its towers of each stream: (agent, epoch, lines, voucher total).
pub(crate) type Mark = (u32, u64, usize, U256);

/// Hands every agent's stream for this epoch and the last to the node's towers, each once it has changed since it was
/// last handed over. Called once a pass of the claim loop, so the towers hold a stream within a minute of a line.
pub async fn hand_over(node: &Node) {
    let (Ok(keys), Ok(now)) = (node.key(), chain::current_epoch(&node.chain).await) else { return };
    let mut handed: Vec<Mark> = store::read_json(&handed_path(), &unbrowse_files::HANDED);
    let before = handed.len();
    handed.retain(|m| chain::claimable(m.1, now));
    let mut changed = handed.len() != before;
    for a in agents::list() {
        for e in [now.saturating_sub(1), now] {
            let Ok(lines) = chain::stream(&node.chain, keys, a.index, e).await else { continue };
            let Some(first) = lines.first() else { continue };
            let mark = (a.index, e, lines.len(), first.cumulative);
            if handed.contains(&mark) {
                continue;
            }
            let (took, asked) = hand(node, &lines).await;
            if handed_to_all(took, asked) {
                handed.retain(|m| (m.0, m.1) != (a.index, e));
                handed.push(mark);
                changed = true;
            }
        }
    }
    if changed {
        let _ = store::write_json(&handed_path(), &unbrowse_files::HANDED, &handed);
    }
}

/// Whether a stream is handed for good: every tower asked took it. A node has towers so that one being away doesn't lose
/// the lines, so one taking them isn't enough, and a stream some tower missed goes again on the next pass (a tower that
/// took it already keeps it once).
fn handed_to_all(took: usize, asked: usize) -> bool {
    asked > 0 && took == asked
}

/// Hands one stream to every tower, in parts of `PART` lines. How many towers took all of it, and how many were asked.
async fn hand(node: &Node, lines: &[PaidLine]) -> (usize, usize) {
    let parts: Vec<Vec<u8>> = lines.chunks(PART).filter_map(|p| serde_json::to_vec(p).ok()).collect();
    let (mut took, mut asked) = (0, 0);
    if let Some(url) = site_tower() {
        asked += 1;
        let client = reqwest::Client::new();
        let mut all = true;
        for p in &parts {
            let sent = client.post(&url).header("content-type", "application/json").body(p.clone()).timeout(std::time::Duration::from_secs(30)).send().await;
            all &= sent.is_ok_and(|r| r.status().is_success());
        }
        took += usize::from(all);
    }
    if let Some(net) = node.net.get() {
        for peer in towers(net).await {
            asked += 1;
            let mut all = true;
            for p in &parts {
                all &= net.hand_over(peer, p.clone()).await.is_ok();
            }
            took += usize::from(all);
        }
    }
    (took, asked)
}

/// The peers a node hands its streams to: the first `TOWERS` in its routing table, nearest first, that count, one per
/// identity, so one owner's nodes are one tower.
async fn towers(net: &unbrowse_net::Net) -> Vec<PeerId> {
    let mut ids = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for (p, _) in net.table().await {
        if out.len() >= TOWERS {
            break;
        }
        if let Standing::Counts(id) = net.admit(p).await {
            if ids.insert(id) {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::providers::Provider;
    use alloy::primitives::{Address, Bytes, FixedBytes};

    /// A line whose window closed pays nothing, so it is let go and never counted towards a claim's worth.
    #[test]
    fn a_line_past_its_window_is_let_go_and_counts_for_nothing() {
        let lines = || vec![line(1, 5, 0, 10), line(1, 6, 0, 10), line(1, 7, 0, 10)];
        let (open, closed) = by_window(lines(), 7, Some(7));
        assert_eq!(open.iter().map(|o| o.epoch).collect::<Vec<_>>(), [6, 7], "the last epoch's and this one's");
        assert_eq!(closed.iter().map(|k| k.2).collect::<Vec<_>>(), [5]);
        // Only the one RPC says epoch 7, or says the chain is far ahead: nothing is let go, and only what it calls open
        // is tried.
        let (open, closed) = by_window(lines(), 7, None);
        assert_eq!(open.iter().map(|o| o.epoch).collect::<Vec<_>>(), [6, 7]);
        assert!(closed.is_empty(), "no line let go on the one RPC's word");
        let (open, closed) = by_window(lines(), 1_000_000, Some(6));
        assert!(open.is_empty() && closed.is_empty(), "a far-future epoch from the one RPC drops nothing a witness keeps open");
    }

    /// One tower taking a stream doesn't settle it: the other, away this pass, is asked again on the next.
    #[test]
    fn a_stream_is_handed_only_once_every_tower_took_it() {
        assert!(handed_to_all(2, 2));
        assert!(!handed_to_all(1, 2), "the second tower has none of it");
        assert!(!handed_to_all(0, 0), "no tower was there to take it");
    }

    fn line(payer: u8, epoch: u64, index: u64, cumulative: u64) -> PaidLine {
        PaidLine {
            payer: Address::repeat_byte(payer),
            agent: Address::repeat_byte(0xa0),
            epoch,
            cumulative: U256::from(cumulative),
            lines: index + 1,
            passed_lines: index + 1,
            receipts_root: FixedBytes::ZERO,
            signature: Bytes::new(),
            index: U256::from(index),
            entry_id: FixedBytes::repeat_byte(1),
            amount: U256::from(1),
            passed: true,
            holders: vec![],
            bounty: U256::ZERO,
            proof: vec![],
        }
    }

    /// The payer's node claims first, as the epoch after the voucher's starts; the serving node half way through it;
    /// a tower only in its last quarter, with that quarter still to go before the window closes.
    #[test]
    fn a_tower_claims_only_in_the_last_stretch_of_the_window() {
        let (e, length) = (20_000, 172_800);
        let closes = (e + 2) * length;
        assert!(!due(e, e * length + 1, length), "not in the voucher's own epoch");
        assert!(!due(e, (e + 1) * length, length), "nor when the payer's claim goes");
        assert!(!due(e, (e + 1) * length + length / 2, length), "nor when the serving node's does");
        assert!(due(e, closes - tower_lead(length), length), "but in the last stretch");
        assert!(tower_lead(length) >= length / 8, "with hours left to get the claim in");
    }

    /// A hand-over's lines that pay one of this node's own listings are its receipts, kept as its own; the rest are
    /// watched for its peers.
    #[test]
    fn a_handed_line_paying_this_nodes_listing_is_its_receipt() {
        let ours = FixedBytes::repeat_byte(1);
        let theirs = PaidLine { entry_id: FixedBytes::repeat_byte(2), ..line(1, 7, 1, 5) };
        let (own, others) = mine(vec![line(1, 7, 0, 5), theirs], |e| e == ours);
        assert_eq!(own.iter().map(|p| p.line().entryId).collect::<Vec<_>>(), [ours]);
        assert_eq!(others.iter().map(|p| p.line().entryId).collect::<Vec<_>>(), [FixedBytes::repeat_byte(2)]);
    }

    /// A tower's store is bounded in all and for each payer; a line handed again under a newer voucher replaces the
    /// one held, and an older voucher never replaces a newer one.
    #[test]
    fn a_towers_store_is_bounded_and_keeps_the_newest_voucher() {
        let _home = store::scratch_home("watchtower-store");
        let now = 100;
        keep(vec![line(1, now, 0, 5), line(1, now, 1, 5)], Some(now)).unwrap();
        keep(vec![line(1, now, 0, 9)], Some(now)).unwrap();
        keep(vec![line(1, now, 1, 2)], Some(now)).unwrap();
        let all = held().unwrap();
        assert_eq!(all.iter().map(|o| o.cumulative.to::<u64>()).collect::<Vec<_>>(), [9, 5], "newest voucher kept, an older one ignored");

        let many: Vec<_> = (2..MAX_LINES_PER_PAYER as u64 + 1).map(|i| line(1, now, i, 5)).collect();
        assert!(keep(many, Some(now)).unwrap_err().contains("as many lines as it keeps"), "one payer can't fill the store");
        assert_eq!(held().unwrap().len(), 2, "a refused hand-over writes nothing");
        keep(vec![line(2, now, 0, 5)], Some(now)).unwrap();
        // An epoch only the one RPC says (no witness) lets nothing go.
        keep(vec![line(4, now, 0, 5)], None).unwrap();
        assert_eq!(held().unwrap().len(), 4, "nothing let go on the one RPC's word");
        // Lines whose window a witnessed epoch closed are let go as the store changes.
        keep(vec![line(3, now + 2, 0, 5)], Some(now + 2)).unwrap();
        assert_eq!(held().unwrap().iter().map(|o| o.payer).collect::<Vec<_>>(), [Address::repeat_byte(3)]);
    }

    /// A tower pays the gas of a claim that isn't its own only when the lines pay at least as much.
    #[test]
    fn a_tower_never_pays_more_gas_than_the_lines_pay_out() {
        let lines = vec![line(1, 1, 0, 5)];
        let usdc = |x: U256| x.to::<u64>() as f64 * 0.01;
        // One line paying 0.01 USDC: a claim of it takes `CLAIM_GAS.of(1, 1)` by the model, which fits at a price a
        // tenth under the one where its gas is the 0.01 and not at a price a tenth over.
        let gas = chain::CLAIM_GAS.of(1, 1) as f64;
        let even = 0.01e18 / gas;
        assert!(worth(&lines, (even * 0.9) as u128, usdc));
        assert!(!worth(&lines, (even * 1.1) as u128, usdc));
    }

    // ---- on a local chain ----

    use crate::{chain::ClaimWhen, peers, share, testchain};
    use std::path::{Path, PathBuf};

    /// One node of the test, with a home and a runtime of its own, as on its own machine.
    struct Peer {
        node: Arc<Node>,
        rt: Option<tokio::runtime::Runtime>,
        home: PathBuf,
    }

    impl Peer {
        fn new(scratch: &Path, name: &str) -> Peer {
            let home = scratch.join(name);
            std::fs::create_dir_all(&home).unwrap();
            let h = home.clone();
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
            let keys = unbrowse_core::MemoryStore::default();
            let id = unbrowse_core::load_or_create(&keys).unwrap();
            let node = Arc::new(Node {
                keys: Box::new(keys),
                identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
                info: crate::NodeInfo { name: name.into(), version: "test".into(), api_port: 1, dev: true },
                walks: crate::learn::Walks::default(),
                chain: chain::Chain::default(),
                chain_error: std::sync::Mutex::new(None),
                events: crate::api::Events::default(),
                net: std::sync::OnceLock::new(),
                share: share::Share::default(),
            });
            Peer { node, rt: Some(rt), home }
        }

        fn on<T: Send + 'static, F: std::future::Future<Output = T> + Send + 'static>(&self, f: impl FnOnce(Arc<Node>) -> F) -> T {
            let rt = self.rt.as_ref().expect("the node is running");
            rt.block_on(rt.spawn(f(self.node.clone()))).unwrap()
        }

        fn me(&self) -> alloy::primitives::Address {
            chain::owner_address(self.node.keys.as_ref()).unwrap()
        }

        fn join(&self) {
            let me = format!("{:#x}", self.me());
            self.on(move |n| async move {
                crate::network::advertise(&me, 1, &n.info.name).unwrap();
                let net = peers::start(n.clone()).await.expect("join");
                n.net.set(net).ok();
            });
        }

        /// The node goes away: its network and everything else it ran stop.
        fn leave(&mut self) {
            self.rt.take().unwrap().shutdown_background();
        }

        /// What the node holds as a tower, read from its own folder.
        fn watching(&self) -> Vec<PaidLine> {
            store::read_json(&self.home.join("devnet").join("watching.json"), &unbrowse_files::WATCHING)
        }
    }

    /// The devnet the first node made, shared, each node keeping the rest of its chain folder apart.
    fn share_devnet(first: &Path, other: &Path) {
        let dir = other.join("devnet");
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["mark.key", "deployment.json", "deployer.key", "network.json"] {
            std::fs::copy(first.join("devnet").join(f), dir.join(f)).unwrap();
        }
    }

    /// Mines the chain up to block `at`.
    async fn mine_to(at: u64) {
        let p = ProviderBuilder::new().connect_http(chain::url());
        let head = p.get_block_number().await.unwrap();
        let _: serde_json::Value = p.raw_request("anvil_mine".into(), (alloy::primitives::U256::from(at - head),)).await.unwrap();
    }

    /// a lists an entry and serves its body; b pays for five uses of it, claims the first three itself, hands its
    /// stream to its watchtower c over the peer network as it goes, and is stopped before it claims the last two. c
    /// does nothing while the payer's and the server's turns last, then, in the window's last stretch and before it
    /// closes, claims the two lines b left: a is paid for all five, once each, and b's deposit pays exactly five fees.
    /// A line c is handed with its amount changed is refused by c, and by the contract when sent anyway.
    /// `cargo test -p unbrowse-node-app watchtower -- --ignored --nocapture`
    #[test]
    #[ignore = "needs Anvil"]
    fn a_watchtower_claims_what_a_stopped_payer_left_before_the_window_closes() {
        let _one = testchain::one_at_a_time_blocking();
        let scratch = std::env::temp_dir().join(format!("unbrowse-watchtower-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        std::env::set_var("UNBROWSE_NETWORK_DIR", scratch.join("network"));
        std::env::set_var("UNBROWSE_DEVNET_PORT", "8593");
        std::env::set_var("UNBROWSE_DEVNET_FORK", "none");

        let a = Peer::new(&scratch, "a");
        a.on(|n| async move { n.chain.start().await.expect("chain") });
        let mut b = Peer::new(&scratch, "b");
        let c = Peer::new(&scratch, "c");
        for p in [&b, &c] {
            share_devnet(&a.home, &p.home);
            p.on(|n| async move { n.chain.start().await.expect("the same chain") });
        }
        let (a_addr, b_addr) = (a.me(), b.me());
        let b_agent = chain::agent_signer(b.node.keys.as_ref(), 0).unwrap().address();
        let entry = chain::test_entry("route-news");
        a.on(|n| async move {
            let keys = n.keys.as_ref();
            chain::faucet(&n.chain, keys, 300_000.0).await.unwrap();
            chain::set_fee(&n.chain, keys, 0.25, None).await.unwrap();
            chain::list_entry(&n.chain, keys, "route-news", "news.example", "Search news").await.unwrap();
        });
        c.on(|n| async move { chain::faucet(&n.chain, n.keys.as_ref(), 1_000.0).await.unwrap() });
        let epoch = b.on(|n| async move {
            let keys = n.keys.as_ref();
            chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
            chain::deposit(&n.chain, keys, 1_000.0).await.unwrap();
            let (agent, _) = crate::agents::create(keys, "agent", 100.0, 30, 1).unwrap();
            chain::authorize(&n.chain, keys, agent.index, 100.0, store::now() + 30 * 86_400).await.unwrap();
            chain::current_epoch(&n.chain).await.unwrap()
        });
        b.join();
        c.join();
        b.on(|n| async move {
            for _ in 0..300 {
                if !n.net.get().unwrap().table().await.is_empty() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            panic!("b never met c");
        });
        // What a is owed: its entry has no coin, so each line's route share is owed to it as its contributor.
        let to_claim = |p: &Peer| p.on(|n| async move { chain::wallet(&n.chain, n.keys.as_ref()).await.unwrap().to_claim });
        // b's deposit in Settlement, in USDC units, read through c: b may have gone by then.
        let deposit = || {
            c.on(move |n| async move {
                let d = n.chain.deployed().unwrap();
                let p = ProviderBuilder::new().connect_http(chain::url());
                (chain::LeanSettlement::new(d.settlement, &p).account(b_addr).call().await.unwrap().balance, d)
            })
        };
        let a_before = to_claim(&a);

        // Three uses, handed over as they are written; b claims them itself.
        let write = |n: usize| {
            b.on(move |_| async move {
                for _ in 0..n {
                    chain::add_network_receipt(0, epoch, entry, Some(a_addr), 0.25, true, 0.0, 100.0, 1_000.0).unwrap();
                }
            })
        };
        write(3);
        b.on(|n| async move { hand_over(&n).await });
        assert_eq!(c.watching().len(), 3, "c holds b's three lines");
        b.on(|n| async move { hand_over(&n).await });
        assert_eq!(c.watching().len(), 3, "an unchanged stream isn't handed over again");
        b.on(move |n| async move { chain::claim(&n.chain, n.keys.as_ref(), 0, epoch, ClaimWhen::Now).await.unwrap().expect("b claims its own") });
        // Two more, handed over; then b stops before it claims them.
        write(2);
        b.on(|n| async move { hand_over(&n).await });
        let held = c.watching();
        assert_eq!(held.len(), 5, "c holds all five, the last two under b's newer voucher");

        // A line changed on its way to the tower is refused there, and by the contract when sent anyway.
        let mut tampered = held.iter().find(|o| o.index == U256::from(4)).unwrap().clone();
        tampered.holders = vec![c.me()];
        let refused = c.on({
            let t = tampered.clone();
            move |n| async move { super::hold(&n.chain, vec![t]).await }
        });
        assert!(refused.unwrap_err().contains("isn't in the voucher"), "the tower refuses a changed line");
        let reverted = c.on({
            let t = tampered.clone();
            move |n| async move {
                let d = n.chain.deployed().unwrap();
                let p = ProviderBuilder::new().connect_http(chain::url());
                chain::LeanSettlement::new(d.settlement, &p).claimBatch(vec![t.voucher()], vec![t.signature.clone()], vec![t.line()], vec![t.proof.clone()]).call().await
            }
        });
        assert!(reverted.is_err(), "the contract refuses it: the proof doesn't take the changed line to the signed root");
        b.leave();
        let ((b_deposit, d), a_mid) = (deposit(), to_claim(&a));
        // 65% of each 0.25 is the route's, owed to a as the contributor of an entry with no coin (`coin.split`).
        assert!((a_mid - a_before - 3.0 * 0.1625).abs() < 1e-9, "b's own claim paid a for three: {a_before} then {a_mid}");

        // The payer's turn and the server's pass: the tower waits.
        let length = chain::DEVNET_EPOCH_BLOCKS;
        c.on(move |_| async move { mine_to((epoch + 1) * length + length / 2 + 60).await });
        assert!(c.on(|n| async move { claim_watched(&n, ClaimWhen::Worth(0.1)).await.unwrap() }).is_none(), "nothing before the last stretch");
        // The last stretch, before the window closes.
        let at = (epoch + 2) * length - tower_lead(length) + 60;
        c.on(move |_| async move { mine_to(at).await });
        let tx = c.on(|n| async move { claim_watched(&n, ClaimWhen::Worth(0.1)).await.unwrap() });
        assert!(tx.is_some(), "the tower claims what b left");
        let closes = (epoch + 2) * length;
        assert!(c.on(|n| async move { chain::chain_block(&n.chain).await.unwrap() }) < closes, "inside the window");
        assert!(c.watching().is_empty(), "the claimed lines and the spent ones are let go");
        assert!(c.on(|n| async move { claim_watched(&n, ClaimWhen::Now).await.unwrap() }).is_none(), "nothing is claimed twice");

        // a's route shares of the two lines.
        let a_after = to_claim(&a);
        assert!((a_after - a_mid - 2.0 * 0.1625).abs() < 1e-9, "a is paid for the two lines the tower claimed: {a_mid} then {a_after}");
        let claimed = c.on(move |n| async move {
            let d = n.chain.deployed().unwrap();
            let p = ProviderBuilder::new().connect_http(chain::url());
            chain::LeanSettlement::new(d.settlement, &p).claimedOf(b_addr, b_agent, epoch).call().await.unwrap()
        });
        assert_eq!(claimed, d.fee_units(5.0 * 0.25), "five lines paid under b's agent, each once");
        let (b_after, _) = deposit();
        assert_eq!(b_deposit - b_after, d.fee_units(0.5), "b's deposit paid the two fees the tower claimed");
        assert_eq!(b_after, d.fee_units(1_000.0 - 1.25), "five fees left b's deposit, no more");
        drop(c);
        drop(a);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// What a tower spent of its own gas on a payer this epoch is kept on disk, and taken whole before a claim goes, so
    /// a node that restarts in the epoch, even between a claim and its count, starts from it: a payer whose allowance
    /// is spent stays spent until the epoch is over.
    #[test]
    fn watchtower_payer_epoch_budget_survives_restart() {
        let _home = store::scratch_home("tower-gas");
        let payer = alloy::primitives::Address::repeat_byte(1);
        let left = reserve_tower(7, payer).unwrap();
        assert_eq!(left, TOWER_GAS_PER_PAYER_USDC, "the whole allowance, before the claim");
        // A restart between the claim and its count: nothing in memory, only the file, which holds it all as taken.
        assert_eq!(reserve_tower(7, payer).unwrap(), 0.0, "spent until the epoch is over");
        settle_tower(7, payer, left, 0.03).unwrap();
        assert!((reserve_tower(7, payer).unwrap() - 0.02).abs() < 1e-12, "once counted, what the claim's writes didn't take is back");
        assert_eq!(reserve_tower(8, payer).unwrap(), TOWER_GAS_PER_PAYER_USDC, "a new epoch, a new allowance");
    }

}
