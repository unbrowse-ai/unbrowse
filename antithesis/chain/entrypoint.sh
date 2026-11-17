#!/usr/bin/env bash
# The chain container: an Anvil that stands in for Arc testnet (its chain id and base fee, nothing forked), set up the
# way the node's own live-mode test sets one up (chain/tests.rs `a_live_network_runs_on_the_contracts_its_file_records`):
#
#   - the stand-in ERC-8004 registry's code at Arc testnet's registry address (testchain.rs `with_registry`);
#   - a 6-decimal test USDC's code and storage at Arc's USDC address (chain.rs `stand_in_usdc`);
#   - Settlement, UNB and the pool deployed by the node's own `unbrowse-node chain deploy --pool`, signed by a
#     platform key, which writes the network file every node then reads;
#   - each node's owner given gas, USDC and UNB, as a faucet would.
#
# Every key here is one of Anvil's published test keys: no real key, no real funds, no live chain.
# The first boot sets everything up and records it on the state volume; a restart reloads the chain's state.
set -euo pipefail

RPC=http://127.0.0.1:8545
STATE=/state
SHARED=/shared
REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
USDC=0x3600000000000000000000000000000000000000
# Anvil's account 0: the platform, which deploys Settlement and owns the test tokens' faucets.
PLATFORM_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PLATFORM=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# The nodes' owners (Anvil's accounts 1-3), each written as that node's root key by its entrypoint.
OWNERS="${UNBROWSE_OWNERS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0x90F79bf6EB2c4f870365E785982E1f101E93b906}"

mkdir -p "$STATE" "$SHARED"
rm -f "$SHARED/chain-ready"

anvil --host 0.0.0.0 --port 8545 --chain-id 5042002 --base-fee 20000000000 --slots-in-an-epoch 0 \
  --state "$STATE/anvil.json" --state-interval 1 --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null; wait $ANVIL' TERM INT

for _ in $(seq 1 300); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
[ "$(cast chain-id --rpc-url "$RPC")" = 5042002 ] || { echo "chain: Anvil didn't start" >&2; exit 1; }

send() { cast send --rpc-url "$RPC" --private-key "$PLATFORM_KEY" "$@" >/dev/null; }

if [ ! -f "$STATE/setup-done" ]; then
  echo "chain: first boot, setting up arc-testnet's stand-ins"
  cast rpc --rpc-url "$RPC" anvil_setBalance "$PLATFORM" 0x21e19e0c9bab2400000 >/dev/null

  cast rpc --rpc-url "$RPC" anvil_setCode "$REGISTRY" "$(tr -d '[:space:]' < /opt/unbrowse-antithesis/Erc8004StandIn.runtime.hex)" >/dev/null

  # A test USDC of 6 decimals, its code and constructor-written slots copied to Arc's USDC address.
  made=$(cast send --rpc-url "$RPC" --private-key "$PLATFORM_KEY" --json \
    --create "$(jq -r .bytecode.object /opt/unbrowse-antithesis/USDC.json)$(cast abi-encode 'constructor(uint8)' 6 | cut -c3-)" | jq -r .contractAddress)
  cast rpc --rpc-url "$RPC" anvil_setCode "$USDC" "$(cast code --rpc-url "$RPC" "$made")" >/dev/null
  for slot in 0 1 2 3 4 5 6 7; do
    v=$(cast storage --rpc-url "$RPC" "$made" "$slot")
    if [ "$v" != 0x0000000000000000000000000000000000000000000000000000000000000000 ]; then
      cast rpc --rpc-url "$RPC" anvil_setStorageAt "$USDC" "$(cast to-uint256 "$slot")" "$v" >/dev/null
    fi
  done
  [ "$(cast call --rpc-url "$RPC" "$USDC" 'decimals()(uint8)')" = 6 ] || { echo "chain: the stand-in USDC isn't 6 decimals" >&2; exit 1; }
  send "$USDC" 'faucet(address,uint256)' "$PLATFORM" 10000000000

  # Settlement, UNB and the pool, deployed by the node's own CLI as an owner deploys them on a live network.
  home="$STATE/platform"
  mkdir -p "$home"
  printf '%s' "${PLATFORM_KEY#0x}" > "$home/root.key"
  chmod 600 "$home/root.key"
  # An epoch here, in blocks (R1.28): few, so a day passes in a moment. Past epoch 0, as every chain Settlement runs on is.
  mkdir -p "$home/networks"
  printf '{"network":"arc-testnet","chain_id":5042002,"epoch_blocks":7200,"existing":{"usdc":"%s"}}' "$USDC" > "$home/networks/arc-testnet.json"
  cast rpc --rpc-url "$RPC" anvil_mine 0x1c20 >/dev/null
  UNBROWSE_HOME="$home" UNBROWSE_CHAIN=arc-testnet UNBROWSE_RPC="$RPC" unbrowse-node chain deploy --domain-deposit 10 --witness-fee 1 --minority-loss 0.25 --pool 1000 1000
  # The built-in file reads registrations from Arc testnet's own height; this chain starts at block 0.
  jq '.registry_from = 0' "$home/networks/arc-testnet.json" > "$STATE/arc-testnet.json"

  # Gas and test USDC only. No UNB: there is no faucet (spec §76 R9.17), and there is no bond to post.
  for owner in $OWNERS; do
    cast rpc --rpc-url "$RPC" anvil_setBalance "$owner" 0x3635c9adc5dea00000 >/dev/null
    send "$USDC" 'faucet(address,uint256)' "$owner" 1000000000
  done
  touch "$STATE/setup-done"
  echo "chain: set up; Settlement $(jq -r .deployment.settlement "$STATE/arc-testnet.json")"
fi

cp "$STATE/arc-testnet.json" "$SHARED/arc-testnet.json.tmp" && mv "$SHARED/arc-testnet.json.tmp" "$SHARED/arc-testnet.json"
touch "$SHARED/chain-ready"
echo "chain: ready on :8545"
wait $ANVIL
