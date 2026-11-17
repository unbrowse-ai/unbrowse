//! Route coins (spec ch. 6 and 8; `unbrowse-settlement/src/coins/README.md`): every entry may have a coin traded
//! against UNB, a paid fetch buys it for its payer and stakes it, and staked, checked coins earn the entry's route share.
//!
//! What the node does, and doesn't:
//!
//! - **A fetch buys by itself.** Settlement sends a claimed line's route share to `CoinFetch`, which pays the coin's
//!   earlier stake and buys and stakes for the payer in the same claim (`coin.fetch-pays`, `-buys`, `-stakes`). The
//!   node sends nothing for it; it shows what its owner's wallets hold (`holdings`). A buy that couldn't run is parked
//!   for (coin, payer): the claim pass completes the owner's own (`complete_own_buys`), never anyone else's unless
//!   the owner turned `coin_complete_others` on, and samples a coin's price for the fetch's drift bound when one is due
//!   (`poke_due`), as it does for UNB's pool. A route share Settlement held because its call failed is sent on for the
//!   owner's own payers (`LeanSettlement.sendHeld`).
//! - **The listing's first buy is on by default** (`decide.dev-buy-default-on`). Once an entry of the wallet's is first
//!   credited on chain (its first claim, R2.18: the contract launches no uncredited entry), the node launches its coin
//!   with `coin_dev_buy_bps` of the UNB the wallet holds then, 1% by default, and stakes what that buys for the owner
//!   (`launch_listed`). A wallet with no UNB launches nothing, and the route still lists. The owner changes the share or
//!   turns it off (`coin_dev_buy`); raising it past the default asks them.
//! - **Everything else is the owner's word.** A launch of another size (`launch`), a buy or a sale, a stake, an unstake
//!   request, a withdrawal, a claim of earnings and the exit delay a fetch stakes with (`set_fetch_delay`) are sent only
//!   when the owner asks (`coin.stake`: "a node buys, stakes or sells a coin only when its owner asks").
//! - **No write goes twice.** A launch, a buy, a sale, a stake and an unstake request are signed and kept before they
//!   go (`inflight`), each under its own key, and nothing of that key is sent while one may still land.
//! - **Allowances only to verified contracts, for the exact amount.** UNB goes only to the deployment's `RouteCoins`
//!   and `CoinBounties`, a coin only to `RouteCoins` and `CoinStakes` (`wallet::spender_allowed`,
//!   `wallet::coin_spender_allowed`), and a coin only once it is proven a clone of the deployment's verified
//!   implementation at the address its entry predicts (`verify_coin`). Each allowance is taken back after its write.
//! - **Rank is read here and computed in `rank::coin`.** The stake book is rebuilt from CoinStakes' own events
//!   (`stake_book`), up to the head the node followed; each coin's market is read at that head (`market`); ranks are
//!   kept for `RANK_TTL` (`ranks`), since a pick reads them many times a second and the chain moves once a block.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::LazyLock;

use alloy::primitives::B256;
use alloy::sol_types::{SolCall, SolEvent, SolValue};

use super::*;
use crate::inflight::{self, Settled};
use crate::rank::coin::{Market, Rank, StakeBook, StakeEvent};

/// The coin contracts' bindings, each in a module of its own: two of them name v4's `PoolKey`, and the stakes' and the
/// bounties' structs live in their interfaces' namespaces.
pub(crate) mod abi {
    pub mod route_coins {
        alloy::sol!(
            /// The factory and every coin's curve, its permanent market (`RouteCoins.sol`).
            #[sol(rpc)]
            #[allow(clippy::too_many_arguments)]
            RouteCoins,
            "contracts/RouteCoins.json"
        );
    }
    pub mod stakes {
        alloy::sol!(
            /// Staked coins in lots, checks, the latest-passed flag, and what stake earns (`CoinStakes.sol`).
            #[sol(rpc)]
            #[allow(clippy::too_many_arguments)]
            CoinStakes,
            "contracts/CoinStakes.json"
        );
    }
    pub mod fetch {
        alloy::sol!(
            /// What a claimed line's route share does (`CoinFetch.sol`).
            #[sol(rpc)]
            #[allow(clippy::too_many_arguments)]
            CoinFetch,
            "contracts/CoinFetch.json"
        );
    }
    pub mod bounties {
        alloy::sol!(
            /// Bounties as limit orders, released by the poster's confirmation or by use (`CoinBounties.sol`).
            #[sol(rpc)]
            #[allow(clippy::too_many_arguments)]
            CoinBounties,
            "contracts/CoinBounties.json"
        );
    }
}
pub use abi::bounties::CoinBounties;
pub use abi::fetch::CoinFetch;
pub use abi::route_coins::RouteCoins;
pub use abi::stakes::CoinStakes;

sol! {
    /// One entry's coin: OpenZeppelin's ERC-20, cloned per entry, with its entry as the clone's argument.
    #[sol(rpc)]
    interface RouteCoin {
        function entryId() external view returns (bytes32);
        function balanceOf(address who) external view returns (uint256);
        function allowance(address owner, address spender) external view returns (uint256);
        function approve(address spender, uint256 amount) external returns (bool);
        function totalSupply() external view returns (uint256);
    }
}

// ---- the deployment's numbers ----

/// The route-coin numbers a deployment is made with and a node holds a live one to (`protocol/params.toml
/// [route_coin]`, the constructor immutables `script/DeployCoins.s.sol` names): one statement of each, which
/// `papers/params_check.py` can pin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CoinParams {
    /// `route_coin.supply`, whole coins.
    pub supply: u64,
    /// `route_coin.virtual_unb`, whole UNB.
    pub virtual_unb: u64,
    /// `route_coin.trade_fee`, basis points.
    pub trade_fee_bps: u64,
    /// `route_coin.snipe_start`, basis points.
    pub snipe_start_bps: u64,
    /// `route_coin.snipe_window`, seconds.
    pub snipe_window: u64,
    /// `route_coin.unstake_delay`: `CoinStakes.DEFAULT_DELAY`, seconds.
    pub unstake_delay: u64,
    /// `route_coin.bounty_lister_share`, basis points.
    pub bounty_lister_share_bps: u64,
    /// `route_coin.bounty_use_cap`, basis points.
    pub bounty_use_cap_bps: u64,
}

/// `protocol/params.toml [route_coin]`.
pub const ROUTE_COIN: CoinParams = CoinParams {
    supply: 1_000_000_000,
    virtual_unb: 30_000_000,
    trade_fee_bps: 100,
    snipe_start_bps: 5_000,
    snipe_window: 300,
    unstake_delay: crate::rank::coin::DEFAULT_EXIT_DELAY,
    bounty_lister_share_bps: 5_000,
    bounty_use_cap_bps: 500,
};

/// The numbers a deploy gives the coin contracts that `params.toml` doesn't have (proposed in `DeployCoins.s.sol`, the
/// owner's to set): `CoinFetch.WINDOW`, `MAX_DRIFT_BPS` and `FETCH_GAS`.
pub const FETCH_WINDOW: u64 = 900;
pub const FETCH_MAX_DRIFT_BPS: u64 = 100;
pub const FETCH_GAS: u64 = 1_500_000;

/// How long a trade the node sends may wait to be mined before the contract refuses it (CL-03), in seconds.
pub const TRADE_DEADLINE: u64 = 600;
/// The most a buy or a sale the owner asks for may come out worse than its quote at the followed head, in basis points.
pub const TRADE_SLIPPAGE_BPS: u64 = 100;

#[cfg(test)]
fn whole_units(n: u64) -> U256 {
    U256::from(n) * U256::from(10u64).pow(U256::from(18u64))
}

/// The coin contracts' error when a deployment names none: one made before route coins, which this node doesn't run.
pub(crate) fn no_coins() -> String {
    "this deployment has no route-coin contracts: it is from before route coins, which this node no longer runs".into()
}

fn coins_of(d: &Deployment) -> Result<Coins, String> {
    if d.coins.named() {
        Ok(d.coins)
    } else {
        Err(no_coins())
    }
}

// ---- a coin is a clone of the verified implementation ----

/// The code every route coin runs: OpenZeppelin 5.7's minimal proxy with immutable arguments
/// (`Clones.cloneDeterministicWithImmutableArgs`), delegating to `implementation`, with the entry id as its one argument
/// (`abi.encode(entryId)`).
pub fn clone_runtime(implementation: Address, entry: B256) -> Vec<u8> {
    [&alloy::hex!("363d3d373d3d3d363d73")[..], implementation.as_slice(), &alloy::hex!("5af43d82803e903d91602b57fd5bf3")[..], entry.as_slice()].concat()
}

/// The creation code `RouteCoins` deploys a coin with (`Clones._cloneCodeWithImmutableArgs`): a header that returns
/// the runtime above.
pub fn clone_creation(implementation: Address, entry: B256) -> Vec<u8> {
    let len = (32u16 + 0x2d).to_be_bytes();
    [&[0x61u8][..], &len[..], &alloy::hex!("3d81600a3d39f3")[..], &clone_runtime(implementation, entry)[..]].concat()
}

/// Where `entry`'s coin is, launched or not (`coin.per-entry`): `CREATE2(route_coins, salt = entry)` over the clone's
/// creation code. Computed here, never read from an RPC.
pub fn coin_address(route_coins: Address, implementation: Address, entry: B256) -> Address {
    route_coins.create2(entry, keccak256(clone_creation(implementation, entry)))
}

/// A route coin the node proved is its entry's: the clone of the deployment's verified implementation, at the address
/// its entry predicts under the deployment's verified factory. Only `verify_coin` makes one, and nothing approves or
/// trades a coin without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedCoin {
    pub coin: Address,
    pub entry: B256,
}

/// A `VerifiedCoin` for a test that needs one without a chain.
#[cfg(test)]
pub(crate) fn test_verified(coin: Address, entry: B256) -> VerifiedCoin {
    VerifiedCoin { coin, entry }
}

/// Whether `code` is `entry`'s coin's: a clone of `implementation` and nothing else.
pub fn is_clone_of(code: &[u8], implementation: Address, entry: B256) -> bool {
    code == clone_runtime(implementation, entry).as_slice()
}

/// `entry`'s coin, once it is launched and its code at the final block is the clone of the deployment's verified
/// implementation at the address its entry predicts (`coin_address`). An error for an entry with no coin yet.
pub async fn verify_coin(p: &impl Provider, d: &Deployment, entry: B256) -> Result<VerifiedCoin, String> {
    let c = coins_of(d)?;
    let coin = coin_address(c.route_coins, c.route_coin_implementation, entry);
    let code = p.get_code_at(coin).block_id(crate::rpc::SETTLED).await.map_err(|e| e.to_string())?;
    if code.is_empty() {
        return Err(format!("entry {entry:#x} has no coin yet"));
    }
    if !is_clone_of(&code, c.route_coin_implementation, entry) {
        return Err(format!("the code at {coin:#x}, where entry {entry:#x}'s coin goes, isn't a clone of the deployment's route coin, so the node won't trade or approve it"));
    }
    Ok(VerifiedCoin { coin, entry })
}

/// The coin at `coin`, by the entry `RouteCoins` says it is for, verified as `verify_coin` verifies it: the address
/// must be the one that entry predicts, so an RPC that names another entry names no coin.
pub async fn verify_coin_at(p: &impl Provider, d: &Deployment, coin: Address) -> Result<VerifiedCoin, String> {
    let c = coins_of(d)?;
    let entry = RouteCoins::new(c.route_coins, p).entryOf(coin).call().await.map_err(|e| e.to_string())?;
    if entry == B256::ZERO {
        return Err(format!("{coin:#x} is no route coin of this deployment"));
    }
    let v = verify_coin(p, d, entry).await?;
    if v.coin != coin {
        return Err(format!("{coin:#x} isn't where entry {entry:#x}'s coin goes"));
    }
    Ok(v)
}

// ---- reading at the followed head ----

/// The block a reading of this operation is made at: the head the node followed (`rpc::Head`), never one an RPC names
/// on its own.
fn head_block(head: &crate::rpc::Head) -> Result<alloy::eips::BlockId, String> {
    match head.followed {
        Some((at, _)) => Ok(alloy::eips::BlockId::number(at)),
        None => Err("the node can't follow the chain to a finalized head just now".into()),
    }
}

/// A typed reading at the followed head: checked against the second RPC when one stands behind the head
/// (`Head::call`), otherwise the one RPC's reading of that same block.
pub(crate) async fn read_at<P: Provider, C: SolCall>(head: &crate::rpc::Head, p: &P, to: Address, call: &C) -> Result<C::Return, String> {
    if let Some(r) = head.call(p, to, call).await? {
        return Ok(r);
    }
    let at = head_block(head)?;
    let req = alloy::rpc::types::TransactionRequest::default().to(to).input(call.abi_encode().into());
    let got = p.call(req).block(at).await.map_err(|e| e.to_string())?;
    C::abi_decode_returns(&got).map_err(|e| e.to_string())
}

/// The timestamp of the followed head's block.
async fn head_time(head: &crate::rpc::Head, p: &impl Provider) -> Result<(u64, u64), String> {
    let Some((at, _)) = head.followed else { return Err("the node can't follow the chain to a finalized head just now".into()) };
    let b = p.get_block_by_number(at.into()).await.map_err(|e| e.to_string())?.ok_or("the followed head's block isn't there")?;
    Ok((at, b.header.timestamp))
}

// ---- writes that must not go twice ----

/// Whether a write of `key` may go now: none of it is out. One that landed and wasn't counted yet is let go and said,
/// never sent again on the owner's behalf: the owner asks again for another.
async fn clear_to_send(p: &impl Provider, key: &str) -> Result<(), String> {
    match inflight::settle(p, key).await? {
        Settled::Clear => Ok(()),
        Settled::Waiting(s) => Err(format!("an earlier {} ({:#x}) isn't mined yet, so nothing more was sent: the node looks at it again each pass", s.what, s.tx)),
        Settled::Landed(s, r) => {
            inflight::done(key)?;
            Err(format!("an earlier {} landed ({}), so nothing more was sent; ask again for another", s.what, tx_hash(&r)))
        }
    }
}

/// What a kept write's key is for each coin write: one of each out at a time, per coin (a launch, per entry).
pub fn coin_key(what: &str, of: impl std::fmt::LowerHex) -> String {
    format!("coin {what} {of:#x}")
}

/// The block time a trade sent now must be mined by.
async fn deadline(p: &impl Provider) -> Result<U256, String> {
    let b = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.ok_or("no latest block")?;
    Ok(U256::from(b.header.timestamp + TRADE_DEADLINE))
}

/// `amount` less the slippage the owner accepts.
pub fn at_least(amount: U256) -> U256 {
    amount * U256::from(10_000 - TRADE_SLIPPAGE_BPS) / U256::from(10_000u64)
}

/// What a coin write did, for the owner.
#[derive(Clone, Debug, Serialize)]
pub struct CoinDone {
    pub tx: String,
    pub coin: String,
    pub entry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

/// `coin.launch`: deploys `entry`'s coin with the owner's first buy of `unb` UNB, untaxed, for the owner. Only the
/// entry's credited contributor may (R2.18), so only an entry this node's wallet is credited with; the node launches
/// when the owner asks, and with the listing's first buy (`coin_dev_buy_bps`, `launch_listed`).
pub async fn launch(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, unb: f64) -> Result<CoinDone, String> {
    if !(unb > 0.0) {
        return Err("a launch is the coin's first buy: name some UNB above zero".into());
    }
    launch_units(chain, keys, entry, unb_units(unb), None).await.map(|(done, _)| done)
}

/// What a launch says when the curve sells nothing for the UNB it was given: too little to buy one unit of the coin.
pub const SELLS_NOTHING: &str = "that is too little UNB for the coin's curve to sell anything for";

/// Whether a launch was refused for buying nothing (`NothingBought`, `ZeroAmount`): too little UNB, not a fault.
fn sells_nothing(e: &alloy::contract::Error) -> bool {
    use alloy::sol_types::SolError;
    e.as_revert_data().is_some_and(|d| d.starts_with(&RouteCoins::NothingBought::SELECTOR) || d.starts_with(&RouteCoins::ZeroAmount::SELECTOR))
}

/// The coins `to` got from `coin` in `receipt`, and the UNB that bought them (`RouteCoins.Bought`).
fn bought_in(receipt: &alloy::rpc::types::TransactionReceipt, coin: Address, to: Address) -> Option<(U256, U256)> {
    receipt.inner.logs().iter().filter_map(|l| RouteCoins::Bought::decode_log(&l.inner).ok()).find(|b| b.coin == coin && b.to == to).map(|b| (b.unbIn, b.coinsOut))
}

/// A launch of `units` UNB: what it did and the coins it bought. Like every trade the node sends it carries a deadline
/// and a least it takes, the launch quoted by running it at the head less `TRADE_SLIPPAGE_BPS`; the UNB is approved
/// exactly to the deployment's verified `RouteCoins` and taken back after. `told`, when set, is the note the owner's
/// activity says it with.
async fn launch_units(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, units: U256, told: Option<String>) -> Result<(CoinDone, U256), String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    if units.is_zero() {
        return Err(SELLS_NOTHING.into());
    }
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let head = crate::rpc::Head::follow(&p).await?;
    let e = read_at(&head, &p, d.settlement, &LeanSettlement::entryCall { entryId: entry }).await?;
    if e.contributor != me || !e.live {
        return Err(format!("only the credited contributor of a live entry launches its coin, and entry {entry:#x} isn't this wallet's live entry"));
    }
    let rc = RouteCoins::new(c.route_coins, &p);
    if read_at(&head, &p, c.route_coins, &RouteCoins::coinOfCall { entryId: entry }).await? != Address::ZERO {
        return Err(format!("entry {entry:#x} already has its coin"));
    }
    let key = coin_key("launch", entry);
    clear_to_send(&p, &key).await?;
    crate::rpc::once_allowed()?;
    let unb = unb_f(units);
    approve(&p, &d, c.route_coins, d.unb, me, units).await?;
    let until = deadline(&p).await?;
    // The coin's first trade, in the transaction that deploys it, quoted by running it at the head.
    let quoted = match rc.launch(entry, units, U256::from(1u64), until, me).call().await {
        Ok(r) => r.coinsOut,
        Err(e) => {
            take_back_allowance(&p, c.route_coins, d.unb, me).await?;
            return Err(if sells_nothing(&e) { SELLS_NOTHING.into() } else { format!("the launch would be refused: {e}") });
        }
    };
    let call = rc.launch(entry, units, at_least(quoted).max(U256::from(1u64)), until, me);
    let watch = (c.route_coins, rc.coinOf(entry).calldata().clone());
    let sent: Result<_, String> = async { Ok(crate::rpc::once!(call, &key, unb, None, watch, "launching a route coin")) }.await;
    allowance_after(&p, &sent, c.route_coins, d.unb, me, "the launch it was for may still land").await?;
    let receipt = sent?;
    inflight::done(&key)?;
    if !receipt.status() {
        return Err("launching the coin was reverted".into());
    }
    let tx = tx_hash(&receipt);
    let coin = coin_address(c.route_coins, c.route_coin_implementation, entry);
    let bought = bought_in(&receipt, coin, me).map(|(_, coins)| coins).unwrap_or(quoted);
    let note = told.unwrap_or_else(|| format!("the coin of entry {entry:#x}, with your first buy"));
    log("Launched a route coin", "coin", Some(unb), &tx, Some(note));
    Ok((CoinDone { tx, coin: format!("{coin:#x}"), entry: format!("{entry:#x}"), amount: Some(unb) }, bought))
}

/// Takes back what is left of an allowance once the write it was for is over, or keeps it owed when that write may
/// still land and pull it.
async fn allowance_after<T>(p: &(impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet>), sent: &Result<T, String>, spender: Address, token: Address, me: Address, why: &str) -> Result<(), String> {
    if sent.as_ref().err().is_none_or(|e| !crate::rpc::unsettled(e)) {
        take_back_allowance(p, spender, token, me).await
    } else {
        note_pending_reset(spender, token, why)
    }
}

/// Buys `entry`'s coin with `unb` of the owner's UNB, on its curve, for at least its quote
/// at the followed head less `TRADE_SLIPPAGE_BPS`. The owner's word only (`coin.stake`).
pub async fn buy(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, unb: f64) -> Result<CoinDone, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    if !(unb > 0.0) {
        return Err("name some UNB above zero to buy with".into());
    }
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let v = verify_coin(&p, &d, entry).await?;
    let head = crate::rpc::Head::follow(&p).await?;
    let units = unb_units(unb);
    let q = read_at(&head, &p, c.route_coins, &RouteCoins::quoteBuyCall { coin: v.coin, unbIn: units }).await?;
    if q.coinsOut.is_zero() {
        return Err("the coin sells nothing for that now (too little UNB)".into());
    }
    let key = coin_key("buy", v.coin);
    clear_to_send(&p, &key).await?;
    crate::rpc::once_allowed()?;
    approve(&p, &d, c.route_coins, d.unb, me, units).await?;
    let rc = RouteCoins::new(c.route_coins, &p);
    let call = rc.buy(v.coin, units, at_least(q.coinsOut), deadline(&p).await?, me);
    let watch = (v.coin, RouteCoin::new(v.coin, &p).balanceOf(me).calldata().clone());
    let sent: Result<_, String> = async { Ok(crate::rpc::once!(call, &key, unb, None, watch, "buying a route coin")) }.await;
    allowance_after(&p, &sent, c.route_coins, d.unb, me, "the buy it was for may still land").await?;
    let receipt = sent?;
    inflight::done(&key)?;
    if !receipt.status() {
        return Err("buying the coin was reverted".into());
    }
    let tx = tx_hash(&receipt);
    log("Bought a route coin", "coin", Some(unb), &tx, Some(format!("about {:.4} coins of entry {entry:#x}, held unstaked until you stake them", unb_f(q.coinsOut))));
    Ok(CoinDone { tx, coin: format!("{:#x}", v.coin), entry: format!("{entry:#x}"), amount: Some(unb_f(q.coinsOut)) })
}

/// Sells `coins` of the owner's unstaked coins of `entry`, for at least the quote at the followed head less
/// `TRADE_SLIPPAGE_BPS`. The owner's word only.
pub async fn sell(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, coins: f64) -> Result<CoinDone, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    if !(coins > 0.0) {
        return Err("name some coins above zero to sell".into());
    }
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let v = verify_coin(&p, &d, entry).await?;
    let head = crate::rpc::Head::follow(&p).await?;
    let units = unb_units(coins);
    let held = read_at(&head, &p, v.coin, &RouteCoin::balanceOfCall { who: me }).await?;
    if held < units {
        return Err(format!("this wallet holds {} unstaked coins of that entry; ask for its unstake first for more", unb_f(held)));
    }
    let q = read_at(&head, &p, c.route_coins, &RouteCoins::quoteSellCall { coin: v.coin, coinsIn: units }).await?;
    if q.unbOut.is_zero() {
        return Err("selling that many returns nothing now".into());
    }
    let key = coin_key("sell", v.coin);
    clear_to_send(&p, &key).await?;
    crate::rpc::once_allowed()?;
    approve_coin(&p, &d, c.route_coins, &v, me, units).await?;
    let rc = RouteCoins::new(c.route_coins, &p);
    let call = rc.sell(v.coin, units, at_least(q.unbOut), deadline(&p).await?, me);
    let watch = (v.coin, RouteCoin::new(v.coin, &p).balanceOf(me).calldata().clone());
    let sent: Result<_, String> = async { Ok(crate::rpc::once!(call, &key, coins, None, watch, "selling a route coin")) }.await;
    allowance_after(&p, &sent, c.route_coins, v.coin, me, "the sale it was for may still land").await?;
    let receipt = sent?;
    inflight::done(&key)?;
    if !receipt.status() {
        return Err("selling the coin was reverted".into());
    }
    let tx = tx_hash(&receipt);
    log("Sold a route coin", "coin", Some(unb_f(q.unbOut)), &tx, Some(format!("{coins} coins of entry {entry:#x}")));
    Ok(CoinDone { tx, coin: format!("{:#x}", v.coin), entry: format!("{entry:#x}"), amount: Some(unb_f(q.unbOut)) })
}

/// Stakes `coins` of the owner's unstaked coins of `entry` in its lot of exit `delay` seconds (`coin.stake`,
/// `rank.exit-delay`): it earns from the next epoch close once the wallet has checked the entry, and counts in rank by
/// its delay while the wallet's own latest call on the entry passed.
pub async fn stake(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, coins: f64, delay: u64) -> Result<CoinDone, String> {
    if !(coins > 0.0) {
        return Err("stake some coins above zero, with an exit delay from 1 second to 2^32 − 1".into());
    }
    stake_units(chain, keys, entry, unb_units(coins), delay).await
}

/// `stake`, of `units` of the coin.
async fn stake_units(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, units: U256, delay: u64) -> Result<CoinDone, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    if units.is_zero() || delay == 0 || delay > u32::MAX as u64 {
        return Err("stake some coins above zero, with an exit delay from 1 second to 2^32 − 1".into());
    }
    let coins = unb_f(units);
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let v = verify_coin(&p, &d, entry).await?;
    let head = crate::rpc::Head::follow(&p).await?;
    let held = read_at(&head, &p, v.coin, &RouteCoin::balanceOfCall { who: me }).await?;
    if held < units {
        return Err(format!("this wallet holds {} unstaked coins of that entry", unb_f(held)));
    }
    let key = coin_key("stake", v.coin);
    clear_to_send(&p, &key).await?;
    crate::rpc::once_allowed()?;
    approve_coin(&p, &d, c.coin_stakes, &v, me, units).await?;
    let st = CoinStakes::new(c.coin_stakes, &p);
    let call = st.stake(v.coin, units, delay);
    let watch = (c.coin_stakes, st.lotsOf(v.coin, me).calldata().clone());
    let sent: Result<_, String> = async { Ok(crate::rpc::once!(call, &key, coins, None, watch, "staking a route coin")) }.await;
    allowance_after(&p, &sent, c.coin_stakes, v.coin, me, "the stake it was for may still land").await?;
    let receipt = sent?;
    inflight::done(&key)?;
    if !receipt.status() {
        return Err("staking the coin was reverted".into());
    }
    let tx = tx_hash(&receipt);
    log("Staked a route coin", "coin", None, &tx, Some(format!("{coins} coins of entry {entry:#x}, exit delay {delay} s; they earn from the next epoch close")));
    Ok(CoinDone { tx, coin: format!("{:#x}", v.coin), entry: format!("{entry:#x}"), amount: Some(coins) })
}

/// Asks `coins` back from the owner's lot of exit `delay` in `entry`'s coin: they stop earning and counting at once and
/// come back after the lot's delay (`withdraw`).
pub async fn request_unstake(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, delay: u64, coins: f64) -> Result<CoinDone, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    if !(coins > 0.0) {
        return Err("ask back some coins above zero".into());
    }
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let v = verify_coin(&p, &d, entry).await?;
    let head = crate::rpc::Head::follow(&p).await?;
    let lots = read_at(&head, &p, c.coin_stakes, &CoinStakes::lotsOfCall { coin: v.coin, wallet: me }).await?;
    let Some(lot) = lots.iter().find(|l| l.delay == delay) else { return Err(format!("this wallet has no lot of exit delay {delay} s in that coin")) };
    // The owner names coins as a decimal, which carries about 15 digits of a lot counted to 18: asking for "all of it"
    // as the node showed it can come out a few units over. Within a billionth of the lot, it is the lot.
    let have = lot.earning + lot.pending;
    let asked = unb_units(coins);
    let units = if asked > have && asked - have <= have / U256::from(1_000_000_000u64) { have } else { asked };
    if have < units {
        return Err(format!("that lot holds {} staked coins", unb_f(have)));
    }
    let key = format!("{} {delay}", coin_key("unstake", v.coin));
    clear_to_send(&p, &key).await?;
    crate::rpc::once_allowed()?;
    let st = CoinStakes::new(c.coin_stakes, &p);
    let call = st.requestUnstake(v.coin, delay, units);
    let watch = (c.coin_stakes, st.lotsOf(v.coin, me).calldata().clone());
    let receipt = crate::rpc::once!(call, &key, coins, None, watch, "asking route coins back");
    inflight::done(&key)?;
    if !receipt.status() {
        return Err("asking the coins back was reverted".into());
    }
    let tx = tx_hash(&receipt);
    log("Asked route coins back", "coin", None, &tx, Some(format!("{coins} coins of entry {entry:#x}; they stop earning now and come back after {delay} s")));
    Ok(CoinDone { tx, coin: format!("{:#x}", v.coin), entry: format!("{entry:#x}"), amount: Some(coins) })
}

/// Takes back the owner's coins asked back from its lot of exit `delay`, once ready. A second asks for nothing.
pub async fn withdraw_coins(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256, delay: u64) -> Result<CoinDone, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    let p = as_signer(owner_signer(keys)?).await?;
    let v = verify_coin(&p, &d, entry).await?;
    let st = CoinStakes::new(c.coin_stakes, &p);
    let call = st.withdraw(v.coin, delay);
    call.call().await.map_err(|e| format!("nothing of that lot is ready to come back yet: {e}"))?;
    let tx = send!(call, "taking back unstaked route coins");
    log("Took back unstaked route coins", "coin", None, &tx, Some(format!("from entry {entry:#x}'s coin")));
    Ok(CoinDone { tx, coin: format!("{:#x}", v.coin), entry: format!("{entry:#x}"), amount: None })
}

/// Claims what the owner's stake in `entry`'s coin earned: USDC from fetches (`coin.claims`). A second claims nothing.
pub async fn claim_earned(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: B256) -> Result<CoinDone, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let v = verify_coin(&p, &d, entry).await?;
    let st = CoinStakes::new(c.coin_stakes, &p);
    let owed = st.owedOf(v.coin, me).call().await.map_err(|e| e.to_string())?;
    if owed.is_zero() {
        return Err("that coin's stake has earned nothing to claim yet".into());
    }
    let tx = send!(st.claim(v.coin), "claiming a route coin's earnings");
    log("Claimed a route coin's earnings", "coin", None, &tx, Some(format!("{} USDC from entry {entry:#x}'s coin", d.usdc_f(owed))));
    Ok(CoinDone { tx, coin: format!("{:#x}", v.coin), entry: format!("{entry:#x}"), amount: Some(d.usdc_f(owed)) })
}

/// Sets the exit delay a fetch's or a bounty's stake for the owner's wallet uses (`coin.fetch-stakes`:
/// `CoinStakes.setFetchDelay`). The contract's default until set is `route_coin.unstake_delay`.
pub async fn set_fetch_delay(chain: &Chain, keys: &(dyn KeyStore + Sync), delay: u64) -> Result<String, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    if delay == 0 || delay > u32::MAX as u64 {
        return Err("an exit delay is from 1 second to 2^32 − 1".into());
    }
    let p = as_signer(owner_signer(keys)?).await?;
    let tx = send!(CoinStakes::new(c.coin_stakes, &p).setFetchDelay(delay), "setting the exit delay fetches stake with");
    log("Set the exit delay your fetches stake with", "coin", None, &tx, Some(format!("{delay} s")));
    Ok(tx)
}

/// The exit delay a fetch's stake for the owner uses now, in seconds.
pub async fn fetch_delay(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<u64, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    let p = ProviderBuilder::new().connect_http(url());
    CoinStakes::new(c.coin_stakes, &p).fetchDelayOf(owner_signer(keys)?.address()).call().await.map_err(|e| e.to_string())
}

/// Takes what `coin.split`'s fallback owes the owner as a credited contributor: route shares of lines on its entries
/// that had no coin, or a part too small to buy (`CoinFetch.withdraw`).
pub async fn withdraw_owed(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Option<String>, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let f = CoinFetch::new(c.coin_fetch, &p);
    let owed = f.owedOf(me).call().await.map_err(|e| e.to_string())?;
    if owed.is_zero() {
        return Ok(None);
    }
    let tx = send!(f.withdraw(), "taking route shares owed to the contributor");
    log("Took route shares owed to you", "coin", None, &tx, Some(format!("{} USDC from lines on your entries that had no coin to buy", d.usdc_f(owed))));
    Ok(Some(tx))
}

// ---- the claim pass ----

/// The payers whose parked buys the node completes: the owner's wallet and every wallet the owner's agents pay from.
pub fn own_payers(keys: &(dyn KeyStore + Sync)) -> Result<BTreeSet<Address>, String> {
    let mut out = BTreeSet::new();
    out.insert(owner_signer(keys)?.address());
    for a in crate::agents::list() {
        for (_, w) in &a.payers {
            if let Some(w) = w.as_deref().and_then(|w| w.parse::<Address>().ok()) {
                out.insert(w);
            }
        }
    }
    Ok(out)
}

/// Whether the node completes a buy parked for `payer`: its owner's own, or anyone's when the owner said so
/// (`coin_complete_others`).
pub fn completes_for(payer: Address, own: &BTreeSet<Address>, others: bool) -> bool {
    own.contains(&payer) || others
}

/// Completes buys a fetch parked (`CoinFetch.completeBuy`): the owner's own payers', and anyone's when
/// `coin_complete_others` is on. Each is tried first as a call, so one that still can't buy costs nothing. Answers the
/// transactions sent.
pub async fn complete_own_buys(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Vec<String>, String> {
    let d = chain.deployed()?;
    let Ok(c) = coins_of(&d) else { return Ok(Vec::new()) };
    let own = own_payers(keys)?;
    let others = store::load_settings().coin_complete_others;
    let p = as_signer(owner_signer(keys)?).await?;
    let f = CoinFetch::new(c.coin_fetch, &p);
    let mut filter = alloy::rpc::types::Filter::new().address(c.coin_fetch).event_signature(CoinFetch::BuyParked::SIGNATURE_HASH);
    if !others {
        filter = filter.topic2(own.iter().map(|a| a.into_word()).collect::<Vec<_>>());
    }
    let mut seen = BTreeSet::new();
    let mut sent = Vec::new();
    for l in logs(&p, filter, d.block, None).await? {
        let Ok(ev) = CoinFetch::BuyParked::decode_log(&l.inner) else { continue };
        if !completes_for(ev.payer, &own, others) || !seen.insert((ev.coin, ev.payer)) {
            continue;
        }
        if f.parked(ev.coin, ev.payer).call().await.map_err(|e| e.to_string())?.is_zero() {
            continue;
        }
        let call = f.completeBuy(ev.coin, ev.payer);
        // Still can't buy (a pushed price, a coin younger than the fetch's window): it waits for the next pass.
        if call.call().await.is_err() {
            continue;
        }
        let call = match super::gas::swap_limit(&call).await { Some(g) => call.gas(g), None => call };
        let tx = send!(call, "completing a parked coin buy");
        log("Completed a parked coin buy", "coin", None, &tx, Some(format!("the coins a fetch paid for, now staked for {:#x}", ev.payer)));
        sent.push(tx);
    }
    Ok(sent)
}

/// Sends on route shares Settlement held for the owner's own payers because their call into the fetch failed inside a
/// claim (`LeanSettlement.sendHeld`). Tried first as a call: one that still fails waits.
pub async fn send_own_held(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Vec<String>, String> {
    let d = chain.deployed()?;
    if coins_of(&d).is_err() {
        return Ok(Vec::new());
    }
    let own = own_payers(keys)?;
    let p = as_signer(owner_signer(keys)?).await?;
    let s = LeanSettlement::new(d.settlement, &p);
    let filter = alloy::rpc::types::Filter::new()
        .address(d.settlement)
        .event_signature(LeanSettlement::LegFailed::SIGNATURE_HASH)
        .topic1(B256::from(U256::from(1u8)))
        .topic3(own.iter().map(|a| a.into_word()).collect::<Vec<_>>());
    let mut seen = BTreeSet::new();
    let mut sent = Vec::new();
    for l in logs(&p, filter, d.block, None).await? {
        let Ok(ev) = LeanSettlement::LegFailed::decode_log(&l.inner) else { continue };
        if !seen.insert((ev.entryId, ev.payer)) {
            continue;
        }
        let k = keccak256((ev.entryId, ev.payer).abi_encode());
        if s.routeHeld(k).call().await.map_err(|e| e.to_string())?.is_zero() {
            continue;
        }
        let call = s.sendHeld(ev.entryId, ev.payer);
        if call.call().await.is_err() {
            continue;
        }
        let call = match super::gas::swap_limit(&call).await { Some(g) => call.gas(g), None => call };
        let tx = send!(call, "sending on a held route share");
        log("Sent on a held route share", "coin", None, &tx, Some(format!("entry {:#x}: its fetch now buys the coin it couldn't in the claim", ev.entryId)));
        sent.push(tx);
    }
    Ok(sent)
}

/// How long after its last sample a coin's price is sampled again for the fetch's drift bound (`CoinFetch.poke`): an
/// eighth of the fetch's window, as UNB's pool is.
pub const POKE_EVERY: u64 = FETCH_WINDOW / 8;

/// Whether a coin whose price record last moved at `last` is due a sample at `now`.
pub fn poke_due_at(last: u64, now: u64) -> bool {
    now.saturating_sub(last) >= POKE_EVERY
}

/// Samples the price of the coins the owner's wallets hold or stake, once a sample is due (`CoinFetch.poke`), as the
/// claim pass samples UNB's pool: the fetch's buy is held to
/// that record (`MAX_DRIFT_BPS` over `WINDOW`), so a node keeps the samples coming for the coins it buys.
pub async fn poke_due(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Vec<String>, String> {
    let d = chain.deployed()?;
    let Ok(c) = coins_of(&d) else { return Ok(Vec::new()) };
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.map(|b| b.header.timestamp).unwrap_or(0);
    let rc = RouteCoins::new(c.route_coins, &p);
    let mut sent = Vec::new();
    for coin in coins_held(chain, me).await? {
        let last = rc.lastTradeAt(coin).call().await.map_err(|e| e.to_string())?;
        if !poke_due_at(last, now) {
            continue;
        }
        let f = CoinFetch::new(c.coin_fetch, &p);
        let call = f.poke(coin);
        if call.call().await.is_err() {
            continue;
        }
        let tx = send!(call, "sampling a route coin's price");
        log("Sampled a route coin's price", "coin", None, &tx, Some(format!("{coin:#x}, so the fetch's next buy of it can read it")));
        sent.push(tx);
    }
    Ok(sent)
}

/// One launch the listing's first buy made (`coin_dev_buy_bps`), as the owner is shown it on Money (`first_buys`).
/// Kept in `<chain>/coin-first-buys.json` from before the launch is sent, so a launch the node lost sight of is
/// recognised when it lands, and a stake the node didn't get to send after it goes out on a later pass.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct FirstBuy {
    pub entry: String,
    pub coin: String,
    /// The share of the wallet's UNB it spent, in basis points, and the UNB that was.
    pub bps: u32,
    pub unb: f64,
    /// The coins it bought, in whole coins and exactly in units, staked for the owner with exit delay `delay` seconds.
    pub coins: f64,
    pub units: String,
    pub delay: u64,
    /// The launch's transaction; none while it may still land.
    pub launch_tx: Option<String>,
    /// The stake's transaction once it went; `none` when the coins had left the wallet before it could.
    pub stake_tx: Option<String>,
    pub at: u64,
}

fn first_buys_path() -> std::path::PathBuf {
    dir().join("coin-first-buys.json")
}

/// The launches the listing's first buy made, oldest first.
pub fn first_buys() -> Vec<FirstBuy> {
    store::read_json(&first_buys_path(), &unbrowse_files::COIN_FIRST_BUYS)
}

fn keep_first_buys(all: &[FirstBuy]) -> Result<(), String> {
    store::write_json(&first_buys_path(), &unbrowse_files::COIN_FIRST_BUYS, &all.to_vec())
}

/// The listing's first buy for a wallet holding `held` UNB: `bps` basis points of it, rounded down.
pub fn first_buy_units(held: U256, bps: u32) -> U256 {
    held * U256::from(bps.min(10_000)) / U256::from(10_000u64)
}

/// The listing's first buy (`coin_dev_buy_bps`, 1% of the wallet's UNB by default, `decide.dev-buy-default-on`): each
/// entry the owner's wallet is credited with that has no coin is launched with that share of the UNB the wallet holds
/// at that moment, and the coins it bought are staked for the owner at its fetch delay (`CoinStakes.fetchDelayOf`),
/// each through `inflight` and an exact allowance to the verified contract. The owner is told of each in the activity
/// feed and on Money (`first_buys`). A wallet with no UNB, or a share too small for the curve to sell anything for,
/// launches nothing, and the route stays listed. Never twice: an entry with a coin is passed by, a launch or stake
/// that may still land is not sent again, and one the node lost sight of is taken up once it lands.
pub async fn launch_listed(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Vec<String>, String> {
    let d = chain.deployed()?;
    let Ok(c) = coins_of(&d) else { return Ok(Vec::new()) };
    let p = ProviderBuilder::new().connect_http(url());
    let me = owner_signer(keys)?.address();
    let rc = RouteCoins::new(c.route_coins, &p);
    let mut sent = Vec::new();
    // First buys sent before: one whose launch the node lost sight of, and stakes still to send.
    let mut all = first_buys();
    let mut changed = false;
    for b in all.iter_mut().filter(|b| b.launch_tx.is_none()) {
        let Ok(entry) = b.entry.parse::<B256>() else { continue };
        let key = coin_key("launch", entry);
        match inflight::settle(&p, &key).await? {
            Settled::Waiting(_) => {}
            Settled::Landed(_, r) => {
                inflight::done(&key)?;
                let coin = coin_address(c.route_coins, c.route_coin_implementation, entry);
                let (_, coins) = bought_in(&r, coin, me).unwrap_or_default();
                (b.coins, b.units, b.launch_tx) = (unb_f(coins), coins.to_string(), Some(tx_hash(&r)));
                changed = true;
            }
            // Nothing kept: it never went, or it landed and the node stopped before writing it down. The chain says which:
            // this wallet's launch of the entry's coin, if there is one, is this first buy.
            Settled::Clear => {
                let filter = alloy::rpc::types::Filter::new().address(c.route_coins).event_signature(RouteCoins::Launched::SIGNATURE_HASH).topic1(entry).topic3(me.into_word());
                let launched = match logs(&p, filter, d.block, None).await?.first().and_then(|l| l.transaction_hash) {
                    Some(tx) => p.get_transaction_receipt(tx).await.map_err(|e| e.to_string())?,
                    None => None,
                };
                let coin = coin_address(c.route_coins, c.route_coin_implementation, entry);
                match launched.as_ref().and_then(|r| bought_in(r, coin, me).map(|(_, coins)| (coins, tx_hash(r)))) {
                    Some((coins, tx)) => (b.coins, b.units, b.launch_tx) = (unb_f(coins), coins.to_string(), Some(tx)),
                    None => b.launch_tx = Some(String::new()),
                }
                changed = true;
            }
        }
    }
    all.retain(|b| b.launch_tx.as_deref() != Some(""));
    if changed {
        keep_first_buys(&all)?;
    }
    sent.extend(stake_first_buys(chain, keys).await);

    let bps = store::load_settings().coin_dev_buy_bps;
    if bps == 0 {
        return Ok(sent);
    }
    let delay = fetch_delay(chain, keys).await?.max(1);
    let unb = UNB::new(d.unb, &p);
    for (entry, contributor, _) in super::discovery::credited(&p, &d, d.block, None).await? {
        if contributor != me || rc.coinOf(entry).call().await.map_err(|e| e.to_string())? != Address::ZERO {
            continue;
        }
        if first_buys().iter().any(|b| b.entry == format!("{entry:#x}") && b.launch_tx.is_none()) {
            continue;
        }
        let held = unb.balanceOf(me).call().await.map_err(|e| e.to_string())?;
        let units = first_buy_units(held, bps);
        if units.is_zero() {
            continue;
        }
        let coin = coin_address(c.route_coins, c.route_coin_implementation, entry);
        let mut record = FirstBuy { entry: format!("{entry:#x}"), coin: format!("{coin:#x}"), bps, unb: unb_f(units), coins: 0.0, units: "0".into(), delay, launch_tx: None, stake_tx: None, at: store::now() };
        let mut kept = first_buys();
        kept.push(record.clone());
        keep_first_buys(&kept)?;
        let told = format!(
            "Your listing's first buy: {}% of the UNB your wallet held ({} UNB) launched entry {entry:#x}'s coin, and the coins it bought are staked for you with a {delay} s exit delay (`unbrowse-node coin dev-buy` sets the share; 0 turns it off)",
            f64::from(bps) / 100.0,
            unb_f(units)
        );
        let result = launch_units(chain, keys, entry, units, Some(told)).await;
        let mut kept = first_buys();
        let at = kept.iter().position(|b| b.entry == record.entry && b.launch_tx.is_none());
        match result {
            Ok((done, coins)) => {
                (record.coins, record.units, record.launch_tx) = (unb_f(coins), coins.to_string(), Some(done.tx.clone()));
                if let Some(i) = at {
                    kept[i] = record;
                }
                keep_first_buys(&kept)?;
                sent.push(done.tx);
            }
            // Kept: it may still land, and a later pass takes it up.
            Err(e) if crate::rpc::unsettled(&e) => eprintln!("coins: the first buy of entry {entry:#x} may still land: {e}"),
            Err(e) => {
                if let Some(i) = at {
                    kept.remove(i);
                    keep_first_buys(&kept)?;
                }
                // Too little UNB for the curve to sell anything for: launched nothing, said nothing.
                if e != SELLS_NOTHING {
                    eprintln!("coins: launching entry {entry:#x}'s coin with the listing's first buy: {e}");
                }
            }
        }
    }
    sent.extend(stake_first_buys(chain, keys).await);
    Ok(sent)
}

/// Stakes each first buy's coins that aren't staked yet, as many of them as the wallet still holds.
async fn stake_first_buys(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Vec<String> {
    let mut sent = Vec::new();
    for b in first_buys().into_iter().filter(|b| b.launch_tx.as_deref().is_some_and(|t| !t.is_empty()) && b.stake_tx.is_none()) {
        let (Ok(entry), Ok(coin), Ok(units)) = (b.entry.parse::<B256>(), b.coin.parse::<Address>(), b.units.parse::<U256>()) else { continue };
        let staked = async {
            let p = ProviderBuilder::new().connect_http(url());
            let me = owner_signer(keys)?.address();
            let held = RouteCoin::new(coin, &p).balanceOf(me).call().await.map_err(|e| e.to_string())?;
            let units = units.min(held);
            if units.is_zero() {
                return Ok("none".to_string());
            }
            stake_units(chain, keys, entry, units, b.delay).await.map(|done| done.tx)
        }
        .await;
        match staked {
            Ok(tx) => {
                let mut kept = first_buys();
                if let Some(x) = kept.iter_mut().find(|x| x.entry == b.entry && x.launch_tx == b.launch_tx) {
                    x.stake_tx = Some(tx.clone());
                }
                if let Err(e) = keep_first_buys(&kept) {
                    eprintln!("coins: keeping the first buys: {e}");
                }
                if tx != "none" {
                    sent.push(tx);
                }
            }
            Err(e) => eprintln!("coins: staking the first buy of entry {entry:#x}: {e}"),
        }
    }
    sent
}

// ---- what the owner holds ----

/// The coins `who` has any position in: staked in, bought for by a fetch or a bounty, or parked for.
async fn coins_held(chain: &Chain, who: Address) -> Result<Vec<Address>, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    let p = ProviderBuilder::new().connect_http(url());
    let mut out = BTreeSet::new();
    let staked = alloy::rpc::types::Filter::new().address(c.coin_stakes).event_signature(CoinStakes::Staked::SIGNATURE_HASH).topic2(who.into_word());
    for l in logs(&p, staked, d.block, None).await? {
        if let Ok(ev) = CoinStakes::Staked::decode_log(&l.inner) {
            out.insert(ev.coin);
        }
    }
    let bought = alloy::rpc::types::Filter::new().address(c.route_coins).event_signature(RouteCoins::Bought::SIGNATURE_HASH).topic3(who.into_word());
    for l in logs(&p, bought, d.block, None).await? {
        if let Ok(ev) = RouteCoins::Bought::decode_log(&l.inner) {
            out.insert(ev.coin);
        }
    }
    let parked = alloy::rpc::types::Filter::new().address(c.coin_fetch).event_signature(CoinFetch::BuyParked::SIGNATURE_HASH).topic2(who.into_word());
    for l in logs(&p, parked, d.block, None).await? {
        if let Ok(ev) = CoinFetch::BuyParked::decode_log(&l.inner) {
            out.insert(ev.coin);
        }
    }
    Ok(out.into_iter().collect())
}

/// One lot of the owner's stake in a coin.
#[derive(Clone, Debug, Serialize)]
pub struct LotView {
    /// Its exit delay, in seconds.
    pub delay: u64,
    /// Coins earning now, and coins staked this epoch that earn from the next.
    pub earning: f64,
    pub pending: f64,
    /// Coins asked back, and when they are ready to take back (a timestamp; 0 when none are).
    pub unstaking: f64,
    pub ready_at: u64,
}

/// What a wallet holds of one coin, for the Money screen.
#[derive(Clone, Debug, Serialize)]
pub struct Holding {
    pub coin: String,
    pub entry: String,
    /// `RouteCoins.stateOf`: "trading" or "not launched".
    pub state: &'static str,
    /// Unstaked coins in the wallet.
    pub held: f64,
    pub lots: Vec<LotView>,
    /// What its stake earned from fetches and hasn't claimed, in USDC.
    pub owed_usdc: f64,
    /// USDC a fetch paid for this wallet whose buy is parked, waiting to be completed.
    pub parked_usdc: f64,
    /// Whether the wallet checked the entry (`coin.check`), and whether its latest paid call on it passed: both must
    /// hold for its stake to earn and count.
    pub checked: bool,
    pub latest_passed: bool,
    /// The coin's price now, UNB a coin, and what its staked and unstaked coins are worth at it.
    pub price: f64,
    pub value_unb: f64,
    /// That value in US dollars, estimated at the UNB pool's steady price (R1.30, `Holdings::unb_usd`): none while the
    /// pool has no steady price to say.
    pub value_usd: Option<f64>,
}

/// What the owner's wallets hold in route coins, per coin, and the USDC `coin.split`'s fallback owes the owner as a
/// contributor: what the Money screen shows in place of the bond, vesting and route stakes.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Holdings {
    pub wallet: String,
    pub coins: Vec<Holding>,
    pub owed_as_contributor_usdc: f64,
    /// The exit delay this wallet's fetches stake with, in seconds.
    pub fetch_delay: u64,
    /// What one UNB is worth in US dollars, estimated (`unb_usd`): what each coin's `value_usd` is reckoned at. None while
    /// the UNB pool has no steady price.
    pub unb_usd: Option<f64>,
}

/// What one UNB is worth in USDC, the network's dollar, estimated at the UNB pool's steady price: the UNB one USDC
/// buys there (`IUnbPool.steadyQuoteUnbOut`, its fee included, so what a buyer pays), inverted. An estimate, not a sale:
/// what the owner would get selling depends on the pool when they do. None with no pool, or while the pool has no
/// steady price (its quote is zero then).
pub async fn unb_usd(p: &impl Provider, d: &Deployment) -> Option<f64> {
    if d.pool == Address::ZERO {
        return None;
    }
    let out = UnbPool::new(d.pool, p).steadyQuoteUnbOut(d.usdc_units(1.0)).call().await.ok()?;
    usd_per_unb(unb_f(out))
}

/// The dollars one UNB is worth when one dollar buys `unb_per_usd` of it: none for a quote of nothing.
pub fn usd_per_unb(unb_per_usd: f64) -> Option<f64> {
    (unb_per_usd.is_finite() && unb_per_usd > 0.0).then(|| 1.0 / unb_per_usd)
}

fn state_name(s: u8) -> &'static str {
    match s {
        1 => "trading",
        _ => "not launched",
    }
}

/// What `who` holds in route coins (`Holdings`).
pub async fn holdings_of(chain: &Chain, who: Address) -> Result<Holdings, String> {
    let d = chain.deployed()?;
    let c = coins_of(&d)?;
    let p = ProviderBuilder::new().connect_http(url());
    let rc = RouteCoins::new(c.route_coins, &p);
    let st = CoinStakes::new(c.coin_stakes, &p);
    let f = CoinFetch::new(c.coin_fetch, &p);
    let e = |e: alloy::contract::Error| e.to_string();
    let mut out = Holdings {
        wallet: format!("{who:#x}"),
        owed_as_contributor_usdc: d.usdc_f(f.owedOf(who).call().await.map_err(e)?),
        fetch_delay: st.fetchDelayOf(who).call().await.map_err(e)?,
        unb_usd: unb_usd(&p, &d).await,
        ..Holdings::default()
    };
    for coin in coins_held(chain, who).await? {
        let Ok(v) = verify_coin_at(&p, &d, coin).await else { continue };
        let held = RouteCoin::new(coin, &p).balanceOf(who).call().await.map_err(e)?;
        let lots = st.lotsOf(coin, who).call().await.map_err(e)?;
        let owed = st.owedOf(coin, who).call().await.map_err(e)?;
        let latest = st.latestPassed(v.entry, who).call().await.map_err(e)?;
        let price = unb_f(rc.priceOf(coin).call().await.map_err(e)?);
        let staked: U256 = lots.iter().fold(U256::ZERO, |a, l| a + l.earning + l.pending + l.unstaking);
        out.coins.push(Holding {
            coin: format!("{coin:#x}"),
            entry: format!("{:#x}", v.entry),
            state: state_name(rc.stateOf(coin).call().await.map_err(e)?),
            held: unb_f(held),
            lots: lots.iter().map(|l| LotView { delay: l.delay, earning: unb_f(l.earning), pending: unb_f(l.pending), unstaking: unb_f(l.unstaking), ready_at: l.readyAt }).collect(),
            owed_usdc: d.usdc_f(owed),
            parked_usdc: d.usdc_f(f.parked(coin, who).call().await.map_err(e)?),
            checked: st.checked(v.entry, who).call().await.map_err(e)?,
            latest_passed: latest.passed,
            price,
            value_unb: unb_f(held + staked) * price,
            value_usd: out.unb_usd.map(|usd| unb_f(held + staked) * price * usd),
        });
    }
    Ok(out)
}

/// What the owner's own wallet holds in route coins.
pub async fn holdings(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<Holdings, String> {
    holdings_of(chain, owner_signer(keys)?.address()).await
}

// ---- rank: the stake book, each coin's market, and the cache ----

/// How long a rank is kept before it is read again: a pick reads ranks many times a second, and they move with the
/// chain's blocks, a stake or a trade at a time.
pub const RANK_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// How long a pick waits for ranks it has none of: past this it picks without them, and the read goes on for the next.
pub const RANK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The stake book read so far, by deployment: read on from where it stopped each time, never from the start again.
static BOOK: LazyLock<tokio::sync::Mutex<Option<(Address, StakeBook)>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));

/// CoinStakes' records in one log, as rank reads them; `None` for any other.
pub fn stake_event(l: &alloy::rpc::types::Log) -> Option<StakeEvent> {
    let t = *l.topic0()?;
    if t == CoinStakes::Staked::SIGNATURE_HASH {
        let ev = CoinStakes::Staked::decode_log(&l.inner).ok()?;
        return Some(StakeEvent::Staked { coin: ev.coin, wallet: ev.wallet, delay: ev.delay, amount: ev.amount });
    }
    if t == CoinStakes::UnstakeRequested::SIGNATURE_HASH {
        let ev = CoinStakes::UnstakeRequested::decode_log(&l.inner).ok()?;
        return Some(StakeEvent::Unstaked { coin: ev.coin, wallet: ev.wallet, delay: ev.delay, amount: ev.amount });
    }
    if t == CoinStakes::Checked::SIGNATURE_HASH {
        let ev = CoinStakes::Checked::decode_log(&l.inner).ok()?;
        return Some(StakeEvent::Checked { entry: ev.entryId, wallet: ev.wallet });
    }
    if t == CoinStakes::LineNoted::SIGNATURE_HASH {
        let ev = CoinStakes::LineNoted::decode_log(&l.inner).ok()?;
        return Some(StakeEvent::Noted { entry: ev.entryId, wallet: ev.wallet, epoch: ev.epoch, passed: ev.passed });
    }
    None
}

/// The stake book up to the followed head: CoinStakes' `Staked`, `UnstakeRequested`, `Checked` and `LineNoted`, read on
/// from where the last read stopped and checked against the second RPC when one is named (`agreed_logs`).
pub async fn stake_book(p: &impl Provider, d: &Deployment, head: &crate::rpc::Head) -> Result<StakeBook, String> {
    let c = coins_of(d)?;
    let Some((to, _)) = head.followed else { return Err("the node can't follow the chain to a finalized head just now".into()) };
    let mut kept = BOOK.lock().await;
    let mut book = match kept.take() {
        Some((s, b)) if s == d.settlement && b.to <= to => b,
        _ => StakeBook { to: d.block.saturating_sub(1), ..StakeBook::default() },
    };
    if book.to < to {
        let topics = vec![
            CoinStakes::Staked::SIGNATURE_HASH,
            CoinStakes::UnstakeRequested::SIGNATURE_HASH,
            CoinStakes::Checked::SIGNATURE_HASH,
            CoinStakes::LineNoted::SIGNATURE_HASH,
        ];
        let filter = alloy::rpc::types::Filter::new().address(c.coin_stakes).event_signature(topics);
        let mut got = super::gas::agreed_logs(p, filter, book.to + 1, to).await?;
        got.sort_by_key(|l| (l.block_number.unwrap_or(0), l.log_index.unwrap_or(0)));
        for l in &got {
            if let Some(ev) = stake_event(l) {
                book.apply(&ev);
            }
        }
        book.to = to;
    }
    *kept = Some((d.settlement, book.clone()));
    Ok(book)
}

/// Samples of each coin's price record the node read, `(timestamp, cumulative)`, oldest first: what the time-weighted
/// price over `rank::coin::RANK_PRICE_WINDOW` is read against once a coin is older than the window.
static SAMPLES: LazyLock<std::sync::Mutex<HashMap<Address, VecDeque<(u64, U256)>>>> = LazyLock::new(Default::default);

/// The most samples kept a coin, at most one a `SAMPLE_EVERY`: a little over two windows.
const SAMPLE_EVERY: u64 = 600;
const SAMPLES_KEPT: usize = (2 * crate::rank::coin::RANK_PRICE_WINDOW / SAMPLE_EVERY) as usize + 2;

fn keep_sample(coin: Address, t: u64, cum: U256) {
    let mut all = SAMPLES.lock().unwrap_or_else(|p| p.into_inner());
    let s = all.entry(coin).or_default();
    if s.back().is_some_and(|(last, _)| t < last + SAMPLE_EVERY) {
        return;
    }
    s.push_back((t, cum));
    while s.len() > SAMPLES_KEPT {
        s.pop_front();
    }
}

/// The newest kept sample of `coin`'s record at or before `t`.
fn sample_before(coin: Address, t: u64) -> Option<(u64, U256)> {
    let all = SAMPLES.lock().unwrap_or_else(|p| p.into_inner());
    all.get(&coin)?.iter().rev().find(|(at, _)| *at <= t).copied()
}

/// The time-weighted price of a coin over the window ending `now` (`rank.score`'s, `RANK_PRICE_WINDOW`), from its
/// price record (`RouteCoins.observe`, ∫ price dt since launch): a coin younger than the window is averaged since its
/// launch (the model's `twap`); one whose record hasn't moved for a window is at the rate it grows at; otherwise the
/// record now against a sample at least a window old, read from the node's own samples or from the chain at a block a
/// window back. With none of those it is averaged over the longest stretch the node has.
pub async fn twap(p: &impl Provider, d: &Deployment, coin: Address, head: &crate::rpc::Head, now: (u64, u64)) -> Result<f64, String> {
    let c = coins_of(d)?;
    let (at, t) = now;
    let w = crate::rank::coin::RANK_PRICE_WINDOW;
    let curve = read_at(head, p, c.route_coins, &RouteCoins::curveOfCall { coin }).await?;
    let cum = read_at(head, p, c.route_coins, &RouteCoins::observeCall { coin }).await?;
    let launched = curve.launchedAt;
    if curve.state == 0 || t <= launched {
        return Ok(0.0);
    }
    keep_sample(coin, t, cum);
    if t - launched <= w {
        return Ok(crate::rank::coin::mean_price(U256::ZERO, launched, cum, t).unwrap_or(0.0));
    }
    let last = read_at(head, p, c.route_coins, &RouteCoins::lastTradeAtCall { coin }).await?;
    if last + w <= t {
        // Unmoved for a window: the rate it grows at is the curve's price.
        return Ok(unb_f(read_at(head, p, c.route_coins, &RouteCoins::priceOfCall { coin }).await?));
    }
    if let Some((t0, c0)) = sample_before(coin, t - w) {
        return Ok(crate::rank::coin::mean_price(c0, t0, cum, t).unwrap_or(0.0));
    }
    // A block about a window back, by the chain's own pace over the last stretch, read there if the RPC keeps it.
    let back = 10_000u64.min(at);
    if back > 0 {
        if let Ok(Some(b)) = p.get_block_by_number((at - back).into()).await {
            let span = t.saturating_sub(b.header.timestamp).max(1);
            let blocks = (w as u128 * back as u128 / span as u128) as u64;
            let then = at.saturating_sub(blocks);
            let req = alloy::rpc::types::TransactionRequest::default().to(c.route_coins).input(RouteCoins::observeCall { coin }.abi_encode().into());
            if let (Ok(got), Ok(Some(tb))) = (p.call(req).block(then.into()).await, p.get_block_by_number(then.into()).await) {
                if let Ok(c0) = RouteCoins::observeCall::abi_decode_returns(&got) {
                    if let Some(m) = crate::rank::coin::mean_price(c0, tb.header.timestamp, cum, t) {
                        return Ok(m);
                    }
                }
            }
        }
    }
    let oldest = {
        let all = SAMPLES.lock().unwrap_or_else(|p| p.into_inner());
        all.get(&coin).and_then(|s| s.front().copied())
    };
    match oldest.and_then(|(t0, c0)| crate::rank::coin::mean_price(c0, t0, cum, t)) {
        Some(m) => Ok(m),
        None => Ok(crate::rank::coin::mean_price(U256::ZERO, launched, cum, t).unwrap_or(0.0)),
    }
}

/// What `counted` (delay-weighted) coins of `coin` are worth as the last out (`rank.last-out`): the sale of `counted`
/// coins after every unstaked coin outside the curve was sold first, before the trade fee, as the curve quotes it at
/// the head.
pub async fn last_out(p: &impl Provider, d: &Deployment, coin: Address, staked: U256, counted: f64, head: &crate::rpc::Head) -> Result<f64, String> {
    let c = coins_of(d)?;
    if !(counted > 0.0) {
        return Ok(0.0);
    }
    let curve = read_at(head, p, c.route_coins, &RouteCoins::curveOfCall { coin }).await?;
    let supply = read_at(head, p, c.route_coins, &RouteCoins::SUPPLYCall {}).await?;
    // Coins still in the curve are none of anyone's.
    let inside = curve.coinReserve;
    let unstaked = supply.saturating_sub(inside).saturating_sub(staked);
    let n = unb_units(counted);
    let gross = |q: RouteCoins::quoteSellReturn| q.unbOut + q.fee;
    let before = read_at(head, p, c.route_coins, &RouteCoins::quoteSellCall { coin, coinsIn: unstaked }).await?;
    let after = read_at(head, p, c.route_coins, &RouteCoins::quoteSellCall { coin, coinsIn: unstaked + n }).await?;
    Ok(unb_f(gross(after).saturating_sub(gross(before))))
}

/// `entry`'s rank at the head, from the stake book and its coin's market (`rank::coin::score`): none for an entry
/// with no coin.
pub async fn rank_of(p: &impl Provider, d: &Deployment, entry: B256, book: &StakeBook, head: &crate::rpc::Head, now: (u64, u64)) -> Result<Rank, String> {
    let c = coins_of(d)?;
    let coin = coin_address(c.route_coins, c.route_coin_implementation, entry);
    if verify_coin(p, d, entry).await.is_err() {
        return Ok(Rank::default());
    }
    let counted = crate::rank::coin::counted_stake(book, entry, coin);
    if counted <= 0.0 {
        return Ok(Rank::default());
    }
    let price = twap(p, d, coin, head, now).await?;
    let supply = unb_f(read_at(head, p, c.route_coins, &RouteCoins::SUPPLYCall {}).await?);
    let out = last_out(p, d, coin, book.staked(coin), counted, head).await?;
    Ok(crate::rank::coin::score(counted, &Market { supply, twap: price, last_out: out }))
}

/// Ranks this node read, by entry, with when.
static RANKS: LazyLock<std::sync::Mutex<HashMap<B256, (std::time::Instant, Rank)>>> = LazyLock::new(Default::default);
/// One refresh at a time.
static REFRESHING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn cached(entries: &[B256]) -> (HashMap<B256, Rank>, Vec<B256>) {
    let all = RANKS.lock().unwrap_or_else(|p| p.into_inner());
    let mut have = HashMap::new();
    let mut stale = Vec::new();
    for e in entries {
        match all.get(e) {
            Some((at, r)) => {
                have.insert(*e, *r);
                if at.elapsed() >= RANK_TTL {
                    stale.push(*e);
                }
            }
            None => stale.push(*e),
        }
    }
    (have, stale)
}

/// Reads `entries`' ranks at a newly followed head and keeps them.
async fn refresh(d: Deployment, entries: Vec<B256>) -> Result<(), String> {
    let _one = REFRESHING.lock().await;
    let (_, stale) = cached(&entries);
    if stale.is_empty() {
        return Ok(());
    }
    let p = ProviderBuilder::new().connect_http(url());
    let head = crate::rpc::Head::follow(&p).await?;
    let book = stake_book(&p, &d, &head).await?;
    let now = head_time(&head, &p).await?;
    for e in stale {
        let r = rank_of(&p, &d, e, &book, &head, now).await.unwrap_or_default();
        RANKS.lock().unwrap_or_else(|p| p.into_inner()).insert(e, (std::time::Instant::now(), r));
    }
    Ok(())
}

/// `entries`' ranks (`rank::coin`), as a pick reads them: the ones kept within `RANK_TTL` at once, and the rest read
/// at a newly followed head, waited for at most `wait`; a read that takes longer goes on for the next pick. An entry
/// with no rank read yet is left out (no rank).
pub async fn ranks(chain: &Chain, entries: &[B256], wait: std::time::Duration) -> HashMap<B256, Rank> {
    let (have, stale) = cached(entries);
    if stale.is_empty() {
        return have;
    }
    let Ok(d) = chain.deployed() else { return have };
    if !d.coins.named() {
        return have;
    }
    let read = tokio::spawn(refresh(d, entries.to_vec()));
    let _ = tokio::time::timeout(wait, read).await;
    cached(entries).0
}

/// Forgets every kept rank and the stake book, for a test that starts a new deployment.
#[cfg(test)]
pub(crate) async fn forget_ranks() {
    RANKS.lock().unwrap_or_else(|p| p.into_inner()).clear();
    *BOOK.lock().await = None;
    SAMPLES.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A route coin's value is shown in UNB and, beside it, in dollars (R1.30): one UNB is worth the inverse of what one
    /// dollar buys at the UNB pool's steady price; a pool that quotes nothing gives no estimate, never a zero.
    #[test]
    fn a_coins_dollars_are_its_unb_at_the_pools_steady_price() {
        assert_eq!(usd_per_unb(2.0), Some(0.5), "a dollar buys 2 UNB: a UNB is half a dollar");
        assert_eq!(usd_per_unb(0.0), None, "no steady price, no estimate");
        assert_eq!(usd_per_unb(f64::NAN), None);
        let value_unb = 1_000.0;
        assert_eq!(usd_per_unb(4.0).map(|usd| value_unb * usd), Some(250.0));
    }

    /// The clone check is OpenZeppelin's own layout: 77 bytes of runtime, its argument the entry id, and the address
    /// CREATE2 gives that creation code; anything else at the address is no coin.
    /// The listing's first buy is its share of what the wallet holds, rounded down: nothing from an empty wallet or at a
    /// share of 0, and never more than all of it.
    #[test]
    fn the_first_buy_is_its_share_of_the_wallets_unb() {
        let u = |x: u64| U256::from(x);
        assert_eq!(first_buy_units(u(1_000_000), 100), u(10_000), "1%");
        assert_eq!(first_buy_units(u(99), 100), U256::ZERO, "too little rounds to none: launched nothing");
        assert_eq!(first_buy_units(U256::ZERO, 100), U256::ZERO, "no UNB");
        assert_eq!(first_buy_units(u(1_000_000), 0), U256::ZERO, "off");
        assert_eq!(first_buy_units(u(1_000_000), 20_000), u(1_000_000), "never past all of it");
    }

    #[test]
    fn a_coin_is_the_clone_of_the_implementation_at_its_entrys_address() {
        let (factory, implementation, entry) = (Address::repeat_byte(0xfa), Address::repeat_byte(0x1e), B256::repeat_byte(0xe1));
        let runtime = clone_runtime(implementation, entry);
        assert_eq!(runtime.len(), 77);
        assert_eq!(&runtime[10..30], implementation.as_slice());
        assert_eq!(&runtime[45..], entry.as_slice());
        let creation = clone_creation(implementation, entry);
        assert_eq!(&creation[..3], &[0x61, 0x00, 0x4d], "the header returns 77 bytes");
        assert_eq!(&creation[10..], runtime.as_slice());
        assert!(is_clone_of(&runtime, implementation, entry));
        assert!(!is_clone_of(&runtime, Address::repeat_byte(0x1f), entry), "a clone of another implementation");
        assert!(!is_clone_of(&runtime, implementation, B256::repeat_byte(0xe2)), "another entry's clone");
        let mut tampered = runtime.clone();
        tampered[0] ^= 1;
        assert!(!is_clone_of(&tampered, implementation, entry));
        assert!(!is_clone_of(&[], implementation, entry), "no code");
        // The address is CREATE2 over that creation code, salted by the entry, and differs by entry and by factory.
        let at = coin_address(factory, implementation, entry);
        assert_eq!(at, factory.create2(entry, keccak256(&creation)));
        assert_ne!(at, coin_address(factory, implementation, B256::repeat_byte(0xe2)));
        assert_ne!(at, coin_address(Address::repeat_byte(0xfb), implementation, entry));
    }

    /// The clone layout is what the deployed implementation's real clones run: OpenZeppelin's `Clones` at the version
    /// the contracts vendor (5.7), checked against its published creation-code prefix.
    #[test]
    fn the_clone_layout_is_openzeppelins() {
        let creation = clone_creation(Address::ZERO, B256::ZERO);
        assert_eq!(alloy::hex::encode(&creation[..20]), "61004d3d81600a3d39f3363d3d373d3d3d363d73");
        assert_eq!(alloy::hex::encode(&creation[40..55]), "5af43d82803e903d91602b57fd5bf3");
    }

    /// The owner's parked buys are completed, nobody else's, unless the owner turned that on.
    #[test]
    fn parked_buys_are_completed_only_for_the_owners_payers() {
        let (me, granted, stranger) = (Address::repeat_byte(1), Address::repeat_byte(2), Address::repeat_byte(3));
        let own: BTreeSet<Address> = [me, granted].into();
        assert!(completes_for(me, &own, false));
        assert!(completes_for(granted, &own, false), "a wallet the owner's agents pay from is the owner's");
        assert!(!completes_for(stranger, &own, false), "never anyone else's by default");
        assert!(completes_for(stranger, &own, true), "anyone's once coin_complete_others is on");
    }

    #[test]
    fn a_coin_is_poked_once_a_sample_is_due() {
        assert!(!poke_due_at(1_000, 1_000 + POKE_EVERY - 1));
        assert!(poke_due_at(1_000, 1_000 + POKE_EVERY));
        assert!(!poke_due_at(2_000, 1_000), "a clock behind the record isn't due");
    }

    #[test]
    fn slippage_takes_a_hundredth_off_a_quote() {
        assert_eq!(at_least(U256::from(10_000u64)), U256::from(9_900u64));
        assert_eq!(at_least(U256::ZERO), U256::ZERO);
    }

    /// The numbers a deployment is held to are `params.toml`'s, and the client's default exit delay is the contract's.
    #[test]
    fn the_route_coin_numbers_are_the_papers() {
        assert_eq!(ROUTE_COIN.supply, 1_000_000_000);
        assert_eq!(ROUTE_COIN.virtual_unb, 30_000_000);
        assert_eq!((ROUTE_COIN.trade_fee_bps, ROUTE_COIN.snipe_start_bps, ROUTE_COIN.snipe_window), (100, 5_000, 300));
        assert_eq!(ROUTE_COIN.unstake_delay, 86_400);
        assert_eq!((ROUTE_COIN.bounty_lister_share_bps, ROUTE_COIN.bounty_use_cap_bps), (5_000, 500));
        assert_eq!(whole_units(ROUTE_COIN.supply), U256::from(10u64).pow(U256::from(27u64)));
    }

    /// The stake book reads each of CoinStakes' four records from its log, and nothing else.
    #[test]
    fn the_stake_book_reads_coinstakes_own_records() {
        use alloy::primitives::{Log as PLog, LogData};
        let (coin, wallet, entry) = (Address::repeat_byte(0xc0), Address::repeat_byte(1), B256::repeat_byte(0xe0));
        let as_log = |data: LogData| alloy::rpc::types::Log { inner: PLog { address: Address::repeat_byte(0x57), data }, ..Default::default() };
        let staked = CoinStakes::Staked { coin, wallet, from: wallet, delay: 3600, amount: U256::from(5u8) };
        assert_eq!(stake_event(&as_log(staked.encode_log_data())), Some(StakeEvent::Staked { coin, wallet, delay: 3600, amount: U256::from(5u8) }));
        let asked = CoinStakes::UnstakeRequested { coin, wallet, delay: 3600, amount: U256::from(2u8), readyAt: 9 };
        assert_eq!(stake_event(&as_log(asked.encode_log_data())), Some(StakeEvent::Unstaked { coin, wallet, delay: 3600, amount: U256::from(2u8) }));
        let checked = CoinStakes::Checked { entryId: entry, wallet };
        assert_eq!(stake_event(&as_log(checked.encode_log_data())), Some(StakeEvent::Checked { entry, wallet }));
        let noted = CoinStakes::LineNoted { entryId: entry, wallet, epoch: 4, passed: false };
        assert_eq!(stake_event(&as_log(noted.encode_log_data())), Some(StakeEvent::Noted { entry, wallet, epoch: 4, passed: false }));
        let other = CoinStakes::FetchDelaySet { wallet, delay: 60 };
        assert_eq!(stake_event(&as_log(other.encode_log_data())), None);
    }
}
