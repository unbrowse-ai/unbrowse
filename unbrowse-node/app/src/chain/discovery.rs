//! Finding routes other nodes listed on chain (Phase 3), Settlement's EIP-712 domain, and checking an agent key a
//! payer authorised.

use super::*;

// ---- network route discovery (Phase 3) ----

/// The owner's on-chain address.
pub fn owner_address(keys: &(dyn KeyStore + Sync)) -> Result<Address, String> {
    Ok(owner_signer(keys)?.address())
}

/// An entry on the chain with its event-time metadata and current state.
pub struct ListedEntry {
    pub entry_id: FixedBytes<32>,
    pub contributor: Address,
    pub domain: String,
    pub description: String,
    pub fee: f64,
    pub live: bool,
}

/// The entries `Listings` credited from `from` to `to`, each with the contributor its latest credit named, in the
/// order credited (`Credited`). The chain learns of a listing only at its first claim (R2.18), so this is every entry
/// some claim has shown, never every listing: listings no claim has shown yet are found between nodes (R2.15).
/// `credited` over `from` to `to`, its logs checked against the second RPC when one is named (`agreed_logs`).
pub(super) async fn credited_agreed(p: &impl Provider, d: &Deployment, from: u64, to: u64) -> Result<Vec<(FixedBytes<32>, Address, (u64, u64))>, String> {
    use alloy::sol_types::SolEvent;
    let at = listings_of(p, d).await?;
    let filter = alloy::rpc::types::Filter::new().address(at).event_signature(ListingsDigest::Credited::SIGNATURE_HASH);
    let mut out: Vec<(FixedBytes<32>, Address, (u64, u64))> = Vec::new();
    for l in agreed_logs(p, filter, from, to).await? {
        let Ok(ev) = ListingsDigest::Credited::decode_log(&l.inner) else { continue };
        out.retain(|(e, _, _)| *e != ev.entryId);
        out.push((ev.entryId, ev.contributor, (l.block_number.unwrap_or(from), l.log_index.unwrap_or(0))));
    }
    Ok(out)
}

pub(super) async fn credited(p: &impl Provider, d: &Deployment, from: u64, to: Option<u64>) -> Result<Vec<(FixedBytes<32>, Address, (u64, u64))>, String> {
    use alloy::sol_types::SolEvent;
    let at = listings_of(p, d).await?;
    let filter = alloy::rpc::types::Filter::new().address(at).event_signature(ListingsDigest::Credited::SIGNATURE_HASH);
    let mut out: Vec<(FixedBytes<32>, Address, (u64, u64))> = Vec::new();
    for l in logs(p, filter, from, to).await? {
        let Ok(ev) = ListingsDigest::Credited::decode_log(&l.inner) else { continue };
        out.retain(|(e, _, _)| *e != ev.entryId);
        out.push((ev.entryId, ev.contributor, (l.block_number.unwrap_or(from), l.log_index.unwrap_or(0))));
    }
    Ok(out)
}

/// Every credit each entry has had, in the order made, by block and log index: a credit can move to an earlier listing
/// (`Listings.Credited`), and what a line paid stays with whoever held the credit when it was claimed.
pub(crate) async fn credit_history(p: &impl Provider, d: &Deployment) -> Result<std::collections::HashMap<FixedBytes<32>, Vec<((u64, u64), Address)>>, String> {
    use alloy::sol_types::SolEvent;
    let at = listings_of(p, d).await?;
    let filter = alloy::rpc::types::Filter::new().address(at).event_signature(ListingsDigest::Credited::SIGNATURE_HASH);
    let mut out: std::collections::HashMap<FixedBytes<32>, Vec<((u64, u64), Address)>> = Default::default();
    for l in logs(p, filter, d.block, None).await? {
        let Ok(ev) = ListingsDigest::Credited::decode_log(&l.inner) else { continue };
        out.entry(ev.entryId).or_default().push(((l.block_number.unwrap_or(d.block), l.log_index.unwrap_or(0)), ev.contributor));
    }
    Ok(out)
}

/// Every entry a claim has credited on the chain, with its current state, and its site and description from the
/// signed listing this node holds for it (its own, or one it read from a peer): the chain keeps no description and
/// only a hash of the site. No listing event is read: a listing writes nothing to the chain (R2.15), so the index is
/// the credits and the listings nodes spread, not `listEntry`, which this deployment has none of.
pub async fn listed_entries(chain: &Chain) -> Result<Vec<ListedEntry>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let mut out = Vec::new();
    for (id, _, _) in credited(&p, &d, d.block, None).await? {
        let e = s.entry(id).call().await.map_err(|e| e.to_string())?;
        if e.contributor == Address::ZERO {
            continue;
        }
        let Some(l) = crate::listing::held_listing(chain, id) else { continue };
        if l.listing.site.is_empty() {
            continue; // a skill: no route to search for
        }
        let listed = l.listing.terms.price.units().unwrap_or_default();
        out.push(ListedEntry {
            entry_id: id,
            contributor: e.contributor,
            domain: l.listing.site.to_ascii_lowercase(),
            description: l.listing.terms.description.clone(),
            fee: d.usdc_f(e.fee.max(listed)),
            live: e.live,
        });
    }
    Ok(out)
}

/// Reads an entry by its raw hash (for network calls where the caller knows the entry id, not the route id).
pub async fn entry_by_hash(chain: &Chain, id: FixedBytes<32>) -> Result<Option<(Address, EntryView)>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let e = LeanSettlement::new(d.settlement, &p).entry(id).call().await.map_err(|e| e.to_string())?;
    Ok((e.contributor != Address::ZERO).then(|| (e.contributor, EntryView { live: e.live, fee: d.usdc_f(e.fee), domain_hash: e.domainHash })))
}

/// The EIP-712 domain the Settlement contract signs under: its name and version, this chain and its own address. A
/// signature made under it holds on no other chain and for no other deployment.
pub fn domain(d: &Deployment) -> alloy::sol_types::Eip712Domain {
    alloy::sol_types::eip712_domain! {
        name: "Unbrowse Settlement",
        version: "1",
        chain_id: d.chain_id,
        verifying_contract: d.settlement,
    }
}

/// What `agent` may still be paid for in `epoch` under `payer`'s cap (R1.22): the key's cap for that epoch, less what
/// claims have already paid of it. The contract pays no line past it.
pub async fn agent_room(chain: &Chain, payer: Address, agent: Address, epoch: u64, head: &crate::rpc::Head) -> Result<U256, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let cap = s.termsFor(payer, agent, epoch).call().await.map_err(|e| format!("reading the agent's cap: {e}"))?.capPerEpoch;
    let paid = s.claimedOf(payer, agent, epoch).call().await.map_err(|e| format!("reading what the agent's epoch has paid: {e}"))?;
    // And at the finalized head the node just followed, agreed by the second RPC when one is named (R9-CHAIN-1): the
    // room is the less of the two, so the first RPC alone can only shrink it.
    let cap_final = head.call_agreed(&p, d.settlement, &LeanSettlement::termsForCall { payer, agent, epoch_: epoch }).await?.capPerEpoch;
    let paid_final = head.call_agreed(&p, d.settlement, &LeanSettlement::claimedOfCall { payer, agent, epoch_: epoch }).await?;
    Ok(cap.min(cap_final).saturating_sub(paid.max(paid_final)))
}

/// Why the chain's claim refuses a voucher of `epoch` by this key, as `LeanSettlement._verify` judges it: it was never
/// granted, it is revoked from `revoked_at` on (zero: never), or its expiry falls at or before the epoch's start.
/// Revoking leaves the vouchers of earlier epochs and of the revoking epoch itself claimable, so a line for a body
/// already served stays good after the payer revokes its key.
pub(crate) fn voucher_refused(cap: U256, revoked_at: u64, expiry: u64, epoch: u64, length: u64) -> Option<&'static str> {
    if cap.is_zero() {
        return Some("the agent isn't authorized by the payer");
    }
    if revoked_at != 0 && epoch >= revoked_at {
        return Some("the agent has been revoked");
    }
    if expiry != 0 && expiry <= epoch.saturating_mul(length) {
        return Some("the agent's key has expired");
    }
    None
}

/// Checks that a line under a voucher of `epoch` by `agent` is one the chain would pay (`voucher_refused`): what a server
/// asks of the line for a body it already served, where `check_agent`, which is for releasing one, would turn away
/// money a claim still pays.
pub async fn check_voucher_key(chain: &Chain, payer: Address, agent: Address, epoch: u64) -> Result<(), String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let terms = s.termsFor(payer, agent, epoch).call().await.map_err(|e| format!("checking agent: {e}"))?;
    let revoked_at = s.revokedAt(payer, agent).call().await.map_err(|e| format!("checking agent: {e}"))?;
    let length = s.epochBlocks().call().await.map_err(|e| e.to_string())?;
    match voucher_refused(terms.capPerEpoch, revoked_at, terms.expiry, epoch, length) {
        Some(why) => Err(why.into()),
        None => Ok(()),
    }
}

/// Checks that `agent` is authorized by `payer` on the chain, hasn't been revoked and hasn't expired: as the contract
/// judges a voucher of this epoch, a key whose expiry falls at or before the epoch's start has expired. Stricter than a
/// claim, which still pays the epoch a key was revoked in: a server releases no new body on a key its payer has revoked
/// (R3.11).
pub async fn check_agent(chain: &Chain, payer: Address, agent: Address) -> Result<(), String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let a = s.agentOf(payer, agent).call().await.map_err(|e| format!("checking agent: {e}"))?;
    if a.capPerEpoch == U256::ZERO {
        return Err("the agent isn't authorized by the payer".into());
    }
    if a.revoked {
        return Err("the agent has been revoked".into());
    }
    if a.expiry != 0 && a.expiry <= current_epoch(chain).await?.saturating_mul(d.blocks_per_epoch()) {
        return Err("the agent's key has expired".into());
    }
    Ok(())
}
