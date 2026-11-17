//! The networks the node runs on, and the addresses on each that it uses but doesn't deploy. Nothing outside this
//! table names a chain ID or an address the node didn't deploy itself.
//!
//! Every value here was read from the chain it names on 28 October 2026: the chain ID from its RPC, USDC's decimals
//! and name, and the ERC-8004 registries' code and `name()` ("AgentIdentity"). `the_table_matches_the_live_chains`
//! reads them again.
//!
//! Arc's own contracts come first (spec §75.4): the node deploys only what Arc lacks (Settlement, its route stakes and
//! the account delegate) and uses the rest where Arc runs it, from Arc's list (docs.arc.io, "Contract addresses"),
//! each read again on 31 October 2026 (`arcs_own_contracts_are_where_the_table_says`):
//! - the ERC-8004 IdentityRegistry, for the identity the node registers at sign-in;
//! - USDC's ERC-20 interface, FiatTokenV2 under the EIP-712 domain ("USDC", "2"), whose EIP-3009
//!   `receiveWithAuthorization` takes a deposit with no approval first (`chain::deposit`);
//! - Multicall3From, which batches a key's writes as that key (`rpc::batch`) where its EIP-7702 delegate isn't set;
//! - CCTP v2 and Gateway, through which USDC held on another chain reaches the node's address (`funding`): no bridge
//!   of the node's own.

use alloy::primitives::{address, Address};

// The Reputation and Validation registries are named for what may move onto them (spec §75.4, proposed).
#[allow(dead_code)]
#[derive(Debug)]
pub struct Network {
    pub name: &'static str,
    pub chain_id: u64,
    pub rpc: &'static str,
    /// USDC's ERC-20 interface to Arc's native gas token: 6 decimals, EIP-3009 authorisations.
    pub usdc: Address,
    /// The ERC-8004 IdentityRegistry: one identity per wallet, its metadata, its agent wallet.
    pub identity: Address,
    /// The ERC-8004 ReputationRegistry.
    pub reputation: Address,
    /// The ERC-8004 ValidationRegistry. Unused: the protocol doesn't use it (R1.16).
    pub validation: Address,
    /// Multicall3From: `aggregate3` from a key runs each call with that key as its sender, through Arc's CallFrom
    /// precompile.
    pub multicall3_from: Address,
    /// CCTP v2's TokenMessengerV2 on this network, and Arc's CCTP domain: USDC burned on another chain for a recipient
    /// here is minted here.
    pub cctp_messenger: Address,
    /// Gateway's minter here: a Gateway balance on any chain is minted to an address here.
    pub gateway_minter: Address,
    /// Where an address gets this network's gas for free, if anywhere: a testnet's faucet.
    pub faucet: Option<&'static str>,
    /// The network's file as this build ships it (`app/networks/<name>.json`): the contracts every node on it shares
    /// (`chain::NetworkFile`).
    pub file: &'static str,
}

pub const ARC_MAINNET: Network = Network {
    name: "arc-mainnet",
    chain_id: 5042,
    rpc: "https://rpc.mainnet.arc.io",
    usdc: address!("3600000000000000000000000000000000000000"),
    identity: address!("8004A169FB4a3325136EB29fA0ceB6D2e539a432"),
    reputation: address!("8004BAa17C55a88189AE136b182e5fdA19dE9b63"),
    validation: address!("8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58"),
    multicall3_from: MULTICALL3_FROM,
    cctp_messenger: address!("28b5a0e9C621a5BadaA536219b3a228C8168cf5d"),
    gateway_minter: address!("2222222d7164433c4C09B0b0D809a9b52C04C205"),
    faucet: None,
    file: include_str!("../networks/arc-mainnet.json"),
};

pub const ARC_TESTNET: Network = Network {
    name: "arc-testnet",
    chain_id: 5042002,
    rpc: "https://rpc.testnet.arc.io",
    usdc: address!("3600000000000000000000000000000000000000"),
    identity: address!("8004A818BFB912233c491871b3d84c89A494BD9e"),
    reputation: address!("8004B663056A597Dffe9eCcC1965A193B7388713"),
    validation: address!("8004Cb1BF31DAf7788923b405b754f57acEB4272"),
    multicall3_from: MULTICALL3_FROM,
    cctp_messenger: address!("8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"),
    gateway_minter: address!("0022222ABE238Cc2C7Bb1f21003F0a260052475B"),
    faucet: Some("Circle's faucet, https://faucet.circle.com"),
    file: include_str!("../networks/arc-testnet.json"),
};

/// Multicall3From, at one address on both networks.
pub const MULTICALL3_FROM: Address = address!("522fAf9A91c41c443c66765030741e4AaCe147D0");
/// Arc's CCTP domain, the same on both networks: what a burn on another chain names to mint here.
pub const CCTP_DOMAIN: u32 = 26;

/// Every Arc network the node knows.
pub const NETWORKS: [&Network; 2] = [&ARC_MAINNET, &ARC_TESTNET];

/// The chain ID of a devnet that forks nothing: Anvil's own, on which no Arc contract exists.
pub const LOCAL_CHAIN_ID: u64 = 31337;

/// Arc's base fee never falls below 20 Gwei. A devnet that forks nothing starts at the same base fee, so its fees
/// behave as Arc's do.
pub const BASE_FEE_FLOOR: u128 = 20_000_000_000;

/// The Arc network with this chain ID, if it is one.
pub fn by_chain_id(id: u64) -> Option<&'static Network> {
    NETWORKS.into_iter().find(|n| n.chain_id == id)
}

/// The Arc network with this name, if it is one.
pub fn by_name(name: &str) -> Option<&'static Network> {
    NETWORKS.into_iter().find(|n| n.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ProviderBuilder;
    use alloy::providers::Provider;
    use alloy::sol;

    sol! {
        #[sol(rpc)]
        interface Named {
            function name() external view returns (string);
            function decimals() external view returns (uint8);
        }
    }

    #[test]
    fn a_network_is_found_by_its_id_and_its_name() {
        assert_eq!(by_chain_id(5042002).map(|n| n.name), Some("arc-testnet"));
        assert_eq!(by_name("arc-mainnet").map(|n| n.chain_id), Some(5042));
        assert!(by_chain_id(LOCAL_CHAIN_ID).is_none(), "a plain devnet is no Arc network");
    }

    /// Reads every value in the table from the chain it names. Needs the network:
    /// `cargo test -p unbrowse-node-app arc -- --ignored`
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn the_table_matches_the_live_chains() {
        for n in NETWORKS {
            let p = ProviderBuilder::new().connect_http(n.rpc.parse().unwrap());
            assert_eq!(p.get_chain_id().await.unwrap(), n.chain_id, "{}", n.name);
            let usdc = Named::new(n.usdc, &p);
            assert_eq!(usdc.decimals().call().await.unwrap(), 6, "{} USDC", n.name);
            assert_eq!(usdc.name().call().await.unwrap(), "USDC", "{} USDC", n.name);
            assert_eq!(Named::new(n.identity, &p).name().call().await.unwrap(), "AgentIdentity", "{} identity", n.name);
            assert!(!p.get_code_at(n.reputation).await.unwrap().is_empty(), "{} reputation", n.name);
        }
    }

    /// Arc's block headers rehash in this build, so the node proves its receipts there against their blocks
    /// (`proof`); if they don't, every receipt there is only its RPC's word, and the node keeps the slower rules for
    /// what it can't prove. Read only. Needs the network: `cargo test -p unbrowse-node-app arc_headers -- --ignored`
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn arc_headers_rehash_in_this_build() {
        for n in NETWORKS {
            let p = ProviderBuilder::new().connect_http(n.rpc.parse().unwrap());
            let b = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Finalized).await.unwrap().unwrap();
            assert_eq!(b.header.inner.hash_slow(), b.header.hash, "{} headers rehash", n.name);
        }
    }

    /// Arc's own contracts are where the table says, on the network it says: code at each, none at the other
    /// network's (the ERC-8004 registries and CCTP differ between them), and USDC's EIP-3009 domain is ("USDC", "2").
    /// Read only: nothing is sent. Needs the network: `cargo test -p unbrowse-node-app arc -- --ignored`
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn arcs_own_contracts_are_where_the_table_says() {
        sol! {
            #[sol(rpc)]
            interface Fiat {
                function version() external view returns (string);
                function DOMAIN_SEPARATOR() external view returns (bytes32);
            }
        }
        for n in NETWORKS {
            let p = ProviderBuilder::new().connect_http(n.rpc.parse().unwrap());
            for (what, a) in [("validation", n.validation), ("Multicall3From", n.multicall3_from), ("CCTP", n.cctp_messenger), ("Gateway", n.gateway_minter)] {
                assert!(!p.get_code_at(a).await.unwrap().is_empty(), "{} {what} at {a:#x}", n.name);
            }
            let fiat = Fiat::new(n.usdc, &p);
            assert_eq!(fiat.version().call().await.unwrap(), "2", "{} USDC's EIP-712 version", n.name);
            let domain = alloy::sol_types::eip712_domain! { name: "USDC", version: "2", chain_id: n.chain_id, verifying_contract: n.usdc, };
            assert_eq!(fiat.DOMAIN_SEPARATOR().call().await.unwrap(), domain.separator(), "{} USDC's domain", n.name);
        }
    }

    /// Arc finalizes each block as it commits it (Malachite BFT, "deterministic, sub-second"): its RPC serves the
    /// `finalized` and `safe` blocks, and they are the head or a block behind it. The node counts a write once its
    /// block is final (`rpc::finalized`), so on Arc that costs a read or two; if this ever fails, writes start waiting
    /// out `FINALITY_TIMEOUT`. Measured on 31 October 2026: 0 blocks behind on most reads, 1 on a few, on both
    /// networks. Needs the network: `cargo test -p unbrowse-node-app arc -- --ignored`
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn arc_blocks_are_final_as_they_are_made() {
        use alloy::eips::BlockNumberOrTag;
        for n in NETWORKS {
            let p = ProviderBuilder::new().connect_http(n.rpc.parse().unwrap());
            for _ in 0..5 {
                let head = p.get_block_number().await.unwrap();
                for tag in [BlockNumberOrTag::Finalized, BlockNumberOrTag::Safe] {
                    let at = p.get_block_by_number(tag).await.unwrap().unwrap_or_else(|| panic!("{} serves {tag}", n.name)).header.number;
                    // Read after the head, so a block made between the two reads puts it ahead, never further behind.
                    assert!(at + 2 >= head, "{}: the {tag} block {at} is more than two behind the head {head}", n.name);
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }

    /// One epoch is the blocks a network makes in 24 hours (R1.28): how the owner measures the `epoch_blocks` a network's
    /// file takes, and sees whether a deployed one has drifted from a day. The pace is read over the last week of
    /// blocks, the span the owner measures a network over before its deploy (docs/OPERATIONS.md §3), so a slow hour or
    /// a quiet day moves it little. Prints each network's pace, and holds a file that names a number to within 5% of
    /// it: a drift that small is accepted, since the number is fixed for the deployment's life. Read only. Needs the
    /// network: `cargo test -p unbrowse-node-app epoch_blocks_are_a_day -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn a_networks_epoch_blocks_are_a_day_of_its_blocks() {
        const PROBE: u64 = 100_000;
        for n in NETWORKS {
            let p = ProviderBuilder::new().connect_http(n.rpc.parse().unwrap());
            let block = async |at: u64| p.get_block_by_number(at.into()).await.unwrap().unwrap().header.timestamp;
            let head = p.get_block_number().await.unwrap();
            // A first pace over the last `PROBE` blocks says how far back a week is; the pace is then read over that week.
            let probe = PROBE * crate::chain::EPOCH / (block(head).await - block(head - PROBE).await);
            let back = (7 * probe).min(head);
            let span = block(head).await - block(head - back).await;
            let a_day = back * crate::chain::EPOCH / span;
            println!("{}: {a_day} blocks in 24 hours, over the last {back} (about a week)", n.name);
            let file: crate::chain::NetworkFile = serde_json::from_str(n.file).unwrap();
            if let Some(blocks) = file.epoch_blocks {
                assert!(blocks.abs_diff(a_day) * 20 <= a_day, "{}: the file says {blocks}, the chain makes {a_day}", n.name);
            }
        }
    }
}
