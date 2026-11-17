#!/usr/bin/env bash
# A node container: seeds the node's home on its first boot, opens the door the workload reaches it by, and runs the
# node headless in live mode against the chain container.
#
#   NODE_NAME     node-1, node-2, node-3
#   NODE_KEY      the owner's root key (one of Anvil's published test keys)
#   NODE_ROLE     contributor (keeps the shop's routes to list: a search; one that writes; and one that writes but
#                 is listed in read words) or caller
#                 (signed in to the shop)
#
# The node's agent API listens on 127.0.0.1 only and answers only Host headers naming that address
# (api.rs `own_host_only`). The door is a plain TCP relay from :7700 to it, so a caller in another container still
# reaches the node through its loopback and names 127.0.0.1:7788 as the host itself (the workload does).
set -euo pipefail

: "${NODE_NAME:?}" "${NODE_KEY:?}" "${NODE_ROLE:?}"
export UNBROWSE_HOME=/data
mkdir -p "$UNBROWSE_HOME"

# The network file the chain container wrote once it deployed Settlement.
for _ in $(seq 1 600); do
  [ -f /shared/chain-ready ] && [ -f /shared/arc-testnet.json ] && break
  sleep 0.5
done
mkdir -p "$UNBROWSE_HOME/networks"
cp /shared/arc-testnet.json "$UNBROWSE_HOME/networks/arc-testnet.json"

if [ ! -f "$UNBROWSE_HOME/root.key" ]; then
  echo "$NODE_NAME: first boot, seeding its home"
  printf '%s' "${NODE_KEY#0x}" > "$UNBROWSE_HOME/root.key"
  chmod 600 "$UNBROWSE_HOME/root.key"
  share=off
  [ "$NODE_ROLE" = contributor ] && share=all
  cat > "$UNBROWSE_HOME/settings.json" <<EOF
{
  "map_while_browsing": true, "hold_routes": false, "signed_in_calls": true, "paused": false, "api_port": 7788,
  "storage_gb": 1.0, "excluded": [], "share_routes": "$share", "share_notice_seen": true, "share_previewed": true, "private_network": true,
  "peer_network": true, "light": false, "auto_update": false, "passkeys": false,
  "passkeys_never": [], "chain": "arc-testnet", "max_fetch_usdc": 0.5, "accept_bearer": true
}
EOF
  # The node holds off the network until its terms are acknowledged; a node with no window does it from a shell.
  unbrowse-node terms accept
  mkdir -p "$UNBROWSE_HOME/jars" "$UNBROWSE_HOME/routes"
  case "$NODE_ROLE" in
    contributor) cp /opt/unbrowse-antithesis/route-*.json "$UNBROWSE_HOME/routes/" ;;
    caller) printf '{"sid":"%s-session"}' "$NODE_NAME" > "$UNBROWSE_HOME/jars/shop.example.com.json" ;;
  esac
fi

# NODE_ANNOUNCE=self names the container's own address as the node's, as an owner who knows it sets UNBROWSE_ANNOUNCE;
# left unset, AutoNAT decides whether the node is reachable.
if [ "${NODE_ANNOUNCE:-}" = self ]; then
  ip=$(hostname -i | awk '{print $1}')
  export UNBROWSE_ANNOUNCE="/ip4/$ip/tcp/4001,/ip4/$ip/udp/4001/quic-v1"
fi

socat TCP-LISTEN:7700,fork,reuseaddr TCP:127.0.0.1:7788 &
exec unbrowse-node
