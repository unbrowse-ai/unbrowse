#!/usr/bin/env bash
# Stateless npm publication handoff: validate one prebuilt tarball, attach it to
# an immutable public release tag, dispatch the public OIDC workflow, and settle
# only when the npm registry exposes both the version and intended dist-tag.
set -euo pipefail

TARBALL="${1:?usage: publish-npm-via-public-oidc.sh <tarball> <v-tag> [public-repo]}"
TAG="${2:?usage: publish-npm-via-public-oidc.sh <tarball> <v-tag> [public-repo]}"
PUBLIC_REPO="${3:-unbrowse-ai/unbrowse}"
VERSION="${TAG#v}"

case "$TAG" in v*-*) ;; v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "invalid release tag: $TAG" >&2; exit 2 ;; esac
test -s "$TARBALL" || { echo "missing or empty npm tarball: $TARBALL" >&2; exit 2; }

PACKAGE_JSON="$(tar -xOf "$TARBALL" package/package.json)"
PACKAGE_NAME="$(printf '%s' "$PACKAGE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name||""))')"
PACKAGE_VERSION="$(printf '%s' "$PACKAGE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version||""))')"
if [ "$PACKAGE_NAME" != "unbrowse" ] || [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  echo "tarball identity mismatch: expected unbrowse@${VERSION}, got ${PACKAGE_NAME:-missing}@${PACKAGE_VERSION:-missing}" >&2
  exit 2
fi

NPM_TAG="latest"
case "$VERSION" in *-preview.*) NPM_TAG="preview" ;; esac

if [ "${UNBROWSE_OIDC_PUBLISH_VALIDATE_ONLY:-0}" = "1" ]; then
  echo "validated ${PACKAGE_NAME}@${PACKAGE_VERSION} -> ${PUBLIC_REPO}:${TAG} dist-tag=${NPM_TAG}"
  exit 0
fi

: "${GH_TOKEN:?GH_TOKEN is required to upload and dispatch in the public repository}"
if ! gh release view "$TAG" --repo "$PUBLIC_REPO" >/dev/null 2>&1; then
  PRERELEASE=()
  case "$VERSION" in *-preview.*) PRERELEASE=(--prerelease) ;; esac
  gh release create "$TAG" --repo "$PUBLIC_REPO" --title "$TAG" --notes "Release ${TAG}" "${PRERELEASE[@]}"
fi
gh release upload "$TAG" "$TARBALL" --repo "$PUBLIC_REPO" --clobber

# The immutable tag both pins the workflow definition and correlates its run.
gh workflow run release.yml --repo "$PUBLIC_REPO" --ref "$TAG" -f tag="$TAG"
echo "dispatched public OIDC publication for ${PACKAGE_NAME}@${VERSION}"

MAX_ATTEMPTS="${UNBROWSE_OIDC_PUBLISH_MAX_ATTEMPTS:-120}"
for ATTEMPT in $(seq 1 "$MAX_ATTEMPTS"); do
  PUBLISHED="$(npm view "${PACKAGE_NAME}@${VERSION}" version 2>/dev/null || true)"
  if [ "$PUBLISHED" = "$VERSION" ]; then
    ACTUAL_TAG="$(npm view "$PACKAGE_NAME" "dist-tags.${NPM_TAG}" 2>/dev/null || true)"
    if [ "$ACTUAL_TAG" != "$VERSION" ]; then
      echo "${PACKAGE_NAME}@${VERSION} exists, but dist-tags.${NPM_TAG} is '${ACTUAL_TAG:-missing}'" >&2
      exit 1
    fi
    echo "verified ${PACKAGE_NAME}@${VERSION} and dist-tags.${NPM_TAG} on npm"
    exit 0
  fi

  RUN="$(gh run list --repo "$PUBLIC_REPO" --workflow release.yml \
    --event workflow_dispatch --branch "$TAG" --limit 1 \
    --json databaseId,status,conclusion,url \
    --jq '.[0] // empty | [.databaseId,.status,.conclusion,.url] | @tsv' \
    2>/dev/null || true)"
  if [ -n "$RUN" ]; then
    IFS=$'\t' read -r RUN_ID RUN_STATUS RUN_CONCLUSION RUN_URL <<< "$RUN"
    if [ "$RUN_STATUS" = "completed" ] && [ "$RUN_CONCLUSION" != "success" ]; then
      echo "public npm OIDC workflow failed: $RUN_URL" >&2
      # Fall through to private-token publish when available (OIDC often fails
      # with ENEEDAUTH if Trusted Publishing is misconfigured; classic tokens
      # can still publish when they are valid automation tokens).
      break
    fi
  fi
  sleep 5
done

# ── Fallback: publish the same tarball with NPM_TOKEN from the build job ──
if [ -n "${NPM_TOKEN:-}${NODE_AUTH_TOKEN:-}" ]; then
  TOKEN="${NPM_TOKEN:-${NODE_AUTH_TOKEN}}"
  echo "attempting direct npm publish of ${PACKAGE_NAME}@${VERSION} via NPM_TOKEN fallback"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$HOME/.npmrc"
  if npm publish "$TARBALL" --access public --tag "$NPM_TAG"; then
    PUBLISHED="$(npm view "${PACKAGE_NAME}@${VERSION}" version 2>/dev/null || true)"
    if [ "$PUBLISHED" = "$VERSION" ]; then
      echo "verified ${PACKAGE_NAME}@${VERSION} and dist-tags.${NPM_TAG} on npm (token fallback)"
      exit 0
    fi
  fi
  echo "NPM_TOKEN fallback publish failed (token may be revoked, classic-only, or lack package write)." >&2
fi

echo "npm publish failed for ${PACKAGE_NAME}@${VERSION}." >&2
echo "Fix ONE of:" >&2
echo "  1) npm Trusted Publishing on unbrowse: owner=unbrowse-ai repo=unbrowse workflow=release.yml environment=prod" >&2
echo "  2) Rotate NPM_TOKEN (and public repo NPM_TOKEN) to a granular automation token with publish on unbrowse" >&2
echo "Tarball is already on github.com/${PUBLIC_REPO}/releases/tag/${TAG} as unbrowse-${VERSION}.tgz" >&2
exit 1
