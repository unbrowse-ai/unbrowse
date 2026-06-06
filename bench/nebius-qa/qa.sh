#!/usr/bin/env bash
# WITNESS: end-to-end QA of unbrowse on fresh TINY Nebius VMs.
# Provisions QA_N (>=2) clean cpu-e2 2vcpu-8gb Ubuntu 24.04 VMs, fresh-installs
# unbrowse@latest from npm on each, runs the real e2e paths (health, fetch,
# search), pulls the result matrix, and exits 0 iff every VM passes the core
# gate. ALWAYS tears down VMs + disks on exit (cost discipline). Raw per-VM
# logs land in artifacts/<run>/ for in-thread judgment.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT=project-e00pqba9pr00xtez9kvqxh
SUBNET=vpcsubnet-e00kx04a7vcjb2ddaw
IMAGE=computeimage-e00d7ctzs3waty7c1w   # ubuntu24.04-driverless
PRESET=2vcpu-8gb
PLATFORM=cpu-e2
DISK_GIB=30
QA_N="${QA_N:-2}"
TAG="ubqa-$(date -u +%Y%m%d-%H%M%S)"
RUN_DIR="$HERE/artifacts/$TAG"
mkdir -p "$RUN_DIR"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR)

say() { echo "[$(date -u +%H:%M:%S)] $*"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

CREATED_INSTANCES=(); CREATED_DISKS=()
teardown() {
  say "TEARDOWN — deleting $((${#CREATED_INSTANCES[@]})) instances + $((${#CREATED_DISKS[@]})) disks"
  for id in "${CREATED_INSTANCES[@]:-}"; do [ -n "$id" ] && nebius compute instance delete --id "$id" --async >/dev/null 2>&1 && say "  del instance $id"; done
  sleep 20
  for id in "${CREATED_DISKS[@]:-}"; do
    [ -z "$id" ] && continue
    for _ in 1 2 3 4 5 6; do nebius compute disk delete --id "$id" --async >/dev/null 2>&1 && { say "  del disk $id"; break; }; sleep 10; done
  done
}
trap teardown EXIT

CLOUD_INIT='#cloud-config
hostname: '"$TAG"'
users:
  - name: lekt9
    groups: sudo
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAPRubwElsMCWqwfKDoLqYMEB0UNrhVq6+yM9+6j9mm8
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBJONZhEDgc8LM9nPoeMwGSVjCeKm8KRg2EppeKowdLF
package_update: true
'

# ---- provision N VMs -------------------------------------------------------
INSTANCE_IDS=(); NAMES=()
for i in $(seq 1 "$QA_N"); do
  name="$TAG-$i"; NAMES+=("$name")
  say "creating disk for $name"
  disk_id="$(nebius compute disk create --parent-id "$PROJECT" --name "$name-boot" \
      --source-image-id "$IMAGE" --size-gibibytes "$DISK_GIB" --type network_ssd \
      --format json 2>"$RUN_DIR/$name.disk.err" | jget "d['metadata']['id']")"
  if [ -z "${disk_id:-}" ]; then say "  disk create FAILED for $name; see $name.disk.err"; cat "$RUN_DIR/$name.disk.err"; exit 3; fi
  CREATED_DISKS+=("$disk_id"); say "  disk=$disk_id"
  # wait disk READY
  for _ in $(seq 1 30); do
    st="$(nebius compute disk get --id "$disk_id" --format json 2>/dev/null | jget "d['status']['state']")"
    [ "$st" = "READY" ] && break; sleep 4
  done
  say "creating instance $name"
  inst_id="$(nebius compute instance create --parent-id "$PROJECT" --name "$name" \
      --resources-platform "$PLATFORM" --resources-preset "$PRESET" \
      --boot-disk-existing-disk-id "$disk_id" --boot-disk-attach-mode read_write \
      --network-interfaces '[{"name":"eth0","subnet_id":"'"$SUBNET"'","ip_address":{},"public_ip_address":{}}]' \
      --cloud-init-user-data "$CLOUD_INIT" --format json 2>"$RUN_DIR/$name.inst.err" | jget "d['metadata']['id']")"
  if [ -z "${inst_id:-}" ]; then say "  instance create FAILED; see $name.inst.err"; cat "$RUN_DIR/$name.inst.err"; exit 3; fi
  CREATED_INSTANCES+=("$inst_id"); INSTANCE_IDS+=("$inst_id"); say "  instance=$inst_id"
  nebius compute instance start --id "$inst_id" --async >/dev/null 2>&1 || true
done

# ---- wait RUNNING + collect public IPs ------------------------------------
declare -a IPS
for idx in "${!INSTANCE_IDS[@]}"; do
  id="${INSTANCE_IDS[$idx]}"; name="${NAMES[$idx]}"
  say "waiting RUNNING: $name"
  ip=""
  for _ in $(seq 1 60); do
    j="$(nebius compute instance get --id "$id" --format json 2>/dev/null)"
    st="$(printf '%s' "$j" | jget "d['status']['state']")"
    if [ "$st" = "STOPPED" ]; then nebius compute instance start --id "$id" --async >/dev/null 2>&1 || true; fi
    if [ "$st" = "RUNNING" ]; then
      ip="$(printf '%s' "$j" | jget "d['status']['network_interfaces'][0]['public_ip_address']['address']")"
      ip="${ip%%/*}"   # strip CIDR mask (Nebius returns e.g. 1.2.3.4/32)
      [ -n "$ip" ] && break
    fi
    sleep 5
  done
  IPS[$idx]="$ip"
  say "  $name state=$st ip=${ip:-none}"
done

# ---- run e2e on each VM ----------------------------------------------------
for idx in "${!INSTANCE_IDS[@]}"; do
  name="${NAMES[$idx]}"; ip="${IPS[$idx]:-}"
  res="$RUN_DIR/$name.result.json"; echo '{"install_ok":false,"version_ok":false,"health_ok":false,"fetch_ok":false,"search_ok":false,"errors":["unreached"]}' > "$res"
  if [ -z "$ip" ]; then say "$name: no IP — skipping"; continue; fi
  say "$name@$ip: waiting for sshd"
  up=false
  for _ in $(seq 1 40); do
    if ssh "${SSH_OPTS[@]}" "lekt9@$ip" 'echo up' >/dev/null 2>&1; then up=true; break; fi
    sleep 6
  done
  if ! $up; then say "  $name: ssh never came up"; continue; fi
  say "  $name: ssh up — copying + running e2e (this installs node+unbrowse)"
  scp "${SSH_OPTS[@]}" "$HERE/vm_e2e.sh" "lekt9@$ip:/tmp/vm_e2e.sh" >/dev/null 2>&1
  # konmari E2E: ship the local lightened tarball if provided (vm_e2e installs it over npm)
  [ -n "${UNBROWSE_LOCAL_TGZ:-}" ] && [ -f "$UNBROWSE_LOCAL_TGZ" ] && \
    scp "${SSH_OPTS[@]}" "$UNBROWSE_LOCAL_TGZ" "lekt9@$ip:/tmp/unbrowse-local.tgz" >/dev/null 2>&1 && say "  shipped local tarball → /tmp/unbrowse-local.tgz"
  out="$(ssh "${SSH_OPTS[@]}" "lekt9@$ip" "UNBROWSE_NPM_REF='${UNBROWSE_NPM_REF:-latest}' bash /tmp/vm_e2e.sh" 2>"$RUN_DIR/$name.ssh.err")"
  printf '%s\n' "$out" > "$RUN_DIR/$name.raw.txt"
  # pull the remote log too
  ssh "${SSH_OPTS[@]}" "lekt9@$ip" 'cat /tmp/unbrowse-qa.log' > "$RUN_DIR/$name.vm.log" 2>/dev/null || true
  json="$(printf '%s' "$out" | awk '/<<<QA_JSON_BEGIN>>>/{f=1;next}/<<<QA_JSON_END>>>/{f=0}f')"
  if [ -n "$json" ] && printf '%s' "$json" | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; then
    printf '%s\n' "$json" > "$res"; say "  $name: result captured"
  else
    say "  $name: no parseable JSON (see $name.raw.txt / $name.ssh.err)"
  fi
done

# ---- judge / gate ----------------------------------------------------------
say "================ QA MATRIX ($TAG) ================"
pass=0
for idx in "${!NAMES[@]}"; do
  name="${NAMES[$idx]}"; res="$RUN_DIR/$name.result.json"
  read -r ok line < <(python3 - "$res" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
core=["install_ok","version_ok","health_ok","fetch_ok","search_ok"]
ok=all(d.get(k) is True for k in core)
v=d.get("unbrowse_version","?")
flags=" ".join(f"{k.split('_')[0]}={'Y' if d.get(k) else 'n'}" for k in core)
errs="; ".join(d.get("errors",[]))[:160]
print(("PASS" if ok else "FAIL"), f"v={v} {flags}" + (f" :: {errs}" if errs else ""))
PY
)
  printf '  %-22s %s %s\n' "$name" "$ok" "$line"
  [ "$ok" = "PASS" ] && pass=$((pass+1))
done
say "PASS $pass / $QA_N  (need >=2 and all)"
say "artifacts: $RUN_DIR"

if [ "$QA_N" -ge 2 ] && [ "$pass" -eq "$QA_N" ]; then
  say "WITNESS GREEN ✓ — unbrowse works end-to-end on $pass tiny VMs (two-witness)"
  exit 0
fi
say "WITNESS RED ✗"
exit 1
