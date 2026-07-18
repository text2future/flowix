#!/usr/bin/env bash
# scripts/upload-release.sh — publish a Flowix release's macOS installers
# to GitHub Releases, with a strict allow-list so accidental files
# (update.json, app.tar.gz, .minisig, ...) never end up as release assets.
#
# Usage:
#   ./scripts/upload-release.sh <tag> [source-dir]
#
# Examples:
#   ./scripts/upload-release.sh v1.0.10
#   ./scripts/upload-release.sh v1.0.10 .build/release-1.0.10
#
# Conventions enforced:
#   - Source dmg files must match  Flowix-${VERSION}-macOS-{Apple-Silicon,Intel}.dmg
#   - Existing assets on the release are scanned; anything outside the
#     allow-list (dmg + GitHub's tag-generated Source code) is deleted first.
#   - The release is created if it doesn't exist yet (draft, no notes).
#   - If a release exists but is missing one of the expected dmg files,
#     only the missing ones are uploaded (existing ones are not re-uploaded).
#
# Exit codes:
#   0  success
#   1  missing arguments or preconditions
#   2  gh CLI not authenticated / network failure
#   3  no matching dmg files in source dir

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "upload-release.sh: usage: $0 <tag> [source-dir]" >&2
  exit 1
fi

TAG="$1"
SOURCE_DIR="${2:-$(pwd)}"
VERSION="${TAG#v}"

OWNER="${GH_OWNER:-text2future}"
REPO="${GH_REPO:-flowix}"

# Files we are willing to leave on the release. Anything else is deleted.
ALLOWED_PATTERN='^(Flowix-[0-9]+\.[0-9]+\.[0-9]+-macOS-Apple-Silicon\.dmg|Flowix-[0-9]+\.[0-9]+\.[0-9]+-macOS-Intel\.dmg|Source[ _]code\.(zip|tar\.gz))$'

APPLE_SILICON_DMG="$SOURCE_DIR/Flowix-${VERSION}-macOS-Apple-Silicon.dmg"
INTEL_DMG="$SOURCE_DIR/Flowix-${VERSION}-macOS-Intel.dmg"

if [ ! -f "$APPLE_SILICON_DMG" ] || [ ! -f "$INTEL_DMG" ]; then
  echo "upload-release.sh: missing dmg files in $SOURCE_DIR:" >&2
  [ ! -f "$APPLE_SILICON_DMG" ] && echo "  - $APPLE_SILICON_DMG" >&2
  [ ! -f "$INTEL_DMG" ] && echo "  - $INTEL_DMG" >&2
  echo "Run scripts/rename-dmg.sh first, or pass the right source dir." >&2
  exit 3
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "upload-release.sh: gh CLI not on PATH" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "upload-release.sh: gh not authenticated; run 'gh auth login' first" >&2
  exit 2
fi

# Step 1: prune any existing assets that aren't on the allow-list.
# `gh release view` returns an empty `assets` array for missing releases,
# which we just skip silently.
echo "==> pruning non-allow-list assets on $TAG (if any)"
EXISTING=$(gh release view "$TAG" --repo "$OWNER/$REPO" --json assets --jq -r '.assets[].name' 2>/dev/null || true)
for asset in $EXISTING; do
  if [[ "$asset" =~ $ALLOWED_PATTERN ]]; then
    continue
  fi
  echo "    deleting: $asset"
  gh release delete-asset "$TAG" "$asset" --repo "$OWNER/$REPO" --yes >/dev/null
done

# Step 2: ensure the release exists (draft if it doesn't). We don't try to
# set a body — the operator is expected to attach notes via gh release edit
# or the GitHub UI.
if ! gh release view "$TAG" --repo "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "==> creating draft release $TAG"
  gh release create "$TAG" \
    --repo "$OWNER/$REPO" \
    --title "$TAG" \
    --draft \
    --target "$(git rev-parse HEAD)"
fi

# Step 3: upload the two dmg files. --clobber replaces if the operator
# already pushed a different build; --skip-existing leaves it alone if
# the existing asset matches by name (we rely on the prune step to keep
# stale files out of the way).
upload_one() {
  local path="$1"
  local name
  name="$(basename "$path")"
  if gh release view "$TAG" --repo "$OWNER/$REPO" --json assets --jq -e --arg n "$name" '.assets[].name | select(. == $n)' >/dev/null 2>&1; then
    echo "==> $name already on release, leaving it"
    return
  fi
  echo "==> uploading $name"
  gh release upload "$TAG" "$path" --repo "$OWNER/$REPO" --clobber >/dev/null
}

upload_one "$APPLE_SILICON_DMG"
upload_one "$INTEL_DMG"

echo "==> done. release $TAG:"
gh release view "$TAG" --repo "$OWNER/$REPO" --json assets --jq '.assets[].name'
