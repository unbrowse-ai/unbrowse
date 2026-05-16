#!/usr/bin/env bash
# unbrowse-flex-settlement evidence: real current state. Emits code:path#Ln
# JSONL rows. Substrate-enables: records what the code declares today.
set -uo pipefail
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
emit(){ python3 - "$1" "$2" "$3" "$4" <<'PY'
import json,sys
sid,t,b,c=sys.argv[1:5]
print(json.dumps({"source_id":sid,"kind":"code","title":t,"body":b[:3500],"context":[x for x in c.split("||") if x],"score":0}))
PY
}
ln(){ grep -n -- "$2" "$1" 2>/dev/null|head -1|cut -d: -f1||echo 0; }
F=src/payments/index.ts
emit "code:$F#buildGateRefusal" "buildGateRefusal only surfaces a structured refusal, does not settle" \
 "Today the 402 path returns buildGateRefusal() structured next_step (account-or-x402 gate from 6ef1fed9). It does NOT create an escrow, sign a session-key authorization, or submit to a facilitator. This wave adds real Flex settlement after the gate." \
 "flex settlement||session key authorization||escrow create||payai facilitator||does not settle"
L=$(ln "$F" 'UNBROWSE_X402_FACILITATOR'); emit "code:$F#L$L" "facilitator is declared config defaulting to PayAI (from 6ef1fed9)" \
 "X402_CONFIG.facilitator = process.env.UNBROWSE_X402_FACILITATOR ?? https://facilitator.payai.network (line $L). The Flex escrow must bind THIS declared facilitator at escrow-creation time; no hardcoded literal." \
 "payai facilitator||declared config||escrow create||facilitator binding"
F=src/client/index.ts
L=$(ln "$F" 'payAndRetry'); emit "code:$F#L$L" "CLI payAndRetry is lobster-pay, not a Flex session-key authorization" \
 "src/client/index.ts ~L$L imports payAndRetry from ../payments/lobster-pay.js. This wave's settle path must produce a Faremeter Flex session-key-signed authorization, not only the lobster pay-and-retry, and reach parity on both CLI and MCP." \
 "flex settlement||session key authorization||cli path||payment parity"
F=src/mcp.ts
L=$(ln "$F" 'payment_required'); emit "code:$F#L$L" "MCP api() 402 branch returns structured payment_required, no settle" \
 "src/mcp.ts ~L$L the 402 branch returns {error:payment_required,next_step:buildGateRefusal()}. It must, when a wallet/escrow is available, settle via Flex+PayAI and retry, parity with the CLI." \
 "flex settlement||mcp path||payment parity||does not settle||session key authorization"
F=backend/src/services/flex.ts
L=$(ln "$F" 'PLATFORM_BPS'); emit "code:$F#L$L" "computeFlexSplits FROZEN: platform 1000 bps, total 10000, <=5 recipients" \
 "PLATFORM_BPS=1000 (line $L); computeFlexSplits is the splits source for the Flex authorization. NON-GOAL: do not change this math. The authorization splits array MUST equal computeFlexSplits output (sum 10000, <=5)." \
 "computeFlexSplits frozen||splits array||authorization||do not change math"
DEP=$(grep -nE '@faremeter/(flex-solana|payment-solana|fetch)' package.json 2>/dev/null||echo "")
emit "code:package.json#faremeter-deps" "@faremeter/flex-solana deps presence in package.json" \
 "grep result: ${DEP:-NONE FOUND}. The prior audit found @faremeter/flex-solana / @faremeter/payment-solana / @faremeter/fetch were NOT dependencies. This wave must add them (or vendor the documented client flow) to build the authorization+escrow path." \
 "add dependency||flex-solana||escrow create||session key authorization"
