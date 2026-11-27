//! How the node reaches its chain. Every provider the node makes comes from `ProviderBuilder` here, which takes the
//! place of alloy's under the same name and the same calls. alloy's own builder connects with an HTTP client that has
//! no timeout, so one RPC that never answers would hold whatever called it for good: a claim pass, with the claim lock
//! it holds, and every pass after it. Here each request has a bound, a sent write is waited on for a bounded time
//! (`mined!`), and the node's writes go out one at a time, each with the nonce the chain gives it then, so two writes
//! made at once never take the same nonce.
//!
//! A write counts once its block is final, not when its receipt arrives (`finalized`): a block the chain may still drop
//! takes the write with it, and the claim mark, deposit, hold or listing the node recorded for it would then stand for
//! nothing. Arc's blocks are final as they are committed (Malachite BFT; its RPC serves `finalized` at the head or one
//! block behind it), so on Arc this is a read or two after the receipt. On a chain whose blocks become final later,
//! the write waits for its block to be.
//!
//! Every write is the node's own, paid in USDC on Arc by the key that makes it (spec §76: no sponsor). A write of several
//! calls (`batch`) goes as one transaction through Arc's Multicall3From where the chain runs it (`one_transaction`).

use std::sync::LazyLock;
use std::time::Duration;

use alloy::consensus::{TxEnvelope, TypedTransaction};
use alloy::eips::BlockNumberOrTag;
use alloy::network::{Ethereum, EthereumWallet, NetworkWallet};
use alloy::primitives::Address;
use alloy::providers::fillers::{BlobGasFiller, ChainIdFiller};
use alloy::providers::{Provider, WalletProvider};
use alloy::rpc::types::TransactionReceipt;
use alloy::signers::local::PrivateKeySigner;
use alloy::transports::http::reqwest;

/// How long one request to the chain may take, and connecting for it. A healthy RPC answers in well under a second;
/// a log read over a wide window takes a few.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a sent write is waited on to be mined. A chain makes a block every few seconds at most; a write not mined
/// in this time is reported as failed, and whoever sent it decides whether to send it again.
pub const RECEIPT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a mined write is waited on for its block to be final. Arc finalizes each block as it commits it, so this
/// bound is reached only on a chain that has stopped finalizing; the write is then reported as not final yet.
pub const FINALITY_TIMEOUT: Duration = Duration::from_secs(60);
/// What a write's error says when the write left the node and what became of it isn't known: it may still land. A caller
/// that would tell the owner the chain refused it asks `unsettled` first.
const UNSETTLED: &str = "sent, and what became of it isn't known yet";
/// How long the signer's mined count may sit below its pending one before the oldest of those writes is stuck (`stuck`).
/// Far past a block on any chain the node runs on, so a write is never taken for stuck while it is only slow.
pub const STUCK_AFTER: u64 = 300;
/// How often a mined write's block is looked at while it isn't final yet: about half of Arc's testnet block time.
const FINALITY_POLL: Duration = Duration::from_millis(250);
/// The block a read is made at when what it reads decides that a write already happened: the chain's finalized block,
/// so nothing the node marks done is in a block that can still be dropped.
pub const SETTLED: alloy::eips::BlockId = alloy::eips::BlockId::Number(BlockNumberOrTag::Finalized);

/// How often a request the RPC turned away for its rate (HTTP 429 or 503, or a JSON-RPC rate-limit error) is sent again,
/// and the wait before each: a public RPC limits each caller, and a node reading the registry or the chain's logs over
/// many windows meets that limit in bursts. Without this, one refusal failed the whole read, and the reader went on with
/// nothing (first contact found no seeds, so the node met no one). A refused request did nothing, so sending it again is
/// safe, a signed write included: the same raw transaction twice is one transaction.
pub(crate) const RATE_LIMIT_RETRIES: u32 = 10;
pub(crate) const RATE_LIMIT_BACKOFF_MS: u64 = 1_000;
/// The rate the retries are spaced for, in alloy's compute units a second (about 20 a request): ten requests a second.
const RATE_LIMIT_UNITS_PER_SECOND: u64 = 200;

/// One HTTP client for every provider: the bounds above, and its connections kept for the next request.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// How long a devnet's own cheats (`devnet_cheat`) may take: mining an epoch on a long devnet waits for its Anvil to
/// save its state, which on a busy machine can take far longer than a request to a chain should.
const DEVNET_CHEAT_TIMEOUT: Duration = Duration::from_secs(600);

/// Sends `method` with `params` to the chain the node runs (`chain::url`), with its own longer bound, when that chain
/// runs on this machine (an Anvil on loopback, the node's devnet or a test's stand-in for a network): a chain reached
/// over the network has no such cheat, and is refused.
pub async fn devnet_cheat(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = crate::chain::url();
    let here = url.host_str().is_some_and(|h| h == "localhost" || h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    if !here {
        return Err(format!("{method} is a local chain's own: the chain at {url} isn't on this machine"));
    }
    static SLOW: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().timeout(DEVNET_CHEAT_TIMEOUT).connect_timeout(CONNECT_TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new()));
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let reply: serde_json::Value = SLOW.post(crate::chain::url()).json(&body).send().await.map_err(|e| format!("{method}: {e}"))?.json().await.map_err(|e| format!("{method}: {e}"))?;
    match reply.get("error") {
        Some(e) => Err(format!("{method}: {e}")),
        None => Ok(reply.get("result").cloned().unwrap_or(serde_json::Value::Null)),
    }
}

/// Held while a write is sent and mined (`mined!`): the node's writes go one at a time. Each write's provider asks the
/// chain for the signer's next nonce as it sends (`SimpleNonceManager`), and with no other write in flight, the
/// answer is one no other write takes. A write is bounded (`REQUEST_TIMEOUT`, `RECEIPT_TIMEOUT`), so the lock is too.
pub static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The node's provider builder: alloy's, connected through `CLIENT`.
pub struct ProviderBuilder;

impl ProviderBuilder {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        ProviderBuilder
    }

    /// A provider that reads.
    pub fn connect_http(self, url: reqwest::Url) -> impl Provider + Clone {
        alloy::providers::ProviderBuilder::new().connect_client(client(url))
    }

    /// A provider that signs as `key`.
    pub fn wallet(self, key: PrivateKeySigner) -> Signing {
        Signing(NodeWallet { wallet: EthereumWallet::from(key.clone()), key, chain: None })
    }
}

/// The wallet every signing provider of the node's holds: alloy's, for transactions, and the key it was made from.
#[derive(Clone, Debug)]
pub struct NodeWallet {
    wallet: EthereumWallet,
    key: PrivateKeySigner,
    /// The chain every transaction this wallet signs names: the node's own (`signing_chain`) when it signs through the
    /// node's chain's RPC (`chain::url`), else none, and the RPC's answer, as a test's second chain has it.
    chain: Option<u64>,
}

impl NodeWallet {
    /// The key this wallet signs with.
    pub fn key(&self) -> &PrivateKeySigner {
        &self.key
    }

    /// The chain this wallet's transactions name, when it signs on the node's own chain.
    pub fn chain(&self) -> Option<u64> {
        self.chain
    }
}

impl NetworkWallet<Ethereum> for NodeWallet {
    fn default_signer_address(&self) -> Address {
        NetworkWallet::<Ethereum>::default_signer_address(&self.wallet)
    }

    fn has_signer_for(&self, address: &Address) -> bool {
        NetworkWallet::<Ethereum>::has_signer_for(&self.wallet, address)
    }

    fn signer_addresses(&self) -> impl Iterator<Item = Address> {
        NetworkWallet::<Ethereum>::signer_addresses(&self.wallet)
    }

    async fn sign_transaction_from(&self, sender: Address, tx: TypedTransaction) -> alloy::signers::Result<TxEnvelope> {
        NetworkWallet::<Ethereum>::sign_transaction_from(&self.wallet, sender, tx).await
    }
}

/// A provider builder that signs.
pub struct Signing(NodeWallet);

impl Signing {
    /// alloy's recommended fillers, but the nonce read from the chain for each write rather than counted up from the
    /// first: a provider that sends more than one write would otherwise reuse a nonce another write took between them.
    /// The chain ID is the one the node runs on (`signing_chain`), never the RPC's answer, and every write's gas and fee
    /// are set before it reaches these fillers (`send_write`, `price`), so the gas filler only ever fills what a write
    /// already holds.
    pub fn connect_http(self, url: reqwest::Url) -> impl Provider + WalletProvider<Wallet = NodeWallet> + Clone {
        let mut wallet = self.0;
        wallet.chain = (url == crate::chain::url()).then(signing_chain).flatten();
        alloy::providers::ProviderBuilder::new()
            .disable_recommended_fillers()
            .with_gas_estimation()
            .filler(BlobGasFiller::default())
            .with_simple_nonce_management()
            .filler(ChainIdFiller::new(wallet.chain))
            .wallet(wallet)
            .connect_client(client(url))
    }
}

/// The RPC client every provider sends through: `CLIENT`'s bounds, and a request the RPC turned away for its rate, or
/// answered from a node behind the block asked for (`behind_head`), sent again after a wait (`RATE_LIMIT_RETRIES`).
fn client(url: reqwest::Url) -> alloy::rpc::client::RpcClient {
    use alloy::transports::layers::{RateLimitRetryPolicy, RetryBackoffLayer};
    let local = url.host_str().is_some_and(|h| h == "127.0.0.1" || h == "localhost" || h == "::1");
    let policy = RateLimitRetryPolicy::default().or(behind_head);
    alloy::rpc::client::RpcClient::builder()
        .layer(RetryBackoffLayer::new_with_policy(RATE_LIMIT_RETRIES, RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_UNITS_PER_SECOND, policy))
        .transport(alloy::transports::http::Http::with_client(CLIENT.clone(), url), local)
}

/// Whether the RPC answered from a node that hasn't reached the block asked for. Arc's public RPCs sit behind a load
/// balancer whose nodes can trail each other by a block, so a read at the block a write was just mined in can reach one
/// that hasn't seen it yet ("request beyond head block"); a moment later it has. A deploy is a dozen writes, each read
/// back at its block, so one such answer stopped it partway.
fn behind_head(e: &alloy::transports::TransportError) -> bool {
    e.as_error_resp().is_some_and(|r| r.message.contains("beyond head block"))
}

/// Sends a contract write and waits, a bounded time, for it to be mined and its block to be final (`finalized`): its
/// receipt as the final block has it, or the error, prefixed with what the write was, returned from the enclosing
/// function. No other write the node makes is in flight meanwhile.
///
/// The signer sends it itself, when it can pay for it by its own estimate (`chain::short_of`); one it can't is refused,
/// saying the node needs gas for it.
macro_rules! mined {
    ($call:expr, $what:expr) => {{
        let _writing = $crate::rpc::write_turn().await;
        // A match keeps the call's temporaries (the contract it was made from) alive while it is checked and sent.
        match &$call {
            call => {
                #[allow(unused_imports)]
                use alloy::providers::WalletProvider as _;
                let payer = call.provider.default_signer_address();
                let wallet = call.provider.wallet().clone();
                let pinned = call.provider.wallet().chain();
                $crate::rpc::send_write(call, payer, &wallet, pinned, &$what.to_string()).await?
            }
        }
    }};
}
pub(crate) use mined;

/// `mined!` for a write the chain would take twice as two (`inflight`): `$key` says what it is for, `$amount` what it
/// moves, `$book` who must count it, and `$watch` a view of the chain (a contract and its calldata) the write changes,
/// read before it is signed, which `inflight` reads again before it ever lets a write go on an RPC's word alone. Kept
/// before it goes, and until `inflight::done`, so nothing sends a second while the first may still land. The caller
/// asks `inflight::settle` first. A write proven to have reverted is let go here: it did nothing.
macro_rules! once {
    ($call:expr, $key:expr, $amount:expr, $book:expr, $watch:expr, $what:expr) => {{
        let _writing = $crate::rpc::write_turn().await;
        match &$call {
            call => {
                #[allow(unused_imports)]
                use alloy::providers::WalletProvider as _;
                let me = call.provider.default_signer_address();
                let wallet = call.provider.wallet().clone();
                let what = $what.to_string();
                $crate::inflight::send(call, me, &wallet, $key, $amount, $book, $watch, &what).await?
            }
        }
    }};
}
pub(crate) use once;

/// What `mined!` does once it is the node's turn to write: the signer's own, once it can pay for it. The node signs the
/// transaction here and knows its hash from the bytes it signed, sends those bytes, and waits for the receipt of that
/// hash and for its block to be final (`finalized`). The day's gas count keeps the write's most cost until the receipt
/// is proven against its block (`proof::prove_on`); an RPC's own word on what it cost is never taken.
pub async fn send_write<P, D>(call: &alloy::contract::CallBuilder<P, D>, payer: Address, wallet: &NodeWallet, pinned: Option<u64>, what: &str) -> Result<TransactionReceipt, String>
where
    P: Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    let chain_id = write_gate(&call.provider, pinned, Signs::Ordinary).await.map_err(|e| format!("{what}: {e}"))?;
    if let Some(short) = crate::chain::short_of(call, payer).await.map_err(|e| format!("{what}: {e}"))? {
        return Err(format!("{what}: {short}"));
    }
    let gas = match call.as_ref().gas {
        Some(g) => g,
        None => call.clone().from(payer).estimate_gas().await.map_err(|e| not_sent(what, e.to_string()))?.saturating_add(NEXT_BLOCK_GAS),
    };
    // A fee the node set on the write itself (a replacement outbidding a stuck write) is kept, held to the cap; any
    // other is the node's own price now.
    let priced = match (call.as_ref().max_fee_per_gas, call.as_ref().max_priority_fee_per_gas) {
        (Some(fee), Some(tip)) => held_to_cap(gas, fee, tip, crate::store::load_settings().max_gas_price_wei()).map_err(|e| format!("{what}: {e}"))?,
        _ => priced(&call.provider, gas).await.map_err(|e| format!("{what}: {e}"))?,
    };
    take_sub_budget(priced.most()).map_err(|e| format!("{what}: {e}"))?;
    let spend = Spend::reserve(&priced).map_err(|e| format!("{what}: {e}"))?;
    // The nonce is set here, not by a filler, so the node knows which of its kept writes it rules out.
    let nonce = match call.as_ref().nonce {
        Some(n) => n,
        None => match call.provider.get_transaction_count(payer).pending().await {
            Ok(n) => n,
            Err(e) => {
                spend.release();
                return Err(not_sent(what, e.to_string()));
            }
        },
    };
    let mut tx: alloy::rpc::types::TransactionRequest = call.as_ref().clone();
    tx.from = Some(payer);
    tx.chain_id = Some(chain_id);
    tx.nonce = Some(nonce);
    tx.gas = Some(priced.gas);
    tx.max_fee_per_gas = Some(priced.max_fee);
    tx.max_priority_fee_per_gas = Some(priced.tip);
    let signed = match <alloy::rpc::types::TransactionRequest as alloy::network::TransactionBuilder<Ethereum>>::build(tx, wallet).await {
        Ok(s) => s,
        Err(e) => {
            spend.release();
            return Err(not_sent(what, e.to_string()));
        }
    };
    let ours = *signed.tx_hash();
    let raw = alloy::eips::eip2718::Encodable2718::encoded_2718(&signed);
    if let Err(e) = call.provider.send_raw_transaction(&raw).await {
        let e = e.to_string();
        // Turned away, by the RPC's word: the signed bytes have left the node all the same, and an RPC that says it
        // refused them may have passed them on, so the write's most stays in the day's count (`Spend`), as a write's
        // cost is never given back on an RPC's word. Unless the RPC says it holds the nonce, the caller may try again.
        if !crate::inflight::holds_nonce(&e) {
            // `spend` is left as it is: its most stays counted.
            return Err(not_sent(what, e));
        }
        // It says it holds the nonce: this write may be the one that took it, and is waited for as any other.
    }
    // A note that can't be kept only leaves a kept write waiting longer: the write is out either way.
    let _ = crate::inflight::note_nonce(payer, nonce, ours);
    let mined = receipt_of(&call.provider, ours, RECEIPT_TIMEOUT).await.map_err(|e| unsettled_error(what, e))?;
    let receipt = finalized(&call.provider, mined).await.map_err(|e| unsettled_error(what, e))?;
    let proven = settle_proven(&call.provider, spend, ours, &receipt, Some(crate::proof::signed_fee(&signed))).await.map_err(|e| unsettled_error(what, e))?;
    // Nothing a write did is taken on its receipt alone: a receipt the block can't be shown to hold leaves the write
    // as one that may still land (`unsettled`), whatever it says.
    match crate::inflight::verdict(receipt.status(), proven.map(|p| p.ran)) {
        crate::inflight::Verdict::Landed | crate::inflight::Verdict::Reverted => Ok(receipt),
        crate::inflight::Verdict::Waiting | crate::inflight::Verdict::Contradicted => Err(unsettled_error(what, "its receipt can't be proven against its block yet")),
    }
}

/// The receipt of the node's transaction `tx`, once the RPC has one, waited for at most `wait`.
pub async fn receipt_of<P: Provider>(p: &P, tx: alloy::primitives::B256, wait: Duration) -> Result<TransactionReceipt, String> {
    let t = std::time::Instant::now();
    loop {
        if let Some(r) = p.get_transaction_receipt(tx).await.map_err(|e| e.to_string())? {
            return Ok(r);
        }
        if t.elapsed() >= wait {
            return Err(format!("no receipt for {tx:#x} within {}s", wait.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Proves the final `receipt` of the node's `tx` against its block and settles the day's gas count by what the proof
/// says it cost; a receipt that can't be proven leaves the write's most counted. A proof the RPC's answers contradict
/// (a receipt that isn't the block's, a block the second RPC hashes otherwise) stops every write (`halt`), and is an
/// error: what the receipt says can't be acted on. A proof the RPC didn't answer (a refusal, a rate limit) is an error
/// too, and stops nothing: the write is read again.
pub async fn settle_proven<P: Provider>(p: &P, spend: Spend, tx: alloy::primitives::B256, receipt: &TransactionReceipt, signed: Option<(u128, u128)>) -> Result<Option<crate::proof::Proven>, String> {
    let at = receipt.block_number.ok_or("the receipt names no block")?;
    match crate::proof::prove_on(p, tx, at, signed).await {
        Ok(crate::proof::Inclusion::Proven(proven)) if proven.ran == receipt.status() => {
            spend.settle(Some(&proven));
            Ok(Some(proven))
        }
        Ok(crate::proof::Inclusion::Proven(proven)) => {
            let why = format!("the RPC's receipt for {tx:#x} says {} and its block says {}", receipt.status(), proven.ran);
            halt(&why);
            Err(why)
        }
        Ok(crate::proof::Inclusion::Unprovable(why)) => {
            // Its most stays counted; the owner hears once that this chain's receipts can't be proven here.
            crate::store::tell_once(&crate::chain::dir().join("unprovable"), &format!("The node can't prove its writes' receipts on this chain ({why}): it counts each write's gas at its most, and lets a kept write go only on the slower rules"));
            Ok(None)
        }
        // A proof that couldn't be read (the RPC refused, rate-limited or timed out) proves nothing either way: the
        // write stays unsettled and is read again. What contradicts has stopped writes where it was found.
        Err(e) => Err(e),
    }
}

tokio::task_local! {
    /// What the writes of the task running within `within_budget` may still cost, in the chain's native units.
    static SUB_BUDGET: std::sync::Arc<std::sync::Mutex<alloy::primitives::U256>>;
}

/// Runs `work` with every write it signs held to `budget` in all, by each write's signed most (its gas limit at the
/// most fee a unit it is signed at: what it can cost whatever it does), taken at the one place writes are signed
/// (`take_sub_budget`): a write that doesn't fit what is left isn't signed. What `work` gave, and what of the budget its
/// writes took.
pub async fn within_budget<F: std::future::Future>(budget: alloy::primitives::U256, work: F) -> (F::Output, alloy::primitives::U256) {
    let left = std::sync::Arc::new(std::sync::Mutex::new(budget));
    let out = SUB_BUDGET.scope(left.clone(), work).await;
    let rest = *left.lock().unwrap_or_else(|e| e.into_inner());
    (out, budget.saturating_sub(rest))
}

/// Takes a write's signed `most` out of the budget of the task it runs in (`within_budget`), if it runs in one: an
/// error when it doesn't fit, and the write isn't signed.
pub fn take_sub_budget(most: alloy::primitives::U256) -> Result<(), String> {
    SUB_BUDGET
        .try_with(|left| {
            let mut left = left.lock().unwrap_or_else(|e| e.into_inner());
            if most > *left {
                return Err(format!("this write could cost up to {}, more than the {} left of the budget it is held to", crate::chain::gas_f(most), crate::chain::gas_f(*left)));
            }
            *left -= most;
            Ok(())
        })
        .unwrap_or(Ok(()))
}

/// Whether the chain the node runs on answers on this machine (an Anvil on loopback, the node's devnet, or a node of
/// the owner's own): its RPC is the owner's, not a stranger's on the network.
pub fn chain_is_here() -> bool {
    let url = crate::chain::url();
    url.host_str().is_some_and(|h| h == "localhost" || h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()))
}

/// What a write is, for where it may be signed (`write_gate`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signs {
    /// A write that does no harm made again, or that its contract caps (a claim, a fee, a root, a grant, a withdrawal,
    /// an allowance): on a chain reached over the network it may go with one RPC, its outcome proven against the chain
    /// followed through that RPC, as no weaker than before the node proved anything.
    Ordinary,
    /// A write that must not go twice (`inflight`: a deposit, a stake, a bounty post, a registration, a USDC send):
    /// whether it landed decides whether it is signed again, so it goes only where more than one RPC's word stands
    /// behind the blocks.
    Once,
}

/// What is held back while a chain reached over the network has no second RPC named, as the owner is told it.
pub const HELD_BACK: &str = "With only one RPC on a chain reached over the network, the node holds back every write that must not go twice (deposits, stakes, bounty posts, its registration and USDC sends) and gives back no gas it set aside for a write; other writes go on, each checked against that one RPC, but nothing they settle is taken as settled on its word: lines claimed stay owed and are claimed again (shown in the activity log as unwitnessed), and allowance resets and revokes stay owed until a second RPC confirms them. Name a second, independent RPC of the same chain, run by another operator (check_rpc in Settings), to let them through.";

/// Where the node stands on a second RPC, for the owner to see (health, chain status): "not needed" on a chain on
/// this machine, "named", "missing" or "misnamed" on one reached over the network, with what is held back meanwhile.
pub fn second_rpc_state() -> (&'static str, Option<String>) {
    second_rpc_state_of(chain_is_here(), second_url().map(|u| u.is_some()))
}

/// The rule, on plain values: `here` whether the chain is on this machine, `second` whether one is named (or why the
/// one named can't be used).
pub fn second_rpc_state_of(here: bool, second: Result<bool, String>) -> (&'static str, Option<String>) {
    match (here, second) {
        (true, _) => ("not needed", None),
        (false, Ok(true)) => ("named", None),
        (false, Ok(false)) => ("missing", Some(HELD_BACK.to_string())),
        (false, Err(e)) => ("misnamed", Some(e)),
    }
}

/// Whether a write that must not go twice may be signed on this chain now (`may_write` for `Signs::Once`): asked
/// before anything that prepares one (its allowance), so nothing is sent for a write that would then be refused.
pub fn once_allowed() -> Result<(), String> {
    may_write(chain_is_here(), second_url()?.is_some(), Signs::Once)
}

/// The rule for where the node signs, on plain values: a chain on this machine (`here`) is the owner's own; on one
/// reached over the network a write that must not go twice needs a second RPC named (`second`), and an ordinary one
/// doesn't.
pub fn may_write(here: bool, second: bool, signs: Signs) -> Result<(), String> {
    if here || second || signs == Signs::Ordinary {
        return Ok(());
    }
    Err(HELD_BACK.into())
}

/// The rule for when a write is signed, given the chain as just followed (`anchor::advance`): only when it was followed
/// to the chain's finalized head on this very call (`current`); and, with a second RPC named, only when that RPC
/// stood behind the head just now (`witness`). A second RPC behind, or not answering, or a first with no finalized
/// head, and the write waits.
pub fn followed_now(current: bool, second_named: bool, witness: Option<crate::anchor::Witness>) -> Result<(), String> {
    if !current {
        return Err("the node hasn't followed the chain to its finalized head just now (its RPC has none, or the second RPC is behind or not answering), so the write waits".into());
    }
    if second_named && witness != Some(crate::anchor::Witness::Second) {
        return Err("the second RPC didn't stand behind the chain's finalized head just now, so the write waits".into());
    }
    Ok(())
}

/// Whether the node may sign a write now, and the chain it names: writes aren't stopped (`halted`), the RPC is the
/// chain the node runs on (`same_chain`), a write that must not go twice has a second RPC named on a chain reached
/// over the network (`may_write`), a second RPC named is no alias of the first (`independent`), and the chain was
/// followed to its finalized head on this very call (`followed_now`), which also starts a run of checkpoints before any
/// block this write can land in. Every write the node signs passes here (`send_write`, `inflight::send`).
pub async fn write_gate<P: Provider>(p: &P, pinned: Option<u64>, signs: Signs) -> Result<u64, String> {
    if let Some(why) = halted() {
        return Err(why);
    }
    let chain_id = same_chain(p, pinned).await?;
    let here = chain_is_here();
    let second = second_url()?;
    if let Err(why) = may_write(here, second.is_some(), signs) {
        crate::store::tell_once(&crate::chain::dir().join("no-second-rpc"), &why);
        return Err(why);
    }
    if let (false, Some(s)) = (here, &second) {
        independent(&crate::chain::url(), s).await?;
    }
    let followed = crate::anchor::advance(chain_id).await?;
    if let Err(why) = followed_now(followed.current, second.is_some(), followed.witness) {
        crate::store::tell_once(&crate::chain::dir().join("not-followed"), &format!("Writes wait: {why}. They go once it is back."));
        return Err(why);
    }
    Ok(chain_id)
}

/// Whether two host names share a registrable domain (the name a registrant controls, by the public suffix list):
/// two endpoints under one are one operator's. An address, or a name with no public suffix, is compared whole.
pub fn same_registrable(a: &str, b: &str) -> bool {
    let reg = |h: &str| {
        let h = h.trim_end_matches('.').to_ascii_lowercase();
        psl::domain_str(&h).map(str::to_string).unwrap_or(h)
    };
    reg(a) == reg(b)
}

/// Whether two sets of addresses share one.
pub fn shares_address(a: &[std::net::IpAddr], b: &[std::net::IpAddr]) -> bool {
    a.iter().any(|x| b.contains(x))
}

async fn addresses(url: &reqwest::Url) -> Result<Vec<std::net::IpAddr>, String> {
    let host = url.host_str().ok_or_else(|| format!("{url} names no host"))?.trim_matches(['[', ']']).to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let found = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|e| format!("{host} doesn't resolve: {e}"))?;
    Ok(found.map(|a| a.ip()).collect())
}

/// Whether the second RPC the owner named can stand as a second witness to the first: not under the same registrable
/// domain, and resolving to no address the first resolves to (a DNS alias, another port of the same host). Code can't
/// prove two operators independent; it refuses only what is plainly one, and that the rest are independent is the
/// owner's judgement (`check_rpc`). A host that doesn't resolve is refused too. Kept for ten minutes.
pub async fn independent(first: &reqwest::Url, second: &reqwest::Url) -> Result<(), String> {
    use crate::sync::Locked;
    static SEEN: std::sync::Mutex<Option<(String, String, u64, Result<(), String>)>> = std::sync::Mutex::new(None);
    let (a, b, now) = (first.to_string(), second.to_string(), crate::store::now());
    if let Some((x, y, at, r)) = SEEN.locked().clone() {
        if x == a && y == b && now.saturating_sub(at) < 600 {
            return r;
        }
    }
    let r = async {
        let (fh, sh) = (first.host_str().unwrap_or_default(), second.host_str().unwrap_or_default());
        if same_registrable(fh, sh) {
            return Err(format!("the second RPC ({sh}) is under the same domain as the first ({fh}): two endpoints of one operator are one witness, so no write goes out until another operator's is named"));
        }
        if shares_address(&addresses(first).await?, &addresses(second).await?) {
            return Err(format!("the second RPC ({sh}) resolves to an address the first ({fh}) resolves to: one server under two names is one witness, so no write goes out until another operator's is named"));
        }
        Ok(())
    }
    .await;
    *SEEN.locked() = Some((a, b, now, r.clone()));
    r
}

/// Why the node stopped writing, once an RPC's answers contradicted themselves or the owner's second RPC: from then on
/// no write is signed until the node starts again and the owner has looked.
static HALTED: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Stops every write, saying why, and tells the owner once.
pub fn halt(why: &str) {
    use crate::sync::Shared;
    let mut h = HALTED.writing();
    if h.is_none() {
        let said = format!("The node stopped writing to the chain: {why}. Its RPC's answers can't be trusted; check the RPC (and the second one, if you named one), then restart the node.");
        crate::store::tell_once(&crate::chain::dir().join("halted"), &said);
        *h = Some(said);
    }
}

/// Lets writes go again, for a test that stopped them.
#[cfg(test)]
pub fn unhalt() {
    use crate::sync::Shared;
    *HALTED.writing() = None;
}

/// Why writes are stopped, if they are.
pub fn halted() -> Option<String> {
    use crate::sync::Shared;
    HALTED.reading().clone()
}

/// The URL of the second RPC the owner named to check the first against (`check_rpc`), if any. A value that isn't an
/// http(s) URL, or names the node's own RPC, is an error, never taken as no second RPC: a second check the owner
/// asked for is never quietly dropped. With none named, a node reading through Unbrowse's gateway checks against the
/// network's public RPC (`gateways_second`).
pub fn second_url() -> Result<Option<reqwest::Url>, String> {
    let Some(named) = crate::store::load_settings().check_rpc.filter(|v| !v.trim().is_empty()) else { return Ok(gateways_second()) };
    let url: reqwest::Url = named.trim().parse().map_err(|e| format!("the second RPC named in check_rpc, {named:?}, isn't a URL ({e}): no write goes out until it is one"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("the second RPC named in check_rpc, {named:?}, isn't http or https: no write goes out until it is"));
    }
    let own = crate::chain::url();
    if url.host_str() == own.host_str() && url.port_or_known_default() == own.port_or_known_default() {
        return Err(format!("the second RPC named in check_rpc, {named:?}, is the node's own RPC: name another endpoint, or no write goes out"));
    }
    Ok(Some(url))
}

/// The second RPC a node reading through Unbrowse's gateway has when its owner names none: the network's public RPC,
/// run by the network's operator, not the gateway's (`gateway`). Any other node has none until its owner names one.
fn gateways_second() -> Option<reqwest::Url> {
    let live = crate::chain::live()?;
    crate::gateway::is_gateway(live.rpc.as_str()).then(|| live.net.rpc.parse().ok()).flatten()
}

/// The second RPC the owner named, as a provider (`second_url`).
pub fn second() -> Result<Option<impl Provider + Clone>, String> {
    Ok(second_url()?.map(|url| ProviderBuilder::new().connect_http(url)))
}

/// Whether the second RPC, when the owner named one, has block `number` at `hash`: one that has another is a
/// contradiction, and stops every write (`halt`); one that hasn't reached it yet is an error that says so, and the
/// caller waits.
pub async fn second_agrees_on_block(number: u64, hash: alloy::primitives::B256) -> Result<(), String> {
    let Some(url) = second_url()? else { return Ok(()) };
    let theirs = match crate::proof::fetch(&url, "eth_getBlockByNumber", serde_json::json!([format!("{number:#x}"), false]), crate::proof::MAX_HEADER_BYTES).await {
        Ok(crate::proof::Answer::Value(v)) => v.get("hash").and_then(|h| h.as_str()).and_then(|h| h.parse::<alloy::primitives::B256>().ok()),
        Ok(crate::proof::Answer::Null) => return Err(format!("the second RPC hasn't reached block {number} yet")),
        Ok(crate::proof::Answer::Refused(e)) | Err(e) => return Err(format!("the second RPC didn't answer: {e}")),
    };
    match theirs {
        Some(h) if h == hash => Ok(()),
        other => {
            let why = format!("the second RPC has block {number} at {other:?}, the first at {hash:#x}");
            halt(&why);
            Err(why)
        }
    }
}

/// The second RPC's own finalized block number, as it says it (R9-CHAIN-1): what `anchor::advance` holds the first's
/// head to.
pub async fn second_finalized() -> Result<u64, String> {
    let Some(url) = second_url()? else { return Err("no second RPC is named".into()) };
    match crate::proof::fetch(&url, "eth_getBlockByNumber", serde_json::json!(["finalized", false]), crate::proof::MAX_HEADER_BYTES).await {
        Ok(crate::proof::Answer::Value(v)) => v.get("number").and_then(|n| n.as_str()).and_then(|n| u64::from_str_radix(n.trim_start_matches("0x"), 16).ok()).ok_or_else(|| "the second RPC's finalized block names no number".to_string()),
        Ok(crate::proof::Answer::Null) => Err("the second RPC has no finalized block".into()),
        Ok(crate::proof::Answer::Refused(e)) | Err(e) => Err(format!("the second RPC didn't answer: {e}")),
    }
}

/// The finalized height to judge an expiry by right now, in one call (R11-CHAIN-1): the second RPC's own finalized
/// block when one is named, else the node's RPC's, on its word; `None` on a chain on this machine, whose head the node
/// followed itself. Only ever used to refuse: a release reads it again just before it reserves and serves.
pub async fn finalized_now() -> Result<Option<u64>, String> {
    if second_url()?.is_some() {
        return second_finalized().await.map(Some);
    }
    if chain_is_here() {
        return Ok(None);
    }
    match crate::proof::fetch(&crate::chain::url(), "eth_getBlockByNumber", serde_json::json!(["finalized", false]), crate::proof::MAX_HEADER_BYTES).await? {
        crate::proof::Answer::Value(v) => Ok(v.get("number").and_then(|n| n.as_str()).and_then(|n| u64::from_str_radix(n.trim_start_matches("0x"), 16).ok())),
        _ => Err("the RPC has no finalized block".into()),
    }
}

/// The head one operation reads at (R9-CHAIN-1): the chain's finalized head as the node followed and anchored it on
/// this very call (`anchor::advance`), never a block number the first RPC names on its own, with who stood behind it
/// then and the second RPC's own finalized head. Followed once per operation (a release, a claim pass) and passed
/// down, so every witnessed reading of that operation is made at that one head: one `anchor::advance`, not one a read.
#[derive(Clone, Copy, Debug, Default)]
pub struct Head {
    /// The block followed and who stood behind it; `None` when the node couldn't follow the chain to its head just now.
    pub followed: Option<(u64, crate::anchor::Witness)>,
    /// The second RPC's own finalized block, when it gave one (`anchor::Followed::second_head`).
    pub second_at: Option<u64>,
    /// When it was followed: a head is good for `HEAD_LIFE` only (R11-CHAIN-1).
    pub taken: Option<std::time::Instant>,
}

/// How long a followed head is read at (R11-CHAIN-1): a few seconds, well under an RPC request's own timeout
/// (`REQUEST_TIMEOUT`), so a reply stalled across an epoch boundary can't have a stale head judge what it brings. A
/// read at a head older than this is no witnessed read; a long pass follows a new one (`Head::renew`).
pub const HEAD_LIFE: Duration = Duration::from_secs(5);

impl Head {
    /// Follows the chain to its finalized head now. An error only when writes are stopped, or the RPCs contradict.
    pub async fn follow<P: Provider>(p: &P) -> Result<Head, String> {
        if let Some(why) = halted() {
            return Err(why);
        }
        // Held to the chain the node runs on (`signing_chain`: the live network's from the build's table, or the
        // devnet's as proved), as a write is. No chain named would refuse every head on a live network (`agrees`).
        let chain_id = same_chain(p, signing_chain()).await?;
        let followed = crate::anchor::advance(chain_id).await?;
        if !followed.current {
            return Ok(Head { taken: Some(std::time::Instant::now()), ..Head::default() });
        }
        let at = followed.anchored.head().zip(followed.witness).map(|((n, _), w)| (n, w));
        Ok(Head { followed: at, second_at: followed.second_head, taken: Some(std::time::Instant::now()) })
    }

    /// Whether the head is still within its `HEAD_LIFE`.
    pub fn live(&self) -> bool {
        self.taken.is_some_and(|t| t.elapsed() < HEAD_LIFE)
    }

    /// Follows the head again once it is past its `HEAD_LIFE`, for a pass that reads at it for longer.
    pub async fn renew<P: Provider>(&mut self, p: &P) -> Result<(), String> {
        if !self.live() {
            *self = Head::follow(p).await?;
        }
        Ok(())
    }

    /// The block a witnessed reading is made at: the head, when more than the one RPC's word stands behind it (a
    /// chain on this machine, or the second RPC standing behind it as its own head), and it is still live.
    pub fn witnessed_at(&self) -> Option<(u64, crate::anchor::Witness)> {
        self.followed.filter(|(_, w)| w.agrees() && self.live())
    }

    /// The more advanced of the two finalized heads, for what staleness would help an attacker with: an expiry, a
    /// window closing (R10-CHAIN-1). Only for a witnessed head, where the second's is within `anchor::HEAD_SKEW` of it.
    /// The rule: where a stale head would help an attacker (an epoch that lets an old voucher in, a window not yet
    /// closed), the more advanced of the two witnessed heads is taken; where being behind is the conservative side
    /// (room under a cap, a deposit), the smaller reading is.
    pub fn latest(&self) -> Option<u64> {
        let (at, _) = self.witnessed_at()?;
        Some(self.second_at.map_or(at, |s| s.max(at)))
    }

    /// The block a reading that must agree is made at: with a second RPC named, only a head it stood behind as its
    /// own on this operation's call; an error when there is none.
    fn agreed_at(&self) -> Result<u64, String> {
        if !self.live() {
            return Err("the head this read was to be made at is older than a head is kept, so it waits for a new one".into());
        }
        let named = second_url()?.is_some();
        match self.followed {
            Some((at, w)) if !named || w == crate::anchor::Witness::Second => Ok(at),
            _ => Err("the node can't follow the chain to a finalized head its second RPC stands behind just now".into()),
        }
    }

    /// What the read `data` of `to` gives at this head, when a witness stands behind it: the second's reading of the
    /// same block must agree (a different answer stops every write, and is an error). `None` with no witness: only the
    /// one RPC, a second behind or ahead, or one that doesn't answer for the block.
    pub async fn read<P: Provider>(&self, p: &P, to: Address, data: alloy::primitives::Bytes) -> Result<Option<alloy::primitives::Bytes>, String> {
        let Some((at, w)) = self.witnessed_at() else { return Ok(None) };
        let req = alloy::rpc::types::TransactionRequest::default().to(to).input(data.into());
        let Ok(ours) = p.call(req.clone()).block(at.into()).await else { return Ok(None) };
        if w == crate::anchor::Witness::Second {
            let Some(q) = second()? else { return Ok(None) };
            let Ok(theirs) = q.call(req).block(at.into()).await else { return Ok(None) };
            second_agrees(&format!("a read of {to:#x}"), at, &ours, &theirs)?;
        }
        Ok(Some(ours))
    }

    /// `read` for a typed call.
    pub async fn call<P: Provider, C: alloy::sol_types::SolCall>(&self, p: &P, to: Address, call: &C) -> Result<Option<C::Return>, String> {
        let Some(got) = self.read(p, to, call.abi_encode().into()).await? else { return Ok(None) };
        C::abi_decode_returns(&got).map(Some).map_err(|e| e.to_string())
    }

    /// What the read `data` of `to` gives at this head, checked against the second RPC's reading of the same block
    /// when one is named: with one RPC, that RPC's reading at the head the node followed.
    pub async fn read_agreed<P: Provider>(&self, p: &P, to: Address, data: alloy::primitives::Bytes) -> Result<alloy::primitives::Bytes, String> {
        let at = self.agreed_at()?;
        let req = alloy::rpc::types::TransactionRequest::default().to(to).input(data.into());
        let ours = p.call(req.clone()).block(at.into()).await.map_err(|e| e.to_string())?;
        if let Some(q) = second()? {
            let theirs = q.call(req).block(at.into()).await.map_err(|e| format!("the second RPC didn't answer: {e}"))?;
            second_agrees(&format!("a read of {to:#x}"), at, &ours, &theirs)?;
        }
        Ok(ours)
    }

    /// `read_agreed` for a typed call.
    pub async fn call_agreed<P: Provider, C: alloy::sol_types::SolCall>(&self, p: &P, to: Address, call: &C) -> Result<C::Return, String> {
        let got = self.read_agreed(p, to, call.abi_encode().into()).await?;
        C::abi_decode_returns(&got).map_err(|e| e.to_string())
    }
}

/// What the second, when the owner named one, says the balance of `who` is at the head the node just followed with it:
/// the two must agree, or every write stops (`second_agrees`). Nothing to check with no second RPC.
pub async fn second_agrees_on_balance<P: Provider>(p: &P, who: Address) -> Result<(), String> {
    let Some(q) = second()? else { return Ok(()) };
    let at = Head::follow(p).await?.agreed_at()?;
    let ours = p.get_balance(who).number(at).await.map_err(|e| e.to_string())?;
    let theirs = q.get_balance(who).number(at).await.map_err(|e| format!("the second RPC didn't answer: {e}"))?;
    second_agrees(&format!("the balance of {who:#x}"), at, &ours, &theirs)
}

/// `Head::read_agreed` at a head followed for this one read.
pub async fn read_agreed<P: Provider>(p: &P, to: Address, data: alloy::primitives::Bytes) -> Result<alloy::primitives::Bytes, String> {
    Head::follow(p).await?.read_agreed(p, to, data).await
}

/// `Head::read` at a head followed for this one read: `None` when no witness stands behind a head now. Whether a
/// reading is witnessed is this result, never configuration. An operation making several readings follows one `Head`
/// and reads at it instead.
pub async fn read_witnessed<P: Provider>(p: &P, to: Address, data: alloy::primitives::Bytes) -> Result<Option<alloy::primitives::Bytes>, String> {
    match Head::follow(p).await {
        Ok(head) => head.read(p, to, data).await,
        Err(e) if halted().is_some() => Err(e),
        Err(_) => Ok(None),
    }
}

/// `read_witnessed` for a typed call: every durable record the node clears, prunes or finalizes on a reading of the
/// chain takes it from here or from a `Head` of its operation (R5-CHAIN-1, R6-CHAIN-2, R7-CHAIN-2, R9-CHAIN-1). Its
/// callers went with the fraud court's cases; it is kept, with its tests, for the next record that needs it.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn call_witnessed<P: Provider, C: alloy::sol_types::SolCall>(p: &P, to: Address, call: &C) -> Result<Option<C::Return>, String> {
    let Some(got) = read_witnessed(p, to, call.abi_encode().into()).await? else { return Ok(None) };
    C::abi_decode_returns(&got).map(Some).map_err(|e| e.to_string())
}

/// `Head::call_agreed` at a head followed for this one read.
pub async fn call_agreed<P: Provider, C: alloy::sol_types::SolCall>(p: &P, to: Address, call: &C) -> Result<C::Return, String> {
    Head::follow(p).await?.call_agreed(p, to, call).await
}

/// Whether the second RPC, when the owner named one, says what the first said of `what` at final block `at`: `ours`,
/// and `theirs` the second's reading. A different answer stops every write (`halt`).
pub fn second_agrees<T: PartialEq + std::fmt::Debug>(what: &str, at: u64, ours: &T, theirs: &T) -> Result<(), String> {
    if ours == theirs {
        return Ok(());
    }
    let why = format!("the second RPC says {what} at block {at} is {theirs:?}, the first {ours:?}");
    halt(&why);
    Err(why)
}

/// Sends `calls` (each a contract and its calldata, with no value) as one write through Arc's Multicall3From where the
/// chain runs it, else one at a time, each through `mined!`. Their receipts once their blocks are final (`finalized`),
/// or the error, prefixed with `what`.
pub async fn batch<P>(p: &P, calls: Vec<(Address, alloy::primitives::Bytes)>, what: &str) -> Result<Vec<TransactionReceipt>, String>
where
    P: Provider + WalletProvider<Wallet = NodeWallet> + Clone,
{
    if calls.is_empty() {
        return Ok(Vec::new());
    }
    let me = p.default_signer_address();
    // As one transaction where the chain runs it, through Arc's Multicall3From; else one write a call.
    if calls.len() > 1 {
        if let Some((to, data)) = one_transaction(p, me, &calls).await.map_err(|e| format!("{what}: {e}"))? {
            let call = alloy::contract::CallBuilder::new_raw(p, data).to(to);
            return Ok(vec![mined!(call, what)]);
        }
    }
    let mut out = Vec::new();
    for (to, data) in calls {
        let call = alloy::contract::CallBuilder::new_raw(p, data).to(to);
        out.push(mined!(call, what));
    }
    Ok(out)
}

/// How the key `me` sends `calls` as one transaction of its own, as `(to, data)`, if its chain can: Arc's
/// Multicall3From, where it is deployed and the batch runs as a call from the key (Arc's networks; not a plain devnet,
/// nor a devnet that forks Arc and so lacks its precompile), whose `aggregate3` runs each call with the key as sender
/// through Arc's CallFrom precompile; no call may fail. It takes calls from a key with no code only.
///
/// `None` when it can't: the calls then go one write each. Either way each call's sender is the key, so what a contract
/// records for it is the same. A read that didn't get an answer is an error, not a chain that can't: a batch sent as
/// separate writes on a moment's RPC failure could stop halfway, where one transaction is all or nothing.
async fn one_transaction<P: Provider>(p: &P, me: Address, calls: &[(Address, alloy::primitives::Bytes)]) -> Result<Option<(Address, alloy::primitives::Bytes)>, String> {
    let code = |at: Address| async move { p.get_code_at(at).await.map_err(|e| e.to_string()) };
    if !code(me).await?.is_empty() || code(crate::arc::MULTICALL3_FROM).await?.is_empty() {
        return Ok(None);
    }
    // Multicall3From runs through Arc's CallFrom precompile, which a chain that only copied its code (a devnet forking
    // Arc) lacks: the batch is tried as a call first, and one that doesn't run there goes one write a call.
    let data = aggregate3(calls);
    let tx = alloy::rpc::types::TransactionRequest::default().from(me).to(crate::arc::MULTICALL3_FROM).input(data.clone().into());
    match p.call(tx).await {
        Ok(_) => Ok(Some((crate::arc::MULTICALL3_FROM, data))),
        // The chain's own answer: the batch doesn't run here.
        Err(e) if e.as_error_resp().is_some() => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

alloy::sol! {
    /// Arc's Multicall3From: Multicall3's `aggregate3`, each call made as the transaction's sender.
    interface Multicall3From {
        struct Call3 {
            address target;
            bool allowFailure;
            bytes callData;
        }
        struct Result {
            bool success;
            bytes returnData;
        }
        function aggregate3(Call3[] calldata calls) external returns (Result[] memory);
    }
}

/// `aggregate3` of `calls`, none of which may fail: one that reverts reverts them all.
pub fn aggregate3(calls: &[(Address, alloy::primitives::Bytes)]) -> alloy::primitives::Bytes {
    use alloy::sol_types::SolCall;
    let calls = calls.iter().map(|(target, data)| Multicall3From::Call3 { target: *target, allowFailure: false, callData: data.clone() }).collect();
    Multicall3From::aggregate3Call { calls }.abi_encode().into()
}

/// Waits for the node's turn to write (`WRITING`), as `mined!` does before every write.
pub async fn write_turn() -> tokio::sync::MutexGuard<'static, ()> {
    match WRITING.try_lock() {
        Ok(g) => g,
        Err(_) => {
            // Another write is in flight: this one waits its turn, the case the lock exists for.
            sut_reachable!("an owner-key write waited for another to be mined");
            WRITING.lock().await
        }
    }
}

/// Waits, at most `FINALITY_TIMEOUT`, for the block a mined write is in to be final, and gives the write's receipt as
/// that final block has it: its status there is the one that counts. A block is final once the chain's `finalized`
/// block has reached its height and it is still the block at that height.
///
/// A reorg before then may move the write into another block, which is then waited on in turn, or drop it. It is
/// dropped once the block at its height is final and isn't the one it was mined in, and the chain neither has a
/// receipt for it nor holds it to be mined: an error, so whatever follows the write (a claim mark, a hold's record) is
/// never written, and the write is made again by whatever made it, on its next pass or when its owner asks again. An
/// RPC that is only behind can't look like that: it has no final block at that height to differ.
pub async fn finalized<P: Provider>(p: &P, mined: TransactionReceipt) -> Result<TransactionReceipt, String> {
    let tx = mined.transaction_hash;
    let at = mined.block_number.ok_or("the receipt names no block")?;
    let t = std::time::Instant::now();
    loop {
        let head = p.get_block_by_number(BlockNumberOrTag::Finalized).await.map_err(|e| format!("reading the chain's finalized block: {e}"))?;
        let head = head.ok_or("the chain's RPC doesn't say which of its blocks are final")?.header;
        let (last, last_hash) = (head.number, head.hash);
        // The hash of the block the chain has at height `n` now.
        let canonical = move |n: u64| async move {
            if n == last {
                return Ok::<_, String>(Some(last_hash));
            }
            p.get_block_by_number(n.into()).await.map(|b| b.map(|b| b.header.hash)).map_err(|e| e.to_string())
        };
        let now = p.get_transaction_receipt(tx).await.map_err(|e| e.to_string())?;
        match now.as_ref().and_then(|r| Some((r.block_number?, r.block_hash?))) {
            Some((n, hash)) if n <= last && canonical(n).await? == Some(hash) => {
                if n != at {
                    eprintln!("chain: a reorg moved {tx:#x} from block {at} to block {n}, which is final");
                }
                return Ok(now.expect("matched above"));
            }
            Some(_) => {}
            None if at <= last && canonical(at).await? != mined.block_hash && p.get_transaction_by_hash(tx).await.map_err(|e| e.to_string())?.is_none() => {
                return Err(format!("it was mined in block {at}, but a reorg dropped that block and the write with it ({tx:#x})"));
            }
            None => {}
        }
        if t.elapsed() >= FINALITY_TIMEOUT {
            return Err(format!(
                "it was mined in block {at} ({tx:#x}) but isn't final after {}s: the chain's finalized block is {}. It may still count; look before sending it again",
                FINALITY_TIMEOUT.as_secs(),
                last
            ));
        }
        tokio::time::sleep(FINALITY_POLL).await;
    }
}

/// The error of a write the chain didn't take, prefixed with what the write was.
pub fn not_sent(what: &str, said: String) -> String {
    // One write is in flight at a time, but the nonce is the RPC's word, and a load-balanced RPC can answer from a node
    // behind the one that took the last write. The write isn't sent, and whoever made it makes it again next pass.
    if crate::inflight::holds_nonce(&said) {
        sut_reachable!("an owner-key write was refused for its nonce", &serde_json::json!({ "what": what, "error": said }));
    }
    format!("{what}: {said}")
}

/// The error of a write that left the node and may still land: past `RECEIPT_TIMEOUT`, or mined and not final.
pub fn unsettled_error(what: &str, said: impl std::fmt::Display) -> String {
    format!("{what}: {UNSETTLED} ({said})")
}

/// Whether `error` is that of a write that may still land (`unsettled_error`), not one the chain refused.
pub fn unsettled(error: &str) -> bool {
    error.contains(UNSETTLED)
}

/// Whether the signer's writes are stuck: `since` is the mined count and when it was first seen there with `pending`
/// above it, `now` the time. A chain that is only taking a block's time moves `mined` on, and `since` with it. What to
/// remember for the next look, and whether to act on this one.
pub fn stuck(since: Option<(u64, u64)>, mined: u64, pending: u64, now: u64) -> (Option<(u64, u64)>, bool) {
    if pending <= mined {
        return (None, false);
    }
    match since {
        Some((n, at)) if n == mined => (since, now.saturating_sub(at) >= STUCK_AFTER),
        _ => (Some((mined, now)), false),
    }
}

/// Clears the way when a write sits unmined and holds back every write after it: the chain mines a signer's writes in
/// nonce order, so one priced under the chain's fee stops them all, each timing out in turn. A no-op to the signer itself
/// at that nonce, at twice the fee now, takes its place. Whatever it replaced comes to nothing, which is safe: every
/// other write is made again by whoever made it, and a kept one reads as gone once the no-op's receipt is proven
/// (`inflight::settle`) and is sent again.
///
/// A kept write whose nonce nothing has taken (its bytes turned away, and still turned away `STUCK_AFTER` on) is taken
/// the same way: the node's own no-op at its nonce, whose proven receipt is what lets the kept write go, rather than an
/// RPC's word that the bytes were refused.
pub async fn unstick<P>(p: &P) -> Result<Option<String>, String>
where
    P: Provider + WalletProvider<Wallet = NodeWallet> + Clone,
{
    use crate::sync::Locked;
    static BEHIND: std::sync::Mutex<Option<(u64, u64)>> = std::sync::Mutex::new(None);
    let me = p.default_signer_address();
    let mined = p.get_transaction_count(me).latest().await.map_err(|e| e.to_string())?;
    let pending = p.get_transaction_count(me).pending().await.map_err(|e| e.to_string())?;
    let act = {
        let mut behind = BEHIND.locked();
        let (next, act) = stuck(*behind, mined, pending, crate::store::now());
        *behind = next;
        act
    };
    if act {
        return replace(p, mined).await.map(Some);
    }
    // A kept write at the next nonce that the chain still hasn't got: the node's own no-op takes the nonce.
    let kept = crate::inflight::all()?;
    let waiting = kept.iter().find(|s| s.signer == me && s.nonce == mined && crate::store::now().saturating_sub(s.at) >= STUCK_AFTER);
    if let Some(s) = waiting {
        if p.get_transaction_receipt(s.tx).await.map_err(|e| e.to_string())?.is_none() && pending <= mined {
            return replace(p, mined).await.map(Some);
        }
    }
    Ok(None)
}

/// Takes the place of the write at `nonce` with the no-op `unstick` sends.
pub async fn replace<P>(p: &P, nonce: u64) -> Result<String, String>
where
    P: Provider + WalletProvider<Wallet = NodeWallet> + Clone,
{
    // Twice what the chain asks now, to outbid the write it replaces, and never past the owner's cap (`price`).
    let fees = priced(p, NO_OP_GAS).await?;
    let cap = crate::store::load_settings().max_gas_price_wei();
    let max_fee = fees.max_fee.saturating_mul(2).min(cap);
    let call = alloy::contract::CallBuilder::new_raw(p, alloy::primitives::Bytes::new())
        .to(p.default_signer_address())
        .nonce(nonce)
        .gas(NO_OP_GAS)
        .max_fee_per_gas(max_fee)
        .max_priority_fee_per_gas(fees.tip.saturating_mul(2).min(max_fee));
    let receipt = mined!(call, "clearing a stuck write");
    Ok(format!("{:#x}", receipt.transaction_hash))
}

/// The gas a no-op transfer to oneself takes.
pub const NO_OP_GAS: u64 = 21_000;

/// The most gas one write may take: a deploy's largest contract, with room. A write an RPC says needs more is refused.
pub const MAX_WRITE_GAS: u64 = 16_000_000;

/// Gas a write is given over its estimate. An RPC estimates a write against the head, and the write is mined in a later
/// block, where what it stores can cost more: a record kept once a block (a checkpoint keyed by the block number) that
/// the estimate found already written this block takes a fresh slot in the next, 22,100 gas for a zero-to-nonzero
/// store against 2,900 to change one. This covers one such slot, with room; what a write doesn't use isn't paid.
pub const NEXT_BLOCK_GAS: u64 = 25_000;

/// The chain ID every transaction and every typed signature the node makes names: the live network it runs on, or
/// the devnet it started and proved its own (`chain::Chain::start`). `None` only before any chain has started.
pub fn signing_chain() -> Option<u64> {
    crate::chain::signing_chain_id()
}

/// Whether the RPC answers as the chain the node runs on: a write goes out only while it does. An RPC that says it is
/// another chain is one whose answers (nonces, fees, receipts) are for that chain, and a write signed through it would
/// be a write there.
/// `pinned` is the chain the signing wallet names (`NodeWallet::chain`): the node's own on its own chain's RPC.
pub async fn same_chain<P: Provider>(p: &P, pinned: Option<u64>) -> Result<u64, String> {
    let said = p.get_chain_id().await.map_err(|e| format!("asking the RPC which chain it is: {e}"))?;
    if let (Some(s), Some(want)) = (second()?, pinned) {
        let theirs = s.get_chain_id().await.map_err(|e| format!("asking the second RPC which chain it is: {e}"))?;
        if theirs != want {
            let why = format!("the second RPC says it is chain {theirs}, not {want}");
            halt(&why);
            return Err(why);
        }
    }
    // On a live network a write signs only through the network's own RPC, where the wallet names its chain.
    agrees(pinned, crate::chain::live().is_some(), said)
}

/// The rule, with the answers as plain values: `want` the chain the node runs on, `live` whether it is a live network.
pub fn agrees(want: Option<u64>, live: bool, said: u64) -> Result<u64, String> {
    match want {
        Some(w) if w == said => Ok(w),
        Some(w) => Err(format!("the chain's RPC says it is chain {said}, but this node runs on chain {w}: no write goes out until they agree")),
        None if live => Err("this node hasn't settled which chain it runs on, so no write goes out".into()),
        None => Ok(said),
    }
}

/// A write's gas and fee, as the node signs them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Priced {
    pub gas: u64,
    pub max_fee: u128,
    pub tip: u128,
}

impl Priced {
    /// The most the write can cost, in the chain's native units: every unit of gas at the most it pays a unit.
    pub fn most(&self) -> alloy::primitives::U256 {
        alloy::primitives::U256::from(self.gas) * alloy::primitives::U256::from(self.max_fee)
    }
}

/// A write's gas and fee from the chain's base fee now and the tip suggested, held to the owner's cap on a unit of gas
/// (`cap`) and to `MAX_WRITE_GAS`: twice the base fee plus the tip, as alloy's estimate is, but never past the cap, and
/// a tip of no more than the cap leaves above the base fee. A base fee above the cap, or more gas than a write may take,
/// is refused: whatever an RPC says, the most a write costs is `MAX_WRITE_GAS` at the cap.
pub fn price(base_fee: u128, suggested_tip: u128, gas: u64, cap: u128) -> Result<Priced, String> {
    if gas > MAX_WRITE_GAS {
        return Err(format!("the chain says this write takes {gas} gas, more than any write the node sends ({MAX_WRITE_GAS}), so it isn't sent"));
    }
    if base_fee > cap {
        return Err(format!(
            "the chain's base fee is {} gwei, above the most you let the node pay a unit of gas ({} gwei, max_gas_price_gwei), so it isn't sent",
            base_fee / 1_000_000_000,
            cap / 1_000_000_000
        ));
    }
    let tip = suggested_tip.min(cap - base_fee);
    let max_fee = base_fee.saturating_mul(2).saturating_add(tip).min(cap);
    Ok(Priced { gas, max_fee, tip })
}

/// A fee the node set on a write itself, held to the owner's cap and to `MAX_WRITE_GAS` as `price` holds its own.
pub fn held_to_cap(gas: u64, fee: u128, tip: u128, cap: u128) -> Result<Priced, String> {
    if gas > MAX_WRITE_GAS {
        return Err(format!("this write takes {gas} gas, more than any write the node sends ({MAX_WRITE_GAS}), so it isn't sent"));
    }
    let max_fee = fee.min(cap);
    Ok(Priced { gas, max_fee, tip: tip.min(max_fee) })
}

/// The base fee and tip a write is priced at, from what the node's RPC says (`first`) and, when the owner named one,
/// what the second RPC says: the lower of each. The tip is paid to the chain whatever the block's base fee turns out
/// to be, so an RPC that says the base fee is low and suggests a large tip would have every write pay up to the owner's
/// cap; with a second RPC named, one RPC alone never raises what a write pays. With none, it is the one RPC's word,
/// held to the cap (`price`).
pub fn agreed_fee(first: (u128, u128), second: Option<(u128, u128)>) -> (u128, u128) {
    match second {
        Some((base, tip)) => (first.0.min(base), first.1.min(tip)),
        None => first,
    }
}

/// The base fee of the latest block `p` has, and the tip it suggests.
async fn fee_said<P: Provider>(p: &P) -> Result<(u128, u128), String> {
    let head = p.get_block_by_number(BlockNumberOrTag::Latest).await.map_err(|e| format!("reading the chain's head: {e}"))?;
    let base = head.and_then(|b| b.header.base_fee_per_gas).map(u128::from).unwrap_or(0);
    let tip = p.get_max_priority_fee_per_gas().await.unwrap_or(0);
    Ok((base, tip))
}

/// `price` for a write of `gas` on the chain `p` reaches now: the base fee of its latest block and the tip it suggests,
/// no higher than the second RPC says when one is named (`agreed_fee`), held to the owner's cap.
pub async fn priced<P: Provider>(p: &P, gas: u64) -> Result<Priced, String> {
    let first = fee_said(p).await?;
    let second = match second()? {
        Some(s) => Some(fee_said(&s).await.map_err(|e| format!("the second RPC: {e}"))?),
        None => None,
    };
    let (base, tip) = agreed_fee(first, second);
    price(base, tip, gas, crate::store::load_settings().max_gas_price_wei())
}

/// What the node's key spent on network fees on `day` (days since the epoch, by this machine's clock), in the chain's
/// native units.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct GasSpent {
    pub day: u64,
    pub spent: alloy::primitives::U256,
}

static GAS_LEDGER: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gas_spent_path() -> std::path::PathBuf {
    crate::chain::dir().join("gas-spent.json")
}

/// Whether a write that could cost `most` fits the day's budget, given what was `spent` today: the budget in native
/// units. Exactly at the budget fits.
pub fn fits_budget(spent: alloy::primitives::U256, most: alloy::primitives::U256, budget: alloy::primitives::U256) -> bool {
    spent.saturating_add(most) <= budget
}

/// A write's place in the day's gas budget: taken at its most before it is signed, and brought to what it really cost
/// once its receipt is in (`settle`). Only a live network counts: the devnet's gas is the devnet's own.
pub struct Spend {
    most: alloy::primitives::U256,
    counted: bool,
}

/// Takes `most` out of `day`'s count in the ledger at `file`, if it fits `budget`, holding the ledger's lock across
/// processes from the read to the write (`store::hold_file`): two processes can't both read the same count and each
/// write back their own. Refused for the budget, the count spent so far; for anything else (the lock, the file), why.
pub fn reserve_in(file: &std::path::Path, day: u64, most: alloy::primitives::U256, budget: alloy::primitives::U256) -> Result<(), Result<alloy::primitives::U256, String>> {
    let _file = crate::store::hold_money_file(file, crate::store::MONEY_LOCK_WAIT).map_err(Err)?;
    let mut kept: GasSpent = crate::store::read_json_strict(file, &unbrowse_files::GAS_SPENT).map_err(Err)?;
    if kept.day != day {
        kept = GasSpent { day, spent: alloy::primitives::U256::ZERO };
    }
    if !fits_budget(kept.spent, most, budget) {
        return Err(Ok(kept.spent));
    }
    kept.spent = kept.spent.saturating_add(most);
    crate::store::write_json(file, &unbrowse_files::GAS_SPENT, &kept).map_err(Err)
}

impl Spend {
    /// Takes `p`'s most cost out of today's budget, or refuses the write when it doesn't fit.
    pub fn reserve(p: &Priced) -> Result<Spend, String> {
        let most = p.most();
        if crate::chain::live().is_none() {
            return Ok(Spend { most, counted: false });
        }
        let _one = GAS_LEDGER.lock().map_err(|e| e.to_string())?;
        let budget_usdc = crate::store::load_settings().gas_budget();
        reserve_in(&gas_spent_path(), crate::store::now() / 86_400, most, crate::chain::gas_units(budget_usdc)).map_err(|spent| match spent {
            Ok(spent) => format!(
                "the node has spent {} of the {budget_usdc} USDC a day you allow for network fees (gas_budget_usdc_per_day), and this write could cost up to {}: it waits for tomorrow, or a higher budget",
                crate::chain::gas_f(spent),
                crate::chain::gas_f(most)
            ),
            Err(e) => e,
        })?;
        Ok(Spend { most, counted: true })
    }

    /// Gives the write's place back: it never left the node, so it cost nothing.
    pub fn release(self) {
        self.give_back(alloy::primitives::U256::ZERO);
    }

    /// Brings the day's count to what the write cost, once that is proven against its block (`proof::prove_on`): the
    /// gas the block's receipts say it took, at the fee it was signed at. With nothing proven (an RPC's receipt alone,
    /// or a write that may still land), its most stays counted: what an RPC says it cost is never given back on its
    /// word.
    pub fn settle(self, proven: Option<&crate::proof::Proven>) {
        // Given back only on a cost more than the one RPC stands behind (`Proven::agreed`).
        let Some(cost) = proven.filter(|p| p.agreed).and_then(|p| p.cost) else { return };
        self.give_back(cost);
    }

    /// Takes off today's count what was reserved past `cost`.
    fn give_back(self, cost: alloy::primitives::U256) {
        if !self.counted {
            return;
        }
        let Ok(_one) = GAS_LEDGER.lock() else { return };
        // A count that can't be locked keeps the write's most: the budget is never given back unlocked.
        let Ok(_file) = crate::store::hold_money_file(&gas_spent_path(), crate::store::MONEY_LOCK_WAIT) else { return };
        let Ok(mut kept) = crate::store::read_json_strict::<GasSpent>(&gas_spent_path(), &unbrowse_files::GAS_SPENT) else { return };
        if kept.day == crate::store::now() / 86_400 {
            kept.spent = kept.spent.saturating_sub(self.most.saturating_sub(cost));
            let _ = crate::store::write_json(&gas_spent_path(), &unbrowse_files::GAS_SPENT, &kept);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::sync::Locked;

    /// An RPC on loopback that answers each request with the next of `replies` (an HTTP status and a body), and the
    /// number of requests it took.
    pub(crate) async fn scripted_rpc(replies: Vec<(u16, String)>) -> (reqwest::Url, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap()).parse().unwrap();
        let taken = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = taken.clone();
        tokio::spawn(async move {
            let mut replies = replies.into_iter();
            while let Ok((mut conn, _)) = listener.accept().await {
                let Some((status, body)) = replies.next() else { return };
                let mut buf = vec![0u8; 64 * 1024];
                let mut got = Vec::new();
                // The request's headers, then its body by Content-Length.
                loop {
                    let n = conn.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if got.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = conn.write_all(reply.as_bytes()).await;
                let _ = conn.shutdown().await;
            }
        });
        (url, taken)
    }

    /// A signer is stuck only when its mined count stays put with writes above it for `STUCK_AFTER`: a chain that mines
    /// anything at all moves the count on and starts the wait again.
    #[test]
    fn a_signer_is_stuck_only_when_its_mined_count_stays_put() {
        assert_eq!(stuck(None, 5, 5, 100), (None, false), "nothing pending");
        let first = stuck(None, 5, 6, 100);
        assert_eq!(first, (Some((5, 100)), false));
        assert_eq!(stuck(first.0, 5, 6, 100 + STUCK_AFTER - 1), (first.0, false));
        assert_eq!(stuck(first.0, 5, 6, 100 + STUCK_AFTER), (first.0, true));
        assert_eq!(stuck(first.0, 6, 7, 100 + STUCK_AFTER), (Some((6, 100 + STUCK_AFTER)), false), "the chain mined one");
        assert_eq!(stuck(first.0, 6, 6, 100 + STUCK_AFTER), (None, false), "everything went");
    }

    /// Whatever fee an RPC suggests, a write is signed at no more than the owner's cap a unit of gas, and with no more
    /// gas than any write takes: a base fee above the cap, or a gas estimate above the most, sends nothing.
    #[test]
    fn a_write_is_never_signed_above_the_fee_cap() {
        let gwei = 1_000_000_000u128;
        let cap = 500 * gwei;
        let p = price(30 * gwei, u128::MAX / 4, 100_000, cap).unwrap();
        assert!(p.max_fee <= cap && p.tip <= cap - 30 * gwei, "a huge suggested tip is held to the cap: {p:?}");
        assert!(p.max_fee >= 30 * gwei + p.tip, "the fee still pays the base fee and the tip");
        let ordinary = price(30 * gwei, gwei, 100_000, cap).unwrap();
        assert_eq!((ordinary.max_fee, ordinary.tip), (61 * gwei, gwei), "twice the base fee and the tip, under the cap");
        assert!(price(cap + 1, 0, 100_000, cap).is_err(), "a base fee above the cap");
        assert!(price(30 * gwei, 0, MAX_WRITE_GAS + 1, cap).is_err(), "more gas than any write takes");
        assert!(price(30 * gwei, gwei, MAX_WRITE_GAS, cap).unwrap().most() <= alloy::primitives::U256::from(MAX_WRITE_GAS) * alloy::primitives::U256::from(cap));
        // A fee the node set itself (a replacement's) is kept under the cap and held to it above.
        assert_eq!(held_to_cap(21_000, 100 * gwei, 4 * gwei, cap).unwrap(), Priced { gas: 21_000, max_fee: 100 * gwei, tip: 4 * gwei });
        assert_eq!(held_to_cap(21_000, 10 * cap, 10 * cap, cap).unwrap(), Priced { gas: 21_000, max_fee: cap, tip: cap });
        assert!(held_to_cap(MAX_WRITE_GAS + 1, gwei, gwei, cap).is_err());
    }

    /// An RPC that says the base fee is low and suggests a large tip can't set what a write pays when a second RPC is
    /// named: each is priced at the lower of what the two say, so the tip paid is the honest one's. With no second RPC
    /// it is the one RPC's word, held to the owner's cap (`a_write_is_never_signed_above_the_fee_cap`).
    #[test]
    fn one_rpc_alone_never_raises_what_a_write_pays() {
        let gwei = 1_000_000_000u128;
        let cap = 500 * gwei;
        let lying = (gwei, 499 * gwei);
        let honest = (20 * gwei, 5 * gwei);
        let (base, tip) = agreed_fee(lying, Some(honest));
        assert_eq!(tip, 5 * gwei, "the honest RPC's tip");
        let p = price(base, tip, 100_000, cap).unwrap();
        assert!(p.tip <= 5 * gwei && p.max_fee <= 2 * 20 * gwei + 5 * gwei, "{p:?}");
        // Either way round, and a second RPC asking more raises nothing.
        assert_eq!(agreed_fee(honest, Some(lying)), (gwei, 5 * gwei));
        assert_eq!(agreed_fee(honest, Some((40 * gwei, 50 * gwei))), honest);
        assert_eq!(agreed_fee(lying, None), lying, "one RPC: its word, which `price` holds to the cap");
    }

    /// The day's gas count is one count however many processes share the chain's folder: processes reserving at once,
    /// each for more than half the budget, leave exactly one reservation standing, never two.
    #[test]
    fn concurrent_process_reservations_cannot_exceed_daily_gas_budget() {
        let u = alloy::primitives::U256::from;
        if let Ok(file) = std::env::var("UNBROWSE_TEST_GAS_LEDGER") {
            // A child: one reservation of 60 of 100, said by its exit code.
            let start: u64 = std::env::var("UNBROWSE_TEST_GAS_START").unwrap().parse().unwrap();
            while crate::store::now() < start {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::process::exit(if reserve_in(std::path::Path::new(&file), 1, u(60), u(100)).is_ok() { 0 } else { 3 });
        }
        let _home = crate::store::scratch_home("gas-race");
        let file = crate::store::home().join("gas-spent.json");
        let start = crate::store::now() + 2;
        let children: Vec<_> = (0..6)
            .map(|_| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "rpc::tests::concurrent_process_reservations_cannot_exceed_daily_gas_budget", "--test-threads=1", "--nocapture"])
                    .env("UNBROWSE_TEST_GAS_LEDGER", &file)
                    .env("UNBROWSE_TEST_GAS_START", start.to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let reserved = children.into_iter().filter(|_| true).map(|mut c| c.wait().unwrap().code()).filter(|c| *c == Some(0)).count();
        assert_eq!(reserved, 1, "exactly one process's reservation fits");
        let kept: GasSpent = crate::store::read_json_strict(&file, &unbrowse_files::GAS_SPENT).unwrap();
        assert_eq!(kept.spent, u(60), "and the ledger holds it once");
    }

    /// A second RPC the owner names is a second witness of every block a receipt is proven in: one that has another
    /// block at that height stops every write, and one that hasn't reached it yet only makes the caller wait.
    #[tokio::test]
    async fn a_second_rpc_that_disagrees_stops_every_write() {
        // It stops every write in the process for a moment: no other test that writes runs meanwhile.
        let _one = crate::testchain::one_at_a_time().await;
        let _home = crate::store::scratch_home("second-rpc");
        let block = |hash: &str| format!(r#"{{"jsonrpc":"2.0","id":0,"result":{{"hash":"{hash}","number":"0x9","parentHash":"0x{z}","sha3Uncles":"0x{z}","miner":"0x0000000000000000000000000000000000000000","stateRoot":"0x{z}","transactionsRoot":"0x{z}","receiptsRoot":"0x{z}","logsBloom":"0x{b}","difficulty":"0x0","gasLimit":"0x0","gasUsed":"0x0","timestamp":"0x0","extraData":"0x","mixHash":"0x{z}","nonce":"0x0000000000000000","uncles":[],"transactions":[]}}}}"#, z = "0".repeat(64), b = "0".repeat(512));
        let ours = alloy::primitives::B256::repeat_byte(0xaa);
        let (url, _) = scripted_rpc(vec![(200, block(&format!("{ours:#x}"))), (200, block(&format!("{:#x}", alloy::primitives::B256::repeat_byte(0xbb)))), (200, r#"{"jsonrpc":"2.0","id":0,"result":null}"#.into())]).await;
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(url.to_string()), ..crate::store::Settings::default() }).unwrap();
        second_agrees_on_block(9, ours).await.expect("the same block");
        assert!(halted().is_none());
        assert!(second_agrees_on_block(9, ours).await.is_err(), "another block at that height");
        assert!(halted().is_some_and(|w| w.contains("second RPC")), "and every write stops");
        unhalt();
        let e = second_agrees_on_block(9, ours).await.unwrap_err();
        assert!(e.contains("hasn't reached") && halted().is_none(), "a second RPC behind only makes the caller wait: {e}");
    }

    /// A second RPC the owner named and that can't be used (not a URL, not http, the node's own RPC again) is an error
    /// every caller meets, never taken as no second RPC.
    #[test]
    fn a_second_rpc_named_wrong_is_an_error_never_none() {
        let _home = crate::store::scratch_home("second-rpc-named");
        let named = |v: &str| crate::store::save_settings(&crate::store::Settings { check_rpc: Some(v.into()), ..crate::store::Settings::default() }).unwrap();
        named("not a url");
        assert!(second_url().is_err());
        named("ftp://elsewhere.example/");
        assert!(second_url().is_err());
        named(crate::chain::url().as_str());
        assert!(second_url().is_err_and(|e| e.contains("node's own RPC")));
        named("https://elsewhere.example/");
        assert!(second_url().unwrap().is_some());
        named("");
        assert!(second_url().unwrap().is_none(), "nothing named is no second RPC");
    }

    /// On a chain reached over the network a write that must not go twice needs a second RPC named, and an ordinary one
    /// doesn't; a chain on this machine is the owner's own.
    #[test]
    fn a_networked_chain_with_one_rpc_gets_no_once_only_write() {
        assert!(may_write(false, false, Signs::Once).is_err_and(|e| e.contains("second, independent RPC")));
        assert!(may_write(false, false, Signs::Ordinary).is_ok(), "an ordinary write goes, checked against the one RPC");
        assert!(may_write(false, true, Signs::Once).is_ok());
        assert!(may_write(true, false, Signs::Once).is_ok());
    }

    /// Two endpoints of one operator are one witness: the same host on another port, a name under the same registrable
    /// domain, a DNS alias of the same address. Code refuses what is plainly one; the rest is the owner's judgement.
    #[tokio::test]
    async fn one_operators_endpoints_are_not_two_witnesses() {
        let u = |s: &str| s.parse::<reqwest::Url>().unwrap();
        assert!(independent(&u("https://rpc.example.com/"), &u("https://rpc.example.com:8443/")).await.is_err(), "the same host on another port");
        assert!(independent(&u("https://a.example.com/v1"), &u("https://b.example.com/v2")).await.is_err(), "two names under one domain");
        assert!(same_registrable("rpc.example.co.uk", "other.example.co.uk") && !same_registrable("example.co.uk", "other.co.uk"), "by the public suffix list, not two labels");
        assert!(independent(&u("http://127.0.0.1:8545/"), &u("http://localhost:9545/")).await.is_err(), "a name that resolves to the first's address");
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        assert!(shares_address(&[ip("10.0.0.1"), ip("10.0.0.2")], &[ip("10.0.0.2")]));
        assert!(!shares_address(&[ip("10.0.0.1")], &[ip("10.0.0.3")]));
    }

    /// A write is signed only when the chain was followed to its finalized head on this very call, and with a second RPC
    /// named only when it stood behind that head just now: one behind or not answering, or a first with no finalized
    /// head, and the write waits.
    #[test]
    fn a_write_waits_unless_the_chain_was_followed_just_now() {
        use crate::anchor::Witness;
        assert!(followed_now(false, true, None).is_err(), "the second RPC behind or not answering");
        assert!(followed_now(false, false, None).is_err(), "no finalized head from the first");
        assert!(followed_now(true, true, Some(Witness::One)).is_err(), "a second named but not standing behind it");
        assert!(followed_now(true, true, Some(Witness::Second)).is_ok());
        assert!(followed_now(true, false, Some(Witness::One)).is_ok(), "one RPC, for an ordinary write");
        assert!(followed_now(true, false, Some(Witness::Here)).is_ok());
    }

    /// With a second RPC named, a write is signed only once that RPC has stood behind the chain's finalized head just
    /// now: behind (no such block yet), or not answering, and both ways a write is signed fail closed before anything is
    /// signed or kept, ordinary (`send_write`) and once-only (`inflight::send`) alike.
    #[tokio::test]
    async fn networked_write_gate_fails_closed_when_second_rpc_is_unavailable_or_behind() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("gate-fails-closed");
        let head = alloy::consensus::Header { number: 9, ..Default::default() };
        let block = serde_json::to_string(&alloy::rpc::types::Block::<alloy::rpc::types::Transaction>::new(alloy::rpc::types::Header::new(head), alloy::rpc::types::BlockTransactions::Hashes(vec![]))).unwrap();
        let ok = |v: &str| (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":{v}}}"#));
        // The first RPC: its chain, then its finalized head, once for each write.
        let (first, _) = scripted_rpc(vec![ok("\"0x539\""), ok(&block), ok("\"0x539\""), ok(&block)]).await;
        // The second: behind for the first write, then not answering at all.
        let (second, _) = scripted_rpc(vec![ok("null")]).await;
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second.to_string()), ..crate::store::Settings::default() }).unwrap();
        let key = PrivateKeySigner::random();
        let p = ProviderBuilder::new().wallet(key.clone()).connect_http(first.clone());
        let call = alloy::contract::CallBuilder::new_raw(&p, alloy::primitives::Bytes::new()).to(Address::repeat_byte(7));
        let held = |e: &str| e.contains("waits") || e.contains("second RPC");
        let ordinary: Result<TransactionReceipt, String> = async { Ok(mined!(call, "an ordinary write")) }.await;
        assert!(ordinary.as_ref().is_err_and(|e| held(e)), "behind: {ordinary:?}");
        let wallet = p.wallet().clone();
        let once = crate::inflight::send(&call, key.address(), &wallet, "gate-test", 1.0, None, (Address::repeat_byte(7), alloy::primitives::Bytes::new()), "a once-only write").await;
        assert!(once.as_ref().is_err_and(|e| held(e)), "not answering: {once:?}");
        assert!(crate::inflight::all().unwrap().is_empty(), "nothing was signed and kept");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// R11-CHAIN-1: a head is good for `HEAD_LIFE` only: past it, no witnessed reading is made at it and no agreed one.
    #[test]
    fn a_head_past_its_life_witnesses_nothing() {
        let fresh = Head { followed: Some((100, crate::anchor::Witness::Here)), second_at: None, taken: Some(std::time::Instant::now()) };
        assert_eq!(fresh.witnessed_at().map(|(n, _)| n), Some(100));
        let old = Head { taken: std::time::Instant::now().checked_sub(HEAD_LIFE + Duration::from_secs(1)), ..fresh };
        assert!(old.taken.is_some() && !old.live());
        assert_eq!(old.witnessed_at(), None);
        assert_eq!(old.latest(), None);
        assert!(old.agreed_at().is_err());
        assert!(HEAD_LIFE < REQUEST_TIMEOUT, "well under one request's own timeout");
    }

    /// R10-CHAIN-1: near an epoch boundary, a first RPC up to `HEAD_SKEW` blocks behind still agrees with the second,
    /// but the epoch an expiry is judged by is the later of the two heads': with the first in the last blocks of epoch
    /// 5 and the second's own head in epoch 6, the witnessed epoch (and the floor) is 6, and a voucher of epoch 4 is
    /// refused though the first's epoch would let it in.
    #[tokio::test]
    async fn an_expiry_is_judged_by_the_later_of_the_two_heads() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("later-head");
        let block = |n: u64| {
            let head = alloy::consensus::Header { number: n, ..Default::default() };
            serde_json::to_string(&alloy::rpc::types::Block::<alloy::rpc::types::Transaction>::new(alloy::rpc::types::Header::new(head), alloy::rpc::types::BlockTransactions::Hashes(vec![]))).unwrap()
        };
        let ok = |v: &str| (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":{v}}}"#));
        let epoch = |e: u8| format!("\"0x{}\"", hex::encode(alloy::primitives::U256::from(e).to_be_bytes::<32>()));
        let length = 14_400u64;
        let (first_at, second_at) = (6 * length - 10, 6 * length + 10);
        let (first, _) = scripted_rpc(vec![ok("\"0x539\""), ok(&block(first_at)), ok(&epoch(5))]).await;
        let (second, _) = scripted_rpc(vec![ok(&block(second_at)), ok(&block(first_at)), ok(&epoch(5))]).await;
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second.to_string()), ..crate::store::Settings::default() }).unwrap();
        let p = ProviderBuilder::new().connect_http(first.clone());
        let head = Head::follow(&p).await.unwrap();
        assert_eq!(head.witnessed_at().map(|(n, _)| n), Some(first_at), "the second stands behind the first's head: 20 blocks apart");
        assert_eq!(head.latest(), Some(second_at));
        let d = crate::chain::Deployment { settlement: Address::repeat_byte(1), epoch_blocks: length, ..Default::default() };
        let seen = crate::chain::epoch_at(&head, &p, &d).await.unwrap();
        assert_eq!(seen, Some(6), "the later epoch of the two heads");
        assert_eq!(crate::chain::epoch_floor().unwrap(), 6, "and the floor rises to it");
        assert!(crate::network::voucher_open(4, 5, seen, 0, true).is_err(), "a voucher of epoch 4 is two epochs old at the second's head");
        assert!(crate::network::voucher_open(5, 5, seen, 0, true).is_ok(), "one of epoch 5 is still in its window");
        // The rule on plain values: never more than one epoch past what the agreed head read.
        assert_eq!(crate::chain::later_epoch(5, Some(6 * length + 10), length), 6);
        assert_eq!(crate::chain::later_epoch(5, Some(90 * length), length), 6, "a second's head can move it one epoch at most");
        assert_eq!(crate::chain::later_epoch(5, Some(5 * length + 3), length), 5);
        assert_eq!(crate::chain::later_epoch(5, None, length), 5);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// R9-CHAIN-1: a witnessed read is made only at the head the node just followed with the second RPC standing behind
    /// it as its own finalized head. A first RPC that names an old finalized block, which an honest second still has
    /// and answers for, gets no witnessed reading: an old epoch never looks witnessed, a voucher past the real epoch
    /// is refused, and the one-RPC bounds stay in force. The same two RPCs at one head are a witness.
    #[tokio::test]
    async fn every_witnessed_read_rejects_a_head_the_first_rpc_chose_alone() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("stale-head");
        let block = |n: u64| {
            let head = alloy::consensus::Header { number: n, ..Default::default() };
            serde_json::to_string(&alloy::rpc::types::Block::<alloy::rpc::types::Transaction>::new(alloy::rpc::types::Header::new(head), alloy::rpc::types::BlockTransactions::Hashes(vec![]))).unwrap()
        };
        let ok = |v: &str| (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":{v}}}"#));
        let epoch = |e: u8| format!("\"0x{}\"", hex::encode(alloy::primitives::U256::from(e).to_be_bytes::<32>()));
        let settlement = Address::repeat_byte(1);
        let call = crate::chain::LeanSettlement::epochCall {};
        // The first names block 100 as final; the honest second is final to block 1,000 and would answer for 100.
        let (first, _) = scripted_rpc(vec![ok("\"0x539\""), ok(&block(100)), ok(&epoch(5))]).await;
        let (second, asked) = scripted_rpc(vec![ok(&block(1_000)), ok(&block(100)), ok(&epoch(5))]).await;
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second.to_string()), ..crate::store::Settings::default() }).unwrap();
        let p = ProviderBuilder::new().connect_http(first.clone());
        let seen = call_witnessed(&p, settlement, &call).await.unwrap();
        assert_eq!(seen, None, "an old head the first chose alone is witnessed by nobody");
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1, "the second was asked only for its own head, never for the old block");
        assert!(halted().is_none());
        // What a release then does with that result: the voucher of the old epoch is refused, and the bounds hold.
        assert!(crate::network::voucher_open(5, 5, seen, 0, true).is_err(), "a voucher past the real epoch is refused");
        assert!(!crate::chain::ledger_has_room(crate::chain::MAX_HELD_LINES, seen.is_some()), "the one-RPC bounds stay in force");
        assert!(crate::chain::may_take_paid_lines(seen.is_some()).is_ok(), "an empty ledger still has room");
        // The same RPCs at one head: the second stands behind it, and the reading is witnessed.
        let (first, _) = scripted_rpc(vec![ok("\"0x539\""), ok(&block(100)), ok(&epoch(7))]).await;
        let (second, _) = scripted_rpc(vec![ok(&block(100)), ok(&block(100)), ok(&epoch(7))]).await;
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second.to_string()), ..crate::store::Settings::default() }).unwrap();
        let p = ProviderBuilder::new().connect_http(first.clone());
        assert_eq!(call_witnessed(&p, settlement, &call).await.unwrap(), Some(7), "a head both stand behind");
        assert!(crate::anchor::fresh_for_second(100, 100 + crate::anchor::HEAD_SKEW) && !crate::anchor::fresh_for_second(100, 101 + crate::anchor::HEAD_SKEW));
        assert!(!crate::anchor::fresh_for_second(1_000, 100), "a second that lags far behind stands behind nothing either");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Where the owner looks (health, chain status, the one-time notice), a chain reached over the network with no second
    /// RPC says so, and says what is held back until one is named; one named wrong says why.
    #[test]
    fn a_missing_second_rpc_is_said_where_the_owner_looks() {
        assert_eq!(second_rpc_state_of(true, Ok(false)), ("not needed", None));
        assert_eq!(second_rpc_state_of(false, Ok(true)), ("named", None));
        let (state, held) = second_rpc_state_of(false, Ok(false));
        assert_eq!(state, "missing");
        assert!(held.is_some_and(|h| h.contains("deposits, stakes, bounty posts") && h.contains("gives back no gas") && h.contains("check_rpc")));
        assert_eq!(second_rpc_state_of(false, Err("not a URL".into())), ("misnamed", Some("not a URL".into())));
    }

    /// A day's writes cost at most the owner's budget: one that could take the day past it isn't sent.
    #[test]
    fn gas_spent_a_day_stays_under_the_budget() {
        let u = alloy::primitives::U256::from;
        assert!(fits_budget(u(0), u(5), u(5)), "exactly the budget");
        assert!(fits_budget(u(3), u(2), u(5)));
        assert!(!fits_budget(u(4), u(2), u(5)), "past it");
        assert!(!fits_budget(u(0), u(1), u(0)), "a budget of nothing sends nothing");
        assert!(!fits_budget(alloy::primitives::U256::MAX, u(1), alloy::primitives::U256::MAX - u(1)), "no overflow lets one through");
    }

    /// Every write names the chain the node runs on: an RPC that says it is another chain gets no write, and a live
    /// node that hasn't settled its chain sends none.
    #[test]
    fn a_write_is_signed_for_the_chosen_chain_whatever_the_rpc_says() {
        let (testnet, mainnet) = (crate::arc::ARC_TESTNET.chain_id, crate::arc::ARC_MAINNET.chain_id);
        assert_eq!(agrees(Some(testnet), true, testnet), Ok(testnet));
        assert!(agrees(Some(testnet), true, mainnet).is_err(), "an RPC that says it is another chain");
        assert!(agrees(None, true, mainnet).is_err(), "a live node with no chain settled");
        // USDC's address is the same on both networks, so only the chain ID keeps a deposit's signature to one of them.
        let usdc = crate::arc::ARC_TESTNET.usdc;
        assert_eq!(usdc, crate::arc::ARC_MAINNET.usdc);
        assert_ne!(crate::chain::usdc_domain_for(testnet, usdc), crate::chain::usdc_domain_for(mainnet, usdc));
    }

    /// A write that left the node may still land, and says so, so nobody tells the owner the chain refused it.
    #[test]
    fn a_write_that_may_still_land_says_so() {
        assert!(unsettled(&unsettled_error("claiming a line", "timed out")));
        assert!(!unsettled(&not_sent("claiming a line", "execution reverted".into())));
    }

    /// A batch sent as separate writes can stop halfway, so a read that got no answer is an error: only the chain saying
    /// the batch doesn't run sends it a write a call.
    #[tokio::test]
    async fn a_read_with_no_answer_is_not_a_chain_without_the_batch() {
        let (url, _) = scripted_rpc(vec![(500, "no".to_string())]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert!(one_transaction(&p, Address::ZERO, &[]).await.is_err(), "no answer about the key's code");

        let code = |hex: &str| format!(r#"{{"jsonrpc":"2.0","id":0,"result":"{hex}"}}"#);
        let (url, _) = scripted_rpc(vec![(200, code("0x")), (200, code("0x60"))]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert!(one_transaction(&p, Address::ZERO, &[]).await.is_err(), "no answer to the trial call");

        let reverted = r#"{"jsonrpc":"2.0","id":0,"error":{"code":3,"message":"execution reverted"}}"#.to_string();
        let (url, _) = scripted_rpc(vec![(200, code("0x")), (200, code("0x60")), (200, reverted)]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert_eq!(one_transaction(&p, Address::ZERO, &[]).await, Ok(None), "the chain's own no");
    }

    /// A public RPC turns a caller away for its rate in bursts; the read waits and asks again rather than failing, so a
    /// reader that makes many requests (first contact's registry read) isn't left with nothing by one refusal.
    #[tokio::test]
    async fn a_request_turned_away_for_the_rpcs_rate_is_sent_again() {
        let limited = r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32005,"message":"rate limit exceeded"}}"#.to_string();
        let answer = r#"{"jsonrpc":"2.0","id":0,"result":"0x2a"}"#.to_string();
        let (url, taken) = scripted_rpc(vec![(429, limited.clone()), (200, limited), (200, answer)]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert_eq!(p.get_block_number().await.unwrap(), 42);
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 3, "an HTTP 429 and a JSON-RPC rate-limit error, each sent again");
    }

    /// The node's bounded reads (`proof::fetch`: the headers between finalized heads, a window of logs) are held to the
    /// same rule as a provider's request: a refusal for the RPC's rate is waited out, and only another refusal is the
    /// answer. One rate-limited header used to fail a whole link between heads.
    #[tokio::test]
    async fn a_bounded_read_turned_away_for_the_rpcs_rate_is_sent_again() {
        let limited = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded"}}"#.to_string();
        let answer = r#"{"jsonrpc":"2.0","id":1,"result":"0x2a"}"#.to_string();
        let (url, taken) = scripted_rpc(vec![(429, limited.clone()), (200, limited), (200, answer)]).await;
        let got = crate::proof::fetch(&url, "eth_blockNumber", serde_json::json!([]), 1024).await.unwrap();
        assert!(matches!(got, crate::proof::Answer::Value(ref v) if v == "0x2a"), "{got:?}");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 3, "an HTTP 429 and a JSON-RPC rate-limit error, each sent again");

        let reverted = r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}"#.to_string();
        let (url, taken) = scripted_rpc(vec![(200, reverted)]).await;
        let got = crate::proof::fetch(&url, "eth_call", serde_json::json!([]), 1024).await.unwrap();
        assert!(matches!(got, crate::proof::Answer::Refused(_)), "{got:?}");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 1, "any other refusal is the answer, sent once");
    }

    /// An RPC that compresses its answers (said in `content-encoding`) is read, in gzip or brotli: some providers
    /// compress every answer whether or not the request asked, in whichever encoding their cache holds (Blockdaemon's
    /// Arc testnet answers brotli to a request that asked for gzip), and a body the node can't decode is no answer.
    #[tokio::test]
    async fn an_rpc_that_compresses_its_answer_is_read() {
        use std::io::Write as _;
        let json = br#"{"jsonrpc":"2.0","id":0,"result":"0x4cef52"}"#;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(json).unwrap();
        read_in("gzip", gz.finish().unwrap()).await;
        let mut br = Vec::new();
        brotli::BrotliCompress(&mut &json[..], &mut br, &brotli::enc::BrotliEncoderParams::default()).unwrap();
        read_in("br", br).await;
    }

    /// A provider's request and a bounded read each read `body`, sent as `encoding`.
    async fn read_in(encoding: &'static str, body: Vec<u8>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: reqwest::Url = format!("http://{}", listener.local_addr().unwrap()).parse().unwrap();
        tokio::spawn(async move {
            for _ in 0..2 {
                let Ok((mut conn, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 64 * 1024];
                let _ = conn.read(&mut buf).await;
                let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: {encoding}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = conn.write_all(head.as_bytes()).await;
                let _ = conn.write_all(&body).await;
                let _ = conn.shutdown().await;
            }
        });
        let p = ProviderBuilder::new().connect_http(url.clone());
        assert_eq!(p.get_chain_id().await.unwrap(), 5042002, "a provider's request, in {encoding}");
        let got = crate::proof::fetch(&url, "eth_chainId", serde_json::json!([]), 1024).await.unwrap();
        assert!(matches!(got, crate::proof::Answer::Value(ref v) if v == "0x4cef52"), "a bounded read, in {encoding}: {got:?}");
    }

    /// A load-balanced RPC can answer from a node a block behind the one that mined a write; the read is sent again
    /// rather than failing the write that waits on it.
    #[tokio::test]
    async fn a_read_answered_from_a_node_behind_the_head_is_sent_again() {
        let behind = r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32602,"message":"request beyond head block: requested 70661205, head 70661204"}}"#.to_string();
        let answer = r#"{"jsonrpc":"2.0","id":0,"result":"0x2a"}"#.to_string();
        let (url, taken) = scripted_rpc(vec![(200, behind), (200, answer)]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert_eq!(p.get_block_number().await.unwrap(), 42);
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// Any other error the RPC gives is the answer: it isn't sent again.
    #[tokio::test]
    async fn another_invalid_params_error_is_not_sent_again() {
        let bad = r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32602,"message":"invalid argument 0"}}"#.to_string();
        let (url, taken) = scripted_rpc(vec![(200, bad)]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert!(p.get_block_number().await.is_err());
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// A batch goes as one transaction to Multicall3From where it runs there, and one write a call where it doesn't: on a
    /// chain without it (a plain devnet), and where its code is but can't run (a devnet forking Arc has its code, not
    /// Arc's CallFrom precompile). Anvil has no CallFrom, so a stand-in that takes any call shows the routing.
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn a_batch_is_one_transaction_where_multicall3from_runs() {
        batched().await.unwrap();
    }

    async fn batched() -> Result<(), String> {
        use crate::chain::USDC;
        use alloy::sol_types::SolCall;
        let _one = crate::testchain::one_at_a_time().await;
        let anvil = crate::testchain::Anvil::start(crate::arc::LOCAL_CHAIN_ID).await;
        // The test's Anvil is the node's chain: what a write is proven against is the node's own chain (`proof`).
        let home = crate::testchain::home("batched");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", anvil.port.to_string())]);
        let key = PrivateKeySigner::random();
        let me = key.address();
        anvil.fund(me).await;
        let p = ProviderBuilder::new().wallet(key).connect_http(anvil.url().parse().unwrap());
        let usdc = mined!(USDC::deploy_builder(&p, 6), "deploy USDC").contract_address.unwrap();
        let mint = |n: u64| (usdc, alloy::primitives::Bytes::from(USDC::faucetCall { to: me, amount: alloy::primitives::U256::from(n) }.abi_encode()));
        let read = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
        let sent = || async { read.get_transaction_count(me).await.unwrap() };
        let set_code = |code: &'static [u8]| {
            let p = p.clone();
            async move {
                let _: serde_json::Value = p.raw_request("anvil_setCode".into(), (crate::arc::MULTICALL3_FROM, alloy::primitives::Bytes::from_static(code))).await.unwrap();
            }
        };

        let before = sent().await;
        assert_eq!(batch(&p, vec![mint(1), mint(2)], "two mints").await.unwrap().len(), 2, "no Multicall3From: one write a call");
        assert_eq!(sent().await, before + 2);
        assert_eq!(USDC::new(usdc, &p).balanceOf(me).call().await.unwrap(), alloy::primitives::U256::from(3), "each ran, as the key");

        set_code(&[0x60, 0x00, 0x60, 0x00, 0xfd]).await; // reverts: its code, not its precompile
        let before = sent().await;
        assert_eq!(batch(&p, vec![mint(1), mint(2)], "two mints").await.unwrap().len(), 2, "a Multicall3From that can't run: one write a call");
        assert_eq!(sent().await, before + 2);

        set_code(&[0x00]).await; // runs: a stand-in that takes the batch
        let before = sent().await;
        let receipts = batch(&p, vec![mint(3), mint(4)], "two mints").await.unwrap();
        assert_eq!((receipts.len(), receipts[0].status(), receipts[0].to), (1, true, Some(crate::arc::MULTICALL3_FROM)), "one transaction, to Multicall3From");
        assert_eq!(sent().await, before + 1);
        let _ = std::fs::remove_dir_all(&home);
        Ok(())
    }

    /// Arc's Multicall3From takes each call with no failure allowed, so one call that fails fails the batch.
    #[test]
    fn a_multicall3from_batch_lets_no_call_fail() {
        use alloy::sol_types::SolCall;
        let a = Address::repeat_byte(1);
        let data = aggregate3(&[(a, alloy::primitives::Bytes::from_static(b"\x01\x02"))]);
        let back = Multicall3From::aggregate3Call::abi_decode(&data).unwrap();
        assert_eq!(back.calls.len(), 1);
        assert_eq!((back.calls[0].target, back.calls[0].allowFailure, back.calls[0].callData.as_ref()), (a, false, &b"\x01\x02"[..]));
        assert_eq!(&data[..4], &alloy::primitives::keccak256("aggregate3((address,bool,bytes)[])")[..4], "Multicall3's selector");
    }

    /// An RPC that takes the connection and never answers, as a chain behind a partition that holds packets does: a
    /// read gives up within its bound instead of holding its caller for good.
    #[tokio::test]
    async fn a_chain_read_gives_up_on_an_rpc_that_never_answers() {
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", silent.local_addr().unwrap()).parse().unwrap();
        std::thread::spawn(move || {
            let held = silent.accept();
            std::thread::sleep(REQUEST_TIMEOUT * 3);
            drop(held);
        });
        let t = std::time::Instant::now();
        let read = tokio::time::timeout(REQUEST_TIMEOUT * 2, ProviderBuilder::new().connect_http(url).get_chain_id()).await;
        assert!(matches!(read, Ok(Err(_))), "the read ends in an error of its own, not the outer timeout: {read:?}");
        assert!(t.elapsed() < REQUEST_TIMEOUT + Duration::from_secs(5), "{:?}", t.elapsed());
    }

    // ---- on Anvil: `cargo test -p unbrowse-node-app rpc -- --ignored --nocapture` ----

    use crate::{chain, store, testchain};

    /// A devnet of the test's own, started the way a node starts one, forking nothing.
    async fn devnet(name: &str) -> (std::path::PathBuf, std::sync::Arc<crate::Node>) {
        let home = testchain::home(name);
        std::env::set_var("UNBROWSE_DEVNET_PORT", testchain::free_port().to_string());
        std::env::set_var("UNBROWSE_DEVNET_FORK", "none");
        let n = testchain::node(name);
        n.chain.start().await.expect("the devnet");
        (home, n)
    }

    /// Owner-key writes made at once (the claim loop, an owner's command, a root posted) each take a nonce of their own:
    /// none fails because another took its nonce.
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn owner_key_writes_never_share_a_nonce() {
        let _one = testchain::one_at_a_time().await;
        let (home, n) = devnet("nonce").await;
        let keys = n.keys.as_ref();
        for round in 0..10u8 {
            let (a, b, c) = futures_util::future::join3(
                chain::set_fee(&n.chain, keys, 0.1 + f64::from(round), None),
                chain::set_fee(&n.chain, keys, 0.2 + f64::from(round), None),
                chain::post_root(&n.chain, keys, alloy::primitives::FixedBytes::<32>::from(alloy::primitives::U256::from(round + 1))),
            )
            .await;
            assert!(a.is_ok() && b.is_ok() && c.is_ok(), "round {round}: {a:?} {b:?} {c:?}");
        }
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A write the chain takes and never mines is given up on within its bound, rather than holding its caller, and
    /// the next write goes through once the chain mines again.
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn background_pass_completes_after_chain_faults_stop() {
        let _one = testchain::one_at_a_time().await;
        let (home, n) = devnet("receipt").await;
        let p = ProviderBuilder::new().connect_http(chain::url());
        let _: serde_json::Value = p.raw_request("evm_setAutomine".into(), (false,)).await.unwrap();
        let t = std::time::Instant::now();
        let stuck = tokio::time::timeout(RECEIPT_TIMEOUT * 2, chain::set_fee(&n.chain, n.keys.as_ref(), 0.3, None)).await;
        assert!(matches!(stuck, Ok(Err(_))), "the write ends in an error of its own: {stuck:?}");
        assert!(t.elapsed() < RECEIPT_TIMEOUT + Duration::from_secs(10), "{:?}", t.elapsed());
        let _: serde_json::Value = p.raw_request("evm_setAutomine".into(), (true,)).await.unwrap();
        let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
        chain::set_fee(&n.chain, n.keys.as_ref(), 0.4, None).await.expect("the next write, once the chain mines");
        assert_eq!(chain::fee_of(&n.chain, n.keys.as_ref()).await.unwrap(), 0.4);
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A node that boots while its live network's RPC doesn't answer starts its chain once it does, with no restart,
    /// and keeps looking for Settlement: an RPC that doesn't answer is told apart from a chain with no Settlement on
    /// it, and Settlement deployed later is taken.
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn boot_failures_heal_without_restart() {
        let _one = testchain::one_at_a_time().await;
        let home = testchain::home("boot");
        let anvil = testchain::Anvil::start(crate::arc::ARC_TESTNET.chain_id).await;
        let cut = testchain::Cut::to(anvil.port);
        let _env = testchain::Env::set(&[("UNBROWSE_CHAIN", crate::arc::ARC_TESTNET.name.into()), ("UNBROWSE_RPC", cut.url())]);
        let n = testchain::node("boot");
        // The network's file names a Settlement where there is none yet.
        let net = &crate::arc::ARC_TESTNET;
        let mut file = chain::network_file(net).unwrap();
        file.deployment = Some(chain::Deployment { settlement: alloy::primitives::Address::repeat_byte(0x5e), chain_id: net.chain_id, ..Default::default() });
        store::write_json(&chain::home_network_file(net), &unbrowse_files::NETWORK, &file).unwrap();

        cut.set(false);
        let booting = tokio::spawn({
            let n = n.clone();
            async move { crate::start_chain(&n).await }
        });
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(n.chain_error.locked().is_some(), "the chain's status says why it isn't up");
        cut.set(true);
        tokio::time::timeout(Duration::from_secs(30), booting).await.expect("the chain starts once its RPC answers").unwrap();
        assert!(n.chain_error.locked().is_none());
        assert_eq!(n.chain.network().map(|net| net.name), Some(crate::arc::ARC_TESTNET.name));

        // No Settlement on this chain: the chain said so, and that is asked again rarely.
        assert!(matches!(n.chain.find_settlement().await, Err(chain::Missing::Absent(_))));
        // The RPC stops answering: that is no word on Settlement, and is asked again soon.
        cut.set(false);
        assert!(matches!(n.chain.find_settlement().await, Err(chain::Missing::Unreachable(_))));
        cut.set(true);
        // Settlement is deployed while the node runs: it is taken without a restart.
        let owner = chain::owner_address(n.keys.as_ref()).unwrap();
        anvil.fund(owner).await;
        // The network's file names its own USDC: a 6-decimal stand-in at its address, and some for the pool's seed.
        let circle = chain::stand_in_usdc(&anvil.url(), net.usdc, 6).await;
        chain::mint_stand_in(&anvil.url(), &circle, net.usdc, owner, 10.0).await;
        let Ok(chain::Mode::Live(l)) = chain::chosen() else { panic!("arc-testnet") };
        let seed = chain::PoolSeed { usdc: 10.0, unb: 10.0 };
        let (_, file) = chain::deploy_shared(&l, n.keys.as_ref(), Some(seed), &chain::DEVNET_OPEN).await.expect("deployed");
        n.chain.find_settlement().await.expect("Settlement found");
        assert_eq!(n.chain.deployed().unwrap().settlement, file.deployment.unwrap().settlement);

        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---- on scripted RPCs: what the node's chain layer does with what an RPC says ----

    fn ok(result: &str) -> (u16, String) {
        (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":{result}}}"#))
    }

    /// A block as an RPC gives it, and the hash it has. `salt` tells two blocks of one height apart.
    fn block_json(number: u64, base_fee: Option<u64>, salt: u64) -> (String, alloy::primitives::B256) {
        let head = alloy::consensus::Header { number, base_fee_per_gas: base_fee, timestamp: salt, ..Default::default() };
        let sealed = alloy::rpc::types::Header::new(head);
        let hash = sealed.hash;
        (serde_json::to_string(&alloy::rpc::types::Block::<alloy::rpc::types::Transaction>::new(sealed, alloy::rpc::types::BlockTransactions::Hashes(vec![]))).unwrap(), hash)
    }

    /// A receipt as an RPC gives it for `tx`, in the block `number` with `hash` (null when it names none).
    fn receipt_json(tx: alloy::primitives::B256, in_block: Option<(u64, alloy::primitives::B256)>) -> String {
        let (number, hash) = match in_block {
            Some((n, h)) => (format!("\"{n:#x}\""), format!("\"{h:#x}\"")),
            None => ("null".into(), "null".into()),
        };
        format!(
            r#"{{"transactionHash":"{tx:#x}","transactionIndex":"0x0","blockHash":{hash},"blockNumber":{number},"from":"0x{z40}","to":"0x{z40}","cumulativeGasUsed":"0x5208","gasUsed":"0x5208","contractAddress":null,"logs":[],"logsBloom":"0x{}","status":"0x1","effectiveGasPrice":"0x1","type":"0x2"}}"#,
            "0".repeat(512),
            z40 = "0".repeat(40)
        )
    }

    /// A head the node followed is read at only while it lives, and counts as witnessed only when more than the node's one
    /// RPC stands behind it; with a second RPC named, an agreed read is made only at a head that second stood behind. A
    /// head with no witness reads nothing, and a live head is not followed again.
    #[tokio::test]
    async fn a_followed_head_is_read_at_only_while_it_lives_and_only_where_a_second_stands_behind_it() {
        use crate::anchor::Witness;
        let _home = crate::store::scratch_home("head-rules");
        let now = Some(std::time::Instant::now());
        let none = Head::default();
        assert!(!none.live() && none.witnessed_at().is_none() && none.latest().is_none());
        assert!(none.agreed_at().is_err_and(|e| e.contains("older than a head is kept")), "a head never followed is not one to read at");
        let one = Head { followed: Some((100, Witness::One)), second_at: None, taken: now };
        assert!(one.live());
        assert_eq!((one.witnessed_at(), one.latest()), (None, None), "one RPC's word witnesses nothing");
        assert_eq!(one.agreed_at(), Ok(100), "with no second RPC named, the one RPC's head is the one to read at");
        let second = Head { followed: Some((100, Witness::Second)), second_at: Some(103), taken: now };
        assert_eq!(second.latest(), Some(103), "the later of the two heads, where a stale one would help");
        assert_eq!(Head { second_at: Some(98), ..second }.latest(), Some(100));
        assert_eq!(Head { followed: Some((100, Witness::Here)), second_at: None, taken: now }.latest(), Some(100), "a chain on this machine is its owner's own");
        assert!(Head { followed: None, taken: now, ..Head::default() }.agreed_at().is_err_and(|e| e.contains("can't follow")));
        // No witness, no reading, and nothing is asked of the RPC (this one answers nothing).
        let (url, taken) = scripted_rpc(vec![]).await;
        let p = ProviderBuilder::new().connect_http(url);
        let data = alloy::primitives::Bytes::from_static(&[1]);
        assert_eq!(one.read(&p, Address::ZERO, data.clone()).await, Ok(None), "one RPC's word is no witnessed reading");
        assert!(Head::default().read_agreed(&p, Address::ZERO, data).await.is_err(), "and a head past its life is no head to agree on");
        let mut live = one;
        live.renew(&p).await.unwrap();
        assert_eq!(live.followed, one.followed, "a head still alive is not followed again");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 0);
        // With a second named, a head only the one RPC stood behind is not one an agreed read is made at.
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some("https://second.example/".into()), ..crate::store::Settings::default() }).unwrap();
        assert!(one.agreed_at().is_err_and(|e| e.contains("second RPC stands behind")));
        assert_eq!(second.agreed_at(), Ok(100));
    }

    /// A write is signed only within the budget its task was given: what doesn't fit isn't signed and takes nothing from
    /// it, what fits is counted, and a write outside any budget is held to none.
    #[tokio::test]
    async fn a_write_that_doesnt_fit_the_budget_it_runs_in_is_refused_and_takes_nothing() {
        let u = alloy::primitives::U256::from;
        assert!(take_sub_budget(alloy::primitives::U256::MAX).is_ok(), "outside any budget nothing is held");
        let (out, spent) = within_budget(u(100), async {
            assert!(take_sub_budget(u(60)).is_ok());
            let refused = take_sub_budget(u(41)).unwrap_err();
            assert!(refused.contains("more than the") && refused.contains("left of the budget"), "{refused}");
            assert!(take_sub_budget(u(40)).is_ok(), "the refused write took nothing: exactly what was left fits");
            assert!(take_sub_budget(u(1)).is_err(), "and now nothing does");
            "done"
        })
        .await;
        assert_eq!((out, spent), ("done", u(100)));
        let (_, none) = within_budget(u(5), async {}).await;
        assert_eq!(none, u(0), "a task that wrote nothing spent nothing");
    }

    /// A write's receipt is waited for only as long as asked: one the RPC has is given, one it hasn't ends in an error
    /// naming the write, and an RPC that refuses is an error.
    #[tokio::test]
    async fn a_receipt_is_waited_for_only_as_long_as_asked() {
        let tx = alloy::primitives::B256::repeat_byte(0xaa);
        let (url, _) = scripted_rpc(vec![ok(&receipt_json(tx, Some((5, alloy::primitives::B256::repeat_byte(1)))))]).await;
        let got = receipt_of(&ProviderBuilder::new().connect_http(url), tx, Duration::from_secs(5)).await.unwrap();
        assert_eq!((got.transaction_hash, got.block_number), (tx, Some(5)));
        let (url, _) = scripted_rpc(vec![ok("null")]).await;
        let e = receipt_of(&ProviderBuilder::new().connect_http(url), tx, Duration::ZERO).await.unwrap_err();
        assert!(e.contains("no receipt for") && e.contains(&format!("{tx:#x}")), "{e}");
        let (url, _) = scripted_rpc(vec![(500, "no".into())]).await;
        assert!(receipt_of(&ProviderBuilder::new().connect_http(url), tx, Duration::from_secs(5)).await.is_err());
    }

    /// A write counts once its block is the chain's own and final: a receipt in a final block that is still the block at
    /// its height lands; a chain that names no final block, a receipt that names no block, and a block a reorg dropped
    /// with the write in it are each an error, so nothing is recorded for a write that may not have happened.
    #[tokio::test]
    async fn a_write_lands_only_in_a_final_block_the_chain_still_has() {
        let tx = alloy::primitives::B256::repeat_byte(0xaa);
        let (head, _) = block_json(9, None, 0);
        let (mined_at, mined_hash) = block_json(5, None, 1);
        let mined: TransactionReceipt = serde_json::from_str(&receipt_json(tx, Some((5, mined_hash)))).unwrap();
        // Final at 9, the receipt still in block 5 and block 5 still the chain's own: landed.
        let (url, _) = scripted_rpc(vec![ok(&head), ok(&receipt_json(tx, Some((5, mined_hash)))), ok(&mined_at)]).await;
        let landed = finalized(&ProviderBuilder::new().connect_http(url), mined.clone()).await.unwrap();
        assert_eq!((landed.block_number, landed.block_hash), (Some(5), Some(mined_hash)));
        // The chain's own block 5 isn't the one it was mined in, and the chain neither has a receipt nor holds the write.
        let (other_at, _) = block_json(5, None, 2);
        let (url, _) = scripted_rpc(vec![ok(&head), ok("null"), ok(&other_at), ok("null")]).await;
        let e = finalized(&ProviderBuilder::new().connect_http(url), mined.clone()).await.unwrap_err();
        assert!(e.contains("a reorg dropped that block"), "{e}");
        // No final block at all.
        let (url, _) = scripted_rpc(vec![ok("null")]).await;
        let e = finalized(&ProviderBuilder::new().connect_http(url), mined).await.unwrap_err();
        assert!(e.contains("doesn't say which of its blocks are final"), "{e}");
        // A receipt that names no block can't be waited on.
        let unplaced: TransactionReceipt = serde_json::from_str(&receipt_json(tx, None)).unwrap();
        let (url, _) = scripted_rpc(vec![]).await;
        assert!(finalized(&ProviderBuilder::new().connect_http(url), unplaced).await.unwrap_err().contains("names no block"));
    }

    /// A write is priced from the chain's base fee and the tip it suggests, never above what a second RPC says when one is
    /// named, and never past the owner's cap; an RPC that can't say what the head costs prices nothing.
    #[tokio::test]
    async fn a_write_is_priced_from_the_chains_own_fees_and_the_lower_of_two_rpcs() {
        let _home = crate::store::scratch_home("priced");
        let gwei = 1_000_000_000u64;
        let tip = |g: u64| format!("\"{:#x}\"", g * gwei);
        let (first, _) = scripted_rpc(vec![ok(&block_json(8, Some(gwei), 0).0), ok(&tip(5))]).await;
        let got = priced(&ProviderBuilder::new().connect_http(first), 21_000).await.unwrap();
        assert_eq!(got, Priced { gas: 21_000, max_fee: 7 * u128::from(gwei), tip: 5 * u128::from(gwei) }, "twice the base fee and the tip");
        // A second RPC naming a lower tip lowers what is paid.
        let (first, _) = scripted_rpc(vec![ok(&block_json(8, Some(gwei), 0).0), ok(&tip(5))]).await;
        let (second, _) = scripted_rpc(vec![ok(&block_json(8, Some(gwei), 0).0), ok(&tip(2))]).await;
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second.to_string()), ..crate::store::Settings::default() }).unwrap();
        let got = priced(&ProviderBuilder::new().connect_http(first), 21_000).await.unwrap();
        assert_eq!((got.max_fee, got.tip), (4 * u128::from(gwei), 2 * u128::from(gwei)), "the second's tip");
        crate::store::save_settings(&crate::store::Settings::default()).unwrap();
        // A base fee past the owner's cap is refused, and so is a head the RPC won't give.
        let (first, _) = scripted_rpc(vec![ok(&block_json(8, Some(u64::MAX / 2), 0).0), ok(&tip(1))]).await;
        assert!(priced(&ProviderBuilder::new().connect_http(first), 21_000).await.unwrap_err().contains("base fee"));
        let (first, _) = scripted_rpc(vec![(500, "no".into())]).await;
        assert!(priced(&ProviderBuilder::new().connect_http(first), 21_000).await.unwrap_err().contains("reading the chain's head"));
    }

    /// A write goes out only on the chain the node runs: an RPC that says it is another chain, or doesn't answer, is
    /// refused; one the node has no chain pinned for, off a live network, is taken at its word. A second RPC that says it
    /// is another chain stops every write.
    #[tokio::test]
    async fn an_rpc_that_is_another_chain_is_refused_and_a_second_that_is_stops_every_write() {
        // It stops every write in the process for a moment: no other test that writes runs meanwhile.
        let _one = crate::testchain::one_at_a_time().await;
        let _home = crate::store::scratch_home("same-chain");
        let chain = |said: &str| ok(&format!("\"{said}\""));
        let (url, _) = scripted_rpc(vec![chain("0x539"), chain("0x539"), chain("0x539"), (500, "no".into())]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert_eq!(same_chain(&p, Some(1337)).await, Ok(1337));
        assert!(same_chain(&p, Some(1)).await.unwrap_err().contains("this node runs on chain 1"));
        assert_eq!(same_chain(&p, None).await, Ok(1337), "no chain pinned, none live: the RPC's word");
        assert!(same_chain(&p, Some(1337)).await.unwrap_err().contains("asking the RPC which chain it is"));
        let (first, _) = scripted_rpc(vec![chain("0x539")]).await;
        let (second, _) = scripted_rpc(vec![chain("0x1")]).await;
        crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second.to_string()), ..crate::store::Settings::default() }).unwrap();
        let e = same_chain(&ProviderBuilder::new().connect_http(first), Some(1337)).await.unwrap_err();
        assert!(e.contains("the second RPC says it is chain 1, not 1337"), "{e}");
        assert!(halted().is_some_and(|w| w.contains("second RPC says it is chain 1")), "every write stops");
        unhalt();
        // Two RPCs that read the same thing differently are the same contradiction.
        assert!(second_agrees("a balance", 7, &5u8, &5u8).is_ok() && halted().is_none());
        let e = second_agrees("a balance", 7, &5u8, &6u8).unwrap_err();
        assert_eq!(e, "the second RPC says a balance at block 7 is 6, the first 5");
        assert!(halted().is_some());
        unhalt();
    }

    /// The day's gas count follows what writes cost: one that never left gives its whole place back, one proven by more
    /// than the one RPC is brought to what it cost, and one only an RPC's receipt speaks for stays counted at its most.
    #[test]
    fn the_days_gas_count_is_given_back_only_for_what_is_proven() {
        let _home = crate::store::scratch_home("gas-give-back");
        let u = alloy::primitives::U256::from;
        let day = crate::store::now() / 86_400;
        let spent = || crate::store::read_json_strict::<GasSpent>(&gas_spent_path(), &unbrowse_files::GAS_SPENT).unwrap().spent;
        let proven = |cost: u64, agreed: bool| crate::proof::Proven { ran: true, gas_used: 1, cost: Some(u(cost)), block: 1, block_hash: alloy::primitives::B256::ZERO, agreed };
        // Off a live network the devnet's gas is the devnet's own: nothing is reserved.
        let free = Spend::reserve(&Priced { gas: 21_000, max_fee: 1, tip: 1 }).unwrap();
        assert!(!free.counted);
        free.release();
        reserve_in(&gas_spent_path(), day, u(70), u(1_000)).unwrap();
        Spend { most: u(70), counted: false }.release();
        assert_eq!(spent(), u(70), "a write not counted gives nothing back");
        Spend { most: u(70), counted: true }.release();
        assert_eq!(spent(), u(0), "a write that never left costs nothing");
        reserve_in(&gas_spent_path(), day, u(60), u(1_000)).unwrap();
        Spend { most: u(60), counted: true }.settle(Some(&proven(25, true)));
        assert_eq!(spent(), u(25), "brought to what it cost");
        reserve_in(&gas_spent_path(), day, u(10), u(1_000)).unwrap();
        Spend { most: u(10), counted: true }.settle(Some(&proven(1, false)));
        Spend { most: u(10), counted: true }.settle(None);
        assert_eq!(spent(), u(35), "a cost one RPC alone stood behind, or none, gives nothing back");
    }

    /// A chain's own cheat reaches the chain on this machine and says what it answered, or why not.
    #[tokio::test]
    async fn a_local_chains_cheat_answers_with_its_result_or_its_error() {
        let _one = crate::testchain::one_at_a_time().await;
        let _home = crate::testchain::home("cheat");
        let bad = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}"#.to_string();
        let (url, _) = scripted_rpc(vec![ok("\"0x2a\""), (200, bad), (200, "not json".into())]).await;
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", url.port().unwrap().to_string())]);
        assert_eq!(devnet_cheat("anvil_mine", serde_json::json!(["0x1"])).await, Ok(serde_json::json!("0x2a")));
        let e = devnet_cheat("anvil_nope", serde_json::json!([])).await.unwrap_err();
        assert!(e.starts_with("anvil_nope:") && e.contains("method not found"), "{e}");
        assert!(devnet_cheat("anvil_mine", serde_json::json!([])).await.unwrap_err().starts_with("anvil_mine:"), "an answer that isn't JSON-RPC");
    }

    /// The second RPC's own finalized block is what an expiry is held to when one is named; with none named and the chain
    /// on this machine, nothing is read; a second with no finalized block, or that doesn't answer, is an error.
    #[tokio::test]
    async fn the_finalized_height_comes_from_the_second_rpc_when_one_is_named() {
        let _one = crate::testchain::one_at_a_time().await;
        let _home = crate::testchain::home("finalized-now");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string())]);
        assert!(second_finalized().await.unwrap_err().contains("no second RPC is named"));
        assert_eq!(finalized_now().await, Ok(None), "a chain on this machine is followed by the node itself");
        let named = |url: &reqwest::Url| crate::store::save_settings(&crate::store::Settings { check_rpc: Some(url.to_string()), ..crate::store::Settings::default() }).unwrap();
        let (second, _) = scripted_rpc(vec![ok(&block_json(42, None, 0).0), ok(&block_json(43, None, 0).0)]).await;
        named(&second);
        assert_eq!(second_finalized().await, Ok(42));
        assert_eq!(finalized_now().await, Ok(Some(43)));
        let (second, _) = scripted_rpc(vec![ok("null"), (500, "no".into()), ok("{}")]).await;
        named(&second);
        assert!(second_finalized().await.unwrap_err().contains("no finalized block"));
        assert!(second_finalized().await.unwrap_err().contains("didn't answer"));
        assert!(second_finalized().await.unwrap_err().contains("names no number"));
    }

    /// A signing provider signs as the key it was made from, names no chain for an RPC that isn't the node's own, and
    /// holds a signer for no other address; a write of no calls is sent as nothing.
    #[tokio::test]
    async fn a_signing_provider_signs_as_its_key_alone_and_a_batch_of_nothing_sends_nothing() {
        let key = PrivateKeySigner::random();
        let (url, taken) = scripted_rpc(vec![]).await;
        let p = ProviderBuilder::new().wallet(key.clone()).connect_http(url);
        let wallet = p.wallet();
        assert_eq!((wallet.key().address(), wallet.chain()), (key.address(), None));
        assert_eq!(NetworkWallet::<Ethereum>::default_signer_address(wallet), key.address());
        assert!(NetworkWallet::<Ethereum>::has_signer_for(wallet, &key.address()) && !NetworkWallet::<Ethereum>::has_signer_for(wallet, &Address::ZERO));
        assert_eq!(NetworkWallet::<Ethereum>::signer_addresses(wallet).collect::<Vec<_>>(), [key.address()]);
        assert_eq!(batch(&p, Vec::new(), "nothing").await.unwrap().len(), 0);
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// A write the signer's chain has mined all of is not stuck, and a kept write that is young, another signer's, or
    /// already has a receipt is not replaced: nothing is sent for any of them.
    #[tokio::test]
    async fn a_write_that_is_only_slow_is_not_replaced() {
        let _home = crate::store::scratch_home("unstick");
        let key = PrivateKeySigner::random();
        let count = |n: u64| ok(&format!("\"{n:#x}\""));
        let (url, taken) = scripted_rpc(vec![count(5), count(5)]).await;
        let p = ProviderBuilder::new().wallet(key.clone()).connect_http(url);
        assert_eq!(unstick(&p).await, Ok(None), "nothing pending");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 2);
        let kept = |signer: Address, at: u64, tx: u8| crate::inflight::Sending {
            key: format!("k{tx}"),
            what: "a deposit".into(),
            signer,
            nonce: 5,
            tx: alloy::primitives::B256::repeat_byte(tx),
            raw: alloy::primitives::Bytes::new(),
            at,
            amount: 1.0,
            book: None,
            others: Vec::new(),
            told: false,
            watch: None,
        };
        crate::inflight::keep_for_test(kept(key.address(), crate::store::now(), 1));
        crate::inflight::keep_for_test(kept(Address::repeat_byte(9), 1, 2));
        let (url, taken) = scripted_rpc(vec![count(5), count(5)]).await;
        assert_eq!(unstick(&ProviderBuilder::new().wallet(key.clone()).connect_http(url)).await, Ok(None), "one signed a moment ago, one by another signer");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 2);
        crate::inflight::keep_for_test(kept(key.address(), 1, 3));
        let tx = alloy::primitives::B256::repeat_byte(3);
        let (url, taken) = scripted_rpc(vec![count(5), count(5), ok(&receipt_json(tx, Some((5, tx))))]).await;
        assert_eq!(unstick(&ProviderBuilder::new().wallet(key).connect_http(url)).await, Ok(None), "an old write the chain does have a receipt for");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    /// An error says what the write was, and whether it may still land: only a write that left the node and was never
    /// seen to fail does.
    #[test]
    fn an_error_says_whether_the_write_may_still_land() {
        assert_eq!(not_sent("a deposit", "max fee too low".into()), "a deposit: max fee too low");
        assert!(!unsettled(&not_sent("a deposit", "nonce too low".into())), "refused before it left");
        let e = unsettled_error("a deposit", "no receipt");
        assert!(e.starts_with("a deposit: ") && unsettled(&e) && e.contains("no receipt"), "{e}");
    }

    /// Writes go one at a time: a second waits for the first's turn to end, and goes then.
    #[tokio::test]
    async fn a_second_write_waits_for_the_first_ones_turn() {
        let _one = crate::testchain::one_at_a_time().await;
        let first = write_turn().await;
        let waiter = tokio::spawn(async { drop(write_turn().await) });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiter.is_finished(), "it waits while the first holds its turn");
        drop(first);
        tokio::time::timeout(Duration::from_secs(5), waiter).await.expect("it goes once the turn is free").unwrap();
    }
}

#[cfg(test)]
#[path = "rpc_cov_tests.rs"]
mod rpc_cov_tests;
