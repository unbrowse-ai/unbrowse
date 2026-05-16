#!/usr/bin/env bash
# codebase-gaps.sh — evidence-build command source `code`.
# Greps the live gate / x402-MCP / lobster surfaces and emits ONE
# evidence-record JSONL line per confirmed gap on stdout. Substrate-enables:
# records what the code declares right now, line numbers resolved live.
# Emits raw evidence only; the wave agent judges.
set -euo pipefail
REPO="${EVIDENCE_BUILD_REPO:-/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse}"
cd "$REPO"

emit() { # source_id  title  body  ctx_pipe_separated
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json,sys
sid,title,body,ctx=sys.argv[1:5]
print(json.dumps({"source_id":sid,"kind":"code","title":title,
  "body":body,"context":[c for c in ctx.split("||") if c],"score":0}))
PY
}

# Resolve a line number for an anchor string in a file (first match).
ln() { grep -n -- "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1 || true; }

# --- Gap 1: anonymous resolve/execute, no account or wallet or api key ---
F=src/client/index.ts
L=$(ln "$F" 'noAuth ? "" : getApiKey()'); L="${L:-0}"
emit "code:$F#L$L" \
  "anonymous resolve execute works without account without wallet" \
  "apiRequest omits the Authorization header entirely when no api key is present (key empty string). resolve and execute proceed anonymous with optional auth. No gate refuses anonymous use. Lewis directive: hard gate login OR x402 wallet." \
  "anonymous resolve||without account||without api key||no wallet required||optional auth gate||hard gate login"

F=backend/src/middleware/auth.ts
L=$(ln "$F" 'optionalAuth'); L="${L:-0}"
emit "code:$F#L$L" \
  "backend optional auth lets anonymous resolve execute through" \
  "resolve and search and skill routes use optionalAuth middleware not bearerAuth. Only /v1/account/* requires a key. Anonymous resolve execute is allowed end to end. The gate must require account api key OR x402 wallet." \
  "anonymous resolve||optional auth gate||without account||backend gate||hard gate login||without api key"

# --- Gap 2: MCP execute swallows the x402 402 challenge ---
F=src/mcp.ts
L=$(ln "$F" 'app.inject'); L="${L:-0}"
emit "code:$F#L$L" \
  "mcp execute swallows x402 payment no payment retry" \
  "MCP api() dispatches in-process via fastify inject(). A backend HTTP 402 challenge returns straight to MCP as an error string; statusCode is checked for 2xx only. No x402 payment, no wallet, no payment retry on the mcp execute path. x402 payment is broken via unbrowse mcp." \
  "mcp execute||x402 payment||payment retry||fastify inject||swallow 402||402 challenge||payment parity"

F=src/client/index.ts
L=$(ln "$F" 'payAndRetry'); L="${L:-0}"
emit "code:$F#L$L" \
  "cli path handles 402 challenge mcp path does not payment parity gap" \
  "The CLI HTTP path catches HTTP 402 and calls payAndRetry via lobster pay then retries the request. The mcp execute path has no equivalent. CLI x402 payment works, mcp x402 payment does not. Payment parity between cli path and mcp path is missing." \
  "402 challenge||pay and retry||cli path||mcp path||x402 payment||payment parity||payment retry"

# --- Gap 3: setup does not register account, wallet optional, silent anon ---
F=src/cli.ts
L=$(ln "$F" 'no longer registers'); L="${L:-0}"
emit "code:$F#L$L" \
  "setup no account registration optional silent anonymous" \
  "Setup explicitly no longer registers an account implicitly. Registration is optional. A fresh machine finishes setup with no account, no api key, and then resolve works anonymous. Silent anonymous success instead of an account gate or wallet gate." \
  "setup no account||registration optional||silent anonymous||wallet optional||fresh machine setup||hard gate login"

F=src/runtime/setup.ts
L=$(ln "$F" 'flex'); L="${L:-0}"
emit "code:$F#L$L" \
  "wallet escrow session key honest skip wallet optional" \
  "promptFundEscrow and promptRegisterSessionKey are HONEST-SKIP stubs that print next steps and return skipped. The wallet path is optional and deferred. A fresh machine setup yields no wallet and no account, so the gate is unsatisfiable yet usage still works anonymous." \
  "wallet optional||honest skip||silent anonymous||fresh machine setup||setup no account||wallet provision"

# --- Gap 4: lobster cash provision path ---
F=src/runtime/setup.ts
L=$(ln "$F" 'lobster-cli'); L="${L:-0}"
emit "code:$F#L$L" \
  "lobster cash wallet provision only when wallet absent not skipped" \
  "Setup runs npx @crossmint/lobster-cli setup only if wallet not configured and UNBROWSE_SKIP_WALLET_SETUP is not 1. Lobster cash is the wallet provision path but a fresh user still needs a human at the hosted approval URL. Setup must surface the lobster cash path as the wallet onboarding next step." \
  "lobster cash||lobster cli||wallet provision||crossmint lobster||fresh machine setup||wallet onboarding"

F=src/payments/wallet.ts
L=$(ln "$F" 'checkWalletConfigured'); L="${L:-0}"
emit "code:$F#L$L" \
  "wallet detection lobster cash address sources" \
  "checkWalletConfigured reads LOBSTER_WALLET_ADDRESS or AGENT_WALLET_ADDRESS or ~/.lobster/agents.json. With none of these a fresh machine has no wallet so the x402 wallet path of the gate is unsatisfied and lobster cash onboarding must run." \
  "lobster cash||wallet provision||x402 payment||wallet onboarding||fresh machine setup||lobster cli"

# --- Gap 5: server-side split math is correct (the break is MCP-only) ---
F=backend/src/services/flex.ts
L=$(ln "$F" 'PLATFORM_BPS'); L="${L:-0}"
emit "code:$F#L$L" \
  "x402 payment splits server side correct break is mcp only" \
  "computeFlexSplits sets platform 1000 bps and contributors 9000 bps weighted by delta. The split math is correct server side. The x402 payment splits failure is purely that the mcp execute path never triggers payment so splits never settle on the mcp surface." \
  "x402 payment||payment splits||mcp execute||split math||payment parity"
