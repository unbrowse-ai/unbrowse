#!/usr/bin/env bash
# unbrowse-flex-settlement evidence: the documented Flex client flow + PayAI
# facilitator contract, bundled from the prior session's doc pulls so the
# wave is offline-stable. Emits faremeter:<doc> JSONL rows.
set -uo pipefail
emit(){ python3 - "$1" "$2" "$3" "$4" <<'PY'
import json,sys
sid,t,b,c=sys.argv[1:5]
print(json.dumps({"source_id":sid,"kind":"faremeter","title":t,"body":b[:3500],"context":[x for x in c.split("||") if x],"score":0}))
PY
}
emit "faremeter:flex-quickstart#escrow" "Flex client escrow + session key creation" \
 "@faremeter/flex-solana: getCreateEscrowInstructionAsync (the facilitator address is set HERE, the primary facilitator config point), getRegisterSessionKeyInstructionAsync; session key is an Ed25519 keypair generated via Web Crypto, reused for all authorizations. Source: docs.faremeter.xyz/flex/quickstart." \
 "escrow create||session key authorization||facilitator binding||@faremeter/flex-solana"
emit "faremeter:flex-quickstart#authorize" "On HTTP 402, createPaymentHandler builds + session-key-signs the authorization and @faremeter/fetch wrap retries" \
 "On 402: createPaymentHandler from @faremeter/payment-solana/flex/client inspects requirements, picks maxAmount + a fresh authorizationId, calls serializePaymentAuthorization, signs with the Ed25519 session key, and @faremeter/fetch wrap retries the request with the signed authorization. Source: docs.faremeter.xyz/flex/quickstart + /flex/concepts." \
 "session key authorization||serializePaymentAuthorization||createPaymentHandler||retry||authorize and settle"
emit "faremeter:flex-concepts#splits" "Flex authorization splits: recipient list, bps sum exactly 10000, MAX 5 per authorization" \
 "Flex concepts: the signed authorization carries a splits array; bps must sum to exactly 10000; the on-chain program supports MAX 5 splits per authorization. This is exactly the shape computeFlexSplits already emits (platform 1000 + <=4 contributors), so the wave wires computeFlexSplits output INTO the authorization unchanged. Source: docs.faremeter.xyz/flex/concepts." \
 "splits array||computeFlexSplits frozen||authorization||10000 bps||max 5"
emit "faremeter:payai#facilitator" "PayAI facilitator /verify + /settle contract (Solana-first, gasless)" \
 "PayAI hosted facilitator at https://facilitator.payai.network (repo github.com/payainetwork/x402-solana; docs docs.payai.network/x402/reference): /verify validates the payment payload, /settle settles on-chain on the server's behalf, gasless. The test echo https://x402.payai.network instant-refunds test payments = the real NO-MOCK behavioral falsifier for the settle path. Source: docs.payai.network/x402/reference." \
 "payai facilitator||verify settle||no-mock falsifier||x402.payai.network echo||authorize and settle"
