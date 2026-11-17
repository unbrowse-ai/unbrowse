//! Entries on chain: listing and delisting routes, the node's fee, roots and domains.

use super::*;

pub fn entry_id(route_id: &str) -> FixedBytes<32> {
    keccak256(format!("unbrowse/entry/{route_id}").as_bytes())
}

/// The entry a body is paid under (`Listings.entryIdOf`): `keccak256("unbrowse/content/" ‖ contentId)`. Every entry is
/// a body's, credited to the earliest signed listing of it shown at a claim (R2.18); a route is listed by signing a
/// listing, with nothing written to the chain (R2.15). Identical bodies are one entry (R2.21).
pub fn content_entry_id(content_id: &str) -> FixedBytes<32> {
    keccak256(format!("unbrowse/content/{content_id}").as_bytes())
}

/// The `Listings` contract Settlement made (`listings()`).
pub async fn listings_of(p: &impl Provider, d: &Deployment) -> Result<Address, String> {
    if let Some(a) = fixed(d.settlement, "listings") {
        return Ok(a);
    }
    let a = LeanSettlement::new(d.settlement, p).listings().call().await.map_err(|e| e.to_string())?;
    keep_fixed(d.settlement, "listings", a);
    Ok(a)
}

/// A wallet's detail fee on the chain (`feeOf`): zero for one that never set it, as a wallet that lists with no gas
/// doesn't (its listing's terms carry its price).
pub async fn fee_of_wallet(chain: &Chain, who: Address) -> Result<U256, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    LeanSettlement::new(d.settlement, &p).feeOf(who).call().await.map_err(|e| e.to_string())
}

/// The stand-in body tests list a route by (`list_entry`, tests only): a content id named for the route.
#[cfg(test)]
pub fn test_content(route_id: &str) -> String {
    format!("sha256:{:x}", keccak256(route_id.as_bytes()))
}

/// The entry tests pay for a route listed with `list_entry`: its stand-in body's.
#[cfg(test)]
pub fn test_entry(route_id: &str) -> FixedBytes<32> {
    content_entry_id(&test_content(route_id))
}

/// Lists `route_id` as tests list one: a signed listing of its stand-in body (`test_content`) under a root this wallet
/// posts, shown to `Listings` at once (`show`), which credits the body's entry to this wallet as a first claim would.
/// What tests from before signed listings did with `listEntry`, which this deployment has none of.
#[cfg(test)]
pub async fn list_entry(chain: &Chain, keys: &(dyn KeyStore + Sync), route_id: &str, site: &str, what: &str) -> Result<String, String> {
    use crate::listing::{Price, SignedListing, Terms};
    let d = chain.deployed()?;
    let key = owner_signer(keys)?;
    let p = as_signer(key.clone()).await?;
    let fee = LeanSettlement::new(d.settlement, &p).feeOf(key.address()).call().await.map_err(|e| e.to_string())?;
    let listing = SignedListing {
        route_id: route_id.into(),
        site: site.into(),
        content_id: test_content(route_id),
        agent_id: crate::listing::own_identity(chain, keys, "test").await?,
        version: 1,
        supersedes: None,
        terms: Terms { description: what.into(), response: None, price: if fee.is_zero() { Price::default() } else { Price::listed(fee) } },
        sig: String::new(),
    }
    .signed(&key, &domain(&d))?;
    let leaf = listing.leaf(&domain(&d));
    post_root(chain, keys, leaf).await?;
    let proven = crate::listing::Proven { listing: listing.clone(), leaf, root: leaf, index: 0, proof: vec![] };
    // Kept in the node's book, as its own listings are, under the root it posted.
    let mut book = crate::listing::load_book(chain);
    book.listings.push(crate::listing::Kept { listing, leaf, root: Some(leaf) });
    book.roots.push(crate::listing::Posted { root: leaf, leaves: vec![leaf], block: root_block(chain, leaf).await?, tx: String::new() });
    crate::listing::keep_book(chain, &book);
    let ls = ListingsDigest::new(listings_of(&p, &d).await?, &p);
    Ok(send!(ls.show(vec![proven.shown()?]), "showing the listing"))
}

/// A route listed with `list_entry`'s entry on the chain (tests only).
#[cfg(test)]
pub async fn entry(chain: &Chain, route_id: &str) -> Result<Option<EntryView>, String> {
    Ok(entry_by_hash(chain, test_entry(route_id)).await?.map(|(_, e)| e))
}

/// Puts an entry of this wallet's back in the live set after it delisted it or left (`relistEntry`, R2.16).
pub async fn relist_entry(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: FixedBytes<32>, what: &str) -> Result<String, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let tx = send!(LeanSettlement::new(d.settlement, &p).relistEntry(entry), "relisting the entry");
    log(&format!("Relisted {what}"), "list", None, &tx, None);
    Ok(tx)
}

/// Sets the node's detail fee: one write reprices every route it lists.
pub async fn set_fee(chain: &Chain, keys: &(dyn KeyStore + Sync), fee: f64, why: Option<String>) -> Result<String, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let tx = send!(LeanSettlement::new(d.settlement, &p).setFee(d.fee_units(fee)), "setting the fee");
    log(&format!("Priced your routes at {fee} USDC a fetch"), "list", None, &tx, why);
    Ok(tx)
}

/// The node's detail fee on the chain.
pub async fn fee_of(chain: &Chain, keys: &(dyn KeyStore + Sync)) -> Result<f64, String> {
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    LeanSettlement::new(d.settlement, &p).feeOf(me).call().await.map(|f| d.usdc_f(f)).map_err(|e| e.to_string())
}

pub async fn latest_block(chain: &Chain) -> Result<u64, String> {
    chain.deployed()?;
    ProviderBuilder::new().connect_http(url()).get_block_number().await.map_err(|e| e.to_string())
}

/// The paid fetches of this node's entries claimed after `from_block`, and the block the count ends on.
pub async fn paid_since(chain: &Chain, keys: &(dyn KeyStore + Sync), from_block: u64) -> Result<(u64, u64), String> {
    use alloy::sol_types::SolEvent;
    let d = chain.deployed()?;
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let latest = p.get_block_number().await.map_err(|e| e.to_string())?;
    let from = from_block.max(d.block) + 1;
    if from > latest {
        return Ok((0, latest));
    }
    let logs = settlement_logs(&p, &d, LeanSettlement::Claimed::SIGNATURE_HASH, from, Some(latest)).await?;
    let mut mine: std::collections::HashMap<FixedBytes<32>, bool> = Default::default();
    let mut lines = 0;
    for l in logs {
        let Ok(ev) = LeanSettlement::Claimed::decode_log(&l.inner) else { continue };
        let is_mine = match mine.get(&ev.entryId) {
            Some(m) => *m,
            None => {
                let m = s.entry(ev.entryId).call().await.map_err(|e| e.to_string())?.contributor == me;
                *mine.entry(ev.entryId).or_insert(m)
            }
        };
        lines += u64::from(is_mine);
    }
    Ok((lines, latest))
}

/// Takes a credited entry of this wallet's out of the live set (`delistEntry`). A listing no claim has shown yet has no
/// entry to delist: it is withdrawn between nodes (R2.16).
/// What the wallet an entry is credited to sends to take it off the chain, or with `back` to put it back: the contract
/// takes either from that wallet alone, and the node holds no key of a wallet linked to it.
pub fn entry_call(chain: &Chain, entry: FixedBytes<32>, back: bool) -> Result<(Address, alloy::primitives::Bytes), String> {
    use alloy::sol_types::SolCall;
    let d = chain.deployed()?;
    let data = if back { LeanSettlement::relistEntryCall { entryId: entry }.abi_encode() } else { LeanSettlement::delistEntryCall { entryId: entry }.abi_encode() };
    Ok((d.settlement, data.into()))
}

pub async fn delist_entry(chain: &Chain, keys: &(dyn KeyStore + Sync), entry: FixedBytes<32>, what: &str) -> Result<String, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let tx = send!(LeanSettlement::new(d.settlement, &p).delistEntry(entry), "delisting the entry");
    log(&format!("Delisted {what}"), "list", None, &tx, Some("Its coin stays: it trades and its stake earns from any call still paid on it".into()));
    Ok(tx)
}


#[derive(Serialize)]
pub struct EntryView {
    pub live: bool,
    pub fee: f64,
    /// The hash of the entry's domain in its canonical form (`domain_hash`).
    #[serde(skip)]
    pub domain_hash: FixedBytes<32>,
}

/// The hash the contract keys an entry's domain by: its `canonicalDomain` (ASCII lowercase, no trailing dot), hashed.
pub fn domain_hash(domain: &str) -> FixedBytes<32> {
    let d = domain.strip_suffix('.').unwrap_or(domain);
    keccak256(d.to_ascii_lowercase().as_bytes())
}


/// Posts a listing root (R2.17, R2.19): anyone may, with no bond. Returns the transaction and the block the root is
/// first recorded in, which a root posted before keeps.
pub async fn post_root(chain: &Chain, keys: &(dyn KeyStore + Sync), root: FixedBytes<32>) -> Result<(String, u64), String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let s = LeanSettlement::new(d.settlement, &p);
    let tx = send!(s.postRoot(root), "posting the listing root");
    let block = s.rootBlock(root).call().await.map_err(|e| e.to_string())?;
    Ok((tx, block))
}

/// The block a listing root was first posted in; zero when it never was.
pub async fn root_block(chain: &Chain, root: FixedBytes<32>) -> Result<u64, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    LeanSettlement::new(d.settlement, &p).rootBlock(root).call().await.map_err(|e| e.to_string())
}

// ---- where an entry's credit sits, and moving it (R2.17, R2.18), on `Listings` ----

/// Where the chain credits `entry`: the contributor, its listing's root's block and its leaf's place in that root. A zero
/// contributor is no credit yet.
pub async fn place_of(chain: &Chain, entry: FixedBytes<32>) -> Result<(Address, u64, u64), String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let ls = LeanSettlement::new(d.settlement, &p).listings().call().await.map_err(|e| e.to_string())?;
    let at = ListingsDigest::new(ls, &p).placeOf(entry).call().await.map_err(|e| e.to_string())?;
    Ok((at.contributor, at.rootBlock, at.leaf.to::<u64>()))
}

/// Moves a body's credit to `proven`, an earlier listing of it (`Listings.correctCredit`, R2.18; anyone may). `None`,
/// with nothing sent, when the chain wouldn't take it: the credit is final, or nothing is left to move.
pub async fn correct_credit(chain: &Chain, keys: &(dyn KeyStore + Sync), proven: &crate::listing::Proven) -> Result<Option<String>, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let ls = LeanSettlement::new(d.settlement, &p).listings().call().await.map_err(|e| e.to_string())?;
    let at = ListingsDigest::new(ls, &p);
    let call = at.correctCredit(proven.shown()?);
    if call.call().await.is_err() {
        return Ok(None);
    }
    Ok(Some(send!(call, "moving a credit to the earlier listing")))
}
