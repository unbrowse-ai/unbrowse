#!/bin/bash
# Apply the Nebius/chat-completions port onto the (gitignored) vendored
# perplexityai/search_evals harness, so the BrowseComp/Exa agent + grader can
# run on Nebius TokenFactory models (e.g. moonshotai/Kimi-K2.6) instead of
# OpenAI's Responses API. Idempotent — re-run after re-cloning the vendor.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../vendor/search_evals/search_evals"
[[ -d "$V" ]] || { echo "vendored search_evals not found at $V — clone it first" >&2; exit 1; }
cp "$HERE/agents/llms/nebius.py"   "$V/agents/llms/nebius.py"
cp "$HERE/agents/llms/__init__.py" "$V/agents/llms/__init__.py"
cp "$HERE/suites/graders.py"       "$V/suites/graders.py"
echo "✓ Nebius port applied to $V"
echo
echo "Run a BrowseComp slice (Kimi agent + Kimi grader):"
echo "  set -a; . ~/.config/env/global.env; set +a"
echo "  cd $HERE/../vendor/search_evals"
echo "  GRADER_BACKEND=nebius GRADER_MODEL=moonshotai/Kimi-K2.6 \\"
echo "  BROWSECOMP_LIMIT=10 UNBROWSE_BIN=/opt/homebrew/bin/unbrowse \\"
echo "    uv run python search_evals/run_eval.py search_engine=unbrowse \\"
echo "      model=nebius/moonshotai/Kimi-K2.6 suite=browsecomp rerun=true max_workers=5"
