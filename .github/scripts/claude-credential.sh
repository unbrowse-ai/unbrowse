#!/bin/sh
# Which Claude credential answers right now.
#
#   claude-credential.sh NAME...
#
# Each NAME is an environment variable holding a Claude Code OAuth token, in the order to prefer them. Each one that is
# set is asked a single question; the first that answers is named on $GITHUB_OUTPUT as `name=NAME`. A token that is set
# can still refuse (a weekly limit, a revoked login), and `${{ secrets.A || secrets.B }}` in a workflow only moves on
# when A is empty, so a job that picks that way dies with the first token while the second would have answered.
#
# When none answers, each one's reason is a warning on the run and the first that is set is named, so the job fails the
# way it would have, with the reason in view. With ANTHROPIC_API_KEY set nothing is asked: the API key is what runs.
#
# CLAUDE_BIN is the claude program to ask with; without it the locked CLI in .github/tools/claude-cli is, and nothing is
# ever installed here.
set -eu

out="${GITHUB_OUTPUT:-/dev/stdout}"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "An API key is set: it runs, no token is asked"
  exit 0
fi

claude="${CLAUDE_BIN:-}"

# Each token is taken out of the environment before anything else runs: no program started here (mktemp, jq, head, sed,
# rm) inherits one, and the CLI is given the one token it is asked with and nothing else of this step's.
for name in "$@"; do
  eval "held_$name=\${$name:-}"
  unset "$name"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

first_set=
for name in "$@"; do
  eval "token=\$held_$name"
  [ -n "$token" ] || { echo "$name: not set"; continue; }
  [ -n "$first_set" ] || first_set="$name"

  # The CLI is the locked one a secret-free step installed (.github/tools/claude-cli, lifecycle scripts off): nothing is
  # installed here, where the tokens are. Without it no token is asked, and the first that is set goes on as before.
  if [ -z "$claude" ]; then
    claude="${GITHUB_WORKSPACE:-.}/.github/tools/claude-cli/node_modules/.bin/claude"
  fi
  if [ ! -x "$claude" ]; then
    echo "::warning::No locked Claude CLI to ask with (npm ci --ignore-scripts --prefix .github/tools/claude-cli first)"
    break
  fi

  # From an empty directory: the question needs none of the repository's settings, tools or instructions.
  answer=$(cd "$work" && env -i PATH="$PATH" HOME="${HOME:-$work}" CLAUDE_CODE_OAUTH_TOKEN="$token" \
    "$claude" -p "Reply with the word ok." --output-format json --max-turns 1 < /dev/null 2> "$work/err") || true
  if printf '%s' "$answer" | jq -e '.is_error == false' > /dev/null 2>&1; then
    echo "$name: answers"
    echo "name=$name" >> "$out"
    exit 0
  fi
  # The CLI's own words: its result when it gave one, else the first line it wrote to stderr (an expired or revoked
  # login says so there, and "no answer" alone left three nights of failed QA unexplained, UNB-235). Anything shaped
  # like a key is cut out.
  reason=$(printf '%s' "$answer" | jq -r '.result // empty' 2> /dev/null | head -1)
  [ -n "$reason" ] || reason=$(grep -v '^[[:space:]]*$' "$work/err" 2> /dev/null | head -1 | cut -c1-300)
  reason=$(printf '%s' "$reason" | sed -E 's/sk-ant-[A-Za-z0-9_-]+/[redacted]/g')
  echo "::warning::Claude credential $name refuses: ${reason:-no answer}"
done

if [ -n "$first_set" ]; then
  echo "::warning::No Claude credential answers: going on with $first_set"
  echo "name=$first_set" >> "$out"
else
  echo "No Claude credential is set"
fi
