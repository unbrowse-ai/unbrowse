#!/usr/bin/env bash
# bench/capability/webagent/gate_grpc.sh — gRPC witness, DEFAULT surface.
#
# A gRPC-web unary call is a POST with `content-type: application/grpc-web-text` and a base64
# gRPC-web frame (1 flag byte + 4-byte big-endian length + protobuf message). This gate drives
# the DEFAULT one-hole / fetch path against a public gRPC-web endpoint and PASSES only when a
# real, decodable gRPC-web response comes back (grpc-status: 0 in the trailer, or a non-empty
# protobuf message frame) — not merely an HTTP 200 error page.
#
# HONEST: as of this writing the fetch-based CLI does not do gRPC-web framing / protobuf, so
# this gate FAILS (the gRPC axis is genuinely uncovered). It exists so the capability-coverage
# aggregate counts gRPC as a real failing axis — coverage is measured, never gamed by omission.
# When real gRPC-web support lands, this gate turns green on its own.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

# grpcb.in offers gRPC-web. Empty unary: frame = 00 00000000 → base64 "AAAAAAA=".
URL="https://grpcb.in:9001/grpcbin.GRPCBin/Empty"

V="FAIL"
# Inline (not a function) so `timeout` actually runs the CLI — `timeout <fn>` fails with
# "No such file or directory", which would skip the real gRPC attempt entirely.
out="$(timeout 40 $BIN_CMD fetch "$URL" --method POST \
  --header "content-type: application/grpc-web-text" --body "AAAAAAA=" 2>/dev/null || true)"
# A real gRPC-web response carries grpc-status:0 or a protobuf message frame.
if echo "$out" | grep -qiE 'grpc-status: ?0|grpc-message'; then
  V="PASS"
else
  # Not a valid gRPC response. Distinguish "host unreachable" (BLOCKED — can't judge) from
  # "host reached but gRPC unsupported" (FAIL — the real, measured state). Only a genuine
  # connect failure is BLOCKED; an error body / empty-after-contact is FAIL, NOT excluded —
  # excluding the hardest axis would silently inflate the capability-coverage number.
  reach="$(timeout 20 $BIN_CMD fetch "https://grpcb.in:9001/" 2>&1 || true)"
  if echo "$reach" | grep -qiE 'ENOTFOUND|ECONNREFUSED|getaddrinfo|connect ETIMEDOUT|could not resolve|network is unreachable'; then
    V="BLOCKED"
  else
    V="FAIL"
  fi
fi

echo " gRPC-web witness: $V  bin=$BIN_CMD"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'P_grpc_onehole',
  'bin':'$BIN_CMD','verdict':'$V','gate':'true' if '$V'=='PASS' else 'false'})+'\n')
"
case "$V" in
  PASS) echo " GATE: PASS — gRPC-web unary call returned a real gRPC response"; exit 0;;
  BLOCKED) echo " GATE: BLOCKED — gRPC endpoint unreachable"; exit 3;;
  *) echo " GATE: FAIL — gRPC not supported (no gRPC-web framing / protobuf codec)"; exit 1;;
esac
