#!/bin/sh
# Make the self-signed "Unbrowse Node Dev" code-signing identity, once per machine, in a keychain of its own.
#
# The identity lives in ~/Library/Keychains/unbrowse-dev.keychain-db, whose password this script makes and keeps in
# ~/.unbrowse/dev-keychain.pass (readable by you only). Because the password is known, the key's access list is set
# here to let codesign use it, so signing never asks for your login password. It signs dev builds on this machine
# only: nobody else trusts it and it never signs a release.
set -e
kc="$HOME/Library/Keychains/unbrowse-dev.keychain-db"
passfile="$HOME/.unbrowse/dev-keychain.pass"
if [ -f "$kc" ] && [ -f "$passfile" ] && security find-identity -p codesigning "$kc" | grep -q '"Unbrowse Node Dev"'; then
  echo "already there"; exit 0
fi
mkdir -p "$HOME/.unbrowse"
umask 077
[ -f "$passfile" ] || openssl rand -hex 24 > "$passfile"
kpass=$(cat "$passfile")
[ -f "$kc" ] || security create-keychain -p "$kpass" "$kc"
security unlock-keychain -p "$kpass" "$kc"
security set-keychain-settings "$kc"   # no auto-lock

dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
cat > "$dir/cert.cnf" <<'CNF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Unbrowse Node Dev
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$dir/key.pem" -out "$dir/cert.pem" -config "$dir/cert.cnf" 2>/dev/null
pass=$(openssl rand -hex 12)
openssl pkcs12 -export -legacy -inkey "$dir/key.pem" -in "$dir/cert.pem" -out "$dir/id.p12" -passout "pass:$pass" -name "Unbrowse Node Dev" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$dir/key.pem" -in "$dir/cert.pem" -out "$dir/id.p12" -passout "pass:$pass" -name "Unbrowse Node Dev"
security import "$dir/id.p12" -k "$kc" -P "$pass" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kpass" "$kc" >/dev/null

# Keep the keychain in the search list so codesign and find-identity see it.
list=$(security list-keychains -d user | tr -d '"' | tr -s ' \n' ' ')
case "$list" in *unbrowse-dev.keychain-db*) ;; *) eval security list-keychains -d user -s $list "$kc" ;; esac
echo "made"
