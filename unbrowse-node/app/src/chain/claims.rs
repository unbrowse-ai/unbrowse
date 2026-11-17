//! The burn batch, then the agents' own receipts, running vouchers and claims (spec §27.1): what this node's agents
//! spent, kept on disk, and claimed from Settlement.

use super::*;

/// Runs Settlement's burn batch (R4.6) once this epoch's is due: it swaps the burn buffer, a capped share of the pool
/// at a time, for UNB, and burns it. Anyone may run it, and it repays its caller from the buffer
/// for a fixed gas at the base fee plus the batch margin (`fees.batch_margin`; there is no relayer, spec §79), so the node sends it as a write it pays for itself.
/// `None` when there is nothing to send: this epoch's batch has run, the buffer holds no
/// more than the repayment, the pool can't swap (the buffer waits), or the node can't pay the gas. When `when` is
/// `Worth`, as in the claim loop, the node waits a share of the epoch drawn from its own address, so the network's
/// nodes don't all send it at the epoch's first minute; the first to send runs it and the rest find it run.
pub async fn burn_batch(chain: &Chain, keys: &(dyn KeyStore + Sync), when: ClaimWhen) -> Result<Option<String>, String> {
    // Over a v4 pool Settlement's swaps are held to the mean of the adapter's samples; a sample is due every eighth of
    // its window, whether or not a batch runs, and costs only its gas.
    let _ = note_pool_price(chain, keys).await;
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let s = LeanSettlement::new(d.settlement, &p);
    let now: u64 = s.epoch().call().await.map_err(|e| e.to_string())?;
    if U256::from(now) < s.nextBurnEpoch().call().await.map_err(|e| e.to_string())? {
        return Ok(None);
    }
    if let ClaimWhen::Worth(_) = when {
        let length = d.blocks_per_epoch();
        let at = p.get_block_number().await.map_err(|e| e.to_string())?;
        if at % length < burn_offset(me, length) {
            return Ok(None);
        }
    }
    // A dry run sees a base fee of zero, where the batch repays nothing, so it passes on a buffer the repayment would
    // swallow and the batch would revert once mined, at the node's cost, on every pass of a quiet network.
    let block = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?;
    let base_fee = block.and_then(|b| b.header.base_fee_per_gas).unwrap_or(0);
    if !batch_pays(s.burnBuffer().call().await.map_err(|e| e.to_string())?, base_fee, d.usdc_decimals) {
        return Ok(None);
    }
    // A gas estimate runs at a base fee of zero too, skips the repayment's transfer, and comes in short of what the batch
    // takes once mined. The limit is set instead: what isn't used isn't paid.
    let call = s.burnBatch().gas(BURN_BATCH_GAS);
    if call.call().await.is_err() {
        return Ok(None);
    }
    if short_of(&call, me).await?.is_some() {
        return Ok(None);
    }
    let tx = send!(call, "the burn batch");
    log("Ran the burn batch", "claim", None, &tx, Some("repaid its gas from the burn buffer".into()));
    Ok(Some(tx))
}

/// Samples the v4 pool's price on its adapter (`V4UnbPool.poke`) once a sample is due (`sampleDue`, an eighth of the
/// adapter's averaging window since the last): Settlement's swaps through it are held to the samples' mean
/// (`steadyQuoteUnbOut`), so a node keeps the samples coming. The stand-in pool sees every change to its own price and
/// has no `sampleDue`: nothing is sent.
async fn note_pool_price(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Option<String>, String> {
    let d = chain.deployed()?;
    if d.pool == Address::ZERO {
        return Ok(None);
    }
    let p = as_signer(owner_signer(keys)?).await?;
    let a = V4UnbPool::new(d.pool, &p);
    if !a.sampleDue().call().await.unwrap_or(false) {
        return Ok(None);
    }
    let call = a.poke();
    if call.call().await.is_err() {
        return Ok(None);
    }
    let tx = send!(call, "noting the pool's price");
    log("Noted the v4 pool's price", "claim", None, &tx, Some("so Settlement's next swap through it can read it".into()));
    Ok(Some(tx))
}

/// Whether a burn batch sent at a block of base fee `base_fee` leaves anything of `buffer` to swap once it has repaid its
/// caller. The contract refuses a buffer no bigger than the repayment (`ZeroAmount`). The base fee can rise by an eighth
/// from one block to the next, so the batch is judged at that, not at the block just read.
pub fn batch_pays(buffer: U256, base_fee: u64, usdc_decimals: u8) -> bool {
    let next = U256::from(base_fee) + U256::from(base_fee) / U256::from(8u8);
    let gas = U256::from(BATCH_GAS * (10_000 + BATCH_MARGIN_BPS) / 10_000);
    let per_unit = U256::from(10u8).pow(U256::from(18u8.saturating_sub(usdc_decimals)));
    next * gas / per_unit < buffer
}

/// The gas a `burnBatch` is repaid for and the margin over it (`BATCH_GAS`, `BATCH_MARGIN_BPS` in `LeanSettlement.sol`).
const BATCH_GAS: u64 = 450_000;
const BATCH_MARGIN_BPS: u64 = 1_000;

/// The gas limit the node sends `burnBatch` with: well over the 401,656 a cold batch takes through the v4 adapter, and
/// the 327,547 through the stand-in pool, both with the transaction's 21,000 (measured in the settlement's
/// `test_aBurnBatchsGasThroughThePool`), and over the 450,000 the contract repays (`BATCH_GAS` in `LeanSettlement.sol`).
pub(super) const BURN_BATCH_GAS: u64 = 600_000;

/// How far into an epoch of `length` seconds the claim loop lets `me` run the burn batch: a point in its first half,
/// drawn from the address, so that nodes spread out and one has usually run it before the next would.
pub fn burn_offset(me: Address, length: u64) -> u64 {
    let half = (length / 2).max(1);
    u64::from_be_bytes(me.0[12..20].try_into().unwrap_or_default()) % half
}

// ---- receipts, vouchers and claims (spec §27.1) ----

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub index: u64,
    pub route_id: String,
    pub amount: f64,
    pub passed: bool,
    pub claimed: bool,
    pub at: u64,
    /// The entry the line pays, by its on-chain id: another contributor's, whose body this node fetched. A line kept
    /// from before every line named its entry (when the node's agents still paid its own routes' fee) has none, and
    /// pays the entry its `route_id` names.
    #[serde(default)]
    pub entry: Option<FixedBytes<32>>,
    /// The holders the line names: the node that served the body, or none. Written with the line and never changed,
    /// so every voucher hashes it the same way and it can't be claimed once under each. A line kept from before names
    /// none.
    #[serde(default)]
    pub holders: Option<Vec<Address>>,
    /// The old bounty stake and the report on it a line named, when the payer's call was its named call (R3.14, R8.26,
    /// before route coins): kept as written, since the voucher's signature covers it, and read by nothing on chain now
    /// (`LeanSettlement.Line.bounty`). A line written now names none: bounties release by confirmation and by use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounty: Option<[u64; 2]>,
    /// Its window closed with the line unpaid, and the owner was told (`tell_lapsed`): nothing can claim it now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lapsed: bool,
    /// Claimed, by the node's one RPC's word only (its receipt of the claim, or its reading of the line as spent), with
    /// nothing more standing behind it: not `claimed`, so it stays owed and is claimed again while its window is open,
    /// until a second RPC (or a chain on this machine) reads it spent (`spent_at`), and the owner is told
    /// (R5-CHAIN-1).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unwitnessed: bool,
}

pub(super) fn receipts_path(agent: u32, epoch: u64) -> PathBuf {
    dir().join("receipts").join(format!("{agent}-{epoch}.json"))
}

/// An agent's receipt lines for a voucher epoch. A file that is there and doesn't read is an error, never an empty
/// ledger: lines already signed would be written over, and the cap and the deposit checked against nothing.
pub fn receipts(agent: u32, epoch: u64) -> Result<Vec<Receipt>, String> {
    store::read_json_strict(&receipts_path(agent, epoch), &unbrowse_files::RECEIPTS)
}

/// One writer at a time for the receipt and owed files. A change reads the file, makes itself and writes it back
/// while holding this, and is never held across a wait on the chain: a claim that waited on the chain merges what it
/// learned into the file as it stands then, so a line written while it waited is never written over.
pub(super) static LEDGER: Mutex<()> = Mutex::new(());

/// One claim pass at a time (the minute's loop, the owner's claim now), so two never submit the same lines.
pub(super) static CLAIMING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The receipt and owed files' lock: this process's, then the one every process on the chain's folder takes, held
/// together for one change. One that can't be taken is an error, and nothing is changed.
pub(super) fn ledger() -> Result<(std::sync::MutexGuard<'static, ()>, crate::store::FileHeld), String> {
    let one = LEDGER.locked();
    let file = crate::store::hold_money_file(&dir().join("ledger"), crate::store::MONEY_LOCK_WAIT)?;
    Ok((one, file))
}

/// What paid calls in flight have set aside, by (agent, voucher epoch): each took its place under the key's cap and
/// the payer's deposit before it fetched a body or reached the site (`reserve`), and gives it back when its line is
/// written or the call ends without one. Read and changed only while `LEDGER` is held, so two calls checked at once
/// each see the other's place.
pub(super) static HELD: Mutex<std::collections::BTreeMap<(u32, u64), f64>> = Mutex::new(std::collections::BTreeMap::new());

pub(super) fn held() -> std::sync::MutexGuard<'static, std::collections::BTreeMap<(u32, u64), f64>> {
    HELD.locked()
}

/// Changes an agent's receipt lines for an epoch as the file holds them now, and writes them back.
pub(super) fn edit_receipts<T>(agent: u32, epoch: u64, change: impl FnOnce(&mut Vec<Receipt>) -> Result<T, String>) -> Result<T, String> {
    let _one = ledger()?;
    let mut all = receipts(agent, epoch)?;
    let out = change(&mut all)?;
    store::write_json(&receipts_path(agent, epoch), &unbrowse_files::RECEIPTS, &all)?;
    Ok(out)
}

/// Runs `change` with the voucher epoch a change of `agent`'s payer takes effect from, at epoch `now`: this one if its
/// stream hasn't begun, else the next, since a stream keeps the payer its lines were checked against. A call in flight
/// has begun it as a line has: it took its place against that payer's deposit. A file that doesn't read may hold lines.
/// Under the lock `reserve` takes, so a place is either seen here or taken after the change, where the call sees it.
pub fn moving_payer<T>(agent: u32, now: u64, change: impl FnOnce(u64) -> T) -> T {
    // The places it reads are this process's own, and it writes no file: this process's lock is enough.
    let _one = LEDGER.locked();
    let empty = receipts(agent, now).is_ok_and(|r| r.is_empty()) && !held().contains_key(&(agent, now));
    change(if empty { now } else { now + 1 })
}

/// A paid call's place under the agent key's cap and the payer's deposit, taken before the call fetches a body or
/// reaches the site (`reserve`). Writing the call's line (`line`) spends it; dropped unspent, when the call ends
/// without a line, it is given back.
#[derive(Debug)]
pub struct Reserved {
    agent: u32,
    epoch: u64,
    amount: f64,
    spent: f64,
    cap: f64,
    deposit: f64,
    open: bool,
}

/// Takes the place one passed line of `amount` will need, for `agent` in voucher epoch `epoch`, or refuses the call
/// before it touches anything. The cap counts every line this node signed for that epoch, claimed or not, and every
/// place calls in flight hold, against the cap for that epoch; `spent` is what the contract has paid under that
/// epoch's vouchers (`agent_spend`), counted too in case lines this file doesn't hold were paid. The deposit counts
/// every unclaimed line and place in every epoch still claimable. All of it is read under the lock that writes lines,
/// so two calls checked at once can't both take the last room.
pub fn reserve(agent: u32, epoch: u64, amount: f64, spent: f64, cap: f64, deposit: f64) -> Result<Reserved, String> {
    let _one = ledger()?;
    let all = receipts(agent, epoch)?;
    let mut places = held();
    let in_flight = places.get(&(agent, epoch)).copied().unwrap_or(0.0);
    within_cap(&all, spent, cap, in_flight + amount)?;
    covered_by(&dir().join("receipts"), epoch, amount, deposit, &places, same_payer(agent, epoch))?;
    // Calls running at once each hold a place: the reservation is what keeps them from both taking the last room.
    sut_sometimes!(in_flight > 0.0, "a paid call took its place under the cap while another call held one", &serde_json::json!({ "agent": agent, "epoch": epoch }));
    *places.entry((agent, epoch)).or_default() += amount;
    Ok(Reserved { agent, epoch, amount, spent, cap, deposit, open: true })
}

impl Reserved {
    /// Writes the line of a use of another contributor's `entry`, naming the node that served its body (or none), in
    /// the place the call took, at the amount reserved, passed or failed. A failed line is never charged
    /// (`decide.failed-fetch-always-free`): it holds no room under the cap or the deposit once written. The place is
    /// given back either way. It is the only line a node writes: a route it learned itself is free to its own agents.
    pub fn network_line(mut self, entry: FixedBytes<32>, server: Option<Address>, passed: bool) -> Result<Receipt, String> {
        self.open = false;
        let _one = ledger()?;
        self.give_back();
        let written = write_line(self.agent, self.epoch, entry, server.into_iter().collect(), self.amount, passed, None, self.spent, self.cap, self.deposit);
        // The place was taken under the same lock before the call reached the site, so the cap and the deposit can't
        // refuse its line now: only a receipt file that can't be read or written can.
        if let Err(e) = &written {
            if e.contains("daily limit") || e.contains("doesn't cover") {
                sut_unreachable!("a reserved call's line was refused for the cap or the deposit after it ran", &serde_json::json!({ "agent": self.agent, "epoch": self.epoch, "passed": passed, "error": e }));
            }
        }
        written
    }

    /// Called with `LEDGER` held.
    fn give_back(&self) {
        let mut places = held();
        if let Some(h) = places.get_mut(&(self.agent, self.epoch)) {
            *h -= self.amount;
            if *h <= 1e-12 {
                places.remove(&(self.agent, self.epoch));
            }
        }
    }
}

impl Drop for Reserved {
    fn drop(&mut self) {
        if self.open {
            // Giving a place back changes only this process's places, never a file.
            let _one = LEDGER.locked();
            self.give_back();
        }
    }
}

/// Adds a receipt line for one paid detail fetch of the entry `route_id` names, its body served by no node the line
/// names. The cap and the deposit are enforced here, before anything is signed (FR-2): `deposit` is what the payer
/// can be drawn on for (`spendable`). A call that fetches a body reserves its place first (`reserve`) and writes its
/// line through it; this is the two at once.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn add_receipt(agent: u32, epoch: u64, route_id: &str, amount: f64, passed: bool, spent: f64, cap: f64, deposit: f64) -> Result<Receipt, String> {
    add_network_receipt(agent, epoch, test_entry(route_id), None, amount, passed, spent, cap, deposit)
}

/// Adds a receipt line for a use of another contributor's `entry`, whose body this node fetched and ran itself: it
/// names the node that served the body as the line's server, so the serving share pays it (R7.6). A try no node
/// served a body for names no server: it is a failed use of the entry, the request unanswered (R7.11).
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn add_network_receipt(agent: u32, epoch: u64, entry: FixedBytes<32>, server: Option<Address>, amount: f64, passed: bool, spent: f64, cap: f64, deposit: f64) -> Result<Receipt, String> {
    reserve(agent, epoch, amount, spent, cap, deposit)?.network_line(entry, server, passed)
}

/// Whether a record of voucher epoch `e`, kept on disk, can still be claimed at epoch `now`: this epoch or the last.
/// An epoch the chain hasn't reached is another deployment's: a network's records outlive its deployments, and epochs
/// count blocks (R1.28), so one made on the old timestamp epochs reads as thousands of epochs ahead, for years.
pub fn claimable(e: u64, now: u64) -> bool {
    e <= now && e.saturating_add(1) >= now
}

/// The agent and voucher epoch a receipt file holds, from its name (`<agent>-<epoch>.json`).
pub(super) fn file_stream(name: &str) -> Option<(u32, u64)> {
    let (agent, epoch) = name.strip_suffix(".json")?.rsplit_once('-')?;
    Some((agent.parse().ok()?, epoch.parse().ok()?))
}

/// Which streams draw on the deposit `agent`'s stream of `epoch` draws on: a key can pay from the node's deposit or from
/// a wallet's that granted it, and by epoch (`Agent::payer_at`), so what one payer's keys signed is no claim on another's.
fn same_payer(agent: u32, epoch: u64) -> impl Fn(u32, u64) -> bool {
    let all = crate::agents::list();
    let payer = move |a: u32, e: u64| all.iter().find(|x| x.index == a).and_then(|x| x.payer_at(e));
    let mine = payer(agent, epoch);
    move |a, e| payer(a, e) == mine
}

/// What this node's agents have signed for and not yet seen claimed, in every voucher epoch still claimable at
/// `epoch`, from the receipts kept in `folder`, of the streams `counts` names: all of it can still be drawn from their
/// payer's deposit. Passed lines only: a failed line is never charged, so it draws nothing. A file that doesn't read is
/// an error: what it holds may be drawn too, whoever's it is.
pub(super) fn unclaimed(folder: &std::path::Path, epoch: u64, counts: impl Fn(u32, u64) -> bool) -> Result<f64, String> {
    let files = match std::fs::read_dir(folder) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0.0),
        Err(e) => return Err(format!("{} doesn't read ({e})", folder.display())),
    };
    let mut owed = 0.0;
    for f in files {
        let f = f.map_err(|e| format!("{} doesn't read ({e})", folder.display()))?;
        let name = f.file_name();
        let stream = file_stream(&name.to_string_lossy());
        if !stream.is_some_and(|(a, e)| claimable(e, epoch) && counts(a, e)) {
            // A file by another name holds no stream, and one past its window (or another deployment's) can't be drawn.
            continue;
        }
        let lines: Vec<Receipt> = store::read_json_strict(&f.path(), &unbrowse_files::RECEIPTS)?;
        owed += lines.iter().filter(|r| r.passed && !r.claimed).map(|r| r.amount).sum::<f64>();
    }
    Ok(owed)
}

/// Whether the streams `counts` names (in `folder`) hold a passed line on `entry` that a bounty posted before `after`
/// (this machine's clock, as the line's own time is) counts. A bounty counts a line when it is claimed
/// (`CoinBounties.lastCounted`, which a claim sets): so a line still unclaimed and not lapsed counts, as does one
/// written after `after`, claimed or not. A file that doesn't read answers yes: the node never pays for a line on a
/// doubt (`autobounty::line_due`).
pub fn counted_line_since(folder: &std::path::Path, entry: FixedBytes<32>, after: u64, counts: impl Fn(u32, u64) -> bool) -> bool {
    let Ok(files) = std::fs::read_dir(folder) else { return false };
    for f in files {
        let Ok(f) = f else { return true };
        if !file_stream(&f.file_name().to_string_lossy()).is_some_and(|(a, e)| counts(a, e)) {
            continue;
        }
        let Ok(lines) = store::read_json_strict::<Vec<Receipt>>(&f.path(), &unbrowse_files::RECEIPTS) else { return true };
        if lines.iter().any(|r| r.entry == Some(entry) && r.passed && !r.lapsed && (!r.claimed || r.at > after)) {
            return true;
        }
    }
    false
}

/// The decimals of the USDC the deployment the node runs on counts in, as its lines are made in units of it
/// (`line_of`): what the cap and the deposit are judged in before a line is signed. Set when the deployment is taken.
static LINE_DECIMALS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(18);

pub(crate) fn set_line_decimals(decimals: u8) {
    LINE_DECIMALS.store(decimals, std::sync::atomic::Ordering::Relaxed);
}

fn line_decimals() -> u8 {
    LINE_DECIMALS.load(std::sync::atomic::Ordering::Relaxed)
}

/// What the passed lines of every stream still claimable at `epoch` that `counts` (in `folder`) leave unclaimed, in
/// units of a USDC of `decimals`, each line rounded as its voucher carries it (`usdc_fee_units`).
fn unclaimed_units(folder: &std::path::Path, epoch: u64, decimals: u8, counts: impl Fn(u32, u64) -> bool) -> Result<U256, String> {
    let files = match std::fs::read_dir(folder) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(U256::ZERO),
        Err(e) => return Err(format!("{} doesn't read ({e})", folder.display())),
    };
    let mut owed = U256::ZERO;
    for f in files {
        let f = f.map_err(|e| format!("{} doesn't read ({e})", folder.display()))?;
        if !file_stream(&f.file_name().to_string_lossy()).is_some_and(|(a, e)| claimable(e, epoch) && counts(a, e)) {
            continue;
        }
        let lines: Vec<Receipt> = store::read_json_strict(&f.path(), &unbrowse_files::RECEIPTS)?;
        owed = lines.iter().filter(|r| r.passed && !r.claimed).fold(owed, |t, r| t.saturating_add(usdc_fee_units(r.amount, decimals)));
    }
    Ok(owed)
}

/// Whether the payer's deposit still covers one more line of `amount`, on top of every line its agents signed
/// that can still be claimed (in `folder`) and every place a call in flight holds. A line past the deposit would make
/// the claim carrying it revert. Judged in the token's units, each line rounded as its voucher carries it and the
/// deposit rounded down, as the contract counts them: whole-token sums can round a line past the deposit under it.
pub(super) fn covered_by(folder: &std::path::Path, epoch: u64, amount: f64, deposit: f64, places: &std::collections::BTreeMap<(u32, u64), f64>, counts: impl Fn(u32, u64) -> bool) -> Result<(), String> {
    covered_by_in(line_decimals(), folder, epoch, amount, deposit, places, counts)
}

pub(super) fn covered_by_in(decimals: u8, folder: &std::path::Path, epoch: u64, amount: f64, deposit: f64, places: &std::collections::BTreeMap<(u32, u64), f64>, counts: impl Fn(u32, u64) -> bool) -> Result<(), String> {
    let up = |x: f64| usdc_fee_units(x, decimals);
    let held = places.iter().filter(|((a, e), _)| e + 1 >= epoch && counts(*a, *e)).fold(U256::ZERO, |t, (_, h)| t.saturating_add(up(*h)));
    let owed = unclaimed_units(folder, epoch, decimals, &counts)?.saturating_add(held);
    if owed.saturating_add(up(amount)) > usdc_units(deposit, decimals) {
        return Err(format!(
            "the balance this agent pays from (${}) doesn't cover this call on top of the ${} it already used: the owner adds funds in the Unbrowse app, under Money",
            crate::money::usdc(deposit),
            crate::money::usdc(usdc_f(owed, decimals))
        ));
    }
    Ok(())
}

/// Whether `extra` more fits under the key's cap for the epoch `all` holds the lines of: every passed line signed for it
/// counts, claimed or not, or the contract's `spent` plus the unclaimed ones if that is more (lines paid that this file
/// doesn't hold). A failed line takes nothing from the cap, so it counts for nothing. A line past the cap is one the
/// contract will never pay.
/// Judged in the token's units as the contract judges it: each line as its voucher carries it, the cap rounded down.
pub(super) fn within_cap(all: &[Receipt], spent: f64, cap: f64, extra: f64) -> Result<(), String> {
    within_cap_in(line_decimals(), all, spent, cap, extra)
}

pub(super) fn within_cap_in(decimals: u8, all: &[Receipt], spent: f64, cap: f64, extra: f64) -> Result<(), String> {
    let up = |x: f64| usdc_fee_units(x, decimals);
    let signed = all.iter().filter(|r| r.passed).fold(U256::ZERO, |t, r| t.saturating_add(up(r.amount)));
    let pending = all.iter().filter(|r| r.passed && !r.claimed).fold(U256::ZERO, |t, r| t.saturating_add(up(r.amount)));
    if signed.max(up(spent).saturating_add(pending)).saturating_add(up(extra)) > usdc_units(cap, decimals) {
        return Err(format!("this would pass this agent's daily limit of ${}: the owner can raise it in the Unbrowse app, under Money", crate::money::usdc(cap)));
    }
    Ok(())
}

/// Writes one line, with `LEDGER` held, at its real amount whether it passed or failed, and only within the cap and
/// the deposit, counting every other call's place. The call's place is judged before it is known to pass, so a failed
/// line is held to them too, though it is never charged.
#[allow(clippy::too_many_arguments)]
pub(super) fn write_line(
    agent: u32,
    epoch: u64,
    entry: FixedBytes<32>,
    holders: Vec<Address>,
    amount: f64,
    passed: bool,
    bounty: Option<[u64; 2]>,
    spent: f64,
    cap: f64,
    deposit: f64,
) -> Result<Receipt, String> {
    let mut all = receipts(agent, epoch)?;
    {
        let places = held();
        within_cap(&all, spent, cap, places.get(&(agent, epoch)).copied().unwrap_or(0.0) + amount)?;
        covered_by(&dir().join("receipts"), epoch, amount, deposit, &places, same_payer(agent, epoch))?;
    }
    let r = Receipt {
        index: all.len() as u64,
        route_id: format!("remote:{entry:#x}"),
        amount,
        passed,
        claimed: false,
        at: store::now(),
        entry: Some(entry),
        holders: Some(holders),
        bounty,
        lapsed: false,
        unwitnessed: false,
    };
    all.push(r.clone());
    // A line is written only within the cap as it stands now (an owner may have lowered the cap under lines signed
    // before; a line kept from before failed lines carried their amount adds nothing).
    sut_always_less_than_or_equal_to!(
        all.iter().map(|r| r.amount).sum::<f64>(),
        cap + 1e-9,
        "a line never takes the epoch's signed total past the key's cap",
        &serde_json::json!({ "agent": agent, "epoch": epoch, "passed": passed })
    );
    store::write_json(&receipts_path(agent, epoch), &unbrowse_files::RECEIPTS, &all)?;
    Ok(r)
}

/// A receipt line as the contract hashes it, its amount in units of a USDC of `decimals`. A receipt holds the fee it
/// paid as whole USDC, as the chain said it, so the line's units are that fee's exactly, on a deployment of any
/// decimals: a receipt file kept from before decimals were recorded makes the same lines it always did.
pub(super) fn line_of(r: &Receipt, decimals: u8) -> LeanSettlement::Line {
    LeanSettlement::Line {
        index: U256::from(r.index),
        entryId: r.entry.unwrap_or_else(|| entry_id(&r.route_id)),
        amount: usdc_fee_units(r.amount, decimals),
        passed: r.passed,
        holders: r.holders.clone().unwrap_or_default(),
        bounty: r.bounty.map_or(U256::ZERO, |[id, rid]| naming(id, rid)),
    }
}

/// The Merkle leaf the contract computes for a line (`lineLeaf`): OpenZeppelin's double hash over the line, with
/// the holders packed as 32-byte words and the bounty it names last, so the voucher's signature covers the naming.
pub fn line_leaf(l: &LeanSettlement::Line) -> FixedBytes<32> {
    use alloy::sol_types::SolValue;
    let packed: Vec<u8> = l.holders.iter().flat_map(|h| h.into_word().0).collect();
    keccak256(keccak256((l.index, l.entryId, l.amount, l.passed, keccak256(&packed), l.bounty).abi_encode_params()))
}

/// The `bounty` field of a receipt line that named old bounty stake `id` and report `rid` on it (`Bounties.naming`,
/// R3.14, before route coins): the stake's id in the high 128 bits, the report's in the low. Kept so a line written
/// then hashes as it was signed.
pub fn naming(id: u64, rid: u64) -> U256 {
    (U256::from(id) << 128) | U256::from(rid)
}

/// One claim transaction: its lines, each with its voucher, signature and proof, and the signed listings it shows
/// for entries no claim has credited yet. Sent as `claimBatch` when it shows none, else as `Listings.showAndClaim`,
/// which credits each entry to the earliest listing shown of its body (R2.18) and then claims the lines; each listing
/// carries its terms in full, so a line paying another identity's entry at least its listed price is also its payer's
/// check (R6.29). Whoever sends it pays its gas; it pays whom the lines name.
#[derive(Clone, Default)]
pub(crate) struct Claim {
    vs: Vec<LeanSettlement::Voucher>,
    sigs: Vec<Bytes>,
    lines: Vec<LeanSettlement::Line>,
    proofs: Vec<Vec<FixedBytes<32>>>,
    shown: Vec<ListingsDigest::Shown>,
    terms: Vec<Bytes>,
}

impl Claim {
    pub(super) fn push(&mut self, v: &LeanSettlement::Voucher, sig: &Bytes, l: &LeanSettlement::Line, proof: &[FixedBytes<32>]) {
        self.vs.push(v.clone());
        self.sigs.push(sig.clone());
        self.lines.push(l.clone());
        self.proofs.push(proof.to_vec());
    }

    /// A claim of one line.
    pub(super) fn one(v: &LeanSettlement::Voucher, sig: &Bytes, l: &LeanSettlement::Line, proof: &[FixedBytes<32>]) -> Claim {
        let mut c = Claim::default();
        c.push(v, sig, l, proof);
        c
    }

    /// Adds, for each entry its lines pay that no claim has credited yet, the signed listing this node holds for it:
    /// its own, or the one it fetched the body under (`listing::held_listing`). An entry it holds none for is left as
    /// it is, and a line on it is refused (`UnknownEntry`) like any line the chain won't pay.
    ///
    /// A line pays whoever the chain credits its entry to when it is claimed. So for an entry already credited, the
    /// claim carries the earliest listing of the body this node holds when it comes before the credited one
    /// (`listing::earlier_held`): a copy credited first is moved off in the same call, and the line pays the listing
    /// the chain orders first, never the copy (R2.18). Once the credit is final the chain skips it, and it costs only
    /// its calldata.
    pub(super) async fn showing(mut self, chain: &Chain, p: &impl Provider, d: &Deployment) -> Result<Claim, String> {
        let s = LeanSettlement::new(d.settlement, p);
        let mut seen = std::collections::BTreeSet::new();
        for l in &self.lines {
            if !seen.insert(l.entryId) {
                continue;
            }
            let held = if s.entry(l.entryId).call().await.map_err(|e| e.to_string())?.contributor != Address::ZERO {
                let (_, block, leaf) = super::place_of(chain, l.entryId).await?;
                crate::listing::earlier_held(chain, l.entryId, (block, leaf)).await
            } else {
                crate::listing::held_listing(chain, l.entryId)
            };
            let Some(held) = held else { continue };
            self.shown.push(held.shown()?);
            self.terms.push(Bytes::from(held.listing.terms_bytes()));
        }
        Ok(self)
    }

    fn listings_voucher(v: &LeanSettlement::Voucher) -> ListingsDigest::Voucher {
        ListingsDigest::Voucher { payer: v.payer, agent: v.agent, epoch: v.epoch, cumulative: v.cumulative, lines: v.lines, passedLines: v.passedLines, receiptsRoot: v.receiptsRoot }
    }

    fn listings_line(l: &LeanSettlement::Line) -> ListingsDigest::Line {
        ListingsDigest::Line { index: l.index, entryId: l.entryId, amount: l.amount, passed: l.passed, holders: l.holders.clone(), bounty: l.bounty }
    }

    /// Whether the chain would take it now.
    pub(super) async fn takes<P: Provider + Clone>(&self, p: &P, d: &Deployment) -> bool {
        if self.shown.is_empty() {
            return LeanSettlement::new(d.settlement, p).claimBatch(self.vs.clone(), self.sigs.clone(), self.lines.clone(), self.proofs.clone()).call().await.is_ok();
        }
        let Ok(at) = listings_of(p, d).await else { return false };
        ListingsDigest::new(at, p)
            .showAndClaim(
                self.shown.clone(),
                self.terms.clone(),
                self.vs.iter().map(Self::listings_voucher).collect(),
                self.sigs.clone(),
                self.lines.iter().map(Self::listings_line).collect(),
                self.proofs.clone(),
            )
            .call()
            .await
            .is_ok()
    }

    /// Whether `me` can pay its gas now.
    pub(super) async fn fits<P: Provider + Clone>(&self, p: &P, d: &Deployment, me: Address) -> Result<(), String> {
        if self.shown.is_empty() {
            return can_send(&LeanSettlement::new(d.settlement, p).claimBatch(self.vs.clone(), self.sigs.clone(), self.lines.clone(), self.proofs.clone()), me).await;
        }
        let at = listings_of(p, d).await?;
        let ls = ListingsDigest::new(at, p);
        let call = ls.showAndClaim(
            self.shown.clone(),
            self.terms.clone(),
            self.vs.iter().map(Self::listings_voucher).collect(),
            self.sigs.clone(),
            self.lines.iter().map(Self::listings_line).collect(),
            self.proofs.clone(),
        );
        can_send(&call, me).await
    }

    /// Sends it, signed and paid for by `p`'s key.
    pub(super) async fn send<P: Provider + WalletProvider<Wallet = crate::rpc::NodeWallet> + Clone>(&self, p: &P, d: &Deployment, what: &str) -> Result<String, String> {
        if self.shown.is_empty() {
            let s = LeanSettlement::new(d.settlement, p);
            let call = s.claimBatch(self.vs.clone(), self.sigs.clone(), self.lines.clone(), self.proofs.clone());
            // A claim may swap its withheld half through the pool, the pool's first change in its block.
            let call = match crate::chain::gas::swap_limit(&call).await { Some(g) => call.gas(g), None => call };
            return Ok(send!(call, what));
        }
        let at = listings_of(p, d).await?;
        let ls = ListingsDigest::new(at, p);
        let call = ls.showAndClaim(
            self.shown.clone(),
            self.terms.clone(),
            self.vs.iter().map(Self::listings_voucher).collect(),
            self.sigs.clone(),
            self.lines.iter().map(Self::listings_line).collect(),
            self.proofs.clone(),
        );
        sut_reachable!("a claim showed the signed listing of an entry no claim had credited", &serde_json::json!({ "listings": self.shown.len() }));
        let call = match crate::chain::gas::swap_limit(&call).await { Some(g) => call.gas(g), None => call };
        Ok(send!(call, format!("{what}, showing {} listing{} at its first claim", self.shown.len(), if self.shown.len() == 1 { "" } else { "s" })))
    }
}


/// The key the contract marks a claimed line spent under (`spentLine`).
pub fn spent_key(v: &LeanSettlement::Voucher, leaf: FixedBytes<32>) -> FixedBytes<32> {
    use alloy::sol_types::SolValue;
    keccak256((v.payer, v.agent, v.epoch, leaf).abi_encode_params())
}

/// Whether the contract has line `key` spent at `head`, the head of the operation it is part of (`rpc::Head`), by more
/// than one RPC's word: `None` when no witness stands behind that head. A line is recorded claimed, or let go, only on
/// `Some(true)`: one RPC that says a line is paid, by a receipt it serves or a reading, never makes the node forget a
/// line (R5-CHAIN-1).
pub(crate) async fn spent_at(head: &crate::rpc::Head, p: &impl Provider, settlement: Address, key: FixedBytes<32>) -> Result<Option<bool>, String> {
    head.call(p, settlement, &<LeanSettlement::spentLineCall as alloy::sol_types::SolCall>::new((key,))).await
}

/// The voucher epoch the contract is in at the chain's final block, by more than one RPC's word (`rpc::read_witnessed`):
/// `None` when that can't be witnessed now. A line is let go as past its window only on a witnessed epoch, and every
/// witnessed epoch read is kept as the latest seen (`seen_epoch`).
pub(crate) async fn epoch_witnessed(p: &impl Provider, d: &Deployment) -> Result<Option<u64>, String> {
    match crate::rpc::Head::follow(p).await {
        Ok(head) => epoch_at(&head, p, d).await,
        Err(e) if crate::rpc::halted().is_some() => Err(e),
        Err(_) => Ok(None),
    }
}

/// `epoch_witnessed` at `head`, the head of the operation it is part of (`rpc::Head`). The epoch is what expiries and
/// windows closing are judged by, where a stale head would help an attacker, so it is the later of the two heads'
/// (R10-CHAIN-1): the contract's epoch read at the head both RPCs stand behind, or the epoch at the second RPC's own
/// finalized head (`Head::latest`; the contract's epoch is `block.number / epochBlocks`), whichever is later. The
/// second's head is within `anchor::HEAD_SKEW` of the agreed one, so it can move the epoch on by one at most.
pub(crate) async fn epoch_at(head: &crate::rpc::Head, p: &impl Provider, d: &Deployment) -> Result<Option<u64>, String> {
    let Some(read) = head.call(p, d.settlement, &LeanSettlement::epochCall {}).await? else { return Ok(None) };
    let e = later_epoch(read, head.latest(), d.blocks_per_epoch());
    note_seen_epoch(e);
    Ok(Some(e))
}

/// The rule for `epoch_at`, on plain values: `read` the epoch at the agreed head, `latest` the more advanced of the two
/// finalized heads, `blocks` an epoch's length. Never more than one epoch past `read`.
pub(crate) fn later_epoch(read: u64, latest: Option<u64>, blocks: u64) -> u64 {
    latest.map_or(read, |n| read.max((n / blocks.max(1)).min(read.saturating_add(1))))
}

/// The latest voucher epoch a witness stood behind on this chain (by its folder): a cache of `epoch-floor.json`.
static SEEN_EPOCH: Mutex<Option<(PathBuf, u64)>> = Mutex::new(None);

/// The floor kept on disk (`<chain>/epoch-floor.json`): the highest epoch a witness stood behind on this deployment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EpochFloor {
    pub epoch: u64,
}

fn floor_path() -> PathBuf {
    dir().join("epoch-floor.json")
}

/// Raises the witnessed floor to `e`, never lowers it, and keeps it on disk so it outlasts a restart (R8-CHAIN-2). A
/// floor that can't be written stays raised in memory for this run.
pub(crate) fn note_seen_epoch(e: u64) {
    let mut seen = SEEN_EPOCH.locked();
    let here = dir();
    let before = match seen.as_ref() {
        Some((d, at)) if *d == here => Some(*at),
        _ => read_floor(),
    };
    let at = before.map_or(e, |b| b.max(e));
    *seen = Some((here, at));
    if before != Some(at) {
        let _ = store::write_json(&floor_path(), &unbrowse_files::EPOCH_FLOOR, &EpochFloor { epoch: at });
    }
}

/// Forgets the floor held in memory, as a restart does, for a test.
#[cfg(test)]
pub(crate) fn forget_seen_in_memory() {
    *SEEN_EPOCH.locked() = None;
}

fn read_floor() -> Option<u64> {
    store::read_json_opt::<EpochFloor>(&floor_path(), &unbrowse_files::EPOCH_FLOOR).map(|f| f.epoch)
}

/// The latest voucher epoch a witness stood behind on this chain, kept across restarts (`epoch-floor.json`): what every
/// record kept by the epoch (served notes, spent vouchers, refusals, a tower's lines) is pruned by, and what no voucher
/// may be older than, never the one RPC's word (R7-CHAIN-2, R8-CHAIN-2). It may lag the chain, which only keeps a
/// record longer; it never goes back.
pub fn seen_epoch() -> Option<u64> {
    let mut seen = SEEN_EPOCH.locked();
    let here = dir();
    if let Some((d, at)) = seen.as_ref() {
        if *d == here {
            return Some(*at);
        }
    }
    let at = read_floor()?;
    *seen = Some((here, at));
    Some(at)
}

/// The floor for a decision that serves something (`network::verify_body_voucher`): 0 when none was ever witnessed, and
/// an error, never 0, when `epoch-floor.json` is there and doesn't read, so a lost floor serves nothing old.
pub fn epoch_floor() -> Result<u64, String> {
    let kept = store::read_json_strict::<EpochFloor>(&floor_path(), &unbrowse_files::EPOCH_FLOOR)?.epoch;
    Ok(seen_epoch().unwrap_or(0).max(kept))
}

/// Reads the epoch with a witness now, raising the floor (`seen_epoch`): the epoch read, `None` when no witness stood
/// behind a reading. An error, never ignored, when the read failed for a reason that stops writes (a second RPC that
/// disagrees): a caller deciding something on the chain's epoch refuses then.
pub async fn witness_epoch(chain: &Chain) -> Result<Option<u64>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    epoch_witnessed(&p, &d).await
}

/// `witness_epoch` at `head`, the head of the operation it is part of: a release follows one head and reads every
/// witnessed value of it there (`rpc::Head`).
pub async fn witness_epoch_at(chain: &Chain, head: &crate::rpc::Head) -> Result<Option<u64>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    epoch_at(head, &p, &d).await
}

/// Follows the chain's finalized head once, for an operation that reads several witnessed values (`rpc::Head`).
pub async fn follow_head(chain: &Chain) -> Result<crate::rpc::Head, String> {
    chain.deployed()?;
    crate::rpc::Head::follow(&ProviderBuilder::new().connect_http(url())).await
}

/// Whether `proof` takes `leaf` to `root` in a sorted-pair tree, as OpenZeppelin's `MerkleProof` checks it.
pub fn proves(root: FixedBytes<32>, leaf: FixedBytes<32>, proof: &[FixedBytes<32>]) -> bool {
    let up = proof.iter().fold(leaf, |h, p| {
        if h <= *p { keccak256([h.as_slice(), p.as_slice()].concat()) } else { keccak256([p.as_slice(), h.as_slice()].concat()) }
    });
    up == root
}

pub(super) mod typed {
    alloy::sol! {
        /// The running voucher as EIP-712 types it; the same struct as the contract's `Voucher`.
        struct Voucher { address payer; address agent; uint64 epoch; uint256 cumulative; uint64 lines; uint64 passedLines; bytes32 receiptsRoot; }
    }
}

/// The EIP-712 digest the agent key signs for a running voucher: the contract's `voucherDigest`, computed here.
pub fn voucher_digest(d: &Deployment, v: &LeanSettlement::Voucher) -> FixedBytes<32> {
    use alloy::sol_types::SolStruct;
    typed::Voucher {
        payer: v.payer,
        agent: v.agent,
        epoch: v.epoch,
        cumulative: v.cumulative,
        lines: v.lines,
        passedLines: v.passedLines,
        receiptsRoot: v.receiptsRoot,
    }
    .eip712_signing_hash(&domain(d))
}

/// Sorted-pair Merkle tree over already-hashed leaves (OpenZeppelin's MerkleProof convention). Returns the root
/// and each leaf's proof.
pub(crate) fn merkle(leaves: &[FixedBytes<32>]) -> (FixedBytes<32>, Vec<Vec<FixedBytes<32>>>) {
    let pair = |a: FixedBytes<32>, b: FixedBytes<32>| if a <= b { keccak256([a.as_slice(), b.as_slice()].concat()) } else { keccak256([b.as_slice(), a.as_slice()].concat()) };
    let mut proofs: Vec<Vec<FixedBytes<32>>> = vec![Vec::new(); leaves.len()];
    let mut level: Vec<(FixedBytes<32>, Vec<usize>)> = leaves.iter().enumerate().map(|(i, l)| (*l, vec![i])).collect();
    if level.is_empty() {
        return (FixedBytes::ZERO, proofs);
    }
    while level.len() > 1 {
        let mut next = Vec::new();
        for chunk in level.chunks(2) {
            if let [a, b] = chunk {
                for &i in &a.1 {
                    proofs[i].push(b.0);
                }
                for &i in &b.1 {
                    proofs[i].push(a.0);
                }
                next.push((pair(a.0, b.0), [a.1.clone(), b.1.clone()].concat()));
            } else {
                // An odd node is carried up a level unchanged.
                next.push(chunk[0].clone());
            }
        }
        level = next;
    }
    (level[0].0, proofs)
}

/// An agent's running voucher for an epoch, over every receipt line so far, signed by the agent key; with each
/// line and its proof.
pub struct Running {
    pub voucher: LeanSettlement::Voucher,
    pub sig: Bytes,
    pub lines: Vec<LeanSettlement::Line>,
    pub proofs: Vec<Vec<FixedBytes<32>>>,
}

/// The running voucher over `lines`, unsigned. Its total is the passed lines' own units: the contract charges only
/// passed lines, each against the total, and never a failed one (`decide.failed-fetch-always-free`), so the total covers
/// every line a claim can pay and is what a server judges the payer's deposit and cap by (`covers`). It counts every
/// line and the passed ones (R3.13): the payer's own word, which the contract doesn't read and a server holding the
/// lines may check (`network::contradicts`).
pub fn voucher_over(payer: Address, agent: Address, epoch: u64, lines: &[LeanSettlement::Line], root: FixedBytes<32>) -> LeanSettlement::Voucher {
    let cumulative = lines.iter().filter(|l| l.passed).fold(U256::ZERO, |t, l| t.saturating_add(l.amount));
    let passed = lines.iter().filter(|l| l.passed).count();
    LeanSettlement::Voucher { payer, agent, epoch, cumulative, lines: lines.len() as u64, passedLines: passed as u64, receiptsRoot: root }
}

/// Signs the agent's running voucher for `epoch`, over the lines written so far: one written since waits for the
/// next voucher. Every line names its holders as it is written; one kept from before names none, as it always did.
pub async fn running_voucher(chain: &Chain, keys: &(dyn KeyStore + Sync), agent: u32, epoch: u64) -> Result<Option<Running>, String> {
    let d = chain.deployed()?;
    let receipts = receipts(agent, epoch)?;
    if receipts.is_empty() {
        return Ok(None);
    }
    let me = payer_of(keys, agent, epoch)?;
    let agent_key = agent_signer(keys, agent)?;
    let lines: Vec<_> = receipts.iter().map(|r| line_of(r, d.usdc_decimals)).collect();
    let (root, proofs) = merkle(&lines.iter().map(line_leaf).collect::<Vec<_>>());
    let voucher = voucher_over(me, agent_key.address(), epoch, &lines, root);
    let sig = agent_key.sign_hash_sync(&voucher_digest(&d, &voucher)).map_err(|e| e.to_string())?;
    Ok(Some(Running { voucher, sig: Bytes::from(sig.as_bytes().to_vec()), lines, proofs }))
}

/// The most lines one claim transaction carries. By `CLAIM_GAS` 40 lines on one entry take about 3.2 million gas, well
/// under a block, so a backlog is paid in several transactions rather than never.
pub const CLAIM_BATCH: usize = 40;

/// What a claim transaction takes in gas: once for the call, once more for each line it carries, and once for each
/// entry and payer whose route share it sends to the entry's coin (`ClaimGas::of`). Settlement gathers a call's lines by
/// (entry, payer) and calls the coin contracts once for each: the bounties' count, then the route share to `CoinFetch`,
/// which pays the coin's earlier stake and swaps the rest through UNB's pool and buys and stakes for the payer
/// (`coin.fetch-pays`); each line is then noted in `CoinStakes` (part of a line's gas). The site's share is a transfer a
/// line and the burn one buffer write a call, so nobody else is paid and the model has no per-wallet term.
///
/// The gas a claim must be SENT with is more than it uses: Settlement gives each coin leg all of its gas or reverts the
/// claim (`LowGas`: `FETCH_GAS` + a sixteenth + `ROUTE_OVERHEAD` for the route leg, about 2.1 million), so the node
/// sends a claim at its own estimate plus an eighth plus `gas::FIRST_IN_BLOCK_GAS` (`gas::swap_limit`), never at this
/// model.
#[derive(Clone, Copy, Debug)]
pub struct ClaimGas {
    pub call: u64,
    pub line: u64,
    /// Each (entry, payer) leg: the bounties' count and the fetch's pay, swap, buy and stake.
    pub earner: u64,
}

impl ClaimGas {
    /// The gas a claim of `lines` over `earners` (entry, payer) legs uses; at least one leg for any line.
    pub fn of(self, lines: usize, earners: usize) -> u64 {
        let legs = if lines == 0 { 0 } else { earners.max(1) };
        self.call.saturating_add(self.line.saturating_mul(lines as u64)).saturating_add(self.earner.saturating_mul(legs as u64))
    }

    /// The gas LIMIT a claim of that shape is sent with, which is what the chain holds the sender's balance to: what
    /// it uses, the reserve Settlement wants in hand for a coin leg before it starts one (`LEG_RESERVE`), and the
    /// margin every write that may swap is sent with (`gas::swap_limit`: an eighth more and `FIRST_IN_BLOCK_GAS`).
    /// Gas a claim doesn't use isn't paid, but a wallet that can't cover the limit can't send it.
    pub fn limit(self, lines: usize, earners: usize) -> u64 {
        let least = self.of(lines, earners).saturating_add(LEG_RESERVE);
        least.saturating_add(least / 8).saturating_add(super::gas::FIRST_IN_BLOCK_GAS)
    }
}

/// What a claim's gas limit must hold beyond what the claim uses: Settlement gives each coin leg all of its gas or
/// reverts the claim with `LowGas`, so the least limit that goes through is far above the gas used. Measured on the
/// final contracts (12 November 2026): one line used 474,056 gas and needed a limit of at least 2,329,070.
pub const LEG_RESERVE: u64 = 1_900_000;

/// The node's claim gas model: the receipts' `gasUsed` of claims the node itself sent on local Anvil
/// (`claim_gas_is_a_call_plus_its_lines`, which fails if a claim takes more than this or the model drifts far above it).
/// Measured 12 November 2026 on the final contracts (no graduation, the audit fixes in, no failure count), each leg
/// buying against the fetch's price anchors: 1, 2, 5, 10, 20 and 40 lines on one entry took 474,056, 528,093, 715,471,
/// 1,012,185, 1,631,909 and 2,889,087 gas, and 10 lines on ten entries 3,505,067; the model is 1.03 to 1.12 times
/// each, above every case, and a claim of a few lines varied by about 6,500 gas between runs. The devnet swaps through the stand-in pool:
/// on a network whose Settlement swaps through the v4 adapter a leg takes more (Settlement's own burn batch, 74,000
/// more), which the claim's sending limit covers (`gas::swap_limit`) and this model doesn't.
pub const CLAIM_GAS: ClaimGas = ClaimGas { call: 155_000, line: 70_000, earner: 275_000 };

/// The (entry, payer) legs the lines make at most: each entry once. A claim the node sends carries one payer's lines
/// (one voucher stream), and lines of several payers on one entry make one leg each, so an owed claim of many payers is
/// counted by entry and may take a little more than this; the write's own estimate is what it is sent with.
pub fn earners<'a>(lines: impl IntoIterator<Item = &'a LeanSettlement::Line>) -> usize {
    lines.into_iter().map(|l| l.entryId).collect::<std::collections::BTreeSet<_>>().len()
}

/// The share of what a batch pays its gas may cost before the claim loop sends it, until the owner says otherwise.
pub const CLAIM_GAS_SHARE: f64 = 0.10;

/// How the node sends a stream's claim: now, as the owner asks, or once it is worth sending.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ClaimWhen {
    /// Every line that can be paid, at once (the owner's `claim_now`).
    Now,
    /// Once the lines are worth their gas: at most this share of what they pay (`claim_due`).
    Worth(f64),
}

/// Whether a stream of `lines` over `earners` legs paying `pays` USDC in all is sent now, at a gas price of
/// `price` (wei, in the chain's native coin, which on Arc is USDC). Once its gas is at most `share` of what the lines
/// pay; once the lines fill a batch, since more lines would only start another; and whatever they pay once the stream
/// is `closed`, so that no line is lost by waiting.
pub fn claim_due(lines: usize, earners: usize, pays: f64, price: u128, share: f64, closed: bool) -> bool {
    if lines == 0 {
        return false;
    }
    let gas = gas_f(U256::from(price) * U256::from(CLAIM_GAS.of(lines.min(CLAIM_BATCH), earners)));
    closed || lines >= CLAIM_BATCH || gas <= share * pays
}

/// The most lines one claim may carry that `have` (wei) covers at a gas price of `price`, by the claim's sending limit
/// (`ClaimGas::limit`) at twice the price, as each write is checked (`short_of`), up to `CLAIM_BATCH`; `earners(n)` is how many wallets the first
/// `n` lines pay. Zero when it can't pay for one.
pub fn claim_fits(have: U256, price: u128, earners: impl Fn(usize) -> usize) -> usize {
    let at = U256::from(price) * U256::from(2u64);
    (1..=CLAIM_BATCH).rev().find(|&n| at * U256::from(CLAIM_GAS.limit(n, earners(n))) <= have).unwrap_or(0)
}

/// The gas the node keeps for its claims, in wei: what a full batch on two entries is sent with, at twice the gas price. A
/// deposit never moves it out of the wallet (`deposit`, `top_up`), so the node can always claim what its agents signed;
/// a batch over more entries than that is sent in smaller ones.
pub fn claim_reserve(price: u128) -> U256 {
    U256::from(price) * U256::from(CLAIM_GAS.limit(CLAIM_BATCH, 2)) * U256::from(2u64)
}

/// How many of `lines` the next claim `p` signs may carry: on a live network, what the signer's gas pays for, so a short balance sends a smaller batch rather than none; an error
/// saying where to get gas when it can't pay for one. The devnet's Anvil tops the signer up, so a full batch there.
pub(super) async fn claim_size(p: &impl Provider, me: Address, _d: &Deployment, lines: &[LeanSettlement::Line]) -> Result<usize, String> {
    let Some(l) = live() else { return Ok(CLAIM_BATCH.min(lines.len())) };
    // The price now, not one held from before: the batch is sized for a write sent now.
    let price = p.get_gas_price().await.map_err(|e| e.to_string())?;
    let have = p.get_balance(me).await.map_err(|e| e.to_string())?;
    let first = |n: usize| earners(&lines[..n.min(lines.len())]);
    match claim_fits(have, price, first).min(lines.len()) {
        0 => Err(needs_gas(l.net, me, have, U256::from(price) * U256::from(CLAIM_GAS.limit(1, first(1))) * U256::from(2u64))),
        n => Ok(n),
    }
}

/// The lines this node already said the chain won't pay, so each is told once (`claim`).
pub(super) static UNPAYABLE: Mutex<std::collections::BTreeSet<(u32, u64, u64)>> = Mutex::new(std::collections::BTreeSet::new());

/// Signs this epoch's running voucher for an agent and claims every passed line not yet spent, including lines for
/// calls other nodes served: anyone may submit a line, and it pays whom it names. A line its payee already claimed is
/// marked claimed and skipped. Each line is tried alone, and in order the lines must fit together what the deposit,
/// the key's cap for the epoch and the voucher still allow, since a batch is all or nothing: one the chain refuses
/// is left out and told, and one the deposit no longer covers is left for a later try, so neither keeps the others
/// from being paid. The rest go in batches of at most `CLAIM_BATCH`, or fewer when the node's gas pays for fewer
/// (`claim_size`), and a batch the chain would refuse whole is claimed line by line.
///
/// `when` says whether the lines go now (the owner asked) or only once they are worth their gas (`claim_due`): a
/// stream whose epoch is over takes no more lines, so waiting can't make it cheaper, and it is claimed on the first
/// pass after, a whole epoch before its window closes.
pub async fn claim(chain: &Chain, keys: &(dyn KeyStore + Sync), agent: u32, epoch: u64, when: ClaimWhen) -> Result<Option<String>, String> {
    let _claiming = CLAIMING.lock().await;
    let d = chain.deployed()?;
    // Passed lines only: a failed line pays nobody and is never charged (`decide.failed-fetch-always-free`), so a
    // stream of failures sends nothing.
    let open: Vec<Receipt> = receipts(agent, epoch)?.into_iter().filter(|r| r.passed && !r.claimed).collect();
    if open.is_empty() {
        return Ok(None);
    }
    let Some(run) = running_voucher(chain, keys, agent, epoch).await? else { return Ok(None) };
    let v = &run.voucher;
    if let ClaimWhen::Worth(share) = when {
        let read = ProviderBuilder::new().connect_http(url());
        let now: u64 = LeanSettlement::new(d.settlement, &read).epoch().call().await.map_err(|e| e.to_string())?;
        let price = crate::chain::gas_price(&read).await?;
        let owed: Vec<_> = open.iter().map(|r| line_of(r, d.usdc_decimals)).collect();
        let worth = claim_due(open.len(), earners(&owed), open.iter().map(|r| r.amount).sum(), price, share, epoch < now);
        // Each payee claims its own lines (R3.22): the serving node claims the lines it served as soon as they are
        // worth its gas (`claim_owed`). The payer's claim is the backstop, sent once the stream's window is half over
        // (`backstop_due`), for whatever no payee claimed: the lines that pay a wallet that only earns and has no gas,
        // whose first claim carries its listing (`showAndClaim`, spec §76 item 2), and lines whose receipt never
        // reached their payee.
        let (at, length) = (chain_block(chain).await?, d.blocks_per_epoch());
        let due = worth && backstop_due(epoch, at, length);
        // Passed lines are claimed within their window: the backstop never holds back a stream past half its last epoch.
        sut_always!(due || !backstop_due(epoch, at, length), "a stream past its backstop is never held back for its gas", &serde_json::json!({ "agent": agent, "epoch": epoch, "now": now, "lines": open.len() }));
        if !due {
            sut_reachable!("a payer's claim waited for its payees to claim first", &serde_json::json!({ "agent": agent, "epoch": epoch, "lines": open.len() }));
            return Ok(None);
        }
    }
    let lines: Vec<Receipt> = receipts(agent, epoch)?.into_iter().take(run.lines.len()).collect();
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let s = LeanSettlement::new(d.settlement, &p);
    let (mut todo, mut spent, mut refused, mut unlisted, mut one_rpc) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let picked: std::collections::BTreeSet<u64> = open.iter().map(|r| r.index).collect();
    let open: Vec<usize> = (0..lines.len()).filter(|&i| !lines[i].claimed && picked.contains(&lines[i].index)).collect();
    let paid = s.claimedOf(v.payer, v.agent, v.epoch).call().await.map_err(|e| e.to_string())?;
    let cap = s.termsFor(v.payer, v.agent, v.epoch).call().await.map_err(|e| e.to_string())?.capPerEpoch;
    // A line draws on the payer's whole deposit.
    let mut room = s.account(v.payer).call().await.map_err(|e| e.to_string())?.balance;
    let mut under_cap = cap.saturating_sub(paid);
    let mut under_voucher = v.cumulative.saturating_sub(paid);
    // One head for the screening below (`rpc::Head`): one `anchor::advance`, every witnessed reading of it there.
    let mut head = crate::rpc::Head::follow(&p).await?;
    for i in open {
        // A long pass follows a new head once this one is past its life (`rpc::HEAD_LIFE`).
        head.renew(&p).await?;
        let l = &run.lines[i];
        let key = spent_key(v, line_leaf(l));
        if s.spentLine(key).call().await.map_err(|e| e.to_string())? {
            // Marked claimed only once the claim that spent it is final, and more than one RPC's word says so. One in a
            // block that isn't final yet (a claim given up on before its block was) is neither marked nor sent again: a
            // later pass marks it, or claims it again if a reorg drops that block. One only the node's one RPC reads as
            // spent is kept owed, as unwitnessed: claimed again on any pass that reads it unspent.
            match spent_at(&head, &p, d.settlement, key).await? {
                Some(true) => spent.push(i),
                Some(false) => {}
                None => {
                    if s.spentLine(key).block(crate::rpc::SETTLED).call().await.map_err(|e| e.to_string())? {
                        one_rpc.push(i);
                    }
                }
            }
        } else if l.amount > room {
            // The deposit may grow again before the window closes: left for a later try.
        } else if l.amount <= under_cap && l.amount <= under_voucher && Claim::one(v, &run.sig, l, &run.proofs[i]).showing(chain, &p, &d).await?.takes(&p, &d).await {
            room -= l.amount;
            under_cap -= l.amount;
            under_voucher -= l.amount;
            todo.push(i);
        } else if unshown(chain, &s, &run.lines[i]).await? {
            unlisted.push(i);
        } else {
            refused.push(i);
        }
    }
    // Only the lines this pass settled change, in the file as it stands now: claimed where more than one RPC's word
    // reads them spent, unwitnessed (and still owed) where only the one RPC does.
    let mark = |settled: &[usize], witnessed: bool| {
        edit_receipts(agent, epoch, |all| {
            mark_lines(all, settled, witnessed);
            Ok(())
        })
    };
    mark(&spent, true)?;
    mark(&one_rpc, false)?;
    // Told of lines newly unwitnessed, not again on every pass that still reads them so.
    let mut unwitnessed = one_rpc.iter().filter(|&&i| !lines[i].unwitnessed).count();
    tell_unpayable(agent, epoch, &refused.iter().map(|&i| &lines[i]).collect::<Vec<_>>(), PAST_THE_CAP);
    tell_unpayable(agent, epoch, &unlisted.iter().map(|&i| &lines[i]).collect::<Vec<_>>(), NO_LISTING);
    let (mut tx, mut claimed, mut total, mut failed) = (None, 0usize, 0.0, None);
    let batch_of = |part: &[usize]| {
        let mut c = Claim::default();
        for &i in part {
            c.push(v, &run.sig, &run.lines[i], &run.proofs[i]);
        }
        c.showing(chain, &p, &d)
    };
    let mut rest = &todo[..];
    while !rest.is_empty() {
        // Sized as each batch goes, from the gas left after the last: by the model, then halved while the batch's own
        // estimate is more than the node can pay.
        let ahead: Vec<_> = rest.iter().map(|&i| run.lines[i].clone()).collect();
        let mut size = match claim_size(&p, me, &d, &ahead).await {
            Ok(n) => n,
            Err(e) => {
                failed.get_or_insert(e);
                break;
            }
        };
        while size > 1 && batch_of(&rest[..size]).await?.fits(&p, &d, me).await.is_err() {
            size /= 2;
        }
        let (batch, after) = rest.split_at(size);
        rest = after;
        let whole: Vec<Vec<usize>> = if batch_of(batch).await?.takes(&p, &d).await { vec![batch.to_vec()] } else { batch.iter().map(|&i| vec![i]).collect() };
        for part in whole {
            let c = batch_of(&part).await?;
            let sent = c.send(&p, &d, if part.len() == 1 { "claiming a line" } else { "claiming" }).await;
            match sent {
                Ok(t) => {
                    // The claim's receipt is the one RPC's word: each line is claimed once the contract reads it spent
                    // by more than that, and unwitnessed until then.
                    let (mut seen, mut unseen) = (Vec::new(), Vec::new());
                    // A head followed after this claim went, once for the lines it paid.
                    let after = crate::rpc::Head::follow(&p).await?;
                    for &i in &part {
                        let key = spent_key(v, line_leaf(&run.lines[i]));
                        if spent_at(&after, &p, d.settlement, key).await? == Some(true) { seen.push(i) } else { unseen.push(i) }
                    }
                    mark(&seen, true)?;
                    mark(&unseen, false)?;
                    unwitnessed += unseen.iter().filter(|&&i| !lines[i].unwitnessed).count();
                    claimed += part.len();
                    total += part.iter().map(|&i| lines[i].amount).sum::<f64>();
                    tx = Some(t);
                }
                // A claim that left the node and may still land says nothing about the line: the next pass reads it.
                Err(e) if part.len() == 1 && !crate::rpc::unsettled(&e) => {
                    tell_unpayable(agent, epoch, &[&lines[part[0]]], PAST_THE_CAP);
                    failed.get_or_insert(e);
                }
                Err(e) => {
                    failed.get_or_insert(e);
                }
            }
        }
    }
    if let Some(tx) = &tx {
        store::log_activity(&Activity {
            at: store::now(),
            who: "Node".into(),
            site: "Settlement".into(),
            what: format!("Claimed {claimed} receipt line{}", if claimed == 1 { "" } else { "s" }),
            kind: "claim".into(),
            result: "done".into(),
            ms: None,
            unb: Some(total),
            tx: Some(tx.clone()),
            note: Some(format!("Split on chain (USDC): {}", SPLIT.said())),
        });
    }
    if unwitnessed > 0 {
        tell_unwitnessed(&format!("{unwitnessed} receipt line{} of agent {agent}, epoch {epoch}", if unwitnessed == 1 { "" } else { "s" }));
    }
    match (tx, failed) {
        (None, Some(e)) => Err(e),
        (tx, _) => Ok(tx),
    }
}

/// Records the lines `settled` (by place) as a claim pass found them paid: claimed where more than one RPC's word reads
/// them spent (`witnessed`), and otherwise unwitnessed, which leaves them owed: counted against the deposit, picked by
/// the next claim pass and handed to towers like any unclaimed line (R5-CHAIN-1). A line claimed stays claimed.
pub(crate) fn mark_lines(all: &mut [Receipt], settled: &[usize], witnessed: bool) {
    for &i in settled {
        if let Some(r) = all.get_mut(i) {
            r.claimed |= witnessed;
            r.unwitnessed = !r.claimed;
        }
    }
}

/// What the owner is told of lines claimed on the node's one RPC's word (`what` names them).
pub(crate) const UNWITNESSED: &str = "only this node's one RPC says they are paid, so they are kept as owed and claimed again while their window is open, and nothing forgets them. Name a second RPC run by another operator (check_rpc in Settings) to have them read and settled";

/// Tells the owner that `what` was newly claimed on one RPC's word only (`UNWITNESSED`).
pub(crate) fn tell_unwitnessed(what: &str) {
    store::log_activity(&Activity {
        at: store::now(),
        who: "Node".into(),
        site: "Settlement".into(),
        what: format!("Claimed {what}, unwitnessed"),
        kind: "claim".into(),
        result: "unwitnessed".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("{}: {UNWITNESSED}", what)),
    });
}

/// What the owner is told of a line the chain refuses alone.
const PAST_THE_CAP: &str = "Claiming it alone is refused (past the key's cap or the voucher), so it is left out and every other line is paid";
/// What the owner is told of a line on an entry nothing has shown yet: the cap has nothing to do with it, and it can
/// still be paid.
const NO_LISTING: &str = "The chain has no entry for it yet and this node doesn't hold the signed listing that shows one, so it can't be claimed from here; every other line is paid, and the entry's own node can still show it";

/// Whether line `l` pays an entry the chain doesn't hold, whose listing this node can't show for it (`Claim::showing`).
async fn unshown(chain: &Chain, s: &LeanSettlement::LeanSettlementInstance<impl Provider>, l: &LeanSettlement::Line) -> Result<bool, String> {
    let contributor = s.entry(l.entryId).call().await.map_err(|e| e.to_string())?.contributor;
    Ok(contributor == Address::ZERO && crate::listing::held_listing(chain, l.entryId).is_none())
}

/// What a stream that closed still owes, in USDC: `lines` less what the chain paid under it (`paid`). A tower's claim
/// pays a line this node never saw go, so its own marks alone would call that line lost.
pub fn left_unpaid(lines: &[Receipt], paid: f64) -> f64 {
    (lines.iter().filter(|r| r.passed).map(|r| r.amount).sum::<f64>() - paid).max(0.0)
}

/// Whether a line of voucher epoch `epoch` can no longer be claimed at epoch `now`: its window is `epoch` and `epoch + 1`.
pub fn window_closed(epoch: u64, now: u64) -> bool {
    epoch.saturating_add(1) < now
}

/// The chain's folder and the epoch `tell_lapsed` last looked in: at most once an epoch, as windows close by the epoch.
static LAPSED_AT: Mutex<Option<(PathBuf, u64)>> = Mutex::new(None);

/// Marks the passed lines whose window closed unclaimed, and tells the owner once a stream what they leave unpaid. The
/// claim pass only visits the two epochs still open, so a node that was away through a window would otherwise say
/// nothing of lines that can never be paid. What the chain paid under the stream decides it: a tower may have claimed
/// them all, and then they are marked claimed.
pub async fn tell_lapsed(chain: &Chain, keys: &(dyn KeyStore + Sync), now: u64) -> Result<(), String> {
    let looked = (dir(), now);
    if LAPSED_AT.locked().replace(looked.clone()).as_ref() == Some(&looked) {
        return Ok(());
    }
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let Ok(files) = std::fs::read_dir(dir().join("receipts")) else { return Ok(()) };
    let agents = crate::agents::list();
    for f in files.flatten() {
        let Some((agent, epoch)) = file_stream(&f.file_name().to_string_lossy()).filter(|(_, e)| window_closed(*e, now)) else { continue };
        let lines = receipts(agent, epoch)?;
        // Lines kept unwitnessed are read again: a second RPC named since settles them.
        if !lines.iter().any(|r| r.passed && !r.claimed && !r.lapsed) {
            continue;
        }
        let Some(key) = agents.iter().find(|a| a.index == agent).and_then(|a| a.address.parse::<Address>().ok()) else { continue };
        let payer = payer_of(keys, agent, epoch)?;
        // What the chain paid under the stream decides it, read with a witness (`rpc::read_witnessed`). With none, the
        // one RPC's total is never taken, either way: no line is marked lapsed or paid, each is kept unwitnessed, and
        // the stream is read again an epoch later (R5-CHAIN-1, R6-CHAIN-1).
        let call = LeanSettlement::claimedOfCall { payer, agent: key, epoch_: epoch };
        let paid = match crate::rpc::read_witnessed(&p, d.settlement, alloy::sol_types::SolCall::abi_encode(&call).into()).await? {
            Some(got) => Some(d.usdc_f(<LeanSettlement::claimedOfCall as alloy::sol_types::SolCall>::abi_decode_returns(&got).map_err(|e| e.to_string())?)),
            None => None,
        };
        let unpaid = paid.map(|paid| left_unpaid(&lines, paid));
        edit_receipts(agent, epoch, |all| {
            settle_lapsed(all, unpaid);
            Ok(())
        })?;
        let Some(unpaid) = unpaid else { continue };
        if unpaid > 1e-12 {
            store::log_activity(&Activity {
                at: store::now(),
                who: "Node".into(),
                site: "Settlement".into(),
                what: format!("Receipt lines of epoch {epoch} were never claimed (agent {agent})"),
                kind: "claim".into(),
                result: "failed".into(),
                ms: None,
                unb: Some(unpaid),
                tx: None,
                note: Some("Their claim window closed with neither this node nor a watchtower claiming them, so what they owed the route's contributor, site and server can't be paid now. Nothing was drawn from your deposit for them".into()),
            });
        }
    }
    Ok(())
}

/// Records what a closed stream's passed, unclaimed lines came to, from `unpaid`: what the chain's witnessed total
/// (`claimedOf`) leaves of them unpaid, or `None` when no witness stood behind a reading. Something left unpaid marks
/// them lapsed, nothing left marks them claimed, and no witnessed reading marks neither: they are kept unwitnessed and
/// read again (R6-CHAIN-1).
pub(crate) fn settle_lapsed(all: &mut [Receipt], unpaid: Option<f64>) {
    for r in all.iter_mut().filter(|r| r.passed && !r.claimed) {
        match unpaid {
            Some(u) if u > 1e-12 => r.lapsed = true,
            Some(_) => {
                r.claimed = true;
                r.unwitnessed = false;
            }
            None => r.unwitnessed = true,
        }
    }
}

/// Tells the owner, once a line, that the chain won't pay a line this node signed, and `why`. The other lines are paid
/// without it.
pub(super) fn tell_unpayable(agent: u32, epoch: u64, refused: &[&Receipt], why: &str) {
    let mut told = UNPAYABLE.locked();
    for r in refused {
        if !told.insert((agent, epoch, r.index)) {
            continue;
        }
        store::log_activity(&Activity {
            at: store::now(),
            who: "Node".into(),
            site: "Settlement".into(),
            what: format!("A receipt line the chain won't pay (agent {agent}, epoch {epoch}, line {})", r.index),
            kind: "claim".into(),
            result: "failed".into(),
            ms: None,
            unb: Some(r.amount),
            tx: None,
            note: Some(why.into()),
        });
    }
}
