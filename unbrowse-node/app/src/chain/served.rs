//! Lines other nodes' agents signed for calls this node served: owed, streamed to watchtowers, claimed, and the
//! board of what each contributor earned.

use super::*;

// ---- lines other nodes' agents signed for calls this node served ----

/// A receipt line a payer's agent signed for a call this node served, with the running voucher that covers it:
/// everything a claim needs.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaidLine {
    pub payer: Address,
    pub agent: Address,
    pub epoch: u64,
    pub cumulative: U256,
    /// The voucher's counts (R3.13): every line so far, and the passed ones. A line kept from before vouchers counted
    /// them has none, and its old signature no longer checks.
    #[serde(default)]
    pub lines: u64,
    #[serde(default)]
    pub passed_lines: u64,
    pub receipts_root: FixedBytes<32>,
    pub signature: Bytes,
    pub index: U256,
    pub entry_id: FixedBytes<32>,
    pub amount: U256,
    pub passed: bool,
    pub holders: Vec<Address>,
    /// The bounty stake and report the line names (`Bounties.naming`), zero for none (R3.14). A line kept from before
    /// lines named bounties names none.
    #[serde(default, skip_serializing_if = "U256::is_zero")]
    pub bounty: U256,
    pub proof: Vec<FixedBytes<32>>,
}

impl PaidLine {
    pub fn of(run: &Running, i: usize) -> Option<PaidLine> {
        let (l, proof) = (run.lines.get(i)?, run.proofs.get(i)?);
        let v = &run.voucher;
        Some(PaidLine {
            payer: v.payer,
            agent: v.agent,
            epoch: v.epoch,
            cumulative: v.cumulative,
            lines: v.lines,
            passed_lines: v.passedLines,
            receipts_root: v.receiptsRoot,
            signature: run.sig.clone(),
            index: l.index,
            entry_id: l.entryId,
            amount: l.amount,
            passed: l.passed,
            holders: l.holders.clone(),
            bounty: l.bounty,
            proof: proof.clone(),
        })
    }

    pub fn voucher(&self) -> LeanSettlement::Voucher {
        LeanSettlement::Voucher {
            payer: self.payer,
            agent: self.agent,
            epoch: self.epoch,
            cumulative: self.cumulative,
            lines: self.lines,
            passedLines: self.passed_lines,
            receiptsRoot: self.receipts_root,
        }
    }

    pub fn line(&self) -> LeanSettlement::Line {
        LeanSettlement::Line { index: self.index, entryId: self.entry_id, amount: self.amount, passed: self.passed, holders: self.holders.clone(), bounty: self.bounty }
    }
}

// ---- a stream handed to watchtowers, and taken from one (see `watchtower`) ----

/// An agent's stream for `epoch` as a watchtower takes it: the running voucher over every line written so far, signed
/// by the agent key, with each passed line not yet seen claimed and its proof. Everything a claim of those lines needs,
/// and nothing a tower could change: the contract checks the signature and pays the payees the lines name.
pub async fn stream(chain: &Chain, keys: &(dyn KeyStore + Sync), agent: u32, epoch: u64) -> Result<Vec<PaidLine>, String> {
    let Some(run) = running_voucher(chain, keys, agent, epoch).await? else { return Ok(vec![]) };
    let lines = receipts(agent, epoch)?;
    Ok((0..run.lines.len()).filter(|&i| lines.get(i).is_some_and(|r| r.passed && !r.claimed)).filter_map(|i| PaidLine::of(&run, i)).collect())
}

/// Checks lines a node handed this one to claim for it, before they are kept: one stream (a payer's agent, an epoch)
/// whose window is still open, each line passed, inside its voucher by its proof, within its voucher's total, and
/// signed by the voucher's agent under this deployment's Settlement, an agent the payer authorized. What only a claim
/// can tell (the deposit, the cap, a line already spent) is left to the claim, which tries each line before it pays
/// gas for it.
pub async fn check_stream(chain: &Chain, lines: &[PaidLine]) -> Result<(), String> {
    let d = chain.deployed()?;
    let Some(first) = lines.first() else { return Err("no lines".into()) };
    if lines.iter().any(|o| (o.payer, o.agent, o.epoch) != (first.payer, first.agent, first.epoch)) {
        return Err("a hand-over is one stream: one payer's agent, one epoch".into());
    }
    for o in lines {
        let (v, l) = (o.voucher(), o.line());
        let sig = alloy::primitives::Signature::try_from(o.signature.as_ref()).map_err(|e| format!("the voucher's signature doesn't read: {e}"))?;
        if sig.recover_address_from_prehash(&voucher_digest(&d, &v)).ok() != Some(v.agent) {
            return Err("the voucher isn't signed by its agent".into());
        }
        if !l.passed {
            return Err("only a passed line pays".into());
        }
        if l.amount > v.cumulative {
            return Err("the line pays more than its voucher's total".into());
        }
        if !proves(v.receiptsRoot, line_leaf(&l), &o.proof) {
            return Err("the line isn't in the voucher".into());
        }
    }
    let now = current_epoch(chain).await?;
    if first.epoch > now || first.epoch.saturating_add(1) < now {
        return Err("the voucher's epoch can't be claimed now".into());
    }
    check_voucher_key(chain, first.payer, first.agent, first.epoch).await
}

/// How long into the last epoch of a line's window its payer waits for the payees to claim before claiming what they
/// left itself, in blocks of an epoch of `length`: half of it, which leaves the other half before the window closes.
pub(super) fn backstop_wait(length: u64) -> u64 {
    length / 2
}

/// Whether a payer's line of `epoch` is the payer's to claim at block `at`, on epochs of `length` blocks: once its
/// window's last epoch is `backstop_wait` old. Before then the line is its payees' to claim (R3.22).
pub(crate) fn backstop_due(epoch: u64, at: u64, length: u64) -> bool {
    at >= epoch.saturating_add(1).saturating_mul(length).saturating_add(backstop_wait(length))
}

/// How long past a line's backstop its server waits before it takes the payer's claim as overdue (R3.22): an eighth of
/// an epoch, room for a claim pass and its block.
pub fn backstop_grace(length: u64) -> u64 {
    length / 8
}

/// The lines this node served that `payer` signed and that are still owed (unclaimed, as far as this node has seen).
pub fn owed_of(payer: Address) -> Vec<PaidLine> {
    store::read_json::<Vec<PaidLine>>(&owed_path(), &unbrowse_files::OWED).into_iter().filter(|o| o.payer == payer).collect()
}

/// Whether `payer`'s backstop claim is overdue (R3.22, spec §76.2 item 9): a line it signed for a body this node served
/// is unclaimed on the chain past its backstop and the grace after it. A payee that claims its own lines (it has gas)
/// never sees one; a server with no gas relies on the payer's backstop, and stops serving a payer that skips it. Says
/// why, and the line's spent key: a claim from anyone before the window closes still pays it (`network::stands`).
pub async fn backstop_overdue(chain: &Chain, payer: Address) -> Result<Option<(String, FixedBytes<32>)>, String> {
    let owed = owed_of(payer);
    if owed.is_empty() {
        return Ok(None);
    }
    let d = chain.deployed()?;
    let (at, length) = (chain_block(chain).await?, d.blocks_per_epoch());
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    // Passed lines only: a failed one is never charged, so no backstop owes it.
    for o in owed.iter().filter(|o| o.passed && backstop_due(o.epoch, at.saturating_sub(backstop_grace(length)), length)) {
        let key = spent_key(&o.voucher(), line_leaf(&o.line()));
        if !s.spentLine(key).call().await.map_err(|e| e.to_string())? {
            return Ok(Some((format!("its line {} of epoch {} is unclaimed past its backstop", o.index, o.epoch), key)));
        }
    }
    Ok(None)
}

/// Whether line `key` is spent, read with a witness at the final block (`spent_at`): `None` when none stood
/// behind the reading. What lifts a payer's refusal early (R8-CHAIN-3).
pub async fn line_spent_witnessed(chain: &Chain, key: FixedBytes<32>, head: &crate::rpc::Head) -> Result<Option<bool>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    spent_at(head, &p, d.settlement, key).await
}

/// One stream of a payer's (its agent and voucher epoch) that this server holds lines of, as far as the payer's
/// deposit must cover it: the highest total any voucher of it this server holds signed (its passed lines', as
/// `voucher_over` makes it: a failed line draws nothing), what the chain has paid of the stream, and what this server
/// is owed in it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Exposure {
    pub cumulative: U256,
    pub claimed: U256,
    pub owed: U256,
}

/// What a payer's deposit has to spare past one stream's signed lines and what its other streams owe this server, or
/// None when it can't cover them (issue #181). A deposit pays lines in the order they are claimed, so a payer can claim
/// lines to an entry of its own first: the stream's whole `cumulative`, less what is `claimed` of it already, and the
/// `others` it owes this server elsewhere, must all fit in what it can still spend (`spendable`).
pub fn headroom(spendable: U256, s: &Exposure, others: U256) -> Option<U256> {
    spendable.saturating_add(s.claimed).checked_sub(s.cumulative.saturating_add(others))
}

/// Whether a server releases a body of `amount` for `stream` to a payer with `spendable` and `room` left under the
/// key's cap that epoch: the stream's total with the body's line in it, and what the payer's other streams owe this
/// server, must fit in the deposit, and the stream must fit under the cap (issue #181). A stream this server holds no
/// line of is taken at what is claimed of it.
pub fn covers(spendable: U256, room: U256, streams: &[((Address, u64), Exposure)], stream: (Address, u64), amount: U256) -> Result<(), String> {
    let owed = streams.iter().fold(U256::ZERO, |a, (_, s)| a.saturating_add(s.owed));
    let mut s = streams.iter().find(|(k, _)| *k == stream).map(|(_, s)| *s).unwrap_or_default();
    let others = owed.saturating_sub(s.owed);
    s.cumulative = s.cumulative.max(s.claimed).saturating_add(amount);
    if headroom(spendable, &s, others).is_none() {
        return Err("the payer's deposit doesn't cover the lines it has signed and what it owes this server".into());
    }
    if s.cumulative.saturating_sub(s.claimed) > room {
        return Err("the lines the payer's key has signed this epoch come to more than its cap still pays".into());
    }
    Ok(())
}

/// Whether a server claims a payer's lines now rather than once they are worth their gas: for some stream, the
/// deposit's headroom has fallen below what the payer owes this server in all, so a few lines of the payer's own
/// claimed first would leave nothing for this server's (issue #181).
pub fn claim_early(spendable: U256, streams: &[Exposure]) -> bool {
    let owed = streams.iter().fold(U256::ZERO, |a, s| a.saturating_add(s.owed));
    !owed.is_zero() && streams.iter().any(|s| headroom(spendable, s, owed.saturating_sub(s.owed)).is_none_or(|h| h < owed))
}

/// `payer`'s streams still claimable in epoch `now` among the lines this server holds (`held`), and `also` though it
/// holds none of it: the highest total each one's vouchers signed, and what it is owed in each. A failed line isn't
/// counted as owed: it pays nobody. Its voucher's total still counts, as the passed lines signed before it.
pub fn streams_of(payer: Address, held: &[PaidLine], also: Option<(Address, u64)>, now: u64) -> Vec<((Address, u64), Exposure)> {
    let mut by: std::collections::BTreeMap<(Address, u64), Exposure> = std::collections::BTreeMap::new();
    if let Some(k) = also {
        by.entry(k).or_default();
    }
    for o in held.iter().filter(|o| o.payer == payer && o.epoch.saturating_add(1) >= now) {
        let s = by.entry((o.agent, o.epoch)).or_default();
        s.cumulative = s.cumulative.max(o.cumulative);
        if o.passed {
            s.owed = s.owed.saturating_add(o.amount);
        }
    }
    by.into_iter().collect()
}

/// `payer`'s spendable deposit, and its streams among `held` (`streams_of`) with what the chain has paid of each.
///
/// `head` is the operation's followed head (`rpc::Head`), where the agreed values are read.
pub async fn exposure(chain: &Chain, payer: Address, held: &[PaidLine], also: Option<(Address, u64)>, head: &crate::rpc::Head) -> Result<(U256, Vec<((Address, u64), Exposure)>), String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let now: u64 = s.epoch().call().await.map_err(|e| e.to_string())?;
    let mut streams = streams_of(payer, held, also, now);
    // At the finalized head the node just followed, agreed by the second RPC when one is named (`rpc::call_agreed`),
    // never at a block the first names alone (R9-CHAIN-1): what is claimed and what is left, and the deposit the less
    // of that and the head's.
    for ((agent, epoch), x) in streams.iter_mut() {
        x.claimed = head.call_agreed(&p, d.settlement, &LeanSettlement::claimedOfCall { payer, agent: *agent, epoch_: *epoch }).await?;
    }
    let settled = head.call_agreed(&p, d.settlement, &LeanSettlement::spendableCall { payer }).await?;
    let head = s.spendable(payer).call().await.map_err(|e| e.to_string())?;
    Ok((settled.min(head), streams))
}

pub(super) fn owed_path() -> PathBuf {
    dir().join("owed.json")
}

/// The line a payer's agent signed, by what names it: one line of one running voucher.
pub fn owed_key(o: &PaidLine) -> (Address, Address, u64, U256) {
    (o.payer, o.agent, o.epoch, o.index)
}

/// Keeps a line to claim, once. A line not kept yet is kept only if `admit` says so: for a served line, that it takes
/// the note its body's release reserved (`network::reserve_served`). That note was counted against the books' bound,
/// so a line kept here never adds to it, and one already served is never refused for want of room (R7-CHAIN-1). Under
/// the ledger's lock, as the reservation was.
pub fn owe(line: PaidLine, admit: impl FnOnce() -> bool) -> Result<(), String> {
    let _one = ledger()?;
    let mut all: Vec<PaidLine> = store::read_json_strict(&owed_path(), &unbrowse_files::OWED)?;
    if all.iter().any(|o| owed_key(o) == owed_key(&line)) {
        return Ok(());
    }
    if !admit() {
        return Err("no call this node served is waiting for that line".into());
    }
    all.push(line);
    store::write_json(&owed_path(), &unbrowse_files::OWED, &all)
}

fn unwitnessed_path() -> PathBuf {
    dir().join("unwitnessed.json")
}

/// The lines this node served that only its one RPC says can't be claimed any more (their window closed, or they were
/// paid), set aside from `owed.json` so that it stays as small as the open windows: kept, never forgotten, and claimed
/// or let go once more than one RPC's word can read them (`claim_owed`, R5-CHAIN-1).
pub fn unwitnessed_owed() -> Result<Vec<PaidLine>, String> {
    store::read_json_strict(&unwitnessed_path(), &unbrowse_files::UNWITNESSED)
}

/// The most served lines a node on a chain over the network with one RPC holds, owed and set aside together, before it
/// takes on no more (`may_take_paid_lines`): lines it can't settle there are never dropped, so the books are bounded by
/// taking no new ones, not by forgetting old ones (R6-CHAIN-3). Each is a line of about a kilobyte on disk.
pub const MAX_HELD_LINES: usize = 10_000;

/// What a server says when it takes on no more paid lines (`may_take_paid_lines`).
pub const LEDGER_FULL: &str = "this node holds as many served lines as it keeps while only its one RPC can read them: it serves no more paid calls until the owner names a second RPC (check_rpc in Settings), which settles the lines it holds";

/// Whether a server may take on another paid line, holding `held` (owed and set aside): always where a witness can
/// read them (they are then claimed or let go, and the books drain), and below `MAX_HELD_LINES` where none can.
pub fn ledger_has_room(held: usize, witnessed: bool) -> bool {
    witnessed || held < MAX_HELD_LINES
}

/// Asked before a body is released against a payment (`share::release`), so that no line is owed that the books would
/// then have to drop: an error, and the owner told once, when they are full (`ledger_has_room`).
///
/// `witnessed`: whether a witness stood behind a fresh head in this very operation (`witness_epoch` gave an epoch),
/// never whether one is configured (R9-CHAIN-1).
pub fn may_take_paid_lines(witnessed: bool) -> Result<(), String> {
    if witnessed {
        return Ok(());
    }
    if ledger_has_room(held_lines_now()?, false) {
        return Ok(());
    }
    store::tell_once(&unwitnessed_path(), &format!("The node {LEDGER_FULL}."));
    Err(LEDGER_FULL.into())
}

/// The ledger's lock, for a change elsewhere that is counted with it (`network::reserve_served_with`).
pub(crate) fn hold_ledger() -> Result<(std::sync::MutexGuard<'static, ()>, crate::store::FileHeld), String> {
    ledger()
}

/// Everything the bound counts now: the served lines owed and set aside, and the notes of bodies released whose lines
/// haven't come yet (each a reserved place, `network::reserve_served`).
pub(crate) fn held_lines_now() -> Result<usize, String> {
    let _one = ledger()?;
    Ok(held_lines_locked()? + crate::network::served_notes()?)
}

/// The served lines held, owed and set aside, read with the ledger's lock held by the caller.
pub(crate) fn held_lines_locked() -> Result<usize, String> {
    let owed: Vec<PaidLine> = store::read_json_strict(&owed_path(), &unbrowse_files::OWED)?;
    Ok(owed.len() + unwitnessed_owed()?.len())
}

/// Adds `lines` to `into`, each once by its key, in time linear in both (R6-CHAIN-3).
pub(crate) fn add_once(into: &mut Vec<PaidLine>, lines: impl IntoIterator<Item = PaidLine>) {
    let mut have: std::collections::HashSet<_> = into.iter().map(owed_key).collect();
    for l in lines {
        if have.insert(owed_key(&l)) {
            into.push(l);
        }
    }
}

/// Moves `lines` from `owed.json` to the lines set aside unwitnessed (`unwitnessed_owed`), once each.
fn set_aside_owed(lines: &[PaidLine]) -> Result<(), String> {
    let _one = ledger()?;
    let mut aside = unwitnessed_owed()?;
    add_once(&mut aside, lines.iter().cloned());
    store::write_json(&unwitnessed_path(), &unbrowse_files::UNWITNESSED, &aside)?;
    let keys: std::collections::HashSet<_> = lines.iter().map(owed_key).collect();
    let mut all: Vec<PaidLine> = store::read_json_strict(&owed_path(), &unbrowse_files::OWED)?;
    all.retain(|o| !keys.contains(&owed_key(o)));
    store::write_json(&owed_path(), &unbrowse_files::OWED, &all)
}

/// Puts every line set aside unwitnessed back among the owed, for a pass that can witness them to claim or let go.
/// Written to `owed.json` before the set-aside file is emptied, so a stop between the two leaves a line in both (read
/// once, by its key), never in neither.
fn bring_back_owed() -> Result<(), String> {
    let _one = ledger()?;
    let aside = unwitnessed_owed()?;
    if aside.is_empty() {
        return Ok(());
    }
    let mut all: Vec<PaidLine> = store::read_json_strict(&owed_path(), &unbrowse_files::OWED)?;
    add_once(&mut all, aside);
    store::write_json(&owed_path(), &unbrowse_files::OWED, &all)?;
    store::write_json(&unwitnessed_path(), &unbrowse_files::UNWITNESSED, &Vec::<PaidLine>::new())
}

/// Where a line of voucher epoch `epoch` stands for a claim pass: `now` the epoch by the node's one RPC, `seen` the
/// epoch by more than its word (`epoch_witnessed`, `None` when that can't be read now), `witnessed` whether a witness
/// can stand behind a reading at all (`rpc::witnessed`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Window {
    /// In its window by the one RPC: claimed as any line.
    Open,
    /// Outside its window by more than one RPC's word (at that epoch): let go.
    Gone(u64),
    /// Outside it by the one RPC's word alone, with no witness to ask: set aside, never let go (R5-CHAIN-1).
    SetAside,
    /// Outside it by the one RPC, and a witness hasn't read that far yet: looked at again on a later pass.
    Wait,
}

pub(crate) fn window_of(epoch: u64, now: u64, seen: Option<u64>, witnessed: bool) -> Window {
    let outside = |at: u64| at > epoch.saturating_add(1) || epoch > at;
    if !outside(now) {
        return Window::Open;
    }
    match seen {
        Some(w) if outside(w) => Window::Gone(w),
        None if !witnessed => Window::SetAside,
        _ => Window::Wait,
    }
}

/// The failed lines among `all` whose claim window has closed by epoch `now`, by their keys (`owed_key`). A server keeps a
/// failed line only while its stream can still be claimed: for the counts a later voucher of the stream signs
/// (`network::contradicts`) and the total its own voucher signed (`streams_of`). No claim sends it, so once its window
/// closes it holds nothing for anyone.
pub(crate) fn stale_failures(all: &[PaidLine], now: u64) -> Vec<(Address, Address, u64, U256)> {
    all.iter().filter(|o| !o.passed && !claimable(o.epoch, now) && o.epoch < now).map(owed_key).collect()
}

/// Whether the passed lines among `all` are worth a claim now, at a gas price of `price` and a gas share of `share`
/// (`claim_due`): `usdc` turns a line's units into USDC. A stream is over once its epoch is, judged by its passed lines
/// only: a failed line is never sent, so an old one doesn't hurry a claim.
pub(crate) fn owed_due(all: &[PaidLine], now: u64, price: u128, share: f64, usdc: impl Fn(U256) -> f64) -> bool {
    let passed: Vec<&PaidLine> = all.iter().filter(|o| o.passed).collect();
    let lines: Vec<_> = passed.iter().map(|o| o.line()).collect();
    let pays: f64 = passed.iter().map(|o| usdc(o.amount)).sum();
    claim_due(passed.len(), earners(&lines), pays, price, share, passed.iter().any(|o| o.epoch < now))
}

/// Lets go of owed lines that were claimed or can't be any more, leaving every other line, kept since or not.
pub(super) fn forget_owed(gone: &[(Address, Address, u64, U256)]) -> Result<(), String> {
    let _one = ledger()?;
    let mut all: Vec<PaidLine> = store::read_json_strict(&owed_path(), &unbrowse_files::OWED)?;
    let gone: std::collections::HashSet<_> = gone.iter().copied().collect();
    all.retain(|o| !gone.contains(&owed_key(o)));
    store::write_json(&owed_path(), &unbrowse_files::OWED, &all)
}

/// Claims the lines other nodes' agents signed for calls this node served, in one batch. Each is tried first: a
/// line already spent (its payer claimed it) or outside its claim window is dropped. One whose voucher is no longer
/// enough (later lines were claimed under a newer voucher) is kept until its window closes, since the payer's own
/// claim with the newer voucher pays it. Lines that pass alone but not together (between them they pass their
/// voucher or the payer's deposit) are claimed one by one, so none holds up the others.
///
/// Each payee claims its own lines (R3.22): this is the serving node's claim of what it served, sent as soon as the
/// lines are worth its gas (`claim_due`). A line on an entry no claim has credited yet carries the signed listing this
/// node holds for it (`Claim::showing`, `Listings.showAndClaim`). The payer's own claim is the backstop, once the
/// window is half over (`backstop_due`). Batches are sized to the node's gas as the payer's are. A payer whose deposit
/// has less to spare than it owes this server is claimed at once, whatever the gas (`claim_early`, issue #181).
pub async fn claim_owed(chain: &Chain, keys: &(dyn KeyStore + Sync), when: ClaimWhen) -> Result<Option<String>, String> {
    let _claiming = CLAIMING.lock().await;
    // Lines set aside on one RPC's word come back once a second RPC (or a chain on this machine) can read them.
    {
        let d = chain.deployed()?;
        let p = ProviderBuilder::new().connect_http(url());
        if epoch_witnessed(&p, &d).await?.is_some() {
            bring_back_owed()?;
        }
    }
    let mut all: Vec<PaidLine> = store::read_json_strict(&owed_path(), &unbrowse_files::OWED)?;
    if all.is_empty() {
        return Ok(None);
    }
    let d = chain.deployed()?;
    let read = ProviderBuilder::new().connect_http(url());
    let now: u64 = LeanSettlement::new(d.settlement, &read).epoch().call().await.map_err(|e| e.to_string())?;
    // Failed lines whose window has closed go first, whatever is claimed: no claim ever sends one, so nothing has to be
    // read spent before it goes.
    let stale = stale_failures(&all, now);
    if !stale.is_empty() {
        forget_owed(&stale)?;
        all.retain(|o| !stale.contains(&owed_key(o)));
    }
    if !all.iter().any(|o| o.passed) {
        return Ok(None);
    }
    if let ClaimWhen::Worth(share) = when {
        // The lines this node served are its own to claim (R3.22), as soon as they are worth their gas, or whatever they
        // pay once their window is closing.
        let price = crate::chain::gas_price(&read).await?;
        if !owed_due(&all, now, price, share, |a| d.usdc_f(a)) {
            // Not worth its gas yet, except the lines of a payer whose deposit has little to spare past what it owes
            // this server: those go now, before lines of its own can be claimed first (issue #181).
            let payers: std::collections::BTreeSet<Address> = all.iter().map(|o| o.payer).collect();
            let mut early = std::collections::BTreeSet::new();
            let head = follow_head(chain).await?;
            for payer in payers {
                let (spendable, streams) = exposure(chain, payer, &all, None, &head).await?;
                if claim_early(spendable, &streams.iter().map(|(_, s)| *s).collect::<Vec<_>>()) {
                    early.insert(payer);
                }
            }
            all.retain(|o| early.contains(&o.payer));
            if all.is_empty() {
                return Ok(None);
            }
        }
    }
    // Only passed lines are sent: a failed one in its window is kept for its stream's counts and pays nobody.
    all.retain(|o| o.passed);
    let paid = claim_paid(chain, keys, all, "claiming served calls", true).await?;
    forget_owed(&paid.gone.iter().chain(&paid.settled).copied().collect::<Vec<_>>())?;
    if !paid.set_aside.is_empty() {
        set_aside_owed(&paid.set_aside)?;
    }
    let told = paid.unwitnessed + paid.set_aside.len();
    if told > 0 {
        tell_unwitnessed(&format!("{told} served call{}", if told == 1 { "" } else { "s" }));
    }
    if let (None, Some(e)) = (&paid.tx, paid.failed) {
        return Err(e);
    }
    if let Some(tx) = &paid.tx {
        let total: f64 = paid.claimed.iter().map(|o| d.usdc_f(o.amount)).sum();
        store::log_activity(&Activity {
            at: store::now(),
            who: "Node".into(),
            site: "Settlement".into(),
            what: format!("Claimed {} served call{}", paid.claimed.len(), if paid.claimed.len() == 1 { "" } else { "s" }),
            kind: "claim".into(),
            result: "done".into(),
            ms: None,
            unb: Some(total),
            tx: Some(tx.clone()),
            note: Some(format!("Paid from the callers' deposits in USDC: {}", SPLIT.said())),
        });
    }
    Ok(paid.tx)
}

/// The chain's time now: the latest block's timestamp, which the contract's epochs are counted in.
pub async fn chain_block(chain: &Chain) -> Result<u64, String> {
    chain.deployed()?;
    ProviderBuilder::new().connect_http(url()).get_block_number().await.map_err(|e| e.to_string())
}

/// Claims lines this node holds as a watchtower for other nodes' payers (`watchtower`), one claim pass at a time with
/// the node's own.
pub async fn claim_for_others(chain: &Chain, keys: &(dyn KeyStore + Sync), lines: Vec<PaidLine>) -> Result<Paid, String> {
    let _claiming = CLAIMING.lock().await;
    claim_paid(chain, keys, lines, "claiming for a payer whose node is away", false).await
}

/// What a claim of lines someone else's agent signed came to.
pub struct Paid {
    /// The last transaction sent, if any was.
    pub tx: Option<String>,
    /// The lines it paid, by the receipts of its claims.
    pub claimed: Vec<PaidLine>,
    /// Of those, the ones more than one RPC's word reads spent (`spent_at`): settled, and let go. The others
    /// (`unwitnessed` of them) are kept owed (R5-CHAIN-1).
    pub settled: Vec<(Address, Address, u64, U256)>,
    pub unwitnessed: usize,
    /// The lines no claim can pay any more, by more than one RPC's word: already spent (their payer, or someone else,
    /// claimed them), or outside their window.
    pub gone: Vec<(Address, Address, u64, U256)>,
    /// The lines only the node's one RPC says are outside their window: set aside, not let go (`set_aside_owed`).
    pub set_aside: Vec<PaidLine>,
    /// The first failure, if one stopped a batch.
    pub failed: Option<String>,
}

/// Claims lines another node's agents signed, sent from this node's own key: anyone may submit a line, and it pays
/// whom it names. Each is tried first: one already spent or outside its claim window is gone. One whose voucher is no
/// longer enough (later lines were claimed under a newer voucher) is left as it is: the payer's own claim with the
/// newer voucher pays it. Lines that pass alone but not together (between them they pass their voucher or the payer's
/// deposit) are claimed one by one, so none holds up the others. Batches are sized to the node's gas as the payer's
/// are. Called with `CLAIMING` held.
pub(super) async fn claim_paid(chain: &Chain, keys: &(dyn KeyStore + Sync), all: Vec<PaidLine>, what: &'static str, served: bool) -> Result<Paid, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let s = LeanSettlement::new(d.settlement, &p);
    let now: u64 = s.epoch().call().await.map_err(|e| e.to_string())?;
    // The epoch by more than one RPC's word, when it can be read so: a line is let go as past its window only on it.
    // Whether a witness stands behind the chain now is this reading's result, never configuration (R9-CHAIN-1).
    // One head for the screening below (`rpc::Head`): one `anchor::advance`, every witnessed reading of it there.
    let mut head = crate::rpc::Head::follow(&p).await?;
    let seen_now = epoch_at(&head, &p, &d).await?;
    let witnessed = seen_now.is_some();
    let (mut todo, mut gone, mut set_aside) = (Vec::new(), Vec::new(), Vec::new());
    for o in all {
        // A long pass follows a new head once this one is past its life (`rpc::HEAD_LIFE`).
        head.renew(&p).await?;
        let (v, l) = (o.voucher(), o.line());
        let key = spent_key(&v, line_leaf(&l));
        match window_of(o.epoch, now, seen_now, witnessed) {
            Window::Open => {}
            Window::Gone(w) => {
                // A served line whose window closed unclaimed: its payer skipped its backstop (R3.22), and this server
                // stops serving it (spec §76.2 item 9). Both on more than one RPC's word.
                if served && w > o.epoch.saturating_add(1) && l.passed && spent_at(&head, &p, d.settlement, key).await? == Some(false) {
                    crate::network::refuse(o.payer, "its backstop claim never came: a line it signed went unclaimed past its window", w);
                }
                gone.push(owed_key(&o));
                continue;
            }
            Window::SetAside => {
                set_aside.push(o);
                continue;
            }
            Window::Wait => continue,
        }
        if !l.passed {
            // A failed line pays nobody and is never charged (`decide.failed-fetch-always-free`): it is held only for
            // the counts its stream signs (`network::contradicts`), never sent, and let go once its window closes.
            continue;
        }
        if s.spentLine(key).call().await.map_err(|e| e.to_string())? {
            // Let go of once the claim that spent it is final, by more than one RPC's word; until then it is kept, and
            // not sent again. On the one RPC's word alone it stays owed, and is claimed on any pass that reads it unspent.
            if spent_at(&head, &p, d.settlement, key).await? == Some(true) {
                gone.push(owed_key(&o));
            }
            continue;
        }
        if Claim::one(&v, &o.signature, &l, &o.proof).showing(chain, &p, &d).await?.takes(&p, &d).await {
            todo.push(o);
        }
    }
    let (mut tx, mut claimed, mut failed) = (None, Vec::new(), None);
    let batch_of = |part: &[PaidLine]| {
        let mut c = Claim::default();
        for o in part {
            c.push(&o.voucher(), &o.signature, &o.line(), &o.proof);
        }
        c.showing(chain, &p, &d)
    };
    let mut rest = &todo[..];
    while !rest.is_empty() {
        let ahead: Vec<_> = rest.iter().map(PaidLine::line).collect();
        let mut size = match claim_size(&p, me, &d, &ahead).await {
            Ok(n) => n,
            Err(e) => {
                failed = Some(e);
                break;
            }
        };
        while size > 1 && batch_of(&rest[..size]).await?.fits(&p, &d, me).await.is_err() {
            size /= 2;
        }
        let (part, after) = rest.split_at(size);
        rest = after;
        let batch = batch_of(part).await?;
        if batch.takes(&p, &d).await {
            let sent = batch.send(&p, &d, what).await;
            match sent {
                Ok(t) => {
                    tx = Some(t);
                    claimed.extend(part.iter().cloned());
                }
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        } else {
            for o in part {
                let one = Claim::one(&o.voucher(), &o.signature, &o.line(), &o.proof).showing(chain, &p, &d).await?;
                if let Ok(t) = one.send(&p, &d, what).await {
                    tx = Some(t);
                    claimed.push(o.clone());
                }
            }
        }
    }
    // A claim's receipt is the one RPC's word: a line it paid is settled once more than that reads it spent.
    let mut settled = Vec::new();
    // A head followed after the claims went (their blocks are past the one above), once for all of them.
    let after = if claimed.is_empty() { crate::rpc::Head::default() } else { crate::rpc::Head::follow(&p).await? };
    for o in &claimed {
        if spent_at(&after, &p, d.settlement, spent_key(&o.voucher(), line_leaf(&o.line()))).await? == Some(true) {
            settled.push(owed_key(o));
        }
    }
    let unwitnessed = claimed.len() - settled.len();
    Ok(Paid { tx, claimed, settled, unwitnessed, gone, set_aside, failed })
}

/// Settlement's payout `call` to the node's address, and with `to`, `amount` of it sent on to `to` in the same batch.
pub(super) async fn paid_out(
    p: &(impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet> + Clone),
    d: &Deployment,
    call: Bytes,
    amount: U256,
    to: Option<Address>,
    what: &str,
) -> Result<String, String> {
    use alloy::sol_types::SolCall;
    let mut calls = vec![(d.settlement, call)];
    if let Some(to) = to.filter(|_| !amount.is_zero()) {
        calls.push((d.usdc, Bytes::from(USDC::transferCall { to, value: amount }.abi_encode())));
    }
    let receipts = crate::rpc::batch(p, calls, what).await?;
    if receipts.iter().any(|r| !r.status()) {
        return Err(format!("{what} was reverted"));
    }
    Ok(tx_hash(receipts.last().ok_or_else(|| format!("{what} sent nothing"))?))
}

/// What a payer's lines can still be drawn on for: its deposit less any withdrawal it has asked for.
/// What `payer` can still spend from its deposit: the less of what the head and the final block say, so a line is
/// signed, or a body released, only against a deposit a reorg or a lagging RPC can't take back.
pub async fn spendable(chain: &Chain, payer: Address) -> Result<U256, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let head = s.spendable(payer).call().await.map_err(|e| e.to_string())?;
    // At the final block, and the same block of the owner's second RPC when there is one.
    let call = s.spendable(payer);
    let settled = crate::rpc::read_agreed(&p, d.settlement, call.calldata().clone()).await?;
    let settled = <LeanSettlement::spendableCall as alloy::sol_types::SolCall>::abi_decode_returns(&settled).map_err(|e| e.to_string())?;
    Ok(head.min(settled))
}

/// The same, in whole USDC.
pub async fn spendable_usdc(chain: &Chain, payer: Address) -> Result<f64, String> {
    let d = chain.deployed()?;
    spendable(chain, payer).await.map(|u| d.usdc_f(u))
}

#[derive(Serialize)]
pub struct BoardRow {
    pub contributor: String,
    pub entries: u64,
    pub lines: u64,
    pub earned: f64,
    pub sites: u64,
}

/// The leaderboard, from the chain's own logs: who listed entries and what their claimed lines paid them.
pub async fn board(chain: &Chain) -> Result<Vec<BoardRow>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let mut rows: std::collections::HashMap<Address, (u64, u64, f64, std::collections::HashSet<String>)> = Default::default();
    let head = p.get_block_number().await.map_err(|e| e.to_string())?;
    for (id, contributor, _) in credited(&p, &d, d.block, Some(head)).await? {
        let e = s.entry(id).call().await.map_err(|e| e.to_string())?;
        if e.contributor != contributor {
            continue;
        }
        let r = rows.entry(contributor).or_default();
        r.0 += 1;
        r.3.insert(format!("{:#x}", e.domainHash));
    }
    // The contributor's take of each claimed line; the serving share goes to whichever node served it.
    for t in crate::earnings::takes(&p, &d).await? {
        let r = rows.entry(t.contributor).or_default();
        r.1 += 1;
        r.2 += d.usdc_f(t.take);
    }
    let mut out: Vec<BoardRow> = rows
        .into_iter()
        .map(|(a, (entries, lines, earned, sites))| BoardRow { contributor: format!("{a:#x}"), entries, lines, earned, sites: sites.len() as u64 })
        .collect();
    out.sort_by(|a, b| b.lines.cmp(&a.lines).then(b.earned.total_cmp(&a.earned)));
    Ok(out)
}
