#!/usr/bin/env bash
# Witness: unbrowse@7.2.0 published to npm `latest`.
set -uo pipefail
echo "[prod] waiting for unbrowse@latest=7.2.0 ..."
deadline=$(( $(date +%s) + 2100 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  L=$(npm view unbrowse dist-tags.latest 2>/dev/null)
  V=$(npm view unbrowse@7.2.0 version 2>/dev/null)
  if [ "$L" = "7.2.0" ] && [ "$V" = "7.2.0" ]; then
    echo "[prod] PASS — unbrowse@7.2.0 on npm latest. npm i unbrowse"; exit 0
  fi
  sleep 30
done
echo "[prod] unbrowse@latest still not 7.2.0 (latest=$(npm view unbrowse dist-tags.latest 2>/dev/null)) — check release run"; exit 1
