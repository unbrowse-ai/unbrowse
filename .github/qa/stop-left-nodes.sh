#!/bin/sh
# Stops the nodes and browser programs an earlier job left running on this runner (UNB-235).
#
#   sh .github/qa/stop-left-nodes.sh
#
# A hosted runner is thrown away after each job; a person's own Mac is not, and a node started with nohup outlives its
# job: Gate bank's scratch node found 17810 taken by one (run 44884521521 on lewis-macbook-pro, parent pid 1). Only
# programs built in this runner's own work tree are matched, by their full path, so the owner's own node (Unbrowse.app)
# and another runner's jobs are never touched.
set -u
ws=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is unset}
programs="$ws/unbrowse-node/target/debug/unbrowse-node $ws/unbrowse-browser/cli/target/debug/agent-browser"
for program in $programs; do
  if pgrep -f "^$program( |\$)" > /dev/null 2>&1; then
    echo "stopping what an earlier job left running: $program"
    pkill -f "^$program( |\$)" || true
  fi
done
sleep 1
for program in $programs; do
  pkill -9 -f "^$program( |\$)" 2>/dev/null || true
done
exit 0
