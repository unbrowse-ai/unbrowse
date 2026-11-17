//! A live network's shared contracts: the network's file, the UNB v4 pool and what makes a deployment usable.

use super::*;

// ---- a live network's shared contracts ----

/// What a live network's file records: the contracts every node on the network shares, and the block its
/// registrations start at. The build ships one for each network (`app/networks/<name>.json`, `arc::Network::file`);
/// `~/.unbrowse/networks/<name>.json`, when there is one, is read instead (`chain deploy` writes it).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NetworkFile {
    /// What the file is, for whoever opens it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub about: String,
    pub network: String,
    pub chain_id: u64,
    /// The block nodes read ERC-8004 registrations from: no Unbrowse identity was registered before it.
    #[serde(default)]
    pub registry_from: Option<u64>,
    /// UNB, Settlement and the route-coin contracts (`coins`, the object `script/DeployCoins.s.sol` prints), once
    /// someone deployed them; `null` until then.
    #[serde(default)]
    pub deployment: Option<Deployment>,
    /// Contracts already on the network that `chain deploy` uses instead of deploying a stand-in.
    #[serde(default)]
    pub existing: Existing,
    /// One epoch on this network, in its blocks (R1.28): 24 hours of them, which `chain deploy` gives the contracts and a
    /// node holds a deployment to. The one deploy value that isn't the protocol's: it is the chain's pace, so it comes
    /// from measuring the chain, and a network that hasn't been measured has none, and can't be deployed on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch_blocks: Option<u64>,
    /// The escrow wait `chain deploy` gives Settlement, in epochs (`escrow.wait`, R4.14); unset, the node's
    /// default (`escrow_wait`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escrow_wait: Option<u64>,
}

/// The network's own USDC, UNB and UNB/USDC pool, when they exist: `chain deploy` builds Settlement on them instead of
/// deploying the test ones. Each left `null` is deployed as the stand-in. A pool fixes the pair it trades, so a token
/// left out is read from a named pool, and one named must be the pool's. `fee_recipient` is who the curves' trade fee
/// accrues to (`fee_recipient_of`), named on the operator's machine, never in a shipped file.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Existing {
    #[serde(default)]
    pub usdc: Option<Address>,
    #[serde(default)]
    pub unb: Option<Address>,
    #[serde(default)]
    pub pool: Option<Address>,
    /// A shipped file leaves it out, and only a deploy reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_recipient: Option<Address>,
}

/// The owner's own copy of a network's file, read over the one the build ships.
pub fn home_network_file(net: &arc::Network) -> PathBuf {
    store::home().join("networks").join(format!("{}.json", net.name))
}

/// The network's file: the owner's copy when there is one, else the build's. One that doesn't read, or names
/// another chain, is an error, never read as empty: it says which contracts hold the money.
pub fn network_file(net: &arc::Network) -> Result<NetworkFile, String> {
    named_by_env(read_network_file(net, &home_network_file(net), net.file)?, net, |k| std::env::var(k).ok())
}

/// The variable on the owner's machine that names a network's own token or pool, over its file: for `arc-mainnet` and
/// `unb`, `UNBROWSE_ARC_MAINNET_UNB`. A deploy can build on an address that isn't written in the repo.
pub fn existing_var(net: &arc::Network, what: &str) -> String {
    format!("UNBROWSE_{}_{}", net.name.to_uppercase().replace('-', "_"), what.to_uppercase())
}

/// `f` with its `existing` USDC, UNB, pool, fee recipient and PoolManager taken from the owner's variables where they are
/// set (`existing_var`).
/// A value that isn't an address is refused, so a typo never deploys a test token in its place.
pub(super) fn named_by_env(mut f: NetworkFile, net: &arc::Network, var: impl Fn(&str) -> Option<String>) -> Result<NetworkFile, String> {
    for (what, slot) in [
        ("usdc", &mut f.existing.usdc),
        ("unb", &mut f.existing.unb),
        ("pool", &mut f.existing.pool),
        ("fee_recipient", &mut f.existing.fee_recipient),
    ] {
        let name = existing_var(net, what);
        if let Some(v) = var(&name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            *slot = Some(v.parse::<Address>().map_err(|_| format!("{name} is set to {v:?}, which isn't an address"))?);
        }
    }
    Ok(f)
}

/// A Uniswap v4 pool of UNB against USDC, the one `chain deploy` puts the adapter (`V4UnbPool`) over and builds
/// Settlement on. Named only on the operator's machine (`v4_pool`), never in a file: its key holds UNB's address.
#[derive(Clone, Debug, PartialEq)]
pub struct V4Pool {
    /// The v4 PoolManager.
    pub manager: Address,
    /// The pool key's hook, its fee (0x800000 when the hook sets it), and its tick spacing.
    pub hook: Address,
    pub fee: u32,
    pub tick_spacing: i32,
    /// What the hook takes of a buy's USDC before the swap, rounded up, in basis points.
    pub buy_fee_bps: u64,
    /// The LP fee a buy swaps at, in pips.
    pub lp_fee: u32,
}

impl V4Pool {
    /// The pool's key for `usdc` and `unb`: v4 orders a key's currencies by address.
    pub(super) fn key(&self, usdc: Address, unb: Address) -> V4UnbPool::V4PoolKey {
        let (currency0, currency1) = if usdc < unb { (usdc, unb) } else { (unb, usdc) };
        V4UnbPool::V4PoolKey {
            currency0,
            currency1,
            fee: alloy::primitives::Uint::<24, 1>::from(self.fee),
            tickSpacing: alloy::primitives::Signed::<24, 1>::try_from(self.tick_spacing).expect("checked in v4_pool"),
            hooks: self.hook,
        }
    }

    /// Where the manager keeps the pool's first word (v4's `StateLibrary`: `pools` is slot 6), zero when no pool has
    /// that key.
    pub(super) fn state_slot(&self, usdc: Address, unb: Address) -> FixedBytes<32> {
        use alloy::sol_types::SolValue;
        let id = keccak256(self.key(usdc, unb).abi_encode());
        keccak256((id, U256::from(6u64)).abi_encode())
    }
}

/// The variables that name a v4 pool (`V4Pool`), each `existing_var(net, …)`: for arc-mainnet
/// `UNBROWSE_ARC_MAINNET_V4_MANAGER`, `_V4_HOOK`, `_V4_FEE`, `_V4_TICK_SPACING`, `_V4_BUY_FEE_BPS` and `_V4_LP_FEE`.
pub const V4_VARS: [&str; 6] = ["v4_manager", "v4_hook", "v4_fee", "v4_tick_spacing", "v4_buy_fee_bps", "v4_lp_fee"];

/// The v4 pool the operator's variables name, if they name one: all of `V4_VARS`, or none. Some but not all set, or one
/// that doesn't read, is refused, so a typo never deploys past the pool it meant.
pub fn v4_pool(net: &arc::Network, var: impl Fn(&str) -> Option<String>) -> Result<Option<V4Pool>, String> {
    let got: Vec<(String, Option<String>)> = V4_VARS
        .iter()
        .map(|w| {
            let name = existing_var(net, w);
            let v = var(&name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
            (name, v)
        })
        .collect();
    if got.iter().all(|(_, v)| v.is_none()) {
        return Ok(None);
    }
    let missing: Vec<&str> = got.iter().filter(|(_, v)| v.is_none()).map(|(n, _)| n.as_str()).collect();
    if !missing.is_empty() {
        return Err(format!("a v4 pool is named by all of its variables; set {} too", missing.join(", ")));
    }
    let val = |i: usize| got[i].1.as_deref().unwrap_or_default();
    let addr = |i: usize| val(i).parse::<Address>().map_err(|_| format!("{} is set to {:?}, which isn't an address", got[i].0, val(i)));
    let num = |i: usize, most: i128| -> Result<i128, String> {
        let v = val(i);
        let n = match v.strip_prefix("0x") {
            Some(h) => i128::from_str_radix(h, 16),
            None => v.parse::<i128>(),
        };
        n.ok().filter(|n| *n >= 0 && *n <= most).ok_or_else(|| format!("{} is set to {v:?}, which isn't a number from 0 to {most}", got[i].0))
    };
    let spacing = num(3, 32_767)?;
    if spacing == 0 {
        return Err(format!("{} is 0; a pool's ticks are spaced by at least 1", got[3].0));
    }
    Ok(Some(V4Pool {
        manager: addr(0)?,
        hook: addr(1)?,
        fee: num(2, 0xFF_FFFF)? as u32,
        tick_spacing: spacing as i32,
        buy_fee_bps: num(4, 9_999)? as u64,
        lp_fee: num(5, 999_999)? as u32,
    }))
}

pub(super) fn read_network_file(net: &arc::Network, home: &Path, shipped: &str) -> Result<NetworkFile, String> {
    // The owner's copy is a file the node keeps, so one read forward leaves its old bytes beside it; the built-in one
    // is part of the build.
    let (read, from) = match std::fs::read(home) {
        Ok(t) => (unbrowse_files::NETWORK.read_from(home, &t), home.display().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (unbrowse_files::NETWORK.read(shipped.as_bytes()), format!("the built-in networks/{}.json", net.name)),
        Err(e) => return Err(format!("{} doesn't read ({e})", home.display())),
    };
    let f: NetworkFile = read.map_err(|r| match r {
        unbrowse_files::Refusal::Unreadable(e) => format!("{from} doesn't read ({e}); fix or remove it"),
        r => r.message(Path::new(&from)),
    })?;
    let chain_ids = std::iter::once(f.chain_id).chain(f.deployment.as_ref().map(|d| d.chain_id));
    if let Some(other) = chain_ids.into_iter().find(|id| *id != net.chain_id) {
        return Err(format!("{from} is for chain {other}, not {} ({})", net.name, net.chain_id));
    }
    Ok(f)
}

/// Why Settlement can't be used on a live network.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Missing {
    /// The RPC didn't answer the question: worth asking again soon.
    Unreachable(String),
    /// The chain answered: there's no Settlement recorded, no contract where the file says, or one from other code.
    /// That changes only when someone deploys, so it is asked again rarely.
    Absent(String),
}

impl Missing {
    pub(super) fn why(&self) -> &str {
        match self {
            Missing::Unreachable(w) | Missing::Absent(w) => w,
        }
    }
}

/// Whether a recorded deployment can be used: on the chain, made from this node's contracts.
pub(super) async fn usable(p: &impl Provider, net: &arc::Network, d: &Deployment, epoch_blocks: Option<u64>) -> Result<Deployment, Missing> {
    // A file that still records the deployment from before route coins (an owner's own copy, say) is no deployment
    // this build runs on, and is said as plainly as none at all (`decide.old-testnet-dropped`).
    if !d.coins.named() {
        return Err(Missing::Absent(format!("{} (its network file still records Settlement {:#x}, from before route coins)", super::not_deployed(net.name), d.settlement)));
    }
    let code = p.get_code_at(d.settlement).await.map_err(|e| Missing::Unreachable(format!("reading Settlement on {}: {e}", net.name)))?;
    if code.is_empty() {
        return Err(Missing::Absent(format!("the {} network file names Settlement at {:#x}, but there's no contract there", net.name, d.settlement)));
    }
    // The chain's word, not the file's: what the file records of the code says nothing of what runs there.
    let verified = conform::check(p, net, d).await?;
    // The contracts a write goes to are the ones checked here, kept for the run, never read from the RPC again.
    pin_fixed(d.settlement, "listings", verified.listings);
    // Every amount on it is counted in its USDC's decimals, so they are the token's own word, not the file's: a file
    // written by hand, or before they were recorded, may say none or other ones.
    let usdc_decimals = USDC::new(d.usdc, p).decimals().call().await.map_err(|e| Missing::Unreachable(format!("reading Settlement's USDC on {}: {e}", net.name)))?;
    // The code covers the verifier, but not the trust anchors it was given: a Settlement on any root but the DNS's own
    // would let whoever signs that root decide every site's escrow.
    let s = LeanSettlement::new(d.settlement, p);
    let dnssec = verified.dnssec;
    let anchors = DnssecVerifier::new(dnssec, p).anchors().call().await.map_err(|e| Missing::Unreachable(format!("reading its trust anchors on {}: {e}", net.name)))?;
    if anchors.as_ref() != ROOT_ANCHORS {
        return Err(Missing::Absent(format!("Settlement on {} proves domains from other trust anchors than the DNS root's; update the network file", net.name)));
    }
    // The contracts the owner's tokens are approved to are the network file's, held to what Settlement names: an RPC's
    // word alone never chooses where an allowance goes (`named_by_file`).
    let domains = named_by_file(net, "its domain proofs", Some(d.domains), Some(verified.domains))?.unwrap_or(Address::ZERO);
    let escrow_wait = match domains {
        a if a == Address::ZERO => 0,
        a => Domains::new(a, p).escrowWait().call().await.map_err(|e| Missing::Unreachable(format!("reading the escrow wait on {}: {e}", net.name)))?,
    };
    // A key's cap is a daily limit because an epoch is a day: a Settlement counting epochs of another length would make
    // every limit the owner sets, and every "today" the node says, wrong. The code can't say (the length is an immutable,
    // blanked in `conform`), and blocks are the chain's own pace, so the network's file does.
    let epoch_blocks_read: u64 = s.epochBlocks().call().await.map_err(|e| Missing::Unreachable(format!("reading Settlement's epoch on {}: {e}", net.name)))?;
    if Some(epoch_blocks_read) != epoch_blocks {
        return Err(Missing::Absent(format!("Settlement on {} counts epochs of {epoch_blocks_read} blocks, and its network file says {epoch_blocks:?}; update the network file", net.name)));
    }
    // The coin contracts are Settlement's word, as `check` verified it, never the file's.
    Ok(Deployment { usdc_decimals, dnssec, domains, escrow_wait, epoch_blocks: epoch_blocks_read, coins: verified.coins, ..d.clone() })
}

/// The address of a contract that pulls the owner's tokens (the domain proofs, the bounties): the one the network file
/// names, once Settlement on the chain names the same (`chain`, as `conform::check` read and verified it). The file is
/// part of the build or the owner's own copy; the chain is one RPC's answer, and an RPC that names a contract of its
/// own, and serves the expected code for it, would have every approval go there. A file that names one Settlement
/// doesn't is refused whole; a contract the file doesn't name isn't used (`None`), so nothing is approved to it.
pub(super) fn named_by_file(net: &arc::Network, what: &str, file: Option<Address>, chain: Option<Address>) -> Result<Option<Address>, Missing> {
    let named = |a: Option<Address>| a.filter(|a| *a != Address::ZERO);
    match (named(file), named(chain)) {
        (None, _) => Ok(None),
        (Some(f), Some(c)) if f == c => Ok(Some(f)),
        (Some(f), c) => Err(Missing::Absent(format!(
            "the {} network file names {what} at {f:#x}, but Settlement there names {}; update the network file",
            net.name,
            c.map_or("none".to_string(), |c| format!("{c:#x}"))
        ))),
    }
}

#[cfg(test)]
mod named_by_file_tests {
    use super::*;

    /// Where the owner's tokens may be pulled from is never an RPC's word alone: a contract Settlement names on the
    /// chain is used only where the network file names the same one, and one the file doesn't name is not used.
    #[test]
    fn a_contract_that_pulls_tokens_is_the_network_files_never_the_rpcs_alone() {
        let net = &arc::ARC_TESTNET;
        let (file, theirs) = (Address::repeat_byte(0xd0), Address::repeat_byte(0xee));
        assert_eq!(named_by_file(net, "its bounties", Some(file), Some(file)), Ok(Some(file)));
        assert!(matches!(named_by_file(net, "its bounties", Some(file), Some(theirs)), Err(Missing::Absent(w)) if w.contains("update the network file")), "the RPC names another");
        assert!(matches!(named_by_file(net, "its bounties", Some(file), None), Err(Missing::Absent(_))), "the RPC names none");
        assert_eq!(named_by_file(net, "its bounties", None, Some(theirs)), Ok(None), "a file that names none: the RPC's isn't taken");
        assert_eq!(named_by_file(net, "its domain proofs", Some(Address::ZERO), Some(theirs)), Ok(None));
    }
}
