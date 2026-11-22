//! Agent keys: what the owner authorises each to spend, and what each has spent this epoch.

use super::*;

pub async fn authorize(chain: &Chain, keys: &(dyn KeyStore + Sync), index: u32, cap: f64, expiry: u64) -> Result<String, String> {
    let d = chain.deployed()?;
    let agent = agent_signer(keys, index)?.address();
    let p = as_signer(owner_signer(keys)?).await?;
    let expiry = expiry_block(chain, expiry).await?;
    let tx = send!(LeanSettlement::new(d.settlement, &p).authorizeAgent(agent, d.usdc_units(cap), expiry), "authorising the agent key");
    Ok(tx)
}

pub async fn revoke(chain: &Chain, keys: &(dyn KeyStore + Sync), index: u32) -> Result<String, String> {
    let d = chain.deployed()?;
    let agent = agent_signer(keys, index)?.address();
    let p = as_signer(owner_signer(keys)?).await?;
    let tx = send!(LeanSettlement::new(d.settlement, &p).revokeAgent(agent), "revoking the agent key");
    Ok(tx)
}

/// The block a chain at block `head` reaches at unix time `at`, read at time `now`, at the pace of `blocks` to the epoch.
/// The chain keeps a key's expiry in blocks, on the epoch's clock (R1.28), and the node and its owner think of it as a
/// date; `EPOCH` is the pace that makes one the other, so it is near, not exact, and only as near as the chain's block
/// time is to it.
pub fn block_at(head: u64, blocks: u64, now: u64, at: u64) -> u64 {
    let ahead = u128::from(at.saturating_sub(now)) * u128::from(blocks) / u128::from(EPOCH);
    head.saturating_add(u64::try_from(ahead).unwrap_or(u64::MAX))
}

/// The unix time a chain at block `head` at time `now` reaches block `block`, as `block_at` counts it.
pub fn time_at(head: u64, blocks: u64, now: u64, block: u64) -> u64 {
    let secs = |n: u64| u64::try_from(u128::from(n) * u128::from(EPOCH) / u128::from(blocks.max(1))).unwrap_or(u64::MAX);
    if block >= head {
        now.saturating_add(secs(block - head))
    } else {
        now.saturating_sub(secs(head - block)).max(1)
    }
}

/// The block a key's expiry at unix time `expiry` is granted as, 0 (none) staying 0.
pub async fn expiry_block(chain: &Chain, expiry: u64) -> Result<u64, String> {
    if expiry == 0 {
        return Ok(0);
    }
    let d = chain.deployed()?;
    let head = ProviderBuilder::new().connect_http(url()).get_block_number().await.map_err(|e| e.to_string())?;
    Ok(block_at(head, d.blocks_per_epoch(), store::now(), expiry))
}

/// A grant's expiry as the chain keeps it, a block, in unix seconds, 0 (none) staying 0.
async fn expiry_time(p: &impl Provider, d: &Deployment, block: u64) -> Result<u64, String> {
    if block == 0 {
        return Ok(0);
    }
    let head = p.get_block_number().await.map_err(|e| e.to_string())?;
    Ok(time_at(head, d.blocks_per_epoch(), store::now(), block))
}

/// An agent key's grant as the chain has it: its cap a voucher epoch in USDC and its expiry in unix seconds (0 for
/// none, read from the block the chain keeps by `expiry_time`); `None` for a key the wallet never granted, or revoked.
/// The node reads `own_grant`, which tells those two apart; tests read this.
#[cfg(test)]
pub async fn agent_grant(chain: &Chain, keys: &(dyn KeyStore + Sync), index: u32) -> Result<Option<(f64, u64)>, String> {
    own_grant(chain, keys, index).await.map(|(grant, _)| grant)
}

/// The node's own grant to agent key `index`, as `agent_grant` reads it, and whether the chain holds that grant revoked.
/// Only this node's root key can revoke its own grant, so a revoke the chain holds is the owner's word from before,
/// which no file kept here can take back (`agents::revoked_by_chain`).
pub async fn own_grant(chain: &Chain, keys: &(dyn KeyStore + Sync), index: u32) -> Result<(Option<(f64, u64)>, bool), String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let a = LeanSettlement::new(d.settlement, &p).agentOf(owner_signer(keys)?.address(), agent_signer(keys, index)?.address()).call().await.map_err(|e| e.to_string())?;
    if a.capPerEpoch.is_zero() {
        return Ok((None, false));
    }
    if a.revoked {
        return Ok((None, true));
    }
    Ok((Some((d.usdc_f(a.capPerEpoch), expiry_time(&p, &d, a.expiry).await?)), false))
}

/// Whether the chain still pays `agent` from `payer`, by a reading of `agentOf` at the final block that a witness
/// stands behind (`rpc::read_witnessed`): `Some(false)` when its grant is revoked or holds nothing, `None` when no
/// witness stands behind the reading now. A revoke owed is let go of only on this value (R6-CHAIN-2), never on
/// whether a witness is configured.
pub async fn grant_pays_witnessed(p: &impl Provider, settlement: Address, payer: Address, agent: Address) -> Result<Option<bool>, String> {
    use alloy::sol_types::SolCall;
    let call = LeanSettlement::agentOfCall { payer, agent };
    let Some(got) = crate::rpc::read_witnessed(p, settlement, call.abi_encode().into()).await? else { return Ok(None) };
    let a = LeanSettlement::agentOfCall::abi_decode_returns(&got).map_err(|e| e.to_string())?;
    Ok(Some(!a.capPerEpoch.is_zero() && !a.revoked))
}

/// `grant_pays_witnessed` for this node's own agent key `index`, granted by the node's own wallet.
pub async fn own_grant_pays_witnessed(chain: &Chain, keys: &(dyn KeyStore + Sync), index: u32) -> Result<Option<bool>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    grant_pays_witnessed(&p, d.settlement, owner_signer(keys)?.address(), agent_signer(keys, index)?.address()).await
}

/// `payer`'s grant to `agent`, as `agent_grant` reads it: the owner's wallet's grant to one of this node's keys.
pub async fn grant_of(chain: &Chain, payer: Address, agent: Address) -> Result<Option<(f64, u64)>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let a = LeanSettlement::new(d.settlement, &p).agentOf(payer, agent).call().await.map_err(|e| e.to_string())?;
    if a.capPerEpoch.is_zero() || a.revoked {
        return Ok(None);
    }
    Ok(Some((d.usdc_f(a.capPerEpoch), expiry_time(&p, &d, a.expiry).await?)))
}

/// The wallet agent `index`'s vouchers for `epoch` name as payer: the owner's wallet once it granted the key
/// (`agents::Agent::payers`, spec §76.1 item 1.7), else the node's own.
pub fn payer_of(keys: &(dyn KeyStore + Sync), index: u32, epoch: u64) -> Result<Address, String> {
    match crate::agents::payer_at(index, epoch) {
        Some(w) => Ok(w),
        None => Ok(owner_signer(keys)?.address()),
    }
}

/// The call the owner's wallet sends to grant agent key `agent` against its own deposit: `authorizeAgent`, to
/// Settlement. The node can't send it, since a grant is the payer's own (`msg.sender`).
pub async fn authorize_call(chain: &Chain, agent: Address, cap: f64, expiry: u64) -> Result<(Address, alloy::primitives::Bytes), String> {
    use alloy::sol_types::SolCall;
    // A wallet's grant always runs out (§76.2 item 3): the owner renews it, never grants a key for good.
    if expiry == 0 {
        return Err("a wallet's grant needs an expiry".into());
    }
    let d = chain.deployed()?;
    let call = LeanSettlement::authorizeAgentCall { agent, capPerEpoch: d.usdc_units(cap), expiry: expiry_block(chain, expiry).await? };
    Ok((d.settlement, call.abi_encode().into()))
}

/// `payer`'s grant to `agent` in full: its cap in USDC, expiry, whether revoked, and what it has paid this epoch;
/// `None` for none.
pub async fn agent_terms(chain: &Chain, payer: Address, agent: Address) -> Result<Option<(f64, u64, bool, f64)>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let a = LeanSettlement::new(d.settlement, &p).agentOf(payer, agent).call().await.map_err(|e| e.to_string())?;
    if a.capPerEpoch.is_zero() {
        return Ok(None);
    }
    Ok(Some((d.usdc_f(a.capPerEpoch), expiry_time(&p, &d, a.expiry).await?, a.revoked, d.usdc_f(a.spentThisEpoch))))
}

/// The keys `payer` ever granted, from its `AgentAuthorized` events: the owner's wallet's keys on all its nodes.
pub async fn granted_by(chain: &Chain, payer: Address) -> Result<Vec<Address>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let filter = alloy::rpc::types::Filter::new().address(d.settlement).event_signature(<LeanSettlement::AgentAuthorized as alloy::sol_types::SolEvent>::SIGNATURE_HASH).topic1(payer.into_word());
    // From Settlement's own block: it logged nothing before it was deployed. The registry's start, read here before,
    // is 3 million blocks earlier on Arc testnet, 309 windows of nothing on each read.
    let mut out: Vec<Address> = logs(&p, filter, d.block, None).await?.iter().filter_map(|l| l.topics().get(2).map(|t| Address::from_word(*t))).collect();
    out.dedup();
    let mut seen = std::collections::HashSet::new();
    out.retain(|a| seen.insert(*a));
    Ok(out)
}

/// What the contract has paid under an agent key's vouchers for voucher epoch `epoch`, and the key's cap for that
/// epoch: the numbers a line filed under `epoch` is judged by when it is claimed (`claimedOf`, `termsFor`), which is
/// not always the epoch the chain is in by the time it is read.
pub async fn agent_spend(chain: &Chain, keys: &(dyn KeyStore + Sync), index: u32, epoch: u64) -> Result<(f64, f64), String> {
    let d = chain.deployed()?;
    let agent = agent_signer(keys, index)?.address();
    let me = payer_of(keys, index, epoch)?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let a = s.agentOf(me, agent).call().await.map_err(|e| e.to_string())?;
    if a.capPerEpoch.is_zero() {
        return Ok((0.0, 0.0));
    }
    // Read at the head and at the final block, and the less room of the two taken: a line is signed against the
    // state that will still hold once the claim's block is final, whichever the RPC answered from.
    let spent = s.claimedOf(me, agent, epoch).call().await.map_err(|e| e.to_string())?;
    // The final reading at the head the node just followed, agreed by the second RPC when one is named (R9-CHAIN-1).
    let spent_final = crate::rpc::call_agreed(&p, d.settlement, &LeanSettlement::claimedOfCall { payer: me, agent, epoch_: epoch }).await?;
    let cap = s.termsFor(me, agent, epoch).call().await.map_err(|e| e.to_string())?.capPerEpoch;
    let cap_final = crate::rpc::call_agreed(&p, d.settlement, &LeanSettlement::termsForCall { payer: me, agent, epoch_: epoch }).await?.capPerEpoch;
    Ok((d.usdc_f(spent.max(spent_final)), d.usdc_f(cap.min(cap_final))))
}

pub async fn advance_day(chain: &Chain) -> Result<(), String> {
    if let Some(net) = chain.network() {
        return Err(format!("advancing a day moves a devnet's clock; {} keeps real time", net.name));
    }
    let d = chain.deployed()?;
    mine_epochs(&ProviderBuilder::new().connect_http(url()), d.blocks_per_epoch(), 1).await
}

/// Mines `epochs` of `blocks` each on the devnet the node runs (`url`): a day passes as blocks do (R1.28). The clock
/// moves with them, at `EPOCH` an epoch, for what is wall time on any chain (a USDC authorisation, a DNSSEC signature).
/// At most `MINE_PER_REQUEST` blocks a request, each through `rpc::devnet_cheat`, whose bound is the devnet's own: a
/// devnet's Anvil slows as its chain grows (it saves its whole state every few seconds), and ninety epochs mined on a
/// busy machine in one request outlasted the bound every other request keeps (`rpc::REQUEST_TIMEOUT`). `_p` is the provider the caller reaches the devnet with; the cheat goes to the same URL.
pub(crate) async fn mine_epochs(_p: &impl Provider, blocks: u64, epochs: u64) -> Result<(), String> {
    let gap = U256::from((EPOCH / blocks.max(1)).max(1));
    for _ in 0..epochs {
        let mut left = blocks;
        while left > 0 {
            let n = left.min(MINE_PER_REQUEST);
            crate::rpc::devnet_cheat("anvil_mine", serde_json::json!([U256::from(n), gap])).await?;
            left -= n;
        }
    }
    Ok(())
}

/// The most blocks one `anvil_mine` request makes (`mine_epochs`).
const MINE_PER_REQUEST: u64 = 1_440;

pub async fn current_epoch(chain: &Chain) -> Result<u64, String> {
    let d = chain.deployed()?;
    if live().is_some() {
        if let Some(e) = EPOCH_SEEN.locked().as_ref().filter(|s| s.settlement == d.settlement && std::time::Instant::now() < s.until) {
            return Ok(e.epoch);
        }
    }
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let epoch = s.epoch().call().await.map_err(|e| e.to_string())?;
    if live().is_some() {
        if let Ok(head) = p.get_block_number().await {
            let hold = epoch_hold(epoch, d.blocks_per_epoch(), head);
            *EPOCH_SEEN.locked() = Some(EpochSeen { settlement: d.settlement, epoch, until: std::time::Instant::now() + hold });
        }
    }
    Ok(epoch)
}

/// The epoch last read from a live chain's Settlement, and until when it holds. `epoch()` is the block number over the
/// epoch's blocks, the same until the next boundary, and the node asked for it on nearly every pass of every loop:
/// about a quarter of an idle node's RPC requests, which a public RPC's rate limit spends on nothing. A devnet's time
/// is moved by hand, so its epoch is always read.
struct EpochSeen {
    settlement: Address,
    epoch: u64,
    until: std::time::Instant,
}

static EPOCH_SEEN: std::sync::Mutex<Option<EpochSeen>> = std::sync::Mutex::new(None);

/// How long an epoch read at block `head` holds: half the time the blocks left should take at `EPOCH`'s pace, so a chain
/// making blocks at twice that pace still turns over after it is read again; less `EPOCH_MARGIN`, and never more than
/// `EPOCH_HOLD_MAX`, so a chain whose pace changes is read again soon.
fn epoch_hold(epoch: u64, length: u64, head: u64) -> std::time::Duration {
    const EPOCH_MARGIN: u64 = 5;
    const EPOCH_HOLD_MAX: u64 = 300;
    let left = epoch.saturating_add(1).saturating_mul(length).saturating_sub(head);
    std::time::Duration::from_secs((left.saturating_mul(EPOCH) / length.max(1) / 2).saturating_sub(EPOCH_MARGIN).min(EPOCH_HOLD_MAX))
}

#[cfg(test)]
mod epoch_tests {
    use super::*;

    /// An epoch read holds until a little before the next boundary, five minutes at most, and not at all at a boundary.
    /// A block here should take two seconds; the hold is half what the blocks left should take.
    #[test]
    fn an_epoch_read_holds_until_just_before_its_boundary() {
        let length = EPOCH / 2;
        assert_eq!(epoch_hold(10, length, 10 * length + 100), std::time::Duration::from_secs(300), "far from the boundary: the cap");
        assert_eq!(epoch_hold(10, length, 11 * length - 65), std::time::Duration::from_secs(60), "sixty-five blocks left");
        assert_eq!(epoch_hold(10, length, 11 * length - 3), std::time::Duration::ZERO, "inside the margin: read every time");
        assert_eq!(epoch_hold(10, length, 11 * length + 10), std::time::Duration::ZERO, "past it");
    }

    /// A key's expiry goes to the chain as a block and comes back as a date, at the pace of an epoch a day.
    #[test]
    fn a_keys_expiry_reads_back_as_the_date_it_was_granted_for() {
        let (head, blocks, now) = (1_000_000, 172_800, 1_800_000_000);
        let thirty_days = now + 30 * EPOCH;
        let block = block_at(head, blocks, now, thirty_days);
        assert_eq!(block, head + 30 * blocks, "thirty epochs of blocks on");
        assert_eq!(time_at(head, blocks, now, block), thirty_days, "and thirty days back");
        assert_eq!(block_at(head, blocks, now, now - 5), head, "a date gone by is the block now: expired");
        assert!(time_at(head, blocks, now, head - blocks) < now, "a block gone by reads as a past date");
    }
}
