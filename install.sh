#!/usr/bin/env sh
# unbrowse installer — https://github.com/unbrowse-ai/unbrowse
# Usage: curl -fsSL https://unbrowse.ai/install.sh | sh
set -e

REPO="unbrowse-ai/unbrowse"
INSTALL_DIR="${UNBROWSE_INSTALL_DIR:-$HOME/.local/bin}"
INTERACTIVE=0

if [ -t 0 ] && [ -t 1 ] && [ "${UNBROWSE_NON_INTERACTIVE:-0}" != "1" ]; then
  INTERACTIVE=1
fi

need_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required binary: $1" >&2
    exit 1
  }
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_NAME="darwin" ;;
  Linux) OS_NAME="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

TARGET="${OS_NAME}-${ARCH_NAME}"

need_bin curl
need_bin tar

echo "Fetching latest unbrowse release..."
VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | head -1 \
  | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"

if [ -z "$VERSION" ]; then
  echo "Error: could not determine latest version" >&2
  exit 1
fi

echo "Installing unbrowse ${VERSION} (${TARGET})..."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/${REPO}/releases/download/${VERSION}/unbrowse-${VERSION}-${TARGET}.tar.gz"
curl -fsSL "$URL" -o "$TMP/unbrowse.tar.gz"
tar -xzf "$TMP/unbrowse.tar.gz" -C "$TMP"

mkdir -p "$INSTALL_DIR"
cp "$TMP/unbrowse" "$INSTALL_DIR/unbrowse"
chmod +x "$INSTALL_DIR/unbrowse"

if [ "$OS_NAME" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/unbrowse" 2>/dev/null || true
fi

echo ""
echo "Installed: unbrowse"
echo "Location: $INSTALL_DIR"
echo ""

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Add to your shell profile:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    ;;
esac

if [ "${UNBROWSE_SKIP_SETUP:-0}" = "1" ]; then
  echo "Next: $INSTALL_DIR/unbrowse setup"
else
  SETUP_ARGS="setup"

  if [ "$INTERACTIVE" -ne 1 ]; then
    SETUP_ARGS="$SETUP_ARGS --non-interactive --skip-wallet-setup"
  fi

  if [ "${UNBROWSE_TOS_ACCEPTED:-0}" = "1" ]; then
    SETUP_ARGS="$SETUP_ARGS --accept-tos"
  fi

  if [ -n "${UNBROWSE_AGENT_EMAIL:-}" ]; then
    SETUP_ARGS="$SETUP_ARGS --agent-email $UNBROWSE_AGENT_EMAIL"
  fi

  if [ "${UNBROWSE_SKIP_WALLET_SETUP:-0}" = "1" ] && ! printf '%s\n' "$SETUP_ARGS" | grep -q -- '--skip-wallet-setup'; then
    SETUP_ARGS="$SETUP_ARGS --skip-wallet-setup"
  fi

  if [ "$INTERACTIVE" -ne 1 ] && [ "${UNBROWSE_TOS_ACCEPTED:-0}" != "1" ]; then
    echo "Skipping interactive setup: non-interactive install requires UNBROWSE_TOS_ACCEPTED=1."
    echo "Next: UNBROWSE_TOS_ACCEPTED=1 ${UNBROWSE_AGENT_EMAIL:+UNBROWSE_AGENT_EMAIL=$UNBROWSE_AGENT_EMAIL }$INSTALL_DIR/unbrowse $SETUP_ARGS"
  else
    echo "Running unbrowse setup..."
    # shellcheck disable=SC2086
    UNBROWSE_SETUP_METHOD="npm-global" "$INSTALL_DIR/unbrowse" $SETUP_ARGS "$@"
  fi
fi

if [ "${UNBROWSE_SKIP_SKILLS_REGISTRY:-0}" = "1" ]; then
  exit 0
fi

if command -v npx >/dev/null 2>&1; then
  echo "Registering install with skills.sh..."
  npx -y skills add unbrowse-ai/unbrowse --yes >/dev/null 2>&1 || \
    echo "Skipping skills.sh registry add (command failed)."
else
  echo "Skipping skills.sh registry add (npx not found)."
fi
