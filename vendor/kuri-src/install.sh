#!/usr/bin/env sh
# kuri installer — https://github.com/justrach/kuri
# Usage: curl -fsSL https://raw.githubusercontent.com/justrach/kuri/main/install.sh | sh
set -e

REPO="justrach/kuri"
INSTALL_DIR="${KURI_INSTALL_DIR:-$HOME/.local/bin}"

# ── Detect platform ───────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_NAME="macos" ;;
  Linux)  OS_NAME="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x86_64" ;;
  arm64|aarch64) ARCH_NAME="aarch64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

TARGET="${ARCH_NAME}-${OS_NAME}"

# ── Fetch latest release tag ──────────────────────────────────────────────────
echo "Fetching latest kuri release..."
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "Error: could not determine latest version" >&2
  exit 1
fi

echo "Installing kuri ${VERSION} (${TARGET})..."

# ── Download & unpack ─────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/${REPO}/releases/download/${VERSION}/kuri-${VERSION}-${TARGET}.tar.gz"
curl -fsSL "$URL" -o "$TMP/kuri.tar.gz"
tar -xzf "$TMP/kuri.tar.gz" -C "$TMP"

# ── Install binaries ──────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"

BINS="kuri kuri-agent kuri-fetch kuri-browse"
INSTALLED=""
for BIN in $BINS; do
  if [ -f "$TMP/$BIN" ]; then
    cp "$TMP/$BIN" "$INSTALL_DIR/$BIN"
    chmod +x "$INSTALL_DIR/$BIN"
    # Remove macOS quarantine so binaries run without Gatekeeper prompt
    if [ "$OS_NAME" = "macos" ]; then
      xattr -d com.apple.quarantine "$INSTALL_DIR/$BIN" 2>/dev/null || true
    fi
    INSTALLED="$INSTALLED $BIN"
  fi
done

# ── PATH hint ─────────────────────────────────────────────────────────────────
echo ""
echo "Installed:$INSTALLED"
echo "Location:  $INSTALL_DIR"
echo ""

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Add to your shell profile:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    ;;
esac

echo "Quick start:"
echo "  kuri-agent tabs          # list Chrome tabs"
echo "  kuri-agent use <ws_url>  # attach to a tab"
echo "  kuri-agent snap          # compact a11y snapshot (~2.8k tokens)"
echo ""
echo "Docs: https://github.com/${REPO}"
