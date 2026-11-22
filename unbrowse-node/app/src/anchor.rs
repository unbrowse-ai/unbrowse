//! The finalized chain the node has followed itself (security round 3, R3-CHAIN-1). A receipt proven against its block
//! (`proof::prove`) shows the block holds the write, not that the block is the chain's: an RPC can make a block of its
//! own, at any height, whose header, transactions and receipts all agree. So a proven block must also be one the node
//! has seen the chain's finalized history pass through:
//!
//! - **Checkpoints.** From the first time it looks, the node keeps finalized heads (`Anchored`), each linked to the one
//!   before by every header between them, each of which it rehashes itself and checks names the one before as its
//!   parent (`walk_down`). A new head is taken only once those links reach the last checkpoint, and, when the owner
//!   names a second RPC, only once that RPC has the same block at the head's height. A gap too long to link starts a
//!   new run of checkpoints, and what fell in the gap is never anchored.
//! - **Anchoring.** A block is anchored when, walking down from a checkpoint above it by the parent hashes the node
//!   rehashes itself, the block at its height is that block (`anchored`). A block made by the RPC, however
//!   self-consistent, isn't on that walk: to put it there the RPC would have to have forged every header since the node
//!   began watching, and the second RPC every one too.
//!
//! The first checkpoint is the RPC's word (and the second RPC's) when the node first looked; what the node can't do
//! without verifying consensus itself is know that word was true. `docs/MONEY.md` says what that leaves.

use std::future::Future;

use alloy::primitives::B256;
use serde::{Deserialize, Serialize};

/// The most headers one link walks: a new head farther than this from the last checkpoint starts a new run, and the
/// gap is never anchored. About an hour of Arc's blocks.
pub const MAX_LINK: u64 = 10_000;
/// How far, in blocks, the second RPC's own finalized head may be from the first's for the second to stand behind the
/// first's head now (R9-CHAIN-1): two honest RPCs of one chain see finality within a few blocks of each other, so a
/// first naming a head further back than this is stale or lying, and one further ahead is a second that lags.
pub const HEAD_SKEW: u64 = 64;

/// Whether the first RPC's finalized head `first` is the head a second RPC whose own finalized head is `second` stands
/// behind now: within `HEAD_SKEW` of it, either way.
pub fn fresh_for_second(first: u64, second: u64) -> bool {
    first.abs_diff(second) <= HEAD_SKEW
}

/// The most checkpoints kept: the oldest go first. At a checkpoint a pass, several days of them.
pub const MAX_CHECKPOINTS: usize = 8_192;

/// The finalized heads the node has linked, by chain: runs of checkpoints, oldest first, each run ascending and each
/// checkpoint linked to the one before it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Anchored {
    pub chain_id: u64,
    pub runs: Vec<Vec<(u64, B256)>>,
    /// The checkpoints a witness other than the node's one RPC stood behind (`Witness::agrees`): a second RPC that had
    /// the same block there, or a chain on this machine. A proof anchored only through others rests on one RPC's word.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agreed: Vec<u64>,
}

/// Who stands behind a finalized head the node takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Witness {
    /// The owner's second RPC has the same block at that height, asked just now.
    Second,
    /// The chain runs on this machine: its RPC is the owner's own.
    Here,
    /// Only the node's one RPC, with no second named.
    One,
}

impl Witness {
    /// Whether a checkpoint it stands behind rests on more than one RPC's word.
    pub fn agrees(self) -> bool {
        matches!(self, Witness::Second | Witness::Here)
    }
}

impl Anchored {
    /// The last checkpoint, if any.
    pub fn head(&self) -> Option<(u64, B256)> {
        self.runs.last().and_then(|r| r.last()).copied()
    }

    fn prune(&mut self) {
        let mut total: usize = self.runs.iter().map(Vec::len).sum();
        while total > MAX_CHECKPOINTS {
            let first = &mut self.runs[0];
            first.remove(0);
            total -= 1;
            if first.is_empty() {
                self.runs.remove(0);
            }
        }
        let oldest = self.runs.first().and_then(|r| r.first()).map(|(n, _)| *n).unwrap_or(0);
        self.agreed.retain(|n| *n >= oldest);
    }

    fn mark(&mut self, number: u64, witness: Witness) {
        if witness.agrees() && !self.agreed.contains(&number) {
            self.agreed.push(number);
        }
    }
}

/// Where headers come from: by hash, as the RPC serves them. Whatever it serves is rehashed before it is used.
pub trait Headers {
    fn by_hash(&self, hash: B256) -> impl Future<Output = Result<Option<alloy::consensus::Header>, String>> + Send;
    /// The headers the source names as blocks `low` to `high`, in that order: `None` for one it hasn't. A walk takes
    /// none of them on their word: each is rehashed and linked as `by_hash`'s are (`walk_down`).
    fn by_numbers(&self, low: u64, high: u64) -> impl Future<Output = Result<Vec<Option<alloy::consensus::Header>>, String>> + Send;
}

/// How many headers a walk asks for in one request: the gateway's most calls a batch, and about 100 KiB on Arc.
pub const LINK_BATCH: u64 = 50;

/// Why a link down the chain wasn't made. An RPC that refused, rate-limited, timed out or hadn't a block yet said
/// nothing (`Unanswered`): the chain is just not followed this time, and the node reads again on its next pass. An
/// RPC whose answers contradict themselves or the checkpoints the node already took (`Contradicts`) can't be trusted,
/// and that alone stops every write (`advance`, `rpc::halt`).
#[derive(Clone, Debug, PartialEq)]
pub enum Broken {
    Unanswered(String),
    Contradicts(String),
}

impl std::fmt::Display for Broken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Broken::Unanswered(e) | Broken::Contradicts(e) => f.write_str(e),
        }
    }
}

impl From<Broken> for String {
    fn from(b: Broken) -> String {
        b.to_string()
    }
}

/// Walks from the block `hash`, at height `number`, down to height `to`, by parent hashes: every header on the way is
/// rehashed here, must be the block the walk derived (its child's parent) and at the height the walk expects. The
/// headers are asked for by number, `LINK_BATCH` to a request (a link of a minute on Arc is a hundred blocks or more,
/// and one request a header made every link, and so every release, wait on that many round trips); one the source names
/// otherwise at a height is asked for again by the hash the walk derived, as every one was before. The hash at `to`, as
/// the walk derives it. A header that doesn't rehash to the hash it was asked by, or a height out of place, contradicts
/// the walk; a header not served, or a walk longer than `MAX_LINK`, is only not linked.
pub async fn walk_down<H: Headers>(src: &H, hash: B256, number: u64, to: u64) -> Result<B256, Broken> {
    if to > number {
        return Err(Broken::Unanswered(format!("block {to} is above {number}")));
    }
    if number - to > MAX_LINK {
        return Err(Broken::Unanswered(format!("{} blocks to link, more than {MAX_LINK}", number - to)));
    }
    let (mut at, mut height) = (hash, number);
    while height > to {
        let low = height.saturating_sub(LINK_BATCH - 1).max(to + 1);
        // A batch that isn't answered is no contradiction: the walk goes on one header at a time, as it always could.
        let batch = src.by_numbers(low, height).await.unwrap_or_default();
        while height >= low {
            let named = batch.get((height - low) as usize).cloned().flatten().filter(|h| h.number == height && h.hash_slow() == at);
            let h = match named {
                Some(h) => h,
                None => {
                    let h = src.by_hash(at).await.map_err(Broken::Unanswered)?.ok_or_else(|| Broken::Unanswered(format!("the RPC has no block {at:#x} yet")))?;
                    if h.hash_slow() != at {
                        return Err(Broken::Contradicts(format!("the header the RPC gave for {at:#x} hashes otherwise")));
                    }
                    if h.number != height {
                        return Err(Broken::Contradicts(format!("the header for {at:#x} says it is block {}, not {height}", h.number)));
                    }
                    h
                }
            };
            at = h.parent_hash;
            height -= 1;
        }
    }
    Ok(at)
}

/// Takes the finalized head (`number`, `hash`) as the next checkpoint when the links from it reach the last one; one
/// too far to link starts a new run. `witness` is who stands behind it now: none (a second RPC named but behind or not
/// answering) and it is never taken. Whether the head was taken.
pub async fn extend<H: Headers>(chain: &mut Anchored, number: u64, hash: B256, witness: Option<Witness>, src: &H) -> Result<bool, Broken> {
    let Some(witness) = witness else { return Ok(false) };
    match chain.head() {
        None => chain.runs.push(vec![(number, hash)]),
        Some((m, _)) if number <= m => return Ok(false),
        Some((m, hm)) if number - m > MAX_LINK => {
            let _ = hm;
            chain.runs.push(vec![(number, hash)]);
        }
        Some((m, hm)) => {
            let derived = walk_down(src, hash, number, m).await?;
            if derived != hm {
                return Err(Broken::Contradicts(format!("the finalized block {number} ({hash:#x}) doesn't descend from block {m} ({hm:#x}), which the node had taken as final")));
            }
            chain.runs.last_mut().expect("a head has a run").push((number, hash));
        }
    }
    chain.mark(number, witness);
    chain.prune();
    Ok(true)
}

/// Whether block `number` at `hash` is on the finalized chain the node has followed: the walk down from the lowest
/// checkpoint at or above it, in the same run, arrives at `hash` at that height. False for a block below every run,
/// above every checkpoint, or in a gap between runs.
#[cfg(test)]
pub async fn anchored<H: Headers>(chain: &Anchored, number: u64, hash: B256, src: &H) -> Result<bool, Broken> {
    Ok(anchored_at(chain, number, hash, src).await?.is_some())
}

/// `anchored`, and whether the checkpoint it walked down from was one a witness other than the one RPC stood behind
/// (`Witness::agrees`): `None` when the block isn't on the followed chain.
pub async fn anchored_at<H: Headers>(chain: &Anchored, number: u64, hash: B256, src: &H) -> Result<Option<bool>, Broken> {
    for run in &chain.runs {
        let Some(&(start, _)) = run.first() else { continue };
        if number < start {
            continue;
        }
        let Some(&(c, hc)) = run.iter().find(|(n, _)| *n >= number) else { continue };
        return Ok((walk_down(src, hc, c, number).await? == hash).then(|| chain.agreed.contains(&c)));
    }
    Ok(None)
}

/// What `advance` came to: the chain as followed, whether it was followed to the chain's finalized head on this very
/// call (`current`: a second RPC named had that block there just now, or there is none to ask), and who stood behind it.
#[derive(Clone, Debug)]
pub struct Followed {
    pub anchored: Anchored,
    pub current: bool,
    pub witness: Option<Witness>,
    /// The second RPC's own finalized block number, as it said it on this call (within `HEAD_SKEW` of the head when
    /// it stood behind it): the more advanced of the two heads is what an expiry is judged by (R10-CHAIN-1).
    pub second_head: Option<u64>,
}

/// Headers as the node's RPC (or the second) serves them, each answer read within its bound (`proof::fetch`).
pub struct FromRpc(pub crate::proof::Url);

impl Headers for FromRpc {
    async fn by_hash(&self, hash: B256) -> Result<Option<alloy::consensus::Header>, String> {
        match crate::proof::fetch(&self.0, "eth_getBlockByHash", serde_json::json!([hash, false]), crate::proof::MAX_HEADER_BYTES).await? {
            crate::proof::Answer::Value(v) => serde_json::from_value::<alloy::rpc::types::Block>(v).map(|b| Some(b.header.inner)).map_err(|e| format!("a header doesn't read: {e}")),
            crate::proof::Answer::Null => Ok(None),
            crate::proof::Answer::Refused(e) => Err(e),
        }
    }

    async fn by_numbers(&self, low: u64, high: u64) -> Result<Vec<Option<alloy::consensus::Header>>, String> {
        let calls: Vec<(&str, serde_json::Value)> = (low..=high).map(|n| ("eth_getBlockByNumber", serde_json::json!([format!("{n:#x}"), false]))).collect();
        let answers = crate::proof::fetch_batch(&self.0, &calls, calls.len() * crate::proof::MAX_HEADER_BYTES).await?;
        Ok(answers
            .into_iter()
            .map(|a| match a {
                crate::proof::Answer::Value(v) => serde_json::from_value::<alloy::rpc::types::Block>(v).ok().map(|b| b.header.inner),
                _ => None,
            })
            .collect())
    }
}

fn path() -> std::path::PathBuf {
    crate::chain::dir().join("headers.json")
}

/// One change to the checkpoints at a time in this process; `node.lock` keeps other processes off the folder.
static ADVANCING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Takes the chain's finalized head as a checkpoint, if it links (`extend`), and says whether the node follows the chain
/// now (`Followed::current`): only when the head was taken, or is the last checkpoint already, on this call. With a
/// second RPC named, only once it has the same block there now: one behind, or not answering, leaves the chain
/// unfollowed, and the node waits. A primary with no finalized head, or one that doesn't answer a header the link
/// needs (a refusal, a rate limit), leaves it unfollowed too. A head that doesn't descend from the last checkpoint, or
/// whose header doesn't rehash, stops every write (`rpc::halt`).
pub async fn advance(chain_id: u64) -> Result<Followed, String> {
    let _one = ADVANCING.lock().await;
    let url = crate::chain::url();
    let mut kept: Anchored = crate::store::read_json_strict(&path(), &unbrowse_files::HEADER_CHAIN)?;
    if kept.chain_id != chain_id {
        kept = Anchored { chain_id, ..Default::default() };
    }
    let head = match crate::proof::fetch(&url, "eth_getBlockByNumber", serde_json::json!(["finalized", false]), crate::proof::MAX_HEADER_BYTES).await? {
        crate::proof::Answer::Value(v) => serde_json::from_value::<alloy::rpc::types::Block>(v).map_err(|e| format!("the finalized header doesn't read: {e}"))?,
        _ => return Ok(Followed { anchored: kept, current: false, witness: None, second_head: None }),
    };
    let (number, hash) = (head.header.inner.number, head.header.inner.hash_slow());
    if hash != head.header.hash {
        let why = format!("the RPC's finalized header for block {number} doesn't hash to the hash it gives: the RPC is lying, or this build can't rehash this chain's headers (`arc_headers_rehash_in_this_build`), and either way nothing about its blocks can be proven");
        crate::rpc::halt(&why);
        return Err(why);
    }
    let mut second_head = None;
    let witness = match crate::rpc::second_url()? {
        // The second stands behind the head only as its own: its finalized head within `HEAD_SKEW` of the first's,
        // and the first's block there by the same hash (R9-CHAIN-1). A first that names an old finalized block, which
        // an honest second still has, is no head a witness stands behind now.
        Some(_) => match crate::rpc::second_finalized().await.inspect(|theirs| second_head = Some(*theirs)) {
            Ok(theirs) if fresh_for_second(number, theirs) => match crate::rpc::second_agrees_on_block(number, hash).await {
                Ok(()) => Some(Witness::Second),
                // A second RPC behind, or not answering, is no witness: the node doesn't follow the chain on the first's
                // word alone while a second is named. One that disagrees has stopped every write.
                Err(e) if e.contains("hasn't reached") || e.contains("didn't answer") => None,
                Err(e) => return Err(e),
            },
            Ok(theirs) => {
                crate::store::tell_once(&crate::chain::dir().join("heads-apart"), &format!("The node's RPC says the chain is final to block {number} and the second RPC to block {theirs}: more than {HEAD_SKEW} blocks apart, so neither is taken as the chain's head and the node waits (writes, and every reading that needs a witness). One of the two is stale or lying."));
                None
            }
            Err(_) => None,
        },
        None if crate::rpc::chain_is_here() => Some(Witness::Here),
        None => Some(Witness::One),
    };
    let last = kept.head();
    let current = match extend(&mut kept, number, hash, witness, &FromRpc(url)).await {
        Ok(true) => true,
        // No new head: followed now only if the head is the last checkpoint, and someone stands behind it now.
        Ok(false) => match witness {
            Some(w) if last == Some((number, hash)) => {
                kept.mark(number, w);
                true
            }
            _ => false,
        },
        // An RPC that didn't answer said nothing: the chain isn't followed this time, so nothing that needs it is
        // signed, and the next pass reads again. Only answers that contradict stop every write.
        Err(Broken::Unanswered(e)) => {
            eprintln!("chain: not followed this pass, read again next: {e}");
            false
        }
        Err(Broken::Contradicts(e)) => {
            crate::rpc::halt(&e);
            return Err(e);
        }
    };
    if current {
        let _file = crate::store::hold_money_file(&path(), crate::store::MONEY_LOCK_WAIT)?;
        crate::store::write_json(&path(), &unbrowse_files::HEADER_CHAIN, &kept)?;
    }
    Ok(Followed { anchored: kept, current, witness, second_head })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Mem(HashMap<B256, alloy::consensus::Header>);

    impl Headers for Mem {
        async fn by_hash(&self, hash: B256) -> Result<Option<alloy::consensus::Header>, String> {
            Ok(self.0.get(&hash).cloned())
        }

        /// The one header it holds at each height; none where it holds two (a forged chain beside the real one).
        async fn by_numbers(&self, low: u64, high: u64) -> Result<Vec<Option<alloy::consensus::Header>>, String> {
            Ok((low..=high)
                .map(|n| {
                    let at: Vec<_> = self.0.values().filter(|h| h.number == n).collect();
                    (at.len() == 1).then(|| at[0].clone())
                })
                .collect())
        }
    }

    /// A chain of `n` headers from height 0, each naming the one before as its parent; `salt` makes another chain.
    fn chain(n: u64, salt: u8) -> Vec<alloy::consensus::Header> {
        let mut out: Vec<alloy::consensus::Header> = Vec::new();
        for i in 0..n {
            let parent = out.last().map(|h| h.hash_slow()).unwrap_or_default();
            out.push(alloy::consensus::Header { number: i, parent_hash: parent, extra_data: vec![salt].into(), ..Default::default() });
        }
        out
    }

    /// A block an RPC made, however self-consistent, at any height, is never anchored: only one the walk down from a
    /// checkpoint the node linked itself arrives at. A head that doesn't descend from the last checkpoint is an
    /// error; one too far to link starts a new run, whose gap is never anchored; a head the second RPC doesn't agree on
    /// is never taken.
    #[tokio::test]
    async fn a_self_consistent_header_at_a_fake_height_is_not_anchored() {
        let real = chain(40, 1);
        let forged = chain(40, 2);
        let mut src: HashMap<B256, alloy::consensus::Header> = real.iter().map(|h| (h.hash_slow(), h.clone())).collect();
        src.extend(forged.iter().map(|h| (h.hash_slow(), h.clone())));
        let src = Mem(src);
        let mut a = Anchored { chain_id: 1, ..Default::default() };
        assert!(extend(&mut a, 10, real[10].hash_slow(), Some(Witness::Second), &src).await.unwrap(), "the first head, on first look");
        assert!(extend(&mut a, 30, real[30].hash_slow(), Some(Witness::One), &src).await.unwrap(), "a head that descends from it");
        assert!(anchored(&a, 20, real[20].hash_slow(), &src).await.unwrap(), "a real block between them");
        assert!(!anchored(&a, 20, forged[20].hash_slow(), &src).await.unwrap(), "a forged block at the same height");
        assert!(!anchored(&a, 5, real[5].hash_slow(), &src).await.unwrap(), "a block before the node looked");
        assert!(!anchored(&a, 35, real[35].hash_slow(), &src).await.unwrap(), "a block past the last checkpoint");
        assert!(!extend(&mut a, 39, real[39].hash_slow(), None, &src).await.unwrap(), "a head the second RPC doesn't agree on");
        assert!(
            matches!(extend(&mut a, 39, forged[39].hash_slow(), Some(Witness::Second), &src).await, Err(Broken::Contradicts(_))),
            "a head that doesn't descend from the last checkpoint contradicts it"
        );
        assert_eq!(a.head(), Some((30, real[30].hash_slow())), "and nothing of it was taken");
        // What a proof walks from says who stood behind it: block 20 walks from checkpoint 30, taken on one RPC's word.
        assert_eq!(anchored_at(&a, 20, real[20].hash_slow(), &src).await.unwrap(), Some(false), "anchored on one RPC's word");
        assert_eq!(anchored_at(&a, 10, real[10].hash_slow(), &src).await.unwrap(), Some(true), "anchored where a second RPC agreed");
    }

    /// An RPC that refuses one header of the walk (a public endpoint's rate limit), or hasn't it yet, has said nothing:
    /// the head isn't taken and the walk is only not linked, never a contradiction that stops every write. The same
    /// head links once the RPC answers again.
    #[tokio::test]
    async fn an_rpc_that_refuses_a_header_contradicts_nothing() {
        struct Refusing(Mem, B256);
        impl Headers for Refusing {
            async fn by_hash(&self, hash: B256) -> Result<Option<alloy::consensus::Header>, String> {
                if hash == self.1 {
                    return Err(r#"{"code":-32005,"message":"rate limit exceeded"}"#.into());
                }
                self.0.by_hash(hash).await
            }

            async fn by_numbers(&self, _low: u64, _high: u64) -> Result<Vec<Option<alloy::consensus::Header>>, String> {
                Err(r#"{"code":-32005,"message":"rate limit exceeded"}"#.into())
            }
        }
        let real = chain(40, 1);
        let all = || Mem(real.iter().map(|h| (h.hash_slow(), h.clone())).collect());
        let mut a = Anchored { chain_id: 1, ..Default::default() };
        assert!(extend(&mut a, 10, real[10].hash_slow(), Some(Witness::One), &all()).await.unwrap());
        let refusing = Refusing(all(), real[20].hash_slow());
        assert!(matches!(extend(&mut a, 30, real[30].hash_slow(), Some(Witness::One), &refusing).await, Err(Broken::Unanswered(_))), "a refused header");
        let missing = Mem(real.iter().filter(|h| h.number != 25).map(|h| (h.hash_slow(), h.clone())).collect());
        assert!(matches!(extend(&mut a, 30, real[30].hash_slow(), Some(Witness::One), &missing).await, Err(Broken::Unanswered(_))), "a header not served yet");
        assert_eq!(a.head(), Some((10, real[10].hash_slow())), "neither took the head");
        assert!(extend(&mut a, 30, real[30].hash_slow(), Some(Witness::One), &all()).await.unwrap(), "the RPC answering again links it");
    }

    /// A source that counts what it was asked: headers by number in batches, and one by hash.
    struct Counted {
        real: Vec<alloy::consensus::Header>,
        lie_at: Option<(u64, alloy::consensus::Header)>,
        batches: std::sync::atomic::AtomicUsize,
        singles: std::sync::atomic::AtomicUsize,
    }

    impl Headers for Counted {
        async fn by_hash(&self, hash: B256) -> Result<Option<alloy::consensus::Header>, String> {
            self.singles.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.real.iter().find(|h| h.hash_slow() == hash).cloned())
        }

        async fn by_numbers(&self, low: u64, high: u64) -> Result<Vec<Option<alloy::consensus::Header>>, String> {
            self.batches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok((low..=high)
                .map(|n| match &self.lie_at {
                    Some((at, forged)) if *at == n => Some(forged.clone()),
                    _ => self.real.get(n as usize).cloned(),
                })
                .collect())
        }
    }

    /// A link between heads costs a request for each `LINK_BATCH` headers, not one a header: on Arc a minute's link is a
    /// hundred blocks or more, and a release that waited on a round trip for each ran past its deadline.
    #[tokio::test]
    async fn a_link_between_heads_asks_for_its_headers_in_batches() {
        let real = chain(130, 1);
        let src = Counted { real: real.clone(), lie_at: None, batches: Default::default(), singles: Default::default() };
        assert_eq!(walk_down(&src, real[120].hash_slow(), 120, 10).await.unwrap(), real[10].hash_slow());
        let (batches, singles) = (src.batches.load(std::sync::atomic::Ordering::SeqCst), src.singles.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!((batches, singles), (3, 0), "110 headers in three batches of at most {LINK_BATCH}, and none asked for alone");
    }

    /// A batch that names another block at a height is no contradiction on its own: that header is asked for again by the
    /// hash the walk derived, as every header was before batches, and the walk goes on when the source has it.
    #[tokio::test]
    async fn a_batch_that_names_another_block_is_checked_by_hash() {
        let real = chain(60, 1);
        let forged = chain(60, 2);
        let src = Counted { real: real.clone(), lie_at: Some((30, forged[30].clone())), batches: Default::default(), singles: Default::default() };
        assert_eq!(walk_down(&src, real[50].hash_slow(), 50, 10).await.unwrap(), real[10].hash_slow());
        assert_eq!(src.singles.load(std::sync::atomic::Ordering::SeqCst), 1, "only the header the batch named otherwise");
    }
}
