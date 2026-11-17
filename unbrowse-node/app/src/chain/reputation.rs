//! What the chain shows about entries and their uses (spec §5), read once and kept, for `rank::reputation`.

use super::*;

// ---- reputation: what the chain shows about entries and their uses (spec §5) ----

/// The chain's record for `rank::reputation`, kept between reads: each read takes only the blocks finalized since the
/// last one, so a pick never rereads the whole chain.
#[derive(Clone, Default)]
pub(super) struct UseRecord {
    /// The Settlement it was read from: another deployment starts over.
    settlement: Address,
    /// The last block read.
    pub(super) to: u64,
    /// Each entry's latest listing: contributor, domain, description, (block, log index).
    listed: std::collections::HashMap<FixedBytes<32>, (Address, String, String, (u64, u64))>,
    /// Each entry's delistings and relistings, by block.
    delisted: std::collections::HashMap<FixedBytes<32>, Vec<Mark>>,
    relisted: std::collections::HashMap<FixedBytes<32>, Vec<Mark>>,
    fees: std::collections::HashMap<Address, U256>,
    uses: Vec<crate::rank::reputation::Use>,
    /// Claimed lines whose event marks them failed: no pass of the entry. Settlement emits `Claimed` only for passed
    /// lines, as a failed line pays nobody, so on it this stays empty.
    failures: Vec<crate::rank::reputation::Failure>,
    keys: std::collections::BTreeSet<(Address, Address)>,
    sent: std::collections::BTreeSet<(Address, Address)>,
    /// Each wallet whose USDC sends have been read, and up to which block.
    sends_read: std::collections::HashMap<Address, u64>,
    /// Each domain's escrow claimant now, by its hash: the wallet its latest DNSSEC proof (`claimEscrow`, R4.14) names.
    /// What decides where reputation travels (R5.5).
    claims: std::collections::HashMap<FixedBytes<32>, Address>,
}

/// Where a log stands in the chain: its block and its index there. An entry can be delisted and listed again in one
/// block, so blocks alone don't order what ended it and what brought it back.
type Mark = (u64, u64);

/// Where an entry listed at `listed` stopped being live and stayed out: the first of `ends` after the last time it came
/// back, or after the listing when it never did. `None` while it is live. `ends` are its delistings, `backs` its
/// relistings.
fn ended_at(listed: Mark, ends: impl Iterator<Item = Mark>, backs: &[Mark]) -> Option<Mark> {
    let from = backs.iter().copied().filter(|b| *b >= listed).max().unwrap_or(listed);
    ends.filter(|e| *e >= from).min()
}

/// One `Domains` event into the record's escrow claims (R4.14, R5.5): a proof makes its wallet the domain's claimant,
/// replacing any before it. Events come in chain order.
fn record_domain_event(r: &mut UseRecord, log: &alloy::primitives::Log) {
    use alloy::sol_types::SolEvent;
    if let Ok(ev) = Domains::DomainProven::decode_log(log) {
        r.claims.insert(ev.domainHash, ev.wallet);
    }
}

/// One claimed line into the record: a use that passed, or, for a line its event marks failed, a failure of the entry,
/// never a pass (R5.2).
fn record_claim(r: &mut UseRecord, ev: &LeanSettlement::Claimed, amount: f64, epoch: u64) {
    if ev.passed {
        r.uses.push(crate::rank::reputation::Use { entry: ev.entryId, payer: ev.payer, agent: ev.agent, amount, epoch });
    } else {
        r.failures.push(crate::rank::reputation::Failure { entry: ev.entryId, payer: ev.payer, epoch });
    }
}

/// Names each entry the record holds with no site or words after `held`, the listings this node holds now. A credit is
/// read once, and a node can read the entry's listing long after it: named only then, the entry would stay out of its
/// route for as long as the node runs, and this node's default would differ from a node that read it first (R5.20).
fn name_entries(r: &mut UseRecord, held: &std::collections::HashMap<FixedBytes<32>, (String, String)>) {
    for (id, e) in r.listed.iter_mut().filter(|(_, e)| e.1.is_empty() && e.2.is_empty()) {
        if let Some((site, what)) = held.get(id) {
            (e.1, e.2) = (site.clone(), what.clone());
        }
    }
}

pub(super) static RECORD: tokio::sync::Mutex<Option<UseRecord>> = tokio::sync::Mutex::const_new(None);

/// The block reputation is read up to (R10-CHAIN-2): the finalized head the node followed and anchored on this very
/// call (`rpc::Head`), with a second RPC named only one it stood behind as its own; `None` when there is none now, and
/// the record isn't read further this time. With no second RPC it is the one RPC's head, on its word.
pub(super) async fn history_head(p: &impl Provider) -> Result<Option<u64>, String> {
    let head = crate::rpc::Head::follow(p).await?;
    let named = crate::rpc::second_url()?.is_some();
    Ok(match head.followed {
        Some((at, w)) if !named || w == crate::anchor::Witness::Second => Some(at),
        _ => None,
    })
}

/// A disagreement between the two RPCs' logs (or a read over the caps) that keeps reputation from being read on: since
/// when, when it is tried again, how often it has been, and why (R11-CHAIN-3). The last agreed record stands meanwhile.
#[derive(Clone, Debug)]
struct Disagreement {
    since: std::time::Instant,
    next: std::time::Instant,
    tries: u32,
    why: String,
}

static DISAGREEING: std::sync::Mutex<Option<Disagreement>> = std::sync::Mutex::new(None);

/// How long a disagreement waits before the same range is read again, after `tries` tries: from 30 seconds, doubling,
/// to 15 minutes at most.
pub(crate) fn retry_after(tries: u32) -> std::time::Duration {
    std::time::Duration::from_secs((30u64 << tries.min(5)).min(15 * 60))
}

/// How long the ranking stands on the last agreed record while the RPCs keep disagreeing before it is said to be
/// unavailable, and candidates are ordered with no reputation at all (`ranking_unavailable`).
pub(crate) const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60 * 60);

fn note_disagreement(why: &str) {
    let now = std::time::Instant::now();
    let mut d = DISAGREEING.locked();
    let (since, tries) = d.as_ref().map_or((now, 0), |d| (d.since, d.tries + 1));
    if d.is_none() {
        crate::store::log_activity(&crate::store::Activity {
            at: crate::store::now(),
            who: "Node".into(),
            site: "Settlement".into(),
            what: "Stopped reading routes' reputation on".into(),
            kind: "chain".into(),
            result: "failed".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some(format!("{why}. The ranking stands on what both RPCs agreed before, the same blocks are read again in a while, and reading goes on once they agree; past an hour the ranking is set aside and routes are ordered without it. Check the RPCs.")),
        });
    }
    *d = Some(Disagreement { since, next: now + retry_after(tries), tries, why: why.to_string() });
}

fn note_agreement() {
    if DISAGREEING.locked().take().is_some() {
        crate::store::log_activity(&crate::store::Activity {
            at: crate::store::now(),
            who: "Node".into(),
            site: "Settlement".into(),
            what: "Reading routes' reputation on again".into(),
            kind: "chain".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some("Both RPCs' logs agree again, so the ranking is read on from where it stopped".into()),
        });
    }
}

/// Why reputation isn't being read on now, while the RPCs disagree (the owner's warning stands as long as this does).
pub fn ranking_disagrees() -> Option<String> {
    DISAGREEING.locked().as_ref().map(|d| d.why.clone())
}

/// Why the ranking is unavailable, once the RPCs have disagreed for longer than `STALE_AFTER`: the last agreed record
/// is then too old to present as current, and routes are ordered with no reputation (the fee and payer caps still bound
/// what a call can spend).
pub fn ranking_unavailable() -> Option<String> {
    DISAGREEING.locked().as_ref().filter(|d| d.since.elapsed() >= STALE_AFTER).map(|d| format!("reputation is unavailable: the RPCs have disagreed for over an hour ({})", d.why))
}

/// For a test: forget a disagreement, make its retry due now, or age it by `by`.
#[cfg(test)]
pub(crate) fn forget_disagreement() {
    *DISAGREEING.locked() = None;
}
#[cfg(test)]
pub(crate) fn retry_now() {
    if let Some(d) = DISAGREEING.locked().as_mut() {
        d.next = std::time::Instant::now();
    }
}
#[cfg(test)]
pub(crate) fn age_disagreement(by: std::time::Duration) {
    if let Some(d) = DISAGREEING.locked().as_mut() {
        d.since = d.since.checked_sub(by).unwrap_or(d.since);
    }
}

/// What the chain shows for reputation, up to the block every node agrees on: entries as listed and delisted;
/// each claimed line, every one paid from its payer's deposit; each agent key a wallet authorised; and
/// USDC sent between wallets Settlement knows (payers and contributors), the edges an audit can link payers by (R6.13).
/// Failure reports and canary sets have no place on the chain yet, so none are read.
pub async fn reputation_history(d: &Deployment) -> Result<crate::rank::reputation::History, String> {
    use crate::rank::reputation::{History, Link, Listed};
    let p = ProviderBuilder::new().connect_http(url());
    // The record is read on into a copy, kept only once that read is whole: a read that fails halfway changes nothing,
    // and no line is counted twice.
    let mut held = RECORD.lock().await;
    let mut kept = match held.take() {
        Some(r) if r.settlement == d.settlement => r,
        _ => UseRecord { settlement: d.settlement, to: d.block.saturating_sub(1), ..UseRecord::default() },
    };
    // Read on only to the head the node just followed (agreed by the second RPC when one is named), every log checked
    // against the second's over the same blocks, into a copy kept only once the whole read agrees (R10-CHAIN-2). A
    // disagreement keeps the last agreed record and tries the same blocks again after a backoff; reading goes on once
    // the two agree (R11-CHAIN-3).
    let due = DISAGREEING.locked().as_ref().is_none_or(|d| std::time::Instant::now() >= d.next);
    if due {
        let to = match history_head(&p).await {
            Ok(to) => to,
            Err(e) => {
                *held = Some(kept);
                return Err(e);
            }
        };
        if let Some(to) = to.filter(|to| *to > kept.to) {
            let mut next = kept.clone();
            match read_on(&mut next, &p, d, to).await {
                Ok(()) => {
                    kept = next;
                    note_agreement();
                }
                // The last agreed record stands, and the same blocks are read again after a while (R11-CHAIN-3).
                Err(e) if e.starts_with(LOGS_DISAGREE) || e.starts_with(LOGS_OVER_CAP) => note_disagreement(&e),
                Err(e) => {
                    *held = Some(kept);
                    return Err(e);
                }
            }
        }
    }
    if let Some(why) = ranking_unavailable() {
        *held = Some(kept);
        return Err(why);
    }
    let r = &mut kept;

    if r.listed.values().any(|e| e.1.is_empty() && e.2.is_empty()) {
        name_entries(r, &crate::listing::held_names(d));
    }
    // The canary operator was Settlement's platform (R5.9); Settlement has none since route coins (`fees.platform` = 0), so
    // no operator is disclosed and no canary set counts until one is.
    let mut h = History { canary_operator: None, ..History::default() };
    let mut ids: Vec<_> = r.listed.keys().copied().collect();
    ids.sort();
    for id in ids {
        let (contributor, domain, description, at) = r.listed[&id].clone();
        let ends = r.delisted.get(&id).into_iter().flatten().copied();
        let ended = ended_at(at, ends, r.relisted.get(&id).map(|b| b.as_slice()).unwrap_or(&[])).map(|m| m.0);
        let listed_epoch = at.0 / d.blocks_per_epoch();
        let ended_epoch = ended.map(|b| b / d.blocks_per_epoch());
        h.entries.push(Listed {
            id,
            contributor,
            site: unbrowse_learn::identity::site_of(&domain),
            what: description,
            fee: d.usdc_f(r.fees.get(&contributor).copied().unwrap_or_default()),
            listed_at: at,
            listed_epoch,
            ended_epoch,
        });
    }
    // Each entry's site's escrow claimant, where its domain has one (R5.5): the domain as listed is the one whose escrow
    // its lines fill (R4.13), keyed by the site the ranking knows the entry by.
    for (_, domain, _, _) in r.listed.values() {
        if let Some(&w) = r.claims.get(&domain_hash(domain)) {
            h.escrow_claimed.insert(unbrowse_learn::identity::site_of(domain), w);
        }
    }
    h.uses = r.uses.clone();
    h.failures = r.failures.clone();
    h.links = r.keys.iter().map(|&(wallet, agent)| Link::Key { wallet, agent }).chain(r.sent.iter().map(|&(from, to)| Link::Sent { from, to })).collect();
    *held = Some(kept);
    Ok(h)
}

/// Reads the chain's record on from `r.to` to `to`, every log through `agreed_logs`, and moves `r.to` to `to` only once
/// all of it is read.
async fn read_on(r: &mut UseRecord, p: &impl Provider, d: &Deployment, to: u64) -> Result<(), String> {
    use alloy::sol_types::SolEvent;
    let from = r.to + 1;
    // An entry is listed on the chain when a claim first shows its signed listing (`Listings.Credited`); its site
    // and description come from the listing this node holds for it, when it holds one.
    for (id, contributor, at) in credited_agreed(p, d, from, to).await? {
        let (site, what) = crate::listing::held_listing_at(d, id).map(|l| (l.listing.site, l.listing.terms.description)).unwrap_or_default();
        r.listed.insert(id, (contributor, site, what, at));
    }
    let wanted = vec![
        LeanSettlement::EntryDelisted::SIGNATURE_HASH,
        LeanSettlement::EntryRelisted::SIGNATURE_HASH,
        LeanSettlement::FeeSet::SIGNATURE_HASH,
        LeanSettlement::Claimed::SIGNATURE_HASH,
        LeanSettlement::AgentAuthorized::SIGNATURE_HASH,
    ];
    let mut found = agreed_logs(p, alloy::rpc::types::Filter::new().address(d.settlement).event_signature(wanted), from, to).await?;
    found.sort_by_key(|l| (l.block_number, l.log_index));
    for l in found {
        let block = l.block_number.unwrap_or(from);
        let mark = (block, l.log_index.unwrap_or(0));
        if let Ok(ev) = LeanSettlement::EntryDelisted::decode_log(&l.inner) {
            r.delisted.entry(ev.entryId).or_default().push(mark);
        } else if let Ok(ev) = LeanSettlement::EntryRelisted::decode_log(&l.inner) {
            r.relisted.entry(ev.entryId).or_default().push(mark);
        } else if let Ok(ev) = LeanSettlement::FeeSet::decode_log(&l.inner) {
            r.fees.insert(ev.contributor, ev.fee);
        } else if let Ok(ev) = LeanSettlement::Claimed::decode_log(&l.inner) {
            record_claim(r, &ev, d.usdc_f(ev.amount), block / d.blocks_per_epoch());
        } else if let Ok(ev) = LeanSettlement::AgentAuthorized::decode_log(&l.inner) {
            r.keys.insert((ev.payer, ev.agent));
        }
    }
    // Who claimed each domain's escrow (R5.5), from `Domains`, in chain order. A deployment made before `Domains`
    // existed has no claims.
    if d.domains != Address::ZERO {
        let wanted = vec![Domains::DomainProven::SIGNATURE_HASH];
        let mut found = agreed_logs(p, alloy::rpc::types::Filter::new().address(d.domains).event_signature(wanted), from, to).await?;
        found.sort_by_key(|l| (l.block_number, l.log_index));
        for l in found {
            record_domain_event(r, &l.inner);
        }
    }
    // USDC sent between the wallets Settlement knows. A wallet seen for the first time has its sends read from
    // Settlement's first block; the rest only over the new blocks.
    let known: std::collections::BTreeSet<Address> =
        r.uses.iter().map(|u| u.payer).chain(r.listed.values().map(|e| e.0)).filter(|a| *a != d.settlement && *a != d.pool).collect();
    let mut fresh: Vec<Address> = Vec::new();
    let mut again: Vec<Address> = Vec::new();
    for a in &known {
        match r.sends_read.get(a) {
            None => fresh.push(*a),
            Some(_) => again.push(*a),
        }
    }
    let transfer = USDC::Transfer::SIGNATURE_HASH;
    for (who, start) in [(fresh, d.block), (again, from)] {
        for chunk in who.chunks(64) {
            let senders: Vec<FixedBytes<32>> = chunk.iter().map(|a| a.into_word()).collect();
            let filter = alloy::rpc::types::Filter::new().address(d.usdc).event_signature(transfer).topic1(senders);
            for l in agreed_logs(p, filter, start, to).await? {
                if let Ok(ev) = USDC::Transfer::decode_log(&l.inner) {
                    if known.contains(&ev.to) && ev.from != ev.to {
                        r.sent.insert((ev.from, ev.to));
                    }
                }
            }
            for a in chunk {
                r.sends_read.insert(*a, to);
            }
        }
    }
    r.to = to;
    Ok(())
}

/// Every route's standings now (`rank::reputation::standings`), from the chain's own record, with nobody verified as
/// a person: no proof of personhood is chosen yet (R1.34). It takes the deployment, not the chain, so a pick can leave
/// it reading in the background when it can't wait for it.
pub async fn standings(d: Deployment) -> Result<crate::rank::reputation::Standings, String> {
    let h = reputation_history(&d).await?;
    let p = ProviderBuilder::new().connect_http(url());
    // The epoch at the head the node just followed, agreed by the second RPC when one is named.
    let now = crate::rpc::call_agreed(&p, d.settlement, &LeanSettlement::epochCall {}).await?;
    Ok(crate::rank::reputation::standings(&h, now, &crate::rank::reputation::NoProofYet))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A disagreement is tried again from 30 seconds on, doubling, never more than 15 minutes apart, and the ranking is
    /// set aside only after `STALE_AFTER` (R11-CHAIN-3).
    #[test]
    fn a_disagreement_is_tried_again_with_a_bounded_backoff() {
        assert_eq!(retry_after(0).as_secs(), 30);
        assert_eq!(retry_after(1).as_secs(), 60);
        assert_eq!(retry_after(4).as_secs(), 480);
        assert_eq!(retry_after(5).as_secs(), 900);
        assert_eq!(retry_after(40).as_secs(), 900, "never more than 15 minutes");
        assert!(STALE_AFTER > retry_after(40), "the ranking is set aside only after several tries");
    }

    /// A credit is read once, and the entry's listing can come later: the next read names the entry after it. A name
    /// the record has already stays.
    #[test]
    fn an_entry_takes_the_name_of_a_listing_read_after_its_credit() {
        let (read, unread, named) = (FixedBytes::repeat_byte(1), FixedBytes::repeat_byte(2), FixedBytes::repeat_byte(3));
        let mut r = UseRecord::default();
        for id in [read, unread] {
            r.listed.insert(id, (Address::repeat_byte(9), String::new(), String::new(), (1, 0)));
        }
        r.listed.insert(named, (Address::repeat_byte(9), "shop.example".into(), "Search items".into(), (1, 0)));
        let held = [(read, ("shop.example".to_string(), "Look up items".to_string())), (named, ("other.example".to_string(), "Other".to_string()))].into();
        name_entries(&mut r, &held);
        assert_eq!((r.listed[&read].1.as_str(), r.listed[&read].2.as_str()), ("shop.example", "Look up items"));
        assert_eq!((r.listed[&unread].1.as_str(), r.listed[&unread].2.as_str()), ("", ""), "no listing yet");
        assert_eq!(r.listed[&named].2, "Search items");
    }

    /// An entry ended by a delisting, a leaving or a conviction reads as ended, and reads as live again once it was
    /// relisted: without the relisting's own event every node held it ended for good.
    #[test]
    fn a_relisted_entry_reads_live_and_its_next_end_counts() {
        let listed = (10, 0);
        assert_eq!(ended_at(listed, [].into_iter(), &[]), None);
        assert_eq!(ended_at(listed, [(20, 1)].into_iter(), &[]), Some((20, 1)));
        assert_eq!(ended_at(listed, [(5, 0)].into_iter(), &[]), None, "before this listing");
        assert_eq!(ended_at(listed, [(20, 1)].into_iter(), &[(30, 0)]), None, "back in the live set");
        assert_eq!(ended_at(listed, [(20, 1), (40, 0), (50, 0)].into_iter(), &[(30, 0)]), Some((40, 0)), "ended again");
        assert_eq!(ended_at(listed, [(20, 1)].into_iter(), &[(20, 3)]), None, "left and listed again in one block");
    }

    /// A failed line claimed past the cap pays like a passed one, but the ranking reads it as a failure of the entry,
    /// never as a pass.
    #[test]
    fn a_claimed_failed_line_counts_as_a_failure_not_a_pass() {
        let line = |passed: bool| LeanSettlement::Claimed {
            payer: Address::repeat_byte(1),
            agent: Address::repeat_byte(2),
            entryId: FixedBytes::repeat_byte(3),
            amount: U256::from(10_000),
            index: U256::from(0),
            passed,
        };
        let mut r = UseRecord::default();
        record_claim(&mut r, &line(true), 0.01, 5);
        record_claim(&mut r, &line(false), 0.01, 5);
        assert_eq!(r.uses.len(), 1, "one pass");
        assert_eq!(r.failures, vec![crate::rank::reputation::Failure { entry: FixedBytes::repeat_byte(3), payer: Address::repeat_byte(1), epoch: 5 }]);
    }

    /// A domain's escrow is claimed by the wallet its latest DNSSEC proof names (R4.14): what decides where a
    /// contributor's reputation travels (R5.5).
    #[test]
    fn an_escrow_claimant_is_the_latest_proof() {
        use alloy::sol_types::SolEvent;
        let at = Address::repeat_byte(7);
        let log = |data: alloy::primitives::LogData| alloy::primitives::Log { address: at, data };
        let (h, a, b) = (FixedBytes::repeat_byte(1), Address::repeat_byte(0xa), Address::repeat_byte(0xb));
        let proven = |w| log(Domains::DomainProven { domainHash: h, domain: "shop.example".into(), wallet: w, releaseAt: 0 }.encode_log_data());
        let mut r = UseRecord::default();
        assert_eq!(r.claims.get(&h), None, "unproven: unclaimed");
        record_domain_event(&mut r, &proven(a));
        assert_eq!(r.claims.get(&h), Some(&a), "a proof claims it");
        record_domain_event(&mut r, &proven(b));
        assert_eq!(r.claims.get(&h), Some(&b), "a later proof replaces it");
    }
}
