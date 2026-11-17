//! The fee split, the owner's wallet and earnings, the faucet, deposits and withdrawals.

use super::*;
use crate::inflight::{self, Settled};

/// How the contract splits each fee, in percent: `ROUTE_PCT` and `SITE_PCT` in `LeanSettlement.sol` (R4.1,
/// `coin.split`), and the burn, the rest. No platform and no serving node take a share (`fees.platform` = 0,
/// `fees.server` = 0). The node's one statement of it: what it reads earnings back with, and what the owner's windows
/// show. `papers/params_check.py` pins each part to `protocol/params.toml [fees]`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Split {
    /// `fees.contributor`: the route's share, which goes to the entry's coin (`coin.fetch-pays`).
    pub contributor: u8,
    /// `fees.website`.
    pub site: u8,
    /// `fees.platform`.
    pub platform: u8,
    /// `fees.server`.
    pub serving: u8,
    /// `fees.burn`.
    pub burn: u8,
}

pub const SPLIT: Split = Split { contributor: 65, site: 30, platform: 0, serving: 0, burn: 5 };

impl Split {
    /// As the activity log says it.
    pub fn said(self) -> String {
        format!(
            "{}% to the entry's route coin (paying its staked, checked holders, then buying the coin for the payer), {}% the site escrow, {}% burned",
            self.contributor, self.site, self.burn
        )
    }
}

#[derive(Serialize)]
pub struct WalletView {
    pub address: String,
    pub chain_id: u64,
    pub block: u64,
    pub epoch: u64,
    pub epoch_ends_in: u64,
    pub usdc: String,
    pub unb: String,
    pub settlement: String,
    /// Settlement's USDC in the owner's wallet. Where that USDC is the chain's gas (Arc's own), this is the gas too.
    pub held: f64,
    pub unb_held: f64,
    pub deposit: f64,
    pub pending_withdrawal: f64,
    pub withdraw_epoch: u64,
    pub earned: Earned,
    /// USDC waiting on the chain for the wallet to take: its coin stakes' earnings and what the fetch owes it as a
    /// contributor (`collect_earnings`). Claims are paid whole: nothing vests.
    pub to_claim: f64,
    /// The node's detail fee, for every route it lists, and how it moves.
    pub fee: f64,
    pub pricing: store::Pricing,
    /// How each fee is split (`SPLIT`).
    pub split: Split,
}

#[derive(Default, Serialize)]
pub struct Earned {
    /// The route share its entries' claimed lines sent to their coins, all time: the coins' money, which pays whoever
    /// stakes them (`earnings::takes`).
    pub entries: f64,
    /// USDC its coin stakes earned, claimed and to claim.
    pub staking: f64,
    /// Lines claimed for this identity's entries, all time.
    pub lines: u64,
    pub by_day: Vec<(u64, f64)>,
}

/// The seconds left in `epoch` at block `head`, on epochs of `length` blocks: what the blocks left should take at
/// `EPOCH`'s pace, for the owner to read. Never a rule: what falls due, falls due by block.
pub(crate) fn epoch_ends_in(epoch: u64, head: u64, length: u64) -> u64 {
    epoch.saturating_add(1).saturating_mul(length).saturating_sub(head).saturating_mul(EPOCH) / length.max(1)
}

pub async fn wallet(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<WalletView, String> {
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let epoch: u64 = s.epoch().call().await.map_err(|e| e.to_string())?;
    let acct = s.account(me).call().await.map_err(|e| e.to_string())?;
    let held = USDC::new(d.usdc, &p).balanceOf(me).call().await.map_err(|e| e.to_string())?;
    let unb_held = UNB::new(d.unb, &p).balanceOf(me).call().await.map_err(|e| e.to_string())?;
    let block = p.get_block_number().await.map_err(|e| e.to_string())?;
    let earnings = crate::earnings::of(chain, me).await.ok();
    Ok(WalletView {
        address: format!("{me:#x}"),
        chain_id: d.chain_id,
        block,
        epoch,
        epoch_ends_in: epoch_ends_in(epoch, block, d.blocks_per_epoch()),
        usdc: format!("{:#x}", d.usdc),
        unb: format!("{:#x}", d.unb),
        settlement: format!("{:#x}", d.settlement),
        held: d.usdc_f(held),
        unb_held: unb_f(unb_held),
        deposit: d.usdc_f(acct.balance),
        pending_withdrawal: d.usdc_f(acct.pending),
        withdraw_epoch: acct.availableAt,
        earned: earned(&p, &d, me).await.unwrap_or_default(),
        to_claim: earnings.as_ref().map_or(0.0, |e| e.to_claim),
        fee: d.usdc_f(s.feeOf(me).call().await.map_err(|e| e.to_string())?),
        pricing: store::load_pricing(),
        split: SPLIT,
    })
}

/// What the Money screen reads of the node's own wallet (`crate::money`), cheaply: no event logs. All USDC.
#[derive(Clone, Debug, Default)]
pub struct MoneyParts {
    /// Settlement's USDC at the node's address.
    pub held: f64,
    /// Its deposit, all of it, and what agents can still draw on (less a withdrawal it asked for).
    pub deposit: f64,
    pub spendable: f64,
    /// Of what is held, what the node keeps for its own network fees: where USDC is the chain's gas, at least a claim
    /// batch's gas or the owner's gas reserve; none where gas is apart (`top_up`).
    pub keep: f64,
    /// What the fetch owes the wallet as a contributor, ready to take (`collect_earnings`). A coin's stake earnings are
    /// per coin (`coins::holdings`).
    pub owed: f64,
}

pub async fn money_parts(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<MoneyParts, String> {
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let acct = s.account(me).call().await.map_err(|e| e.to_string())?;
    let held = USDC::new(d.usdc, &p).balanceOf(me).call().await.map_err(|e| e.to_string())?;
    let spendable = s.spendable(me).call().await.map_err(|e| e.to_string())?;
    let keep = match chain.network() {
        Some(net) if gas_is_usdc(net, &d) => {
            let price = crate::chain::gas_price(&p).await?;
            store::load_settings().gas_reserve_usdc.max(gas_f(claim_reserve(price)))
        }
        _ => 0.0,
    };
    let owed = if d.coins.named() { CoinFetch::new(d.coins.coin_fetch, &p).owedOf(me).call().await.map_err(|e| e.to_string())? } else { U256::ZERO };
    Ok(MoneyParts { held: d.usdc_f(held), deposit: d.usdc_f(acct.balance), spendable: d.usdc_f(spendable), keep, owed: d.usdc_f(owed) })
}

/// What this node's agents signed for and not yet seen claimed, in every voucher epoch still claimable at `epoch`:
/// already spent, though the deposit still shows it until the claim (`unclaimed`).
pub fn signed_unclaimed(epoch: u64) -> f64 {
    unclaimed(&dir().join("receipts"), epoch, |_, _| true).unwrap_or(0.0)
}

/// The same, for the keys drawing on `wallet`'s deposit in each stream (`None`, the node's own).
pub fn signed_unclaimed_on(epoch: u64, wallet: Option<Address>) -> f64 {
    unclaimed(&dir().join("receipts"), epoch, |a, e| crate::agents::payer_at(a, e) == wallet).unwrap_or(0.0)
}

/// What this identity's entries and stake earned, read back from the chain's events: the route share of each claimed
/// line of its entries ([`crate::earnings::takes`], the one reading Earnings and the leaderboard show too), by the
/// day it was claimed, and what its coin stakes earned (`earnings::of`).
pub(super) async fn earned(p: &impl Provider, d: &Deployment, me: Address) -> Result<Earned, String> {
    // A calendar day, for the owner to read: the block's date, not its epoch, which counts blocks (R1.28).
    let mut days: std::collections::BTreeMap<u64, f64> = Default::default();
    let mut blocks: std::collections::HashMap<FixedBytes<32>, u64> = Default::default();
    let mut out = Earned::default();
    for t in crate::earnings::takes(p, d).await?.into_iter().filter(|t| t.contributor == me) {
        out.entries += d.usdc_f(t.take);
        out.lines += 1;
        #[allow(clippy::map_entry)] // the value is read from the chain between the check and the insert
        if !blocks.contains_key(&t.tx) {
            let day = match p.get_transaction_receipt(t.tx).await.ok().flatten().and_then(|r| r.block_number) {
                Some(n) => p.get_block_by_number(n.into()).await.ok().flatten().map(|b| b.header.timestamp / EPOCH).unwrap_or(0),
                None => 0,
            };
            blocks.insert(t.tx, day);
        }
        *days.entry(blocks[&t.tx]).or_default() += d.usdc_f(t.take);
    }
    out.by_day = days.into_iter().collect();
    Ok(out)
}

/// Mints test UNB to the owner. On the devnet its own deployer mints; on a live network only UNB's owner can, so the
/// node's owner mints there only if they deployed it.
pub async fn faucet(chain: &Chain, keys: &(dyn KeyStore + Sync), amount: f64) -> Result<String, String> {
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    match chain.network() {
        // The devnet's deployer owns both test tokens and mints them.
        None => {
            let p = as_signer(deployer()?).await?;
            let _ = send!(USDC::new(d.usdc, &p).faucet(me, d.usdc_units(amount)), "the USDC faucet");
            let tx = send!(UNB::new(d.unb, &p).faucet(me, unb_units(amount)), "the UNB faucet");
            log("Test USDC and UNB from the devnet faucet", "deposit", Some(amount), &tx, Some("Devnet only: on Arc you fund USDC and buy UNB through the pool".into()));
            Ok(tx)
        }
        // On a live network only a token this node's owner deployed mints: the test UNB, and a test USDC where the
        // network had no USDC of its own. The network's own USDC is funded from its faucet, never minted here.
        Some(net) => {
            let read = ProviderBuilder::new().connect_http(url());
            let owner = UNB::new(d.unb, &read).owner().call().await.map_err(|e| e.to_string())?;
            if owner != me {
                return Err(format!("test UNB on {} is minted only by whoever deployed it there ({owner:#x}); this node's owner didn't", net.name));
            }
            let p = as_signer(owner_signer(keys)?).await?;
            if d.usdc != net.usdc && USDC::new(d.usdc, &read).owner().call().await.ok() == Some(me) {
                let _ = send!(USDC::new(d.usdc, &p).faucet(me, d.usdc_units(amount)), "the USDC faucet");
            }
            let tx = send!(UNB::new(d.unb, &p).faucet(me, unb_units(amount)), "the UNB faucet");
            log(&format!("Test UNB from the {} faucet", net.name), "deposit", Some(amount), &tx, Some("Minted by UNB's owner, who deployed it".into()));
            Ok(tx)
        }
    }
}

/// Whether `spender` may be given an allowance of `token`: one of the deployment's own contracts that pull tokens
/// (Settlement, USDC and UNB; the route coins' curves and the coin bounties, UNB), each an address the deployment
/// recorded when it was made or checked (`conform::check`), and one of its two tokens. Nothing else is ever approved,
/// whatever an RPC names. A route coin itself goes only through `coin_spender_allowed`. The domain proofs pull no token.
pub(crate) fn spender_allowed(d: &Deployment, spender: Address, token: Address) -> bool {
    let pulls = [d.settlement, d.coins.route_coins, d.coins.coin_bounties].into_iter().filter(|a| *a != Address::ZERO);
    let tokens = [d.unb, d.usdc].into_iter().filter(|a| *a != Address::ZERO);
    spender != Address::ZERO && pulls.into_iter().any(|a| a == spender) && tokens.into_iter().any(|t| t == token)
}

/// Whether `spender` may be given an allowance of the route coin `coin`: only the deployment's verified curves (a sale)
/// and stakes (a stake), and only for a coin proven its entry's clone of the verified implementation
/// (`coins::verify_coin`, the only maker of a `VerifiedCoin`).
pub(crate) fn coin_spender_allowed(d: &Deployment, spender: Address, coin: &super::coins::VerifiedCoin) -> bool {
    let pulls = [d.coins.route_coins, d.coins.coin_stakes].into_iter().filter(|a| *a != Address::ZERO);
    spender != Address::ZERO && coin.coin != Address::ZERO && pulls.into_iter().any(|a| a == spender)
}

/// The allowance to set so that `amount` is exactly what may be pulled: `None` when it already is.
pub(crate) fn allowance_to_set(allowed: U256, amount: U256) -> Option<U256> {
    (allowed != amount).then_some(amount)
}

/// An allowance the node set and couldn't confirm taken back: retried before any other approval (`approve`), and the
/// owner told.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingReset {
    pub spender: Address,
    pub token: Address,
    pub at: u64,
}

fn resets_path() -> PathBuf {
    dir().join("allowance-resets.json")
}

/// The allowances still to take back.
pub fn pending_resets() -> Result<Vec<PendingReset>, String> {
    store::read_json_strict(&resets_path(), &unbrowse_files::ALLOWANCE_RESETS)
}

/// Keeps `spender`'s allowance of `token` as one to take back, once, and tells the owner. Under the file's lock across
/// processes; a record that can't be kept is an error.
pub(crate) fn note_pending_reset(spender: Address, token: Address, why: &str) -> Result<(), String> {
    let _file = store::hold_money_file(&resets_path(), store::MONEY_LOCK_WAIT)?;
    let mut all = pending_resets()?;
    if !all.iter().any(|r| r.spender == spender && r.token == token) {
        all.push(PendingReset { spender, token, at: store::now() });
        store::write_json(&resets_path(), &unbrowse_files::ALLOWANCE_RESETS, &all)?;
        store::tell_once(&resets_path(), &format!("{spender:#x} may still pull {token:#x} from this wallet: taking its allowance back didn't confirm ({why}). The node takes it back before it approves anything else"));
    }
    Ok(())
}

fn clear_pending_reset(spender: Address, token: Address) -> Result<(), String> {
    let _file = store::hold_money_file(&resets_path(), store::MONEY_LOCK_WAIT)?;
    let mut all = pending_resets()?;
    let had = all.len();
    all.retain(|r| !(r.spender == spender && r.token == token));
    if all.len() != had {
        store::write_json(&resets_path(), &unbrowse_files::ALLOWANCE_RESETS, &all)?;
    }
    Ok(())
}

/// Whether taking an allowance back is done: the write went (`sent`) and the allowance reads nothing at the chain's
/// final block (`after`). Anything less is a reset still owed.
pub fn reset_done(sent: bool, after: Option<U256>) -> bool {
    sent && after == Some(U256::ZERO)
}

/// `spender`'s allowance of `token` from `me` at the chain's final block, checked against the owner's second RPC
/// when there is one (`rpc::read_agreed`).
async fn allowance_settled(p: &impl Provider, spender: Address, token: Address, me: Address) -> Result<U256, String> {
    use alloy::sol_types::SolCall;
    let data = UNB::allowanceCall { owner: me, spender }.abi_encode();
    let got = crate::rpc::read_agreed(p, token, data.into()).await?;
    UNB::allowanceCall::abi_decode_returns(&got).map_err(|e| e.to_string())
}

/// `spender`'s allowance of `token` from `me` at the chain's final block, by a reading a witness stood behind
/// (`rpc::read_witnessed`): `None` when none did. A reset owed is cleared only on this value (R6-CHAIN-2).
async fn allowance_witnessed(p: &impl Provider, spender: Address, token: Address, me: Address) -> Result<Option<U256>, String> {
    use alloy::sol_types::SolCall;
    let data = UNB::allowanceCall { owner: me, spender }.abi_encode();
    let Some(got) = crate::rpc::read_witnessed(p, token, data.into()).await? else { return Ok(None) };
    UNB::allowanceCall::abi_decode_returns(&got).map(Some).map_err(|e| e.to_string())
}

/// Lets `spender`, one of the deployment's contracts (`spender_allowed`), pull exactly `amount` of `token` from the
/// owner, for the one write that needs it: an allowance above it, an unlimited one an older node left included, is
/// brought down to it, and it reads as that at the chain's final block before the write goes. Every allowance still to
/// take back (`pending_resets`) is taken back first; one that won't be refuses this one. The write that pulls it spends
/// it; `take_back_allowance` takes back whatever that write didn't. A USDC deposit needs none (`deposit`, EIP-3009).
/// UNB has the ERC-20 allowance ABI USDC's binding names.
pub(crate) async fn approve(p: &(impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet>), d: &Deployment, spender: Address, token: Address, me: Address, amount: U256) -> Result<(), String> {
    if !spender_allowed(d, spender, token) {
        return Err(format!("{spender:#x} isn't one of this deployment's contracts, so no allowance of {token:#x} goes to it"));
    }
    set_allowance(p, spender, token, me, amount).await
}

/// `approve` for a route coin: only to the verified curves or stakes (`coin_spender_allowed`), for exactly `amount`.
pub(crate) async fn approve_coin(p: &(impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet>), d: &Deployment, spender: Address, coin: &super::coins::VerifiedCoin, me: Address, amount: U256) -> Result<(), String> {
    if !coin_spender_allowed(d, spender, coin) {
        return Err(format!("{spender:#x} isn't the deployment's curves or stakes, so no allowance of the coin {:#x} goes to it", coin.coin));
    }
    set_allowance(p, spender, coin.coin, me, amount).await
}

/// Sets exactly `amount` of `token` for `spender`, once every allowance still owed back is taken back, and reads it back.
async fn set_allowance(p: &(impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet>), spender: Address, token: Address, me: Address, amount: U256) -> Result<(), String> {
    for r in pending_resets()? {
        take_back_allowance(p, r.spender, r.token, me).await.map_err(|e| format!("an allowance still to take back comes first: {e}"))?;
    }
    let t = UNB::new(token, p);
    let allowed = t.allowance(me, spender).call().await.map_err(|e| e.to_string())?;
    if let Some(to) = allowance_to_set(allowed, amount) {
        let _ = send!(t.approve(spender, to), "approving the token");
        let now = allowance_settled(p, spender, token, me).await?;
        if now != to {
            note_pending_reset(spender, token, "the approval didn't read back")?;
            return Err(format!("the allowance of {token:#x} for {spender:#x} reads {now} after approving {to}, so nothing that needs it was sent"));
        }
    }
    Ok(())
}

/// Takes back what is left of `spender`'s allowance of `token`, once the write it was for is over, landed or not: no
/// allowance outlives the write it was given for. Done only when the allowance reads nothing at the chain's final
/// block (`reset_done`); otherwise it is kept as owed (`note_pending_reset`), the owner told, and an error returned.
pub(crate) async fn take_back_allowance(p: &(impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet>), spender: Address, token: Address, me: Address) -> Result<(), String> {
    let t = UNB::new(token, p);
    let allowed = t.allowance(me, spender).call().await.map_err(|e| e.to_string())?;
    let sent: Result<(), String> = async {
        if !allowed.is_zero() {
            let _ = send!(t.approve(spender, U256::ZERO), "taking back the token's allowance");
        }
        Ok(())
    }
    .await;
    let after = allowance_settled(p, spender, token, me).await.ok();
    if reset_done(sent.is_ok(), after) {
        // Let go of only on a reading of the allowance a witness stood behind (R5-CHAIN-1, R6-CHAIN-2), never because one
        // is named. Otherwise it is kept as still to take back, read again before every approval, and the owner told;
        // nothing waits on it meanwhile.
        if reset_done(true, allowance_witnessed(p, spender, token, me).await.ok().flatten()) {
            return clear_pending_reset(spender, token);
        }
        return note_pending_reset(spender, token, "only the node's one RPC reads it as nothing; name a second RPC to have it confirmed");
    }
    let why = match (&sent, after) {
        (Err(e), _) => e.clone(),
        (Ok(()), Some(left)) => format!("it reads {left} at the final block"),
        (Ok(()), None) => "its allowance couldn't be read back".into(),
    };
    note_pending_reset(spender, token, &why)?;
    Err(format!("taking back the allowance of {token:#x} for {spender:#x}: {why}; it is taken back before anything else is approved"))
}

pub async fn deposit(chain: &Chain, keys: &(dyn KeyStore + Sync), amount: f64) -> Result<String, String> {
    let d = chain.deployed()?;
    let signer = owner_signer(keys)?;
    let me = signer.address();
    let p = as_signer(signer).await?;
    // An earlier deposit may still land, and the chain takes a second as a second. Asked again for what already went in,
    // this is that deposit.
    match inflight::settle(&p, DEPOSIT).await? {
        Settled::Clear => {}
        Settled::Waiting(s) => return Err(format!("an earlier deposit of {} USDC ({:#x}) isn't mined yet, so nothing more was sent: the node looks at it again each pass", s.amount, s.tx)),
        Settled::Landed(s, r) => {
            let tx = tx_hash(&r);
            log("Moved USDC into your agents' deposit", "deposit", Some(s.amount), &tx, None);
            inflight::done(DEPOSIT)?;
            if s.amount == amount {
                return Ok(tx);
            }
        }
    }
    // Where Settlement's USDC is the chain's gas, the deposit and the gas are one balance: a deposit never takes what
    // the node keeps to claim a full batch of what its agents signed (`claim_reserve`).
    if let Some(net) = chain.network().filter(|n| gas_is_usdc(n, &d)) {
        let have = p.get_balance(me).await.map_err(|e| e.to_string())?;
        let price = crate::chain::gas_price(&p).await?;
        let keep = claim_reserve(price);
        if have < keep {
            return Err(needs_gas(net, me, have, keep));
        }
        if have.saturating_sub(gas_units(amount)) < keep {
            sut_reachable!("a deposit was refused to keep the gas a full claim batch needs");
            let most = d.usdc_f(d.usdc_units(gas_f(have.saturating_sub(keep))));
            return Err(format!(
                "{me:#x} has {} USDC on {}, which is its gas too, and keeps {} of it for gas: it can deposit at most {most}",
                gas_f(have),
                net.name,
                gas_f(keep)
            ));
        }
    }
    let units = d.usdc_units(amount);
    // One call, and no approval first: the key signs USDC's EIP-3009 authorisation for Settlement to pull the deposit
    // (Arc's USDC has `receiveWithAuthorization`, and so does the devnet's), naming its own account as the one credited.
    use alloy::sol_types::SolCall;
    let mut salt = [0u8; 32];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    let salt = FixedBytes::from(salt);
    // Valid by the chain's clock, which USDC judges it by: a devnet moved on by `advance_day` runs ahead of this
    // machine's, where an authorisation timed by the machine's clock has already expired.
    let chain_now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.ok().flatten().map(|b| b.header.timestamp).unwrap_or(0);
    let valid_before = U256::from(store::now().max(chain_now) + DEPOSIT_AUTH_SECS);
    let domain = usdc_domain(&p, &d).await?;
    let sig = deposit_authorization(p.wallet().key(), domain, d.settlement, me, units, valid_before, salt)?;
    let call = LeanSettlement::depositWithAuthorizationCall { from: me, to: me, amount: units, validBefore: valid_before, salt, sig };
    let call = alloy::contract::CallBuilder::new_raw(&p, Bytes::from(call.abi_encode())).to(d.settlement);
    // What a deposit changes: the account's balance in Settlement.
    let watch = (d.settlement, LeanSettlement::new(d.settlement, &p).account(me).calldata().clone());
    let receipt = crate::rpc::once!(call, DEPOSIT, amount, None, watch, "the deposit");
    if !receipt.status() {
        return Err("the deposit was reverted".into());
    }
    let tx = tx_hash(&receipt);
    log("Moved USDC into your agents' deposit", "deposit", Some(amount), &tx, None);
    inflight::done(DEPOSIT)?;
    Ok(tx)
}

/// What a deposit is kept under while it is out (`inflight`).
const DEPOSIT: &str = "deposit";

/// How long a deposit's authorisation is good for: long enough for the write and its retries.
pub(super) const DEPOSIT_AUTH_SECS: u64 = 3_600;

sol! {
    /// What the node reads of USDC's EIP-3009 support: Circle's FiatTokenV2, on Arc and as the devnet's stand-in.
    #[sol(rpc)]
    interface Eip3009 {
        function DOMAIN_SEPARATOR() external view returns (bytes32);
        function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    }
}

/// USDC's EIP-712 domain separator for the chain the node runs on: its signing domain (`USDC`, version `2`, as
/// FiatTokenV2 and the devnet's stand-in name it) with this chain's ID and USDC's address, computed here. The token's
/// own answer must agree, or nothing is signed: a separator read from the RPC alone could be another chain's, where
/// the same signature would move the same USDC.
pub(crate) fn usdc_domain_for(chain_id: u64, usdc: Address) -> FixedBytes<32> {
    alloy::sol_types::eip712_domain! { name: "USDC", version: "2", chain_id: chain_id, verifying_contract: usdc, }.separator()
}

async fn usdc_domain(p: &impl Provider, d: &Deployment) -> Result<FixedBytes<32>, String> {
    let chain_id = crate::rpc::signing_chain().ok_or("this node hasn't settled which chain it runs on, so nothing is signed")?;
    let mine = usdc_domain_for(chain_id, d.usdc);
    let said = Eip3009::new(d.usdc, p).DOMAIN_SEPARATOR().call().await.map_err(|e| format!("reading USDC's EIP-712 domain: {e}"))?;
    if said != mine {
        return Err(format!("USDC at {:#x} doesn't sign under chain {chain_id}'s domain, so no deposit authorisation is signed for it", d.usdc));
    }
    Ok(mine)
}

/// EIP-3009's `ReceiveWithAuthorization` typehash.
pub(super) fn receive_typehash() -> FixedBytes<32> {
    keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
}

/// The nonce of a deposit's authorisation, as Settlement's `depositWithAuthorization` makes it: the account credited
/// and a salt, so whoever submits the authorisation can't credit another account.
pub(crate) fn deposit_nonce(to: Address, salt: FixedBytes<32>) -> FixedBytes<32> {
    use alloy::sol_types::SolValue;
    keccak256((to, salt).abi_encode())
}

/// `from`'s signature, under USDC's EIP-712 domain `domain`, authorising Settlement to pull `value` into `to`'s
/// deposit until `valid_before` (unix seconds): what `depositWithAuthorization` takes, as r ‖ s ‖ v.
pub(crate) fn deposit_authorization(
    from: &PrivateKeySigner,
    domain: FixedBytes<32>,
    settlement: Address,
    to: Address,
    value: U256,
    valid_before: U256,
    salt: FixedBytes<32>,
) -> Result<Bytes, String> {
    use alloy::sol_types::SolValue;
    let item = (receive_typehash(), from.address(), settlement, value, U256::ZERO, valid_before, deposit_nonce(to, salt)).abi_encode();
    let digest = keccak256([&[0x19u8, 0x01][..], domain.as_slice(), keccak256(item).as_slice()].concat());
    let sig = from.sign_hash_sync(&digest).map_err(|e| e.to_string())?;
    Ok(Bytes::from(sig.as_bytes().to_vec()))
}

/// On a live chain with Settlement, moves Settlement's USDC that the node's wallet holds into its deposit while what
/// agents' paid lines can be drawn on, the deposit, is below `floor`: as much as brings it up to the floor, no more,
/// so USDC the owner keeps in the wallet for something else stays there. It moves only USDC the wallet holds: a node
/// with none deposits nothing.
/// One deposit a call; the devnet's owner deposits by hand. What it deposited, if anything.
///
/// When the deployment's USDC is the chain's gas token (the network's own USDC interface, `arc::Network::usdc`), the
/// wallet's USDC and its gas are one balance: `reserve` of it always stays for gas, and never less than a full claim
/// batch takes at the gas price now (`claim_reserve`), and only what is above it moves. With a token of its own (a
/// test USDC), the gas is apart and the whole token balance can move.
pub async fn top_up(chain: &Chain, keys: &(dyn KeyStore + Sync), floor: f64, reserve: f64) -> Result<Option<f64>, String> {
    let Some(net) = chain.network() else { return Ok(None) };
    if !(floor > 0.0) {
        return Ok(None);
    }
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    // A deposit that is out shows in no balance yet: the balance read below would call for it again. One that landed
    // is this pass's top-up, and the next pass reads the balance with it in.
    match inflight::settle(&p, DEPOSIT).await? {
        Settled::Clear => {}
        Settled::Waiting(_) => return Ok(None),
        Settled::Landed(s, r) => {
            log("Moved USDC into your agents' deposit", "deposit", Some(s.amount), &tx_hash(&r), None);
            inflight::done(DEPOSIT)?;
            return Ok(Some(s.amount));
        }
    }
    let s = LeanSettlement::new(d.settlement, &p);
    // What lines can be drawn on, as `spendable` and Money read it: a withdrawal asked for is on its way out, whichever the
    // balance says until it goes. Filling that takes nothing from it: `withdraw` pays what is pending.
    let account = s.account(me).call().await.map_err(|e| e.to_string())?;
    let deposited = account.balance.saturating_sub(account.pending);
    let held = USDC::new(d.usdc, &p).balanceOf(me).call().await.map_err(|e| e.to_string())?;
    // Both in the deployment's USDC units: the reserve rounded up, so at least it stays for gas, and the floor down.
    let held = if gas_is_usdc(net, &d) {
        let claims = gas_f(claim_reserve(crate::chain::gas_price(&p).await?));
        held.saturating_sub(units(reserve.max(claims), d.usdc_decimals, Round::Up))
    } else {
        held
    };
    // A whole number of the token's units, so the deposit turns back into exactly them and never asks for more than
    // the wallet holds.
    let amount = d.usdc_f(to_deposit(deposited, d.usdc_units(floor), held, paid_out_here()?));
    if amount <= 0.0 {
        return Ok(None);
    }
    deposit(chain, keys, amount).await?;
    Ok(Some(amount))
}

/// What `top_up` moves into the deposit, in the deployment's USDC units: what brings `deposited` up to `floor`, from
/// the USDC the wallet `held` that is free to go there. What was paid out to this address (`paid_out`) is not: it is
/// the owner's, taken out of the deposit or earned, on its way to them by `send_usdc` (MONEY-12.2).
pub fn to_deposit(deposited: U256, floor: U256, held: U256, paid_out: U256) -> U256 {
    floor.saturating_sub(deposited).min(held.saturating_sub(paid_out))
}

/// What was paid out to the node's own address with no wallet of the owner's to send it on to, in the deployment's
/// USDC units: a withdrawal (`withdraw_to`). `send_usdc` sends it on, and
/// until then `top_up` leaves it where it is. Gas the node pays from its USDC may since have spent some of it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PaidOut {
    pub usdc: U256,
}

fn paid_out_path() -> PathBuf {
    dir().join("paid-out.json")
}

/// One change to `paid-out.json` at a time.
static PAID_OUT: Mutex<()> = Mutex::new(());

/// What `PaidOut` holds: nothing where no withdrawal stayed here.
pub fn paid_out_here() -> Result<U256, String> {
    Ok(store::read_json_strict::<PaidOut>(&paid_out_path(), &unbrowse_files::PAID_OUT)?.usdc)
}

/// Adds `add` to what was paid out here and takes `sent` off it, never below nothing.
pub(super) fn note_paid_out(add: U256, sent: U256) -> Result<(), String> {
    let _one = PAID_OUT.locked();
    let _file = store::hold_money_file(&paid_out_path(), store::MONEY_LOCK_WAIT)?;
    let now = paid_out_here()?.saturating_add(add).saturating_sub(sent);
    store::write_json(&paid_out_path(), &unbrowse_files::PAID_OUT, &PaidOut { usdc: now })
}

/// Sends `amount` USDC from the node's own address to `to`, an address the owner names: the way on for what was paid
/// out here with no linked wallet (MONEY-12.1), and what `top_up` then stops leaving alone. Where the USDC is the
/// chain's gas, it never takes what the node keeps to claim a full batch (`claim_reserve`), as a deposit doesn't.
pub async fn send_usdc(chain: &Chain, keys: &(dyn KeyStore + Sync), to: Address, amount: f64) -> Result<String, String> {
    if !(amount.is_finite() && amount > 0.0) {
        return Err("send an amount of USDC above zero".into());
    }
    if to == Address::ZERO {
        return Err("name the address to send the USDC to".into());
    }
    let d = chain.deployed()?;
    let signer = owner_signer(keys)?;
    let me = signer.address();
    if to == me {
        return Err(format!("{to:#x} is this node's own address: name the wallet to send it to"));
    }
    let p = as_signer(signer).await?;
    // A send still out is that send: the chain would take a second as a second.
    match inflight::settle(&p, SEND).await? {
        Settled::Clear => {}
        Settled::Waiting(s) => return Err(format!("an earlier send of {} USDC ({:#x}) isn't mined yet, so nothing more was sent", s.amount, s.tx)),
        Settled::Landed(s, r) => {
            let tx = tx_hash(&r);
            sent_on(d.usdc_units(s.amount));
            log("Sent USDC on from the node's address", "withdraw", Some(-s.amount), &tx, None);
            inflight::done(SEND)?;
            if s.amount == amount {
                return Ok(tx);
            }
        }
    }
    let units = d.usdc_units(amount);
    let held = USDC::new(d.usdc, &p).balanceOf(me).call().await.map_err(|e| e.to_string())?;
    let keep = match chain.network().filter(|n| gas_is_usdc(n, &d)) {
        Some(_) => units_from_gas(claim_reserve(crate::chain::gas_price(&p).await?), &d),
        None => U256::ZERO,
    };
    if held.saturating_sub(keep) < units {
        return Err(format!("{me:#x} holds {} USDC and keeps {} of it for gas: it can send at most {}", d.usdc_f(held), d.usdc_f(keep), d.usdc_f(held.saturating_sub(keep))));
    }
    let usdc = USDC::new(d.usdc, &p);
    let call = usdc.transfer(to, units);
    // What a send changes: the USDC the receiver holds.
    let watch = (d.usdc, usdc.balanceOf(to).calldata().clone());
    let receipt = crate::rpc::once!(call, SEND, amount, None, watch, "sending the USDC");
    if !receipt.status() {
        return Err("sending the USDC was reverted".into());
    }
    let tx = tx_hash(&receipt);
    sent_on(units);
    log("Sent USDC on from the node's address", "withdraw", Some(-amount), &tx, Some(format!("To {to:#x}")));
    inflight::done(SEND)?;
    Ok(tx)
}

/// What a send of USDC on is kept under while it is out (`inflight`).
const SEND: &str = "send";

/// `units` of what was paid out here went on: `top_up` may move what's left above it. The send landed either way, so a
/// book that can't be written is said and fails nothing.
fn sent_on(units: U256) {
    if let Err(e) = note_paid_out(U256::ZERO, units) {
        eprintln!("send: couldn't note what went on from the node's address: {e}");
    }
}

/// The gas `wei` (18 decimals) as the deployment's USDC units, rounded up: where USDC is the gas, the same money.
fn units_from_gas(wei: U256, d: &Deployment) -> U256 {
    units(gas_f(wei), d.usdc_decimals, Round::Up)
}

/// About how much USDC the owner should send the node's address for it to deposit `short` at once: where the
/// deposit's USDC is the chain's gas, a deposit leaves the gas the node keeps (`top_up`), so that is sent too.
pub async fn to_fund(chain: &Chain, me: Address, short: f64) -> Option<f64> {
    let d = chain.deployed().ok()?;
    let p = ProviderBuilder::new().connect_http(url());
    let held = d.usdc_f(USDC::new(d.usdc, &p).balanceOf(me).call().await.ok()?);
    let keep = match chain.network() {
        Some(net) if gas_is_usdc(net, &d) => {
            let price = crate::chain::gas_price(&p).await.ok()?;
            store::load_settings().gas_reserve_usdc.max(gas_f(claim_reserve(price)))
        }
        _ => 0.0,
    };
    Some((short + keep - held).max(0.0))
}

/// Whether the deployment's USDC is the chain's gas token: the network's own USDC interface, whose balance is the
/// account's gas. Read from the deployment and the network table, never from the network's name.
pub fn gas_is_usdc(net: &arc::Network, d: &Deployment) -> bool {
    d.usdc == net.usdc
}

pub async fn request_withdraw(chain: &Chain, keys: &(dyn KeyStore + Sync), amount: f64) -> Result<String, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let tx = send!(LeanSettlement::new(d.settlement, &p).requestWithdraw(d.usdc_units(amount)), "the withdrawal request");
    log("Asked to withdraw from the deposit", "withdraw", Some(-amount), &tx, Some("Completes two epochs after the request".into()));
    Ok(tx)
}

/// Pays out the withdrawal asked for, and with `to` (the owner's linked wallet) sends it on there in the same write.
pub async fn withdraw_to(chain: &Chain, keys: &(dyn KeyStore + Sync), to: Option<Address>) -> Result<String, String> {
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    let p = as_signer(owner_signer(keys)?).await?;
    // What `withdraw` pays: the pending amount, or the balance if claims drew it lower.
    let a = LeanSettlement::new(d.settlement, &p).account(me).call().await.map_err(|e| e.to_string())?;
    let amount = a.pending.min(a.balance);
    let tx = paid_out(&p, &d, Bytes::from(alloy::sol_types::SolCall::abi_encode(&LeanSettlement::withdrawCall {})), amount, to, "the withdrawal").await?;
    // Kept from `top_up` until it is sent on. The payout went either way, so a book that can't be written is said and
    // fails nothing.
    if to.is_none() {
        if let Err(e) = note_paid_out(amount, U256::ZERO) {
            eprintln!("withdraw: couldn't note what stays at the node's address: {e}");
        }
    }
    let note = to.map(|w| format!("Sent on to your wallet {w:#x}"));
    log(if to.is_some() { "Withdrew from the deposit to your wallet" } else { "Withdrew from the deposit" }, "withdraw", None, &tx, note);
    Ok(tx)
}

#[cfg(test)]
mod allowance_tests {
    use super::*;

    /// Taking an allowance back is done only when its write went and the allowance reads nothing at the final block;
    /// any other ending is kept as owed, said to the owner, and retried before the next approval.
    #[test]
    fn failed_allowance_reset_is_reported_and_never_marked_complete() {
        assert!(reset_done(true, Some(U256::ZERO)));
        assert!(!reset_done(false, Some(U256::ZERO)), "a write that failed, whatever the reading");
        assert!(!reset_done(true, Some(U256::from(5u8))), "an allowance still there");
        assert!(!reset_done(true, None), "an allowance that couldn't be read back");
        let _home = store::scratch_home("allowance-resets");
        let (s, t) = (Address::repeat_byte(0x5e), Address::repeat_byte(0x0b));
        note_pending_reset(s, t, "reverted").unwrap();
        note_pending_reset(s, t, "reverted").unwrap();
        assert_eq!(pending_resets().unwrap().iter().map(|r| (r.spender, r.token)).collect::<Vec<_>>(), [(s, t)], "kept once");
        clear_pending_reset(s, t).unwrap();
        assert!(pending_resets().unwrap().is_empty(), "and let go once done");
    }

    fn deployment() -> Deployment {
        Deployment {
            settlement: Address::repeat_byte(0x5e),
            domains: Address::repeat_byte(0xd0),
            coins: Coins {
                route_coins: Address::repeat_byte(0xc1),
                route_coin_implementation: Address::repeat_byte(0xc2),
                coin_stakes: Address::repeat_byte(0xc3),
                coin_fetch: Address::repeat_byte(0xc4),
                coin_bounties: Address::repeat_byte(0xc5),
                ..Coins::default()
            },
            unb: Address::repeat_byte(0x0b),
            usdc: Address::repeat_byte(0x0c),
            ..Default::default()
        }
    }

    /// Only the deployment's own contracts, as it recorded them when it was made or checked, are ever given an
    /// allowance, and only of its own tokens: an address an RPC names later is none of them.
    #[test]
    fn a_spender_is_only_an_address_the_check_verified() {
        let d = deployment();
        for spender in [d.settlement, d.coins.route_coins, d.coins.coin_bounties] {
            assert!(spender_allowed(&d, spender, d.unb) && spender_allowed(&d, spender, d.usdc));
        }
        let stranger = Address::repeat_byte(0xee);
        assert!(!spender_allowed(&d, stranger, d.unb), "an address the deployment doesn't name");
        assert!(!spender_allowed(&d, d.domains, d.unb) && !spender_allowed(&d, d.domains, d.usdc), "the domain proofs pull no token");
        assert!(!spender_allowed(&d, d.settlement, stranger), "a token the deployment doesn't name");
        // The fetch pulls nothing from a wallet, and the stakes pull only coins: neither takes UNB or USDC.
        assert!(!spender_allowed(&d, d.coins.coin_fetch, d.usdc), "the fetch is paid by Settlement, never by a wallet");
        assert!(!spender_allowed(&d, d.coins.coin_stakes, d.unb), "the stakes take coins, never UNB");
        let none = Deployment { coins: Coins::default(), domains: Address::ZERO, ..deployment() };
        assert!(!spender_allowed(&none, Address::ZERO, none.unb), "a contract the deployment has none of");
    }

    /// A route coin goes only to the verified curves (to sell it) and stakes (to stake it), and only once proven its
    /// entry's clone: an unverified address can't even be named, since only `coins::verify_coin` makes a `VerifiedCoin`.
    #[test]
    fn a_coin_is_approved_only_to_the_curves_and_the_stakes() {
        let d = deployment();
        let coin = crate::chain::coins::test_verified(Address::repeat_byte(0x77), FixedBytes::repeat_byte(0xe0));
        assert!(coin_spender_allowed(&d, d.coins.route_coins, &coin));
        assert!(coin_spender_allowed(&d, d.coins.coin_stakes, &coin));
        for other in [d.settlement, d.domains, d.coins.coin_fetch, d.coins.coin_bounties, Address::repeat_byte(0xee), Address::ZERO] {
            assert!(!coin_spender_allowed(&d, other, &coin), "{other:#x} pulls no coin");
        }
        assert!(!coin_spender_allowed(&Deployment { coins: Coins::default(), ..d.clone() }, d.coins.route_coins, &coin), "a deployment with no coin contracts");
    }

    /// An allowance is set to what the write needs, an unlimited one left from before brought down to it.
    #[test]
    fn an_approval_is_for_the_amount_and_no_more() {
        let five = U256::from(5u8);
        assert_eq!(allowance_to_set(U256::MAX, five), Some(five), "an unlimited allowance is brought down");
        assert_eq!(allowance_to_set(U256::ZERO, five), Some(five));
        assert_eq!(allowance_to_set(five, five), None, "already exactly it");
    }
}
