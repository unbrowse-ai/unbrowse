//! Chains for the node's tests, on this machine only: an Anvil of the test's own, a relay in front of it the test
//! can cut (a chain behind a partition), a stand-in ERC-8004 registry, and a node with a scratch home. The chain a
//! node reads is the process's (`UNBROWSE_DEVNET_PORT`, `UNBROWSE_CHAIN`, `UNBROWSE_RPC`), so tests that set it hold
//! `one_at_a_time` throughout.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use alloy::primitives::{Address, Bytes};
use alloy::providers::Provider;

use crate::rpc::ProviderBuilder;
use alloy::transports::http::reqwest;
use crate::{arc, chain, store, Node};
use crate::sync::Locked;

static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held by a test while it sets the process's chain.
pub async fn one_at_a_time() -> tokio::sync::MutexGuard<'static, ()> {
    ONE.lock().await
}

/// The same, for a test that runs no runtime of its own on its thread.
pub fn one_at_a_time_blocking() -> tokio::sync::MutexGuard<'static, ()> {
    ONE.blocking_lock()
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// A scratch home for the test, as this thread's home and the process's (the node runs some work on other threads).
pub fn home(name: &str) -> PathBuf {
    let dir = store::scratch_home(name);
    std::env::set_var("UNBROWSE_HOME", &dir);
    std::env::set_var("UNBROWSE_NETWORK_DIR", dir.join("network"));
    // These tests' owner has answered for the terms: what they test starts from a node that may join.
    store::save_settings(&crate::terms::acknowledged(store::load_settings(), false)).expect("a scratch home's settings");
    dir
}

/// An Anvil the test started, stopped when dropped.
pub struct Anvil {
    child: Child,
    pub port: u16,
}

impl Anvil {
    pub async fn start(chain_id: u64) -> Anvil {
        Self::started(chain_id, None).await
    }

    /// An Anvil on a copy of the chain behind `rpc`, from its latest block: it only reads from that chain, and every
    /// write lands on the copy.
    pub async fn fork(chain_id: u64, rpc: &str) -> Anvil {
        Self::started(chain_id, Some(rpc)).await
    }

    async fn started(chain_id: u64, fork: Option<&str>) -> Anvil {
        let port = free_port();
        let bin = unbrowse_files::private::user_home().join(".foundry").join("bin").join(format!("anvil{}", std::env::consts::EXE_SUFFIX));
        let mut cmd = Command::new(bin);
        if let Some(rpc) = fork {
            cmd.args(["--fork-url", rpc]);
        }
        let child = cmd
            .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--silent", "--chain-id", &chain_id.to_string(), "--base-fee", &arc::BASE_FEE_FLOOR.to_string()])
            // Each block final as it is made, as Arc's are: the node's writes count once final (`rpc::finalized`).
            .args(["--slots-in-an-epoch", "0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("Anvil (~/.foundry/bin/anvil)");
        let a = Anvil { child, port };
        let p = ProviderBuilder::new().connect_http(a.url().parse().unwrap());
        // A fork reads its first block over the network, so it is given longer to answer.
        for _ in 0..if fork.is_some() { 600 } else { 100 } {
            if p.get_chain_id().await.is_ok() {
                return a;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("Anvil didn't start");
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Gives `who` gas.
    pub async fn fund(&self, who: Address) {
        let p = ProviderBuilder::new().connect_http(self.url().parse().unwrap());
        let _: serde_json::Value = p.raw_request("anvil_setBalance".into(), (who, chain::gas_units(10.0))).await.unwrap();
    }

    /// Puts the stand-in ERC-8004 registry (`tests/fixtures/erc8004`) at Arc testnet's registry address.
    pub async fn with_registry(&self) {
        let code: Bytes = include_str!("../tests/fixtures/erc8004/Erc8004StandIn.runtime.hex").trim().parse().unwrap();
        let p = ProviderBuilder::new().connect_http(self.url().parse().unwrap());
        let _: serde_json::Value = p.raw_request("anvil_setCode".into(), (arc::ARC_TESTNET.identity, code)).await.unwrap();
    }
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A relay to a chain on this machine that the test can cut: while cut, it takes each connection and closes it at
/// once, as a chain behind a partition does; connections already relayed are closed too.
pub struct Cut {
    pub port: u16,
    open: Arc<AtomicBool>,
    epoch: Arc<std::sync::atomic::AtomicU64>,
}

impl Cut {
    pub fn to(port: u16) -> Cut {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let cut = Cut { port: listener.local_addr().unwrap().port(), open: Arc::new(AtomicBool::new(true)), epoch: Default::default() };
        let (open, epoch) = (cut.open.clone(), cut.epoch.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                if !open.load(Ordering::SeqCst) {
                    continue;
                }
                let Ok(up) = TcpStream::connect(("127.0.0.1", port)) else { continue };
                let at = epoch.load(Ordering::SeqCst);
                for (mut from, mut to) in [(conn.try_clone().unwrap(), up.try_clone().unwrap()), (up, conn)] {
                    let (open, epoch) = (open.clone(), epoch.clone());
                    std::thread::spawn(move || {
                        let _ = from.set_read_timeout(Some(Duration::from_millis(100)));
                        let mut buf = [0u8; 16 * 1024];
                        loop {
                            if !open.load(Ordering::SeqCst) || epoch.load(Ordering::SeqCst) != at {
                                break;
                            }
                            match from.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    if to.write_all(&buf[..n]).is_err() {
                                        break;
                                    }
                                }
                                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                                Err(_) => break,
                            }
                        }
                        let _ = to.shutdown(std::net::Shutdown::Both);
                    });
                }
            }
        });
        cut
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Cuts the chain off, or joins it again. Connections relayed until now are closed either way, and the call returns
    /// once they are.
    pub fn set(&self, open: bool) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.open.store(open, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Sets the process's environment for a test, and unsets it when dropped, whether or not the test passed.
pub struct Env(Vec<&'static str>);

impl Env {
    pub fn set(vars: &[(&'static str, String)]) -> Env {
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
        Env(vars.iter().map(|(k, _)| *k).collect())
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        for k in &self.0 {
            std::env::remove_var(k);
        }
    }
}

/// A node with a fresh owner key and no network, its chain not started.
/// Signs `node`'s owner in with a wallet of the test's own, as an owner bringing a wallet does (`link_message`,
/// `link_wallet`): from here the node is on the network (R1.35). The wallet's key, to sign as the owner again.
/// Keeps the node in this test's home off the network, as an owner who switched the peer network off: it is local.
pub fn keep_local() {
    let mut s = crate::store::load_settings();
    s.peer_network = false;
    crate::store::save_settings(&s).unwrap();
}

pub fn sign_in(node: &Arc<Node>) -> alloy::signers::local::PrivateKeySigner {
    let owner = alloy::signers::local::PrivateKeySigner::random();
    sign_in_as(node, &owner);
    owner
}

/// Signs `node` in with `owner`'s own wallet, as `sign_in` does: several nodes signed in with one wallet.
pub fn sign_in_as(node: &Arc<Node>, owner: &alloy::signers::local::PrivateKeySigner) {
    use alloy::signers::SignerSync;
    let owner = owner.clone();
    crate::link::set_node(&crate::identity(node).unwrap().address);
    let m = crate::link::link_message(node, &owner.address().to_string()).unwrap();
    let sig = owner.sign_message_sync(m["message"].as_str().unwrap().as_bytes()).unwrap();
    crate::link::link_wallet(node, &owner.address().to_string(), m["nonce"].as_str().unwrap(), &format!("0x{}", hex::encode(sig.as_bytes()))).unwrap();
}

pub fn node(name: &str) -> Arc<Node> {
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
        info: crate::NodeInfo { name: name.into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: crate::api::Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    })
}

/// The node's chain as a devnet that forks Arc testnet would be at `anvil`: its chain ID, so the registry is the
/// ERC-8004 one, and its first block 0.
pub fn on_arc_devnet(node: &Node, anvil_port: u16) {
    std::env::set_var("UNBROWSE_DEVNET_PORT", anvil_port.to_string());
    *node.chain.deployment.locked() = Some(chain::Deployment { chain_id: arc::ARC_TESTNET.chain_id, ..Default::default() });
}

/// A first RPC for a test, that lies in two ways and otherwise passes every request on to `real`: the chain's head
/// tags (`latest`, `safe`, `finalized`, `pending`) and `eth_blockNumber` are answered as of `behind` blocks before the
/// real finalized head, and every `eth_getLogs` answer has `forge` added to it, when given. Its blocks and state are the
/// real ones, so a second RPC holds the same blocks it names.
pub async fn lying_rpc(real: reqwest::Url, behind: Arc<std::sync::atomic::AtomicU64>, forge: Arc<std::sync::Mutex<Option<serde_json::Value>>>) -> reqwest::Url {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap()).parse().unwrap();
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        while let Ok((mut conn, _)) = listener.accept().await {
            let (client, real, behind, forge) = (client.clone(), real.clone(), behind.clone(), forge.clone());
            tokio::spawn(async move {
                let mut got = Vec::new();
                let mut buf = vec![0u8; 64 * 1024];
                let body = loop {
                    let n = conn.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if got.len() >= end + 4 + len {
                            break got[end + 4..end + 4 + len].to_vec();
                        }
                    }
                };
                let ask = |req: serde_json::Value| {
                    let (client, real) = (client.clone(), real.clone());
                    async move { client.post(real).json(&req).send().await.unwrap().json::<serde_json::Value>().await.unwrap() }
                };
                let fin = ask(serde_json::json!({"jsonrpc": "2.0", "id": 0, "method": "eth_getBlockByNumber", "params": ["finalized", false]})).await;
                let fin = u64::from_str_radix(fin["result"]["number"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
                let stale = format!("{:#x}", fin.saturating_sub(behind.load(std::sync::atomic::Ordering::SeqCst)));
                let mut req: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let logs = req["method"] == "eth_getLogs";
                let reply = if req["method"] == "eth_blockNumber" {
                    serde_json::json!({"jsonrpc": "2.0", "id": req["id"].clone(), "result": stale})
                } else {
                    if let Some(params) = req["params"].as_array_mut() {
                        for v in params.iter_mut() {
                            if matches!(v.as_str(), Some("latest" | "safe" | "finalized" | "pending")) {
                                *v = serde_json::Value::String(stale.clone());
                            }
                        }
                    }
                    ask(req).await
                };
                let mut reply = reply;
                let forged = forge.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let (true, Some(f), Some(found)) = (logs, forged, reply["result"].as_array_mut()) {
                    found.push(f);
                }
                let out = reply.to_string();
                let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", out.len());
                let _ = conn.write_all(head.as_bytes()).await;
                let _ = conn.write_all(out.as_bytes()).await;
                let _ = conn.shutdown().await;
            });
        }
    });
    url
}
