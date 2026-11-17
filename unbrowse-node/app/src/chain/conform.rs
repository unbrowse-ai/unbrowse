//! Whether a live network's contracts are the ones this node was built for, read from the chain.
//!
//! The node can't make another peer run the rules, but it can refuse to put money or trust in a contract that doesn't
//! run them. The network's file says where Settlement is and nothing more is taken from it: from that one address the
//! node walks every contract the deployment is made of, as the chain names them, and for each one checks
//!
//! - **its code**: the deployed code, with its immutables and the compiler's metadata blanked, is what this build's
//!   sources compile to (`contracts/runtime.json`, written by `unbrowse-settlement/script/runtime-manifest.py`). The
//!   metadata changes with a comment, so a comment never costs a redeploy;
//! - **its links**: blanking the immutables leaves them to be read. Each contract must name the others back, and the
//!   values a deploy fixes must be the ones it always fixes: every `route_coin.*` number (`coins::ROUTE_COIN`), the
//!   fetch's gas and window. Otherwise a constructor of someone's own
//!   could point the right code at the wrong books, or at other economics.
//!
//! The route-coin set is walked from Settlement (`fetch`, `coinStakes`, `coinBounties`) and from there to the factory,
//! and the clone implementation every coin delegates to; a coin itself is checked before the
//! node approves or trades it (`coins::verify_coin`), against the implementation verified here.
//!
//! A deployment that fails is refused like one that isn't there: the node runs, and only what needs Settlement says
//! why it can't. Nothing here is a rule a peer has to agree to, so nodes on older builds don't change what it finds.
//!
//! What this doesn't reach: storage a constructor of someone's own wrote (only the creation transaction shows that),
//! the curves' fee recipient and the open values (a deploy chooses them, and nothing here says what they must be),
//! and UNB, which on mainnet is the network's own token, not this code; it is held to the pool's pair.

use std::collections::HashMap;
use std::sync::LazyLock;

use sha2::{Digest, Sha256};

use super::*;

sol! {
    /// What every contract that serves one Settlement names.
    #[sol(rpc)]
    interface NamesSettlement {
        function settlement() external view returns (address);
    }
    /// The registry Listings checks signers in.
    #[sol(rpc)]
    interface ListingsLinks {
        function identity() external view returns (address);
    }
    /// The pair a pool trades.
    #[sol(rpc)]
    interface PoolPair {
        function usdc() external view returns (address);
        function unb() external view returns (address);
    }
}

/// What one contract's deployed code must be.
#[derive(Deserialize)]
pub(super) struct Expected {
    size: usize,
    sha256: String,
    /// Where a deployment or a comment may change it: `(start, length)`.
    pub(super) blank: Vec<(usize, usize)>,
}

#[derive(Deserialize)]
struct Runtime {
    contracts: HashMap<String, Expected>,
}

static RUNTIME: LazyLock<Runtime> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../contracts/runtime.json")).expect("contracts/runtime.json reads"));

pub(super) fn expected(contract: &str) -> &'static Expected {
    RUNTIME.contracts.get(contract).unwrap_or_else(|| panic!("contracts/runtime.json has no {contract}"))
}

/// Whether `code` is what `contract` compiles to, whatever its immutables and metadata.
pub(super) fn built_from(contract: &str, code: &[u8]) -> bool {
    let e = expected(contract);
    if code.len() != e.size {
        return false;
    }
    let mut masked = code.to_vec();
    for (start, length) in &e.blank {
        masked[*start..start + length].fill(0);
    }
    hex::encode(Sha256::digest(&masked)) == e.sha256
}

/// Reads one value of a contract whose code has been checked, so a failure is the RPC's, not the contract's.
macro_rules! read {
    ($net:expr, $what:expr, $call:expr) => {
        $call.call().await.map_err(|e| Missing::Unreachable(format!("reading {} on {}: {e}", $what, $net.name)))?
    };
}

async fn code_at(p: &impl Provider, net: &arc::Network, what: &str, at: Address) -> Result<Bytes, Missing> {
    p.get_code_at(at).await.map_err(|e| Missing::Unreachable(format!("reading {what} on {}: {e}", net.name)))
}

fn other_code(net: &arc::Network, what: &str, at: Address) -> Missing {
    Missing::Absent(format!("{what} on {} at {at:#x} was deployed from other contracts than this node's; update the node", net.name))
}

async fn same_code(p: &impl Provider, net: &arc::Network, what: &str, contract: &str, at: Address) -> Result<(), Missing> {
    if built_from(contract, &code_at(p, net, what, at).await?) {
        Ok(())
    } else {
        Err(other_code(net, what, at))
    }
}

fn names<T: PartialEq + std::fmt::Debug>(net: &arc::Network, what: &str, found: T, want: T) -> Result<(), Missing> {
    if found == want {
        Ok(())
    } else {
        Err(Missing::Absent(format!("{what} on {} is {found:?}, not {want:?}; update the network file", net.name)))
    }
}

/// The addresses `check` verified, as it read them: what the node keeps of the deployment and the only ones it ever
/// approves or pays through. They are never read from the RPC again, so an answer that differs later can't put another
/// address behind a write.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Verified {
    pub dnssec: Address,
    pub domains: Address,
    pub listings: Address,
    pub coins: Coins,
}

/// Walks the deployment from Settlement: every contract it is made of is this node's code, and they name each other.
/// What it verified, for the node to keep.
pub(super) async fn check(p: &impl Provider, net: &arc::Network, d: &Deployment) -> Result<Verified, Missing> {
    same_code(p, net, "Settlement", "LeanSettlement", d.settlement).await?;
    let me = d.settlement;
    let s = LeanSettlement::new(me, p);
    // What the node pays and swaps through is the file's word until these agree with Settlement's.
    names(net, "Settlement's USDC", read!(net, "Settlement's USDC", s.usdc()), d.usdc)?;
    let unb = read!(net, "Settlement's UNB", s.unb());
    names(net, "Settlement's UNB", unb, d.unb)?;
    let pool = read!(net, "Settlement's pool", s.pool());
    names(net, "Settlement's pool", pool, d.pool)?;

    let at = read!(net, "Settlement's listings", s.listings());
    same_code(p, net, "Settlement's listings", "Listings", at).await?;
    names(net, "The listings' Settlement", read!(net, "the listings' Settlement", NamesSettlement::new(at, p).settlement()), me)?;
    names(net, "The listings' registry", read!(net, "the listings' registry", ListingsLinks::new(at, p).identity()), net.identity)?;
    let listings = at;

    let domains = read!(net, "Settlement's domain proofs", s.domains());
    same_code(p, net, "Settlement's domain proofs", "Domains", domains).await?;
    let proofs = Domains::new(domains, p);
    names(net, "The domain proofs' Settlement", read!(net, "the domain proofs' Settlement", proofs.settlement()), me)?;
    let dnssec = read!(net, "Settlement's DNSSEC verifier", s.dnssec());
    names(net, "The domain proofs' verifier", read!(net, "the domain proofs' verifier", proofs.dnssec()), dnssec)?;
    same_code(p, net, "The DNSSEC verifier", "FixedDNSSEC", dnssec).await?;

    let coins = check_coins(p, net, d, unb, pool).await?;
    let verified = Verified { dnssec, domains, listings, coins };
    if pool != Address::ZERO {
        let code = code_at(p, net, "Settlement's pool", pool).await?;
        if !built_from("UnbPool", &code) && !built_from("V4UnbPool", &code) {
            return Err(other_code(net, "Settlement's pool", pool));
        }
        let pair = PoolPair::new(pool, p);
        names(net, "The pool's USDC", read!(net, "the pool's USDC", pair.usdc()), d.usdc)?;
        names(net, "The pool's UNB", read!(net, "the pool's UNB", pair.unb()), unb)?;
    }
    Ok(verified)
}

/// The route-coin set Settlement pays through, walked from it: the fetch, the stakes and the bounties Settlement names,
/// the factory they name, and the implementation every coin is a clone of. Each is this build's code, names the others and Settlement back, carries the numbers every deployment
/// fixes, and is the address the network's file records under `coins`.
async fn check_coins(p: &impl Provider, net: &arc::Network, d: &Deployment, unb: Address, pool: Address) -> Result<Coins, Missing> {
    use super::coins::{CoinBounties, CoinFetch, CoinStakes, RouteCoins, FETCH_GAS, FETCH_MAX_DRIFT_BPS, FETCH_WINDOW, ROUTE_COIN};
    let me = d.settlement;
    let s = LeanSettlement::new(me, p);
    let fetch = read!(net, "Settlement's fetch", s.fetch());
    let stakes = read!(net, "Settlement's coin stakes", s.coinStakes());
    let bounties = read!(net, "Settlement's coin bounties", s.coinBounties());
    same_code(p, net, "Settlement's fetch", "CoinFetch", fetch).await?;
    same_code(p, net, "Settlement's coin stakes", "CoinStakes", stakes).await?;
    same_code(p, net, "Settlement's coin bounties", "CoinBounties", bounties).await?;
    let f = CoinFetch::new(fetch, p);
    let route_coins = read!(net, "the fetch's coins", f.COINS());
    same_code(p, net, "The route coins", "RouteCoins", route_coins).await?;
    names(net, "The fetch's Settlement", read!(net, "the fetch's Settlement", f.SETTLEMENT()), me)?;
    names(net, "The fetch's stakes", read!(net, "the fetch's stakes", f.STAKES()), stakes)?;
    names(net, "The fetch's pool", read!(net, "the fetch's pool", f.POOL()), pool)?;
    names(net, "The fetch's USDC", read!(net, "the fetch's USDC", f.USDC()), d.usdc)?;
    names(net, "The fetch's gas", read!(net, "the fetch's gas", f.FETCH_GAS()), U256::from(FETCH_GAS))?;
    names(net, "The fetch's window", read!(net, "the fetch's window", f.WINDOW()), U256::from(FETCH_WINDOW))?;
    names(net, "The fetch's drift bound", read!(net, "the fetch's drift bound", f.MAX_DRIFT_BPS()), U256::from(FETCH_MAX_DRIFT_BPS))?;

    let rc = RouteCoins::new(route_coins, p);
    names(net, "The route coins' Settlement", read!(net, "the route coins' Settlement", rc.SETTLEMENT()), me)?;
    names(net, "The route coins' UNB", read!(net, "the route coins' UNB", rc.UNB()), unb)?;
    names(net, "The route coins' bounties", read!(net, "the route coins' bounties", rc.BOUNTIES()), bounties)?;
    let e18 = U256::from(10u64).pow(U256::from(18u64));
    let supply = U256::from(ROUTE_COIN.supply) * e18;
    names(net, "The coins' supply (route_coin.supply)", read!(net, "the coins' supply", rc.SUPPLY()), supply)?;
    names(net, "The curves' virtual UNB (route_coin.virtual_unb)", read!(net, "the virtual UNB", rc.VIRTUAL_UNB()), U256::from(ROUTE_COIN.virtual_unb) * e18)?;
    names(net, "The trade fee (route_coin.trade_fee)", read!(net, "the trade fee", rc.TRADE_FEE_BPS()), U256::from(ROUTE_COIN.trade_fee_bps))?;
    names(net, "The snipe tax (route_coin.snipe_start)", read!(net, "the snipe tax", rc.SNIPE_START_BPS()), U256::from(ROUTE_COIN.snipe_start_bps))?;
    names(net, "The snipe window (route_coin.snipe_window)", read!(net, "the snipe window", rc.SNIPE_WINDOW()), U256::from(ROUTE_COIN.snipe_window))?;
    let implementation = read!(net, "the coins' implementation", rc.IMPLEMENTATION());
    same_code(p, net, "The coins' implementation", "RouteCoin", implementation).await?;

    let st = CoinStakes::new(stakes, p);
    names(net, "The stakes' coins", read!(net, "the stakes' coins", st.COINS()), route_coins)?;
    names(net, "The stakes' Settlement", read!(net, "the stakes' Settlement", st.SETTLEMENT()), me)?;
    names(net, "The stakes' fetch", read!(net, "the stakes' fetch", st.FETCH()), fetch)?;
    names(net, "The stakes' bounties", read!(net, "the stakes' bounties", st.BOUNTIES()), bounties)?;
    names(net, "The stakes' USDC", read!(net, "the stakes' USDC", st.USDC()), d.usdc)?;
    names(net, "The default exit delay (route_coin.unstake_delay)", read!(net, "the default exit delay", st.DEFAULT_DELAY()), ROUTE_COIN.unstake_delay)?;

    let b = CoinBounties::new(bounties, p);
    names(net, "The bounties' Settlement", read!(net, "the bounties' Settlement", b.SETTLEMENT()), me)?;
    names(net, "The bounties' coins", read!(net, "the bounties' coins", b.COINS()), route_coins)?;
    names(net, "The bounties' stakes", read!(net, "the bounties' stakes", b.STAKES()), stakes)?;
    names(net, "The bounties' pool", read!(net, "the bounties' pool", b.POOL()), pool)?;
    names(net, "The lister's share (route_coin.bounty_lister_share)", read!(net, "the lister's share", b.LISTER_SHARE_BPS()), U256::from(ROUTE_COIN.bounty_lister_share_bps))?;
    names(net, "The use cap (route_coin.bounty_use_cap)", read!(net, "the use cap", b.USE_CAP_BPS()), U256::from(ROUTE_COIN.bounty_use_cap_bps))?;

    let found = Coins {
        route_coins,
        route_coin_implementation: implementation,
        coin_stakes: stakes,
        coin_fetch: fetch,
        coin_bounties: bounties,
        chain_id: d.coins.chain_id,
        block: d.coins.block,
    };
    // The file's word, checked against the chain's: a file naming other coin contracts names nothing this node uses.
    names(net, "The network file's coin contracts", (d.coins.route_coins, d.coins.coin_stakes, d.coins.coin_fetch, d.coins.coin_bounties), (route_coins, stakes, fetch, bounties))?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each contract the node carries is what the manifest says, so the manifest can't drift from what it deploys.
    /// (CI's `runtime-manifest.py --check` holds it, and those made by a constructor, to the sources.)
    #[test]
    fn the_manifest_is_what_the_node_carries() {
        use super::super::coins::{CoinBounties, CoinFetch, CoinStakes, RouteCoins};
        for (name, code) in [
            ("LeanSettlement", &LeanSettlement::DEPLOYED_BYTECODE),
            ("Domains", &Domains::DEPLOYED_BYTECODE),
            ("UnbPool", &UnbPool::DEPLOYED_BYTECODE),
            ("V4UnbPool", &V4UnbPool::DEPLOYED_BYTECODE),
            ("RouteCoins", &RouteCoins::DEPLOYED_BYTECODE),
            ("CoinStakes", &CoinStakes::DEPLOYED_BYTECODE),
            ("CoinFetch", &CoinFetch::DEPLOYED_BYTECODE),
            ("CoinBounties", &CoinBounties::DEPLOYED_BYTECODE),
        ] {
            assert!(built_from(name, code), "{name}: run unbrowse-settlement/script/runtime-manifest.py");
        }
        // Every contract the walk reads must have a record, the one a constructor makes (RouteCoin) included.
        for name in ["Listings", "FixedDNSSEC", "RouteCoin"] {
            let _ = expected(name);
        }
        // A coin's own code, a 77-byte clone, is none of these: it is checked as a clone (`coins::verify_coin`).
        let clone = super::super::coins::clone_runtime(Address::repeat_byte(1), FixedBytes::repeat_byte(2));
        assert!(!built_from("RouteCoin", &clone), "a clone is not its implementation");
    }

    /// The deployments this build ships run its code, read from the chains themselves. A release whose network file
    /// names contracts older than its own fails here: its nodes would refuse them. Read only.
    /// `cargo test -p unbrowse-node-app shipped_networks -- --ignored` (needs the network).
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn the_shipped_networks_run_this_builds_code() {
        for net in arc::NETWORKS {
            let file: NetworkFile = serde_json::from_str(net.file).unwrap();
            let Some(d) = file.deployment else { continue };
            let p = ProviderBuilder::new().connect_http(net.rpc.parse().unwrap());
            check(&p, net, &d).await.unwrap_or_else(|e| panic!("{}: {}", net.name, e.why()));
        }
    }

    /// An immutable or the metadata may differ; a byte of code, or the code's size, may not.
    #[test]
    fn only_the_blanks_may_differ() {
        let code = LeanSettlement::DEPLOYED_BYTECODE.to_vec();
        let e = expected("LeanSettlement");
        let mut other = code.clone();
        for (start, length) in &e.blank {
            other[*start..start + length].fill(0xab);
        }
        assert!(built_from("LeanSettlement", &other), "every blank filled in");

        let open = (0..code.len()).find(|i| !e.blank.iter().any(|(s, l)| (*s..s + l).contains(i))).unwrap();
        let mut changed = code.clone();
        changed[open] ^= 1;
        assert!(!built_from("LeanSettlement", &changed), "one byte of code");
        assert!(!built_from("LeanSettlement", &code[..code.len() - 1]), "shorter");
        assert!(!built_from("LeanSettlement", &[]), "no code");
    }
}
