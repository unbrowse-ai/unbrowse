//! Deploying the contracts: the devnet's own, and a live network's shared set, with the guards a mainnet deploy needs.
//!
//! One deployment is, from one key with nothing sent between them (`script/DeployLean.s.sol`'s order, which every
//! constructor checks): the domain proofs at nonce n, `RouteCoins` at n+1, `CoinStakes` at n+2, `CoinFetch` at n+3,
//! `CoinBounties` at n+4, and Settlement at n+5, which checks that each names it. Each names the others by the addresses those nonces give.

use super::*;
use super::coins::{CoinBounties, CoinFetch, CoinStakes, RouteCoins, FETCH_GAS, FETCH_MAX_DRIFT_BPS, FETCH_WINDOW, ROUTE_COIN};

/// What a stand-in pool is seeded with, in whole tokens of each: its depth and its opening price (USDC a UNB is
/// `usdc / unb`). Set by whoever deploys; the devnet's is `POOL_SEED` of each, minted from its own faucets.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PoolSeed {
    pub usdc: f64,
    pub unb: f64,
}

/// Whether an RPC address is this machine's own loopback, where only a devnet runs.
pub(super) fn loopback(rpc: &reqwest_url::Url) -> bool {
    rpc.host_str().is_some_and(|h| {
        h.eq_ignore_ascii_case("localhost") || h.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    })
}

/// Who the curves' trade fee accrues to (`RouteCoins.FEE_RECIPIENT`, `route_coin.trade_fee` "to the platform"; who that
/// is is the owner's, brief Q3): the address `existing` names, else the deployer. Nothing can change it, so it is that
/// address's for good; `mainnet_guard` refuses to let it default where the money is real.
pub(super) fn fee_recipient_of(existing: &Existing, deployer: Address) -> Result<Address, String> {
    match existing.fee_recipient {
        Some(a) if a.is_zero() => Err("the curves' fee recipient is the zero address: RouteCoins refuses it".into()),
        Some(a) => Ok(a),
        None => Ok(deployer),
    }
}

/// What a deploy has made so far, written after each contract it makes (`chain deploy` keeps it in
/// `networks/<network>.deploying.json`). A deploy is a dozen writes on a public RPC, and one that failed partway (the
/// RPC gone, the gas run out, another write taking the key's nonce) left everything it had made, a real pool seed
/// included, for the next run to make again. A rerun uses what is recorded here and still on the chain. Only the key
/// that made them uses them, on the chain it made them on, and only for the same deploy (`asked`). A v4 pool's adapter
/// isn't kept: it is one contract, made again.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub by: Address,
    pub chain_id: u64,
    /// The deploy asked for: the network's own contracts, the seed and the values the contracts are made with. A
    /// rerun asking for another is refused, so nothing made for one is used for the other.
    pub asked: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usdc: Option<Address>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unb: Option<Address>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<Address>,
    /// Whether the stand-in pool holds its seed: set once the seed is added, so a rerun never seeds it twice.
    #[serde(default)]
    pub seeded: bool,
    /// The key's nonce the set below starts at (the domain proofs'), and the set made so far, in its order: the domain
    /// proofs, `RouteCoins`, `CoinStakes`, `CoinFetch`, `CoinBounties` (`set_kept`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub set: Vec<Address>,
}

/// The contracts of one set before Settlement, in the order they are made.
pub const SET: [&str; 5] = ["the domain proofs", "RouteCoins", "CoinStakes", "CoinFetch", "CoinBounties"];

/// Where `chain deploy` keeps what it has made on `net` until the deployment is recorded.
pub fn deploying_path(net: &arc::Network) -> PathBuf {
    store::home().join("networks").join(format!("{}.deploying.json", net.name))
}

/// The set an earlier run made that this run goes on from, and the nonce the set starts at. Each contract names the
/// others by the address its nonce gives, from `base`, so a set is kept only while the key, at `nonce` now, makes the
/// next one where the others expect it: `made` holds the first `k` of the set, still on the chain, and `nonce` is
/// `base + k`. A write from the key since (another writer, or a contract sent and lost) moved its nonce past that, and
/// a set naming addresses it can never make is of no use: it is begun again at `nonce`.
pub fn set_kept(made: &[Address], base: Option<u64>, nonce: u64) -> (Vec<Address>, u64) {
    match base {
        Some(b) if made.len() < SET.len() && b + made.len() as u64 == nonce => (made.to_vec(), b),
        _ => (Vec::new(), nonce),
    }
}

/// Whether `me`'s next write, at `nonce`, is the one the set expects at `want`: anything else written from the key
/// in between would put the contract where nothing names it.
pub fn nonce_lands(me: Address, nonce: u64, want: u64, what: &str) -> Result<(), String> {
    if nonce == want {
        return Ok(());
    }
    Err(format!(
        "another write from {me:#x} landed while the contracts that name each other were made, so {what} can't go at the address the others name. Nothing more was sent: run `chain deploy` again once nothing else writes with this key, and it begins the set again"
    ))
}

/// `at`, recorded by an earlier run, when a contract is still there.
async fn still_there(p: &impl Provider, at: Option<Address>) -> Result<Option<Address>, String> {
    let Some(a) = at else { return Ok(None) };
    Ok((!p.get_code_at(a).await.map_err(|e| e.to_string())?.is_empty()).then_some(a))
}

/// Deploys the domain proofs, the four route-coin contracts and LeanSettlement signed by `signer`, with the spec's
/// constructor values, on the USDC, UNB and pool `existing` names, deploying a stand-in for each it doesn't: the test
/// tokens (a test USDC of `test_usdc_decimals`), whose faucets the signer then owns, and a constant-product pool of the
/// two, seeded with `seed`. The seed of a token the signer deployed is minted; of one the network has, it comes from the
/// signer's own balance, checked before anything is sent. With no seed, a pool of two test tokens gets `POOL_SEED` of
/// each, and a deploy that would stand one up beside a network's own token is refused: how much of real money goes into
/// it is never assumed. The curves' fee recipient (`fee_recipient_of`) has no other power over anything: the pool, the
/// DNSSEC trust anchors (`ROOT_ANCHORS`), the escrow wait (`escrow_wait`) and every route-coin number (`ROUTE_COIN`)
/// are fixed by the deploy.
///
/// What an earlier run made (`so_far`) is used where it is still on the chain, and each contract made is recorded
/// there and handed to `keep` before the next write, so a run that stops partway is picked up by the next (`Progress`).
#[allow(clippy::too_many_arguments)]
pub(super) async fn deploy_as(
    signer: PrivateKeySigner,
    gas: u64,
    existing: &Existing,
    v4: Option<&V4Pool>,
    test_usdc_decimals: u8,
    seed: Option<PoolSeed>,
    escrow_wait: u64,
    epoch_blocks: u64,
    _open: &OpenValues,
    mut so_far: Progress,
    keep: &(dyn Fn(&Progress) -> Result<(), String> + Sync),
) -> Result<Deployment, String> {
    let me = signer.address();
    let fee_recipient = fee_recipient_of(existing, me)?;
    let p = paying(signer, gas).await?;
    let made = |what: &str, r: &alloy::rpc::types::TransactionReceipt| -> Result<Address, String> {
        if !r.status() {
            return Err(format!("deploying {what} was reverted"));
        }
        r.contract_address.ok_or_else(|| format!("deploying {what}: no contract address"))
    };
    // A run that made Settlement and stopped before the network's file recorded it: a second would split the network.
    if let (Some(b), 6) = (so_far.base, so_far.set.len()) {
        if still_there(&p, Some(me.create(b + 6))).await?.is_some() {
            return Err(format!(
                "an earlier `chain deploy` made Settlement at {:#x} and stopped before recording it; a second one would split the network. Record that one in the network's file by hand",
                me.create(b + 6)
            ));
        }
    }
    let mut want = named(&p, existing).await?;
    // UNB's v4 pool: its key must name a pool on the manager, read before anything is sent, and the adapter over it is
    // Settlement's pool. The tokens were checked above; the adapter's constructor checks they are the key's pair.
    if let Some(v) = v4 {
        let (Some(usdc), Some(unb)) = (want.usdc, want.unb) else {
            return Err("a v4 pool's key pairs the network's USDC and UNB; name both".into());
        };
        let first = V4Manager::new(v.manager, &p).extsload(v.state_slot(usdc, unb)).call().await.map_err(|e| format!("reading the v4 PoolManager at {:#x}: {e}", v.manager))?;
        if first.is_zero() {
            return Err(format!("the v4 PoolManager at {:#x} has no pool with that key: check its hook, fee and tick spacing", v.manager));
        }
        let adapter = made(
            "the v4 pool's adapter",
            &crate::rpc::mined!(
                V4UnbPool::deploy_builder(&p, v.manager, v.key(usdc, unb), usdc, U256::from(v.buy_fee_bps), alloy::primitives::Uint::<24, 1>::from(v.lp_fee)),
                "deploy the v4 pool's adapter"
            ),
        )?;
        let reserve = V4UnbPool::new(adapter, &p).reserveUsdc().call().await.map_err(|e| format!("reading the v4 pool's depth: {e}"))?;
        if reserve.is_zero() {
            return Err(format!("the v4 pool has no liquidity at its price; Settlement would never swap through it (adapter {adapter:#x})"));
        }
        want.pool = Some(adapter);
    }
    // Fees settle in USDC, and route coins trade against UNB (spec §41). Each is the network's own when its file names it, else the
    // test token, on a live network too until it names one.
    let usdc_decimals = match want.usdc {
        Some(a) => USDC::new(a, &p).decimals().call().await.map_err(|e| format!("reading USDC's decimals: {e}"))?,
        None => test_usdc_decimals,
    };
    let minted = want.usdc.is_none() && want.unb.is_none();
    let seed = match (want.pool, seed) {
        (Some(_), _) => None,
        (None, Some(s)) => Some(s),
        (None, None) if minted => Some(PoolSeed { usdc: POOL_SEED as f64, unb: POOL_SEED as f64 }),
        (None, None) => {
            return Err("the network's file names its own token but no pool, so a stand-in pool is deployed beside it: say how much USDC and UNB to seed it with (`chain deploy --pool <usdc> <unb>`)".into())
        }
    };
    let seed_units = seed.map(|s| (usdc_units(s.usdc, usdc_decimals), unb_units(s.unb)));
    // What an earlier run made, read before anything is sent: a stand-in token or pool the network doesn't name, still
    // there, and the pool only while it trades the tokens this deploy uses.
    let usdc_kept = if want.usdc.is_none() { still_there(&p, so_far.usdc).await? } else { None };
    let unb_kept = if want.unb.is_none() { still_there(&p, so_far.unb).await? } else { None };
    let pool_kept = match (want.pool, want.usdc.or(usdc_kept), want.unb.or(unb_kept), still_there(&p, so_far.pool).await?) {
        (None, Some(u), Some(b), Some(a)) => {
            let pl = UnbPool::new(a, &p);
            let trades = (pl.usdc().call().await.map_err(|e| e.to_string())?, pl.unb().call().await.map_err(|e| e.to_string())?);
            (trades == (u, b)).then_some(a)
        }
        _ => None,
    };
    // A pool an earlier run seeded takes no seed again, so nothing is drawn for one.
    let seeded = pool_kept.is_some() && so_far.seeded;
    let seed_units = seed_units.filter(|_| !seeded);
    if let Some((u, b)) = seed_units {
        if u.is_zero() || b.is_zero() {
            return Err("a pool is seeded with some of each token".into());
        }
        // A seed of the network's own token comes from what the signer holds: checked before anything is sent.
        for (what, token, need, decimals) in [("USDC", want.usdc, u, usdc_decimals), ("UNB", want.unb, b, UNB_DECIMALS)] {
            let Some(token) = token else { continue };
            let held = USDC::new(token, &p).balanceOf(me).call().await.map_err(|e| format!("reading the {what} held: {e}"))?;
            if held < need {
                return Err(format!("{me:#x} holds {} {what} and the pool's seed is {}", whole(held, decimals), whole(need, decimals)));
            }
        }
    }
    let usdc = match want.usdc.or(usdc_kept) {
        Some(a) => a,
        None => {
            let a = made("USDC", &crate::rpc::mined!(USDC::deploy_builder(&p, usdc_decimals), "deploy USDC"))?;
            so_far.usdc = Some(a);
            keep(&so_far)?;
            a
        }
    };
    let token = match want.unb.or(unb_kept) {
        Some(a) => a,
        None => {
            let a = made("UNB", &crate::rpc::mined!(UNB::deploy_builder(&p), "deploy UNB"))?;
            so_far.unb = Some(a);
            keep(&so_far)?;
            a
        }
    };
    let pool = match want.pool {
        Some(a) => a,
        None => {
            let pool = match pool_kept {
                Some(a) => a,
                None => {
                    let a = made("the pool", &crate::rpc::mined!(UnbPool::deploy_builder(&p, usdc, token), "deploy the pool"))?;
                    so_far.pool = Some(a);
                    so_far.seeded = false;
                    keep(&so_far)?;
                    a
                }
            };
            if let Some((u, b)) = seed_units {
                if want.usdc.is_none() {
                    let _ = send!(USDC::new(usdc, &p).faucet(me, u), "minting the pool's USDC");
                }
                if want.unb.is_none() {
                    let _ = send!(UNB::new(token, &p).faucet(me, b), "minting the pool's UNB");
                }
                let _ = send!(USDC::new(usdc, &p).approve(pool, u), "approving the pool's USDC");
                let _ = send!(UNB::new(token, &p).approve(pool, b), "approving the pool's UNB");
                let _ = send!(UnbPool::new(pool, &p).addLiquidity(u, b, U256::ZERO, me), "seeding the pool");
                so_far.seeded = true;
                keep(&so_far)?;
                // A fetch swaps through a pool only once its price has a mean over a whole window
                // (`UnbPool.WINDOW_BLOCKS`): until then a claim's route share is parked for (coin, payer). A devnet on
                // this machine mines the window at once, so its first claim buys like any later one; a shared network's
                // pool lives long before its first claim, and the node's claim pass completes what was parked.
                if loopback(&url()) {
                    let window = UnbPool::new(pool, &p).WINDOW_BLOCKS().call().await.map_err(|e| e.to_string())?;
                    let blocks = U256::from(2 * window + 1);
                    let mined: Result<serde_json::Value, _> = p.raw_request("anvil_mine".into(), (blocks,)).await;
                    if let Err(e) = mined {
                        eprintln!("devnet: couldn't mine the pool's first price window ({e}); claims wait for it");
                    }
                }
            }
            pool
        }
    };
    // Listings checks a listing's signer against its ERC-8004 identity in the chain's registry (R2.14); a chain with
    // none known (a plain devnet) gives none, and an identity then speaks for itself.
    let chain_id = p.get_chain_id().await.map_err(|e| e.to_string())?;
    let identity = arc::by_chain_id(chain_id).map(|n| n.identity).unwrap_or(Address::ZERO);
    // The set, each naming the others by the addresses the key's nonces give from `base`.
    let nonce = p.get_transaction_count(me).pending().await.map_err(|e| e.to_string())?;
    let mut kept_now = Vec::new();
    for a in &so_far.set {
        match still_there(&p, Some(*a)).await? {
            Some(a) => kept_now.push(a),
            None => break,
        }
    }
    let (mut set, base) = set_kept(&kept_now, so_far.base, nonce);
    (so_far.base, so_far.set) = (Some(base), set.clone());
    keep(&so_far)?;
    let at = |k: u64| me.create(base + k);
    let (domains_at, coins_at, stakes_at, fetch_at, bounties_at, settlement_at) = (at(0), at(1), at(2), at(3), at(4), at(5));
    for k in set.len()..SET.len() {
        nonce_lands(me, p.get_transaction_count(me).pending().await.map_err(|e| e.to_string())?, base + k as u64, SET[k])?;
        let receipt = match k {
            0 => crate::rpc::mined!(
                Domains::deploy_builder(&p, settlement_at, Bytes::from_static(&ROOT_ANCHORS), escrow_wait, epoch_blocks),
                "deploy the domain proofs"
            ),
            1 => crate::rpc::mined!(
                RouteCoins::deploy_builder(
                    &p,
                    RouteCoins::Config {
                        unb: token,
                        settlement: settlement_at,
                        bounties: bounties_at,
                        feeRecipient: fee_recipient,
                        supply: U256::from(ROUTE_COIN.supply) * U256::from(10u64).pow(U256::from(18u64)),
                        virtualUnb: U256::from(ROUTE_COIN.virtual_unb) * U256::from(10u64).pow(U256::from(18u64)),
                        tradeFeeBps: U256::from(ROUTE_COIN.trade_fee_bps),
                        snipeStartBps: U256::from(ROUTE_COIN.snipe_start_bps),
                        snipeWindow: U256::from(ROUTE_COIN.snipe_window),
                    }
                ),
                "deploy RouteCoins"
            ),
            2 => crate::rpc::mined!(CoinStakes::deploy_builder(&p, coins_at, usdc, settlement_at, fetch_at, ROUTE_COIN.unstake_delay), "deploy CoinStakes"),
            3 => crate::rpc::mined!(
                CoinFetch::deploy_builder(
                    &p,
                    CoinFetch::Config {
                        settlement: settlement_at,
                        coins: coins_at,
                        stakes: stakes_at,
                        pool,
                        usdc,
                        fetchGas: U256::from(FETCH_GAS),
                        maxDriftBps: U256::from(FETCH_MAX_DRIFT_BPS),
                        window: U256::from(FETCH_WINDOW),
                    }
                ),
                "deploy CoinFetch"
            ),
            _ => crate::rpc::mined!(
                CoinBounties::deploy_builder(&p, coins_at, stakes_at, settlement_at, pool, U256::from(ROUTE_COIN.bounty_lister_share_bps), U256::from(ROUTE_COIN.bounty_use_cap_bps)),
                "deploy CoinBounties"
            ),
        };
        let a = made(SET[k], &receipt)?;
        set.push(a);
        so_far.set = set.clone();
        keep(&so_far)?;
    }
    nonce_lands(me, p.get_transaction_count(me).pending().await.map_err(|e| e.to_string())?, base + 5, "Settlement")?;
    let receipt = crate::rpc::mined!(
        LeanSettlement::deploy_builder(&p, usdc, token, epoch_blocks, pool, identity, domains_at, fetch_at, stakes_at, bounties_at),
        "deploy Settlement"
    );
    let settlement = made("Settlement", &receipt)?;
    if settlement != settlement_at {
        return Err(format!("Settlement landed at {settlement:#x}, not {settlement_at:#x} where the set names it"));
    }
    // The domain proofs' constructor made the verifier.
    let dnssec = LeanSettlement::new(settlement, &p).dnssec().call().await.map_err(|e| format!("reading Settlement's DNSSEC verifier: {e}"))?;
    let implementation = RouteCoins::new(coins_at, &p).IMPLEMENTATION().call().await.map_err(|e| format!("reading the coins' implementation: {e}"))?;
    // Settlement's logs start in the block that made it; the set's logs before it name nothing yet.
    let block = receipt.block_number.ok_or("deploy Settlement: no block")?;
    let coins = Coins {
        route_coins: coins_at,
        route_coin_implementation: implementation,
        coin_stakes: stakes_at,
        coin_fetch: fetch_at,
        coin_bounties: bounties_at,
        chain_id: Some(chain_id),
        block: Some(block),
    };
    Ok(Deployment { usdc, usdc_decimals, unb: token, pool, settlement, dnssec, domains: domains_at, escrow_wait, epoch_blocks, coins, chain_id, block, code: code_hash() })
}

/// The contracts a network names, checked before anything is sent: each is a contract, a named pool's pair fills in
/// the tokens left out and must match the ones named, and a named UNB counts in 18 decimals, as the node counts UNB.
/// A named USDC may count in any: the deployment records its own (Arc's has 6).
pub(super) async fn named(p: &impl Provider, existing: &Existing) -> Result<Existing, String> {
    let mut want = existing.clone();
    for (what, a) in [("USDC", want.usdc), ("UNB", want.unb), ("the pool", want.pool)] {
        if let Some(a) = a {
            if p.get_code_at(a).await.map_err(|e| e.to_string())?.is_empty() {
                return Err(format!("the network file names {what} at {a:#x}, but there's no contract there"));
            }
        }
    }
    if let Some(pool) = want.pool {
        let pl = UnbPool::new(pool, p);
        let pair = [("USDC", &mut want.usdc, pl.usdc().call().await), ("UNB", &mut want.unb, pl.unb().call().await)];
        for (what, mine, theirs) in pair {
            let theirs = theirs.map_err(|e| format!("reading the pool's {what}: {e}"))?;
            match mine {
                Some(a) if *a != theirs => return Err(format!("the network file names {what} {a:#x}, but its pool trades {theirs:#x}")),
                _ => *mine = Some(theirs),
            }
        }
    }
    if let Some(a) = want.unb {
        let d = UNB::new(a, p).decimals().call().await.map_err(|e| format!("reading UNB's decimals: {e}"))?;
        if d != UNB_DECIMALS {
            return Err(format!("UNB at {a:#x} counts in {d} decimals; the node counts UNB in {UNB_DECIMALS}"));
        }
    }
    Ok(want)
}

/// On Arc mainnet a deploy builds on UNB's live token and its existing public pool and never stands up its own, nor a
/// test USDC (spec §75.4): the stand-ins are for devnets and the testnet. Their addresses come from the operator's own
/// machine at deploy time, never from the file the build ships, which names neither: either an `IUnbPool` with
/// `UNBROWSE_ARC_MAINNET_POOL` (and `_UNB`, else read from the pool), or `existing` in
/// `~/.unbrowse/networks/arc-mainnet.json`; or UNB's v4 pool by its key (`v4_pool`, the `_V4_*` variables, with
/// `_UNB`), which the deploy puts its adapter over.
pub fn mainnet_guard(net: &arc::Network, existing: &Existing, v4: Option<&V4Pool>, seed: Option<PoolSeed>) -> Result<(), String> {
    if net.chain_id != arc::ARC_MAINNET.chain_id {
        return Ok(());
    }
    let shipped: NetworkFile = serde_json::from_str(net.file).map_err(|e| e.to_string())?;
    if shipped.existing.unb.is_some() || shipped.existing.pool.is_some() {
        return Err(format!("the built-in networks/{}.json names a UNB or a pool; it must name neither, so a deploy takes them from the operator's machine", net.name));
    }
    if existing.usdc != Some(net.usdc) {
        return Err(format!("on {} Settlement's USDC is Arc's own; a deploy never stands up a test USDC there", net.name));
    }
    if seed.is_some() {
        return Err(format!("on {} a deploy never seeds a pool of its own: it builds on UNB's existing public pool", net.name));
    }
    if existing.pool.is_none() && v4.is_none() {
        return Err(format!(
            "on {} a deploy never deploys its own UNB or pool: name UNB's existing pool (and UNB, else it is read from the pool) with {} and {}, or under `existing` in {}; or UNB's v4 pool by its key with {} and {}",
            net.name,
            existing_var(net, "pool"),
            existing_var(net, "unb"),
            home_network_file(net).display(),
            existing_var(net, "unb"),
            V4_VARS.iter().map(|w| existing_var(net, w)).collect::<Vec<_>>().join(", "),
        ));
    }
    if existing.fee_recipient.is_none() {
        return Err(format!(
            "on {} a deploy never assumes the deploying key takes the curves' trade fee: RouteCoins fixes its recipient for good, and that key is a node's, online. Name one (a multisig) with {}, or under `existing` in {}",
            net.name,
            existing_var(net, "fee_recipient"),
            home_network_file(net).display(),
        ));
    }
    Ok(())
}

/// What a deploy on a v4 pool needs besides its key: the USDC and UNB the key pairs, and no other pool named beside it.
pub(super) fn v4_guard(net: &arc::Network, existing: &Existing, v4: &V4Pool, seed: Option<PoolSeed>) -> Result<(Address, Address), String> {
    if existing.pool.is_some() {
        return Err(format!("both a pool ({}) and a v4 pool ({}) are named; Settlement swaps through one", existing_var(net, "pool"), existing_var(net, "v4_manager")));
    }
    if seed.is_some() {
        return Err("a deploy on a v4 pool seeds nothing: the pool is UNB's own".into());
    }
    let usdc = existing.usdc.ok_or_else(|| format!("a v4 pool's key pairs UNB with the network's USDC; name it with {}", existing_var(net, "usdc")))?;
    let unb = existing.unb.ok_or_else(|| format!("a v4 pool's key names UNB; name it with {}", existing_var(net, "unb")))?;
    if v4.manager == Address::ZERO {
        return Err(format!("{} is the zero address", existing_var(net, "v4_manager")));
    }
    Ok((usdc, unb))
}

/// The epoch a live network's deploy fixes, from its file (R1.28). It has no default: it is the chain's own pace, fixed
/// for good by the deploy, and a wrong one makes every delay, cap and exit delay run long or short.
pub(super) fn epoch_blocks(net: &arc::Network, file: Option<u64>) -> Result<u64, String> {
    file.filter(|b| *b != 0).ok_or_else(|| {
        format!("{} has no `epoch_blocks` in its network file: set it to the blocks this chain makes in 24 hours, measured, before deploying", net.name)
    })
}

/// Deploys the contracts every node on a live network shares, signed by the owner's key: the domain proofs, the route-coin
/// set (the curves' trade fee to who `existing` names, else the owner, `fee_recipient_of`) and Settlement, on the USDC, UNB and pool the network's file names under `existing`, and a
/// stand-in for each it doesn't (test tokens whose faucets the owner then holds, a pool seeded with `seed`). Only the owner runs this, by
/// hand (`unbrowse-node chain deploy`); never when the network's file already names a Settlement on chain, since a
/// second one would split the network. Writes the owner's copy of the network's file, and returns where.
pub async fn deploy_shared(l: &Live, keys: &(dyn KeyStore + Sync), seed: Option<PoolSeed>, open: &OpenValues) -> Result<(PathBuf, NetworkFile), String> {
    check_rpc(l).await?;
    let mut file = network_file(l.net)?;
    set_live(Some(l.clone()));
    // The deploy signs with the node's key: never beside a running node on the same chain's folder.
    store::hold_for_process(&dir())?;
    if let Some(d) = &file.deployment {
        let p = ProviderBuilder::new().connect_http(l.rpc.clone());
        if !p.get_code_at(d.settlement).await.map_err(|e| e.to_string())?.is_empty() {
            return Err(format!("Settlement is already deployed on {} at {:#x}; a second deployment would split the network", l.net.name, d.settlement));
        }
    }
    let v4 = v4_pool(l.net, |k| std::env::var(k).ok())?;
    mainnet_guard(l.net, &file.existing, v4.as_ref(), seed)?;
    if let Some(v) = &v4 {
        v4_guard(l.net, &file.existing, v, seed)?;
    }
    let escrow = escrow_wait(file.escrow_wait)?;
    let epoch_blocks = epoch_blocks(l.net, file.epoch_blocks)?;
    let signer = owner_signer(keys)?;
    let me = signer.address();
    let read = ProviderBuilder::new().connect_http(l.rpc.clone());
    let mined = read.get_transaction_count(me).latest().await.map_err(|e| e.to_string())?;
    let pending = read.get_transaction_count(me).pending().await.map_err(|e| e.to_string())?;
    key_is_quiet(me, mined, pending)?;
    // What an earlier run of this deploy made, by this key on this chain; one of another key or chain is no use here.
    let asked = asked_of(&file.existing, v4.as_ref(), seed, escrow, epoch_blocks, open);
    let progress_at = deploying_path(l.net);
    let kept: Progress = store::read_json_strict(&progress_at, &unbrowse_files::DEPLOYING)?;
    let so_far = if kept.by == me && kept.chain_id == l.net.chain_id {
        if kept.asked != asked {
            return Err(format!(
                "{} records a deploy on {} asked with other values, still under way: run it again as it was asked (the same flags and variables), or move that file aside to start over",
                progress_at.display(),
                l.net.name
            ));
        }
        kept
    } else {
        Progress { by: me, chain_id: l.net.chain_id, asked, ..Default::default() }
    };
    let keep = |p: &Progress| store::write_json(&progress_at, &unbrowse_files::DEPLOYING, p);
    let d = deploy_as(signer, DEPLOY_GAS, &file.existing, v4.as_ref(), 18, seed, escrow, epoch_blocks, open, so_far, &keep).await?;
    file.network = l.net.name.into();
    file.chain_id = l.net.chain_id;
    file.deployment = Some(d);
    let path = home_network_file(l.net);
    store::write_json(&path, &unbrowse_files::NETWORK, &file)?;
    // The deployment is recorded, and with it everything made on the way.
    let _ = std::fs::remove_file(&progress_at);
    Ok((path, file))
}

/// A deploy as `Progress::asked` records it: everything the contracts are made with that the owner chooses. The epoch's
/// length goes in too: a set kept from a run that counted another one would refuse the Settlement this run makes.
pub(super) fn asked_of(existing: &Existing, v4: Option<&V4Pool>, seed: Option<PoolSeed>, escrow: u64, epoch_blocks: u64, open: &OpenValues) -> String {
    format!("{existing:?} {v4:?} {seed:?} {escrow} {epoch_blocks} {open:?}")
}

/// Whether `me` is free for a deploy: no write of its still pending (`pending` past `mined`). A deploy's contracts go
/// one after another from this key, each naming the others by the nonces they take (`set_kept`); a write in
/// flight says something else is writing with the key now (the node, running with it here or elsewhere), and its next
/// write would take a nonce the deploy counts on.
pub fn key_is_quiet(me: Address, mined: u64, pending: u64) -> Result<(), String> {
    if pending <= mined {
        return Ok(());
    }
    Err(format!(
        "{me:#x} has {} write{} still pending: something else is writing with this key, a node running with it perhaps. A deploy's contracts go one after another from this key alone: stop the other writer, let its writes land, and run `chain deploy` again",
        pending - mined,
        if pending - mined == 1 { "" } else { "s" }
    ))
}
