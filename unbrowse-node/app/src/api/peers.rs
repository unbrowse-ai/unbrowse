//! What other nodes send this node: receipts for calls it served, reserve leaves and roots, and its proof of itself.

use super::*;

// ---- what other nodes send this node ----

/// Why `/v1/remote/call/{id}` runs nothing now: a node used to run its listed routes for other nodes' agents there. A
/// caller now fetches the body and runs it itself, so this answers an older node with the reason, for one release.
pub(super) const NO_REMOTE_CALLS: &str = "this node no longer runs routes for other nodes: a caller fetches the route's body over the peer network, pays for it and runs it on its own node, under its own session. Update the calling node: a released node updates itself while automatic updates are on (Settings), else install the newest release (`npm install -g unbrowse`).";

pub(super) async fn retired_remote_call() -> Reply {
    refuse(StatusCode::GONE, NO_REMOTE_CALLS)
}

/// A line a caller's agent signed for a use of one of this node's entries whose body this node served: checked, then
/// kept for the node's next claim.
pub(super) async fn serve_remote_receipt(State(node): State<Arc<Node>>, Json(paid): Json<chain::PaidLine>) -> Reply {
    match network::accept_receipt(&node.chain, node.keys.as_ref(), &paid).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => refuse(StatusCode::BAD_REQUEST, &e),
    }
}

/// `POST /v1/remote/reserve/leaf`: a listing's leaf for the reserve's next root, signed by its sender (R2.20). Only a
/// node that posts the reserve's roots takes one (`reserve::accept`).
pub(super) async fn reserve_leaf(State(node): State<Arc<Node>>, Json(sent): Json<crate::reserve::Sent>) -> Reply {
    match crate::reserve::accept(&node.chain, &sent).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => refuse(StatusCode::BAD_REQUEST, &e),
    }
}

#[derive(Deserialize)]
pub(super) struct SinceQuery {
    #[serde(default)]
    since: u64,
}

/// `GET /v1/remote/reserve/roots?since=<block>`: the roots this node posted for the reserve, each with its leaf list,
/// so each contributor finds its leaf's place and proof.
pub(super) async fn reserve_roots(State(node): State<Arc<Node>>, Query(q): Query<SinceQuery>) -> Json<Vec<crate::listing::Posted>> {
    Json(crate::reserve::roots(&node.chain, q.since))
}

#[derive(Deserialize)]
pub(super) struct ProofQuery {
    challenge: String,
    /// The key the asker holds and wants this node to prove itself to: an agent's `token_key` (32 bytes, hex), or the
    /// owner's address another node read from this node's ad.
    #[serde(default)]
    key: Option<String>,
}

/// `GET /v1/node/proof?challenge=<32 bytes, hex>&key=<the key the asker holds>`: this node, proving it is the node a
/// client means before the client sends it anything, to the key the client names and no other. An agent names its
/// token's `token_key` and gets back `agents: [node_proof(token, port, challenge)]`, which only the node that made the
/// token can answer; another node names the owner's address it read from this node's ad and gets back `address` and
/// the owner key's `signature` over the challenge and port (`network::proven`). A key this node doesn't hold, or none,
/// gets `agents: []` and nothing else: the answer names no owner and counts no keys for whoever asks.
pub(super) async fn node_proof(State(door): State<super::window::Door>, Query(q): Query<ProofQuery>) -> Reply {
    let node = door.node.clone();
    use alloy::signers::SignerSync;
    let challenge: alloy::primitives::FixedBytes<32> = match q.challenge.parse() {
        Ok(c) => c,
        Err(_) => return refuse(StatusCode::BAD_REQUEST, "the challenge is 32 bytes, in hex"),
    };
    if !node.unlocked() {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, crate::WAITING_FOR_KEY);
    }
    let port = node.info.api_port;
    let (Ok(owner), Ok(root)) = (chain::owner_signer(node.keys.as_ref()), unbrowse_core::RootKey::load(node.keys.as_ref())) else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, crate::WAITING_FOR_KEY);
    };
    let named = q.key.as_deref().map(|k| k.trim().trim_start_matches("0x").to_ascii_lowercase()).unwrap_or_default();
    let mut answer = proof_for(&named, port, &challenge, owner.address(), &door.owner, agents::list().into_iter().filter(|a| !a.revoked && a.expires > store::now() && a.gateway.is_none()).map(|a| agents::token_of(&root, &a)));
    if answer.get("address").is_some() {
        let Ok(sig) = owner.sign_hash_sync(&network::endpoint_digest(port, &challenge)) else {
            return refuse(StatusCode::INTERNAL_SERVER_ERROR, "couldn't sign");
        };
        answer["signature"] = json!(format!("0x{}", hex::encode(sig.as_bytes())));
    }
    (StatusCode::OK, Json(answer))
}

/// The proof for the key `named` (bare lowercase hex), among the owner's `address`, the owner's token and the live
/// agents' `tokens`: the owner's address when that is the key named (the signature is added by the caller), the owner
/// token's proof (`owner`) when its key is, the one agent's proof when its token's key is, and nothing else either way.
fn proof_for(named: &str, port: u16, challenge: &alloy::primitives::FixedBytes<32>, address: alloy::primitives::Address, owner_token: &str, tokens: impl Iterator<Item = String>) -> Value {
    let mut answer = json!({ "agents": [] });
    if named.is_empty() {
        return answer;
    }
    if named == hex::encode(address.as_slice()) {
        answer["address"] = json!(format!("{address:#x}"));
        return answer;
    }
    if !owner_token.is_empty() && named == hex::encode(unbrowse_core::token_key(owner_token)) {
        answer["owner"] = json!(hex::encode(unbrowse_core::node_proof(owner_token, port, challenge.as_slice())));
        return answer;
    }
    for token in tokens {
        if hex::encode(unbrowse_core::token_key(&token)) == named {
            answer["agents"] = json!([hex::encode(unbrowse_core::node_proof(&token, port, challenge.as_slice()))]);
            break;
        }
    }
    answer
}

#[cfg(test)]
mod proof_tests {
    use super::*;

    /// The proof answers the key the asker names and no other: an agent's proof for its token's key, the owner's
    /// address for another node that names it, and for anyone naming nothing (or a key this node doesn't hold) no
    /// address and no count of keys.
    #[test]
    fn a_proof_reveals_no_count_of_keys() {
        let challenge = alloy::primitives::FixedBytes::from([7u8; 32]);
        let owner: alloy::primitives::Address = "0x00000000000000000000000000000000000000aa".parse().unwrap();
        let tokens = || ["unb_one", "unb_two", "unb_three"].into_iter().map(String::from);
        for nobody in ["", "00", &hex::encode([9u8; 32])] {
            let a = proof_for(nobody, 7788, &challenge, owner, "owner-tok", tokens());
            assert_eq!(a, json!({ "agents": [] }), "naming {nobody:?} learns nothing");
        }
        let two = hex::encode(unbrowse_core::token_key("unb_two"));
        let a = proof_for(&two, 7788, &challenge, owner, "owner-tok", tokens());
        assert_eq!(a, json!({ "agents": [hex::encode(unbrowse_core::node_proof("unb_two", 7788, challenge.as_slice()))] }), "one proof, the named key's");
        let a = proof_for(&hex::encode(owner.as_slice()), 7788, &challenge, owner, "owner-tok", tokens());
        assert_eq!(a, json!({ "agents": [], "address": format!("{owner:#x}") }), "another node that names the owner");
        let a = proof_for(&hex::encode(unbrowse_core::token_key("owner-tok")), 7788, &challenge, owner, "owner-tok", tokens());
        assert_eq!(a, json!({ "agents": [], "owner": hex::encode(unbrowse_core::node_proof("owner-tok", 7788, challenge.as_slice())) }), "the window, holding the owner's token");
    }

    /// A node with a key of its own and no chain to read.
    fn a_node_with_no_chain(keyed: bool) -> Arc<Node> {
        let keys = unbrowse_core::MemoryStore::default();
        let identity = keyed.then(|| {
            let id = unbrowse_core::load_or_create(&keys).unwrap();
            Ok(crate::IdentityView { address: id.address.to_checksum(), created: true })
        });
        Arc::new(Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(identity),
            info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 7788, dev: true },
            walks: crate::learn::Walks::default(),
            chain: chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        })
    }

    /// What other nodes send a node whose chain can't be read is refused in words, and nothing is kept: a receipt and a
    /// reserve leaf are a 400, no roots are handed out, and a node that asks it to run a route is told that nodes no
    /// longer do (410).
    #[tokio::test]
    async fn what_other_nodes_send_a_node_with_no_chain_is_refused_in_words() {
        let home = store::scratch_home("peers-no-chain");
        store::use_home(&home);
        let node = a_node_with_no_chain(true);
        let (status, Json(said)) = retired_remote_call().await;
        assert_eq!((status, said["error"].as_str()), (StatusCode::GONE, Some(NO_REMOTE_CALLS)));
        let zero = format!("0x{}", "00".repeat(32));
        let paid: chain::PaidLine = serde_json::from_value(json!({
            "payer": "0x0000000000000000000000000000000000000001", "agent": "0x0000000000000000000000000000000000000002", "epoch": 1, "cumulative": "0x0",
            "receipts_root": zero, "signature": "0x00", "index": "0x0", "entry_id": zero, "amount": "0x0", "passed": true, "holders": [], "proof": []
        }))
        .unwrap();
        let (status, Json(said)) = serve_remote_receipt(State(node.clone()), Json(paid)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said["error"].as_str().is_some_and(|e| !e.is_empty()), "{said}");
        let sent: crate::reserve::Sent = serde_json::from_value(json!({ "leaf": zero, "from": "0x0000000000000000000000000000000000000001", "sig": "0x00" })).unwrap();
        let (status, Json(said)) = reserve_leaf(State(node.clone()), Json(sent)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        let Json(roots) = reserve_roots(State(node), Query(SinceQuery { since: 0 })).await;
        assert!(roots.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A node's proof of itself is asked for with a 32-byte challenge, and given only once its key is readable: a
    /// challenge that isn't one is a 400, a node still waiting for its key is a 503, and a node that has it proves itself
    /// to the owner's address another node names, signing the challenge and the port, and to no key that isn't its own.
    #[tokio::test]
    async fn a_node_proves_itself_only_to_a_challenge_it_can_read_with_its_key() {
        let home = store::scratch_home("peers-node-proof");
        store::use_home(&home);
        let door = |node: &Arc<Node>| crate::api::window::Door { node: node.clone(), owner: Arc::new(String::new()) };
        let challenge = format!("0x{}", "07".repeat(32));
        let asked = |challenge: &str, key: Option<String>| ProofQuery { challenge: challenge.to_string(), key };
        let node = a_node_with_no_chain(true);
        let (status, Json(said)) = node_proof(State(door(&node)), Query(asked("not hex", None))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        let locked = a_node_with_no_chain(false);
        let (status, _) = node_proof(State(door(&locked)), Query(asked(&challenge, None))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let (status, Json(said)) = node_proof(State(door(&node)), Query(asked(&challenge, None))).await;
        assert_eq!((status, said), (StatusCode::OK, json!({ "agents": [] })), "a key named by no one is proved to no one");
        let owner = chain::owner_address(node.keys.as_ref()).unwrap();
        let (status, Json(said)) = node_proof(State(door(&node)), Query(asked(&challenge, Some(hex::encode(owner.as_slice()))))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(said["address"], json!(format!("{owner:#x}")), "{said}");
        assert!(said["signature"].as_str().is_some_and(|s| s.starts_with("0x") && s.len() > 100), "{said}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
