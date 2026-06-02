#!/usr/bin/env bash
# hole-template-gate.sh — witness for expose-holes-only.
#
# The node (the user's "we only EXPOSE what is needed to the client like the
# holes to fill via their llm and auth thats it"): the backend hands the client
# a request SKELETON + a typed list of HOLES (auth from vault, params from its
# LLM) carrying NO secret, and the client fills the holes locally. Verifies:
#   1. the module builds,
#   2. extractHoles exposes only holes (skeleton + holes carry no secret), each
#      typed/located/wallet-bound; fillHoles reconstructs a concrete request from
#      local fills, leaves unfilled holes visible, and does not mutate the
#      template — via the test (chained off the real obfuscation output).
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/capture/hole-template.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "hole-template-gate: FAIL — hole-template module does not build"; exit 1
fi

if ! bun test tests/hole-template.test.ts >/dev/null 2>&1; then
  echo "hole-template-gate: FAIL — hole-template test red"; exit 1
fi

echo "hole-template-gate: ok — backend exposes only skeleton + typed holes (no secret), client fills holes locally into a concrete request"
exit 0
