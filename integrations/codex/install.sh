#!/bin/sh
# Connects Codex to the Unbrowse node without the plugin.
#
# - Adds the node's MCP server to $CODEX_HOME/config.toml (default ~/.codex/config.toml) as [mcp_servers.unbrowse]:
#   `unbrowse mcp`, which signs each message with the token and never sends it (npm install -g unbrowse puts it on PATH).
#   An older Unbrowse's [mcp_servers.unbrowse] (12.x: `npx unbrowse mcp`, `dist/cli.js mcp`, an unbrowse.ai address) is
#   replaced, the file as it was kept beside it as config.toml.before-unbrowse-<time>; every other setting stays as it
#   was. This node's server is left alone, and so is one no Unbrowse install wrote.
#   It names the agent (`--agent first`), never its token, which `unbrowse mcp` reads from the owner's grant.
# - Copies the skills into ~/.agents/skills, where Codex reads a user's skills. A folder already there under a skill's
#   name that isn't this copy is moved aside (to ~/.agents/unbrowse-kept/<name>.before-unbrowse-<time>, outside the
#   skills folder so Codex doesn't load it), never deleted.
#
# Safe to run again. UNBROWSE_NODE, when set, is the node's address (default http://127.0.0.1:7788): http:// or
# https://, a host and an optional port, nothing else.
set -eu

case "${1:-}" in
  -h | --help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
  "") ;;
  *)
    echo "install.sh: takes no arguments" >&2
    exit 2
    ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
codex_home=${CODEX_HOME:-$HOME/.codex}
config="$codex_home/config.toml"
skills_to="$HOME/.agents/skills"
node=${UNBROWSE_NODE:-http://127.0.0.1:7788}
node=${node%/}

# The address goes into config.toml as a TOML string, through sed: only a plain address may, never a quote, a
# backslash, a newline or anything sed or TOML reads as more than text.
nl='
'
case "$node" in
  *"$nl"*) bad=1 ;;
  http://?* | https://?*) bad=$(printf '%s' "${node#*://}" | LC_ALL=C tr -d 'A-Za-z0-9.:[]-') ;;
  *) bad=1 ;;
esac
if [ -n "$bad" ]; then
  echo "install.sh: UNBROWSE_NODE is http://host[:port] or https://host[:port], and nothing else; nothing was written" >&2
  exit 2
fi

# ---- the MCP server ----

# Each unbrowse server config.toml declares (`unbrowse`, and `unbrowse-<account>` as the 12.x client named a second
# account's), one per line as `<name> <kind>`, read the way `unbrowse connect` reads them (unb/legacy.rs):
#   legacy   an older Unbrowse's: an unbrowse.ai address, `dist/cli.js mcp`, `unbrowse@12`/`@6`, `unbrowse mcp` without
#            --agent, or the 12.x client's UNBROWSE_CONFIG_DIR / UNBROWSE_SHARED_SIGNIN in its env
#   core     this node's: `unbrowse mcp --agent …`, or a loopback address on 7788 or the node's port
#   unknown  anything else (a fork, another org's proxy): never touched
#   inline   written as dotted keys or an inline table, which this installer doesn't rewrite
#   multiline  holds a multi-line string, which this installer doesn't rewrite
servers() {
  awk -v node="$node" '
    function hostport(u, out,   scheme, hp) {
      if (u !~ /^[A-Za-z][A-Za-z0-9+.-]*:\/\//) return 0
      scheme = tolower(u); sub(/:.*/, "", scheme)
      hp = u; sub(/^[^:]*:\/\//, "", hp); sub(/[\/?#].*/, "", hp); sub(/.*@/, "", hp)
      out["port"] = ""
      if (hp ~ /^\[/) { out["host"] = hp; sub(/\].*/, "]", out["host"]); if (hp ~ /\]:/) { out["port"] = hp; sub(/.*\]:/, "", out["port"]) } }
      else { out["host"] = hp; if (index(hp, ":")) { out["port"] = hp; sub(/^[^:]*:/, "", out["port"]); sub(/:.*/, "", out["host"]) } }
      out["host"] = tolower(out["host"]); sub(/\.$/, "", out["host"])
      if (out["port"] == "") out["port"] = scheme == "https" ? 443 : (scheme == "http" ? 80 : "")
      return 1
    }
    function ours(n) { return n == "unbrowse" || n ~ /^unbrowse-[A-Za-z0-9_-]+$/ }
    function quoted(v, list,   n) {
      n = 0
      while (match(v, /"([^"\\]|\\.)*"|\047[^\047]*\047/)) { list[++n] = substr(v, RSTART + 1, RLENGTH - 2); v = substr(v, RSTART + RLENGTH) }
      return n
    }
    function runs_unbrowse(w,   b) {
      b = w; sub(/.*[\/\\]/, "", b); sub(/\.(exe|cmd)$/, "", b)
      return b == "unbrowse" || b == "unb" || b ~ /^unbrowse@/
    }
    function kind(n,   i, k, w, nw, words, parts, u, at, agent) {
      if (inline[n]) return "inline"
      if (multi[n]) return "multiline"
      if (n in url) {
        if (!hostport(url[n], u)) return "unknown"
        if (u["host"] ~ /^(www\.|api\.|v3\.)?unbrowse\.ai$/) return "legacy"
        if ((u["host"] == "127.0.0.1" || u["host"] == "localhost" || u["host"] == "[::1]") && (u["port"] == 7788 || u["port"] == nodeport)) return "core"
        return "unknown"
      }
      if (env[n, "UNBROWSE_CONFIG_DIR"] || env[n, "UNBROWSE_SHARED_SIGNIN"]) return "legacy"
      nw = split(cmd[n], parts, /[ \t]+/)
      for (i = 1; i <= nw; i++) words[i] = parts[i]
      k = quoted(args[n], parts)
      for (i = 1; i <= k; i++) words[++nw] = parts[i]
      for (i = 1; i <= nw; i++) {
        w = words[i]
        if (w ~ /dist[\/\\]cli\.js$/ && words[i + 1] == "mcp") return "legacy"
        if (w ~ /^unbrowse@(12|6|0\.|1\.)/) return "legacy"
      }
      for (i = 1; i <= nw; i++) if (runs_unbrowse(words[i])) { at = i; break }
      if (at && words[at + 1] == "mcp") {
        for (i = at + 2; i <= nw; i++) if (words[i] == "--agent") agent = 1
        return agent ? "core" : "legacy"
      }
      return "unknown"
    }
    BEGIN { nodeport = ""; if (hostport(node, nu)) nodeport = nu["port"] }
    {
      line = $0; sub(/^[ \t]+/, "", line)
      if (inargs) { args[name] = args[name] " " line; if (line ~ /\]/) inargs = 0; next }
    }
    line ~ /^\[/ {
      table = line; sub(/#.*/, "", table); gsub(/[ \t"\047]/, "", table)
      name = ""; sub_ = ""
      if (table ~ /^\[mcp_servers\.[^].]+[].]/) {
        n = table; sub(/^\[mcp_servers\./, "", n); sub(/[].].*/, "", n)
        if (ours(n)) {
          name = n; seen[n] = 1
          s = table; sub(/^\[mcp_servers\.[^].]+/, "", s); sub(/^\./, "", s); sub(/\]$/, "", s); sub_ = s
        }
      }
      next
    }
    {
      key = line; gsub(/[ \t"\047]/, "", key)
      # The spellings this installer does not rewrite (the same ones the old check found).
      if (table == "" && key ~ /^mcp_servers\.unbrowse[-A-Za-z0-9_]*[.=]/) { n = key; sub(/^mcp_servers\./, "", n); sub(/[.=].*/, "", n); if (ours(n)) { inline[n] = 1; seen[n] = 1 } }
      if (table == "[mcp_servers]" && key ~ /^unbrowse[-A-Za-z0-9_]*[.=]/) { n = key; sub(/[.=].*/, "", n); if (ours(n)) { inline[n] = 1; seen[n] = 1 } }
      if (table == "" && key ~ /^mcp_servers=/ && key ~ /unbrowse/) { inline["unbrowse"] = 1; seen["unbrowse"] = 1 }
      if (name == "") next
      if (line ~ /"""|\047\047\047/) multi[name] = 1
      if (line ~ /^#/ || line !~ /=/) next
      k = line; sub(/[ \t]*=.*/, "", k); gsub(/["\047]/, "", k)
      v = line; sub(/^[^=]*=[ \t]*/, "", v)
      if (sub_ == "env") { env[name, k] = 1; next }
      if (sub_ != "") next
      if (k == "url" && quoted(v, q)) url[name] = q[1]
      if (k == "command" && quoted(v, q)) cmd[name] = q[1]
      if (k == "args") { args[name] = v; if (v ~ /^\[/ && v !~ /\]/) inargs = 1 }
      if (k == "env") { while (match(v, /[A-Za-z_][A-Za-z0-9_]*["\047]?[ \t]*=/)) { e = substr(v, RSTART, RLENGTH); sub(/["\047]?[ \t]*=$/, "", e); env[name, e] = 1; v = substr(v, RSTART + RLENGTH) } }
    }
    END { for (n in seen) print n, kind(n) }
  ' "$1"
}

# config.toml without the [mcp_servers.unbrowse] table and its sub-tables ([mcp_servers.unbrowse.env], …).
without_unbrowse() {
  awk '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^\[/ {
      table = line; sub(/#.*/, "", table); gsub(/[ \t"\047]/, "", table)
      drop = table == "[mcp_servers.unbrowse]" || index(table, "[mcp_servers.unbrowse.") == 1
    }
    !drop { print }
  ' "$1"
}

# mcp_servers written as an inline table can't take another server from a [mcp_servers.unbrowse] header.
inline_servers() {
  awk '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^\[/ { seen = 1 }
    !seen && line ~ /^mcp_servers[ \t]*=/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

# Whether Python 3.11+ is here to read TOML.
can_parse() {
  command -v python3 > /dev/null 2>&1 && python3 -c 'import tomllib' 2> /dev/null
}

# Adds a newline if the file doesn't end in one (it would run into the next table), then a blank line.
end_paragraph() {
  if [ -s "$1" ] && [ "$(tail -c 1 "$1" | od -An -c | tr -d ' ')" != '\n' ]; then
    echo >> "$1"
  fi
  [ -s "$1" ] && echo >> "$1"
  return 0
}

block=$(sed "s|\"http://127.0.0.1:7788\"|\"$node\"|" "$here/mcp-server.toml")

mkdir -p "$codex_home"
[ -f "$config" ] || : > "$config"

found=$(servers "$config")
main=$(printf '%s\n' "$found" | awk '$1 == "unbrowse" { print $2 }')

for old in $(printf '%s\n' "$found" | awk '$1 != "unbrowse" && $2 == "legacy" { print $1 }'); do
  echo "config: [mcp_servers.$old] in $config is an older Unbrowse's, for the hosted service, which has closed; remove it when you like"
done

case "$main" in
  core)
    echo "config: $config already has this node's unbrowse MCP server; left as it is"
    ;;
  unknown)
    echo "config: $config has an [mcp_servers.unbrowse] that no Unbrowse install wrote; left as it is. To use the node instead, put this in its place:"
    echo "$block"
    ;;
  inline | multiline)
    echo "config: $config names an unbrowse MCP server in a form this installer doesn't rewrite; left as it is. If it is an older Unbrowse's (npx unbrowse mcp, or an unbrowse.ai address), put this in its place by hand:"
    echo "$block"
    ;;
  legacy)
    candidate=$(mktemp)
    trap 'rm -f "$candidate"' EXIT
    without_unbrowse "$config" > "$candidate"
    end_paragraph "$candidate"
    echo "$block" >> "$candidate"
    # With Python 3.11+: the result must parse, hold exactly this table as the unbrowse server, and every other setting
    # as it was. Without it, only whole tables were taken out and one added, which keeps a file that parsed parsing.
    if can_parse && ! python3 -c '
import sys, tomllib
was, now = (tomllib.load(open(p, "rb")) for p in sys.argv[1:3])
want = tomllib.loads(sys.argv[3])["mcp_servers"]["unbrowse"]
was.get("mcp_servers", {}).pop("unbrowse", None)
got = now.get("mcp_servers", {}).pop("unbrowse", None)
sys.exit(0 if got == want and was == now else 1)
' "$config" "$candidate" "$block" 2> /dev/null; then
      echo "install.sh: $config would not keep its other settings with the older unbrowse table replaced; nothing written. Replace [mcp_servers.unbrowse] by hand with:" >&2
      echo "$block" >&2
      exit 1
    fi
    stamp=$(date +%Y%m%d%H%M%S)
    kept="$config.before-unbrowse-$stamp"
    n=0
    while [ -e "$kept" ] || [ -L "$kept" ]; do
      n=$((n + 1))
      kept="$config.before-unbrowse-$stamp-$n"
    done
    # The file as it was, kept beside it for the owner only: an older entry may carry a header with a key in it.
    (umask 077 && cat "$config" > "$kept")
    # Written in place, so the file keeps its owner and mode.
    cat "$candidate" > "$config"
    echo "config: replaced the older Unbrowse's [mcp_servers.unbrowse] in $config with this node's (unbrowse mcp, to the node at $node); the file as it was is $kept"
    ;;
  *)
    if inline_servers "$config"; then
      echo "install.sh: $config sets mcp_servers inline; add this table to it by hand:" >&2
      echo "$block" >&2
      exit 1
    fi
    candidate=$(mktemp)
    trap 'rm -f "$candidate"' EXIT
    cat "$config" > "$candidate"
    end_paragraph "$candidate"
    echo "$block" >> "$candidate"
    # Python 3.11+ can read TOML: check the result parses before writing it. Without it, the checks above stand.
    if can_parse && ! python3 -c 'import sys, tomllib; tomllib.load(open(sys.argv[1], "rb"))' "$candidate" 2> /dev/null; then
      echo "install.sh: $config would not parse with the unbrowse table added; nothing written. Add this by hand:" >&2
      echo "$block" >&2
      exit 1
    fi
    # Written in place, so the file keeps its owner and mode.
    cat "$candidate" > "$config"
    echo "config: added [mcp_servers.unbrowse] (unbrowse mcp, to the node at $node) to $config"
    ;;
esac

# ---- the skills ----

mkdir -p "$skills_to"
for skill in "$here"/plugins/unbrowse/skills/*/; do
  name=$(basename "$skill")
  target="$skills_to/$name"
  if [ -d "$target" ] && [ ! -L "$target" ] && diff -r "$skill" "$target" > /dev/null 2>&1; then
    echo "skill: $target is this copy already"
    continue
  fi
  # Whatever is there (the user's own skill of that name, an edited or older copy) is kept, moved aside.
  # It goes to unbrowse-kept beside the skills folder, not in it, so Codex doesn't load it as a second skill.
  if [ -e "$target" ] || [ -L "$target" ]; then
    kept_dir="$(dirname "$skills_to")/unbrowse-kept"
    mkdir -p "$kept_dir"
    stamp=$(date +%Y%m%d%H%M%S)
    kept="$kept_dir/$name.before-unbrowse-$stamp"
    n=0
    while [ -e "$kept" ] || [ -L "$kept" ]; do
      n=$((n + 1))
      kept="$kept_dir/$name.before-unbrowse-$stamp-$n"
    done
    if [ -L "$target" ]; then
      # A link stays a link to the same place, its target made absolute so the move can't break it.
      link=$(readlink "$target")
      case $link in /*) ;; *) link="$skills_to/$link" ;; esac
      ln -s "$link" "$kept"
      rm "$target"
    else
      mv "$target" "$kept"
    fi
    echo "skill: kept what was at $target as $kept"
  fi
  cp -R "$skill" "$target"
  echo "skill: $target"
done

cat << EOF

Codex starts \`unbrowse mcp --agent first\`, which acts as the node's first agent key once you let it in: run
\`unbrowse grant first\` once (the node asks you). For a key of Codex's own, run \`unbrowse agent new codex\`, put the
number it shows in place of first in $config, and run \`unbrowse grant <number>\`.
EOF
