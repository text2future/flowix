#!/usr/bin/env bash
# scripts/release.sh — one-shot release pipeline.
#
# Steps:
#   1. (precondition) confirm version + ensure Rust target compiled
#   2. produce signed + unsigned artifacts via `npm run tauri:build:production`
#   3. for each platform that produced a `.app`: tar.gz + minisign sign
#   4. emit `update.json` manifest alongside the tarballs
#
# The same script is called from `.github/workflows/release.yml`. There the
# rust + node toolchains come pre-installed; locally they come from your PATH.
#
# Inputs (env vars; CI secrets in production):
#   TAURI_SIGNING_PRIVATE_KEY  ── contents of the minisign secret key file
#                                  (NOT the file path; the actual base64)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD ── optional (only if the key has one)
#   FLOWIX_ALLOW_UNSIGNED=1    ── skip macOS code-signing requirement
#                                  (Apple Developer ID missing in dev)
#   FLOWIX_SKIP_PUBLISH=1      ── do everything except `gh release create`
#                                  (default when no GITHUB_TOKEN available)
#
# Outputs (next to where this script lives — well, at $RELEASE_OUT):
#   FLOWIX_VERSION.app.tar.gz     (updater payload)
#   FLOWIX_VERSION.app.tar.gz.minisig
#   update.json                   (manifest pointing at GitHub release URLs)
#
# Exit codes:
#   0  success
#   1  build failed
#   2  signing failed
#   3  publish failed (only when GH publish is enabled)

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
export CARGO_TARGET_DIR
BUNDLE_DIR="$CARGO_TARGET_DIR/release/bundle"
RELEASE_OUT="$CARGO_TARGET_DIR/release/updater"
VERSION="$(awk -F'"' '/^version *=/{print $2; exit}' "$REPO_ROOT/app/Cargo.toml")"
PUBKEY_PATH="${TAURI_SIGNING_PUBKEY_PATH:-$HOME/.tauri/keys/flowix-dev.key.pub}"
GH_OWNER="${GH_OWNER:-text2future}"
GH_REPO="${GH_REPO:-flowix}"
TAG="v${VERSION}"

mkdir -p "$RELEASE_OUT"
rm -f "$RELEASE_OUT"/*.app.tar.gz "$RELEASE_OUT"/*.minisig "$RELEASE_OUT"/update.json

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: build (production profile). Sets $TAURI_SIGNING_PRIVATE_KEY so the
# signing is wired through whatever hooks the build runs.
# ──────────────────────────────────────────────────────────────────────────────

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "release.sh: TAURI_SIGNING_PRIVATE_KEY not set; aborting." >&2
  exit 1
fi
if [ ! -f "$PUBKEY_PATH" ]; then
  echo "release.sh: pubkey file missing at $PUBKEY_PATH" >&2
  exit 1
fi

echo "==> building $VERSION (Flowix → bundle/)"
cd "$REPO_ROOT"
FLOWIX_ALLOW_UNSIGNED="${FLOWIX_ALLOW_UNSIGNED:-1}" \
  npm run tauri:build:production 2>&1 | tee "$RELEASE_OUT/.build.log"

if [ ! -d "$BUNDLE_DIR/macos/Flowix.app" ] && [ ! -d "$BUNDLE_DIR/nsis" ] && [ ! -d "$BUNDLE_DIR/appimage" ]; then
  echo "release.sh: build didn't produce any recognised bundle" >&2
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: for each platform bundle, tar the `.app` (or leave .msi.zip /
# .AppImage.tar.gz as-is from Tauri's own bundling), and minisign it.
# ──────────────────────────────────────────────────────────────────────────────

PUBKEY="$(grep -v '^untrusted' "$PUBKEY_PATH" | tr -d '\n')"

sign_artifact () {
  # sign_artifact <path> <output-name>
  local src="$1"
  local out="$2"
  cp "$src" "$RELEASE_OUT/$out"
  echo "==> signing $out"
  if ! minisign -S \
        -s "${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/keys/flowix-dev.key}" \
        -m "$RELEASE_OUT/$out" \
        -c "release ${VERSION}" </dev/null; then
    echo "release.sh: minisign failed for $out" >&2
    exit 2
  fi
}

# macOS
if [ -d "$BUNDLE_DIR/macos/Flowix.app" ]; then
  cd "$BUNDLE_DIR/macos"
  tar -czf "$RELEASE_OUT/Flowix_${VERSION}_aarch64.app.tar.gz" Flowix.app
  cd "$REPO_ROOT"
  sign_artifact "$RELEASE_OUT/Flowix_${VERSION}_aarch64.app.tar.gz" "Flowix_${VERSION}_aarch64.app.tar.gz"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: write update.json. Currently a single-platform manifest; extend with
# windows + linux once those targets ship real artifacts.
# ──────────────────────────────────────────────────────────────────────────────

darwin_aarch64_sig_file="$RELEASE_OUT/Flowix_${VERSION}_aarch64.app.tar.gz.minisig"
darwin_aarch64_sig="$(sed -n 2p "$darwin_aarch64_sig_file")"

cat >"$RELEASE_OUT/update.json" <<EOF
{
  "version": "${VERSION}",
  "notes": "Release ${TAG}.",
  "pub_date": "$(date -u +%FT%TZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${darwin_aarch64_sig}",
      "url": "https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${TAG}/Flowix_${VERSION}_aarch64.app.tar.gz"
    }
  }
}
EOF
echo "==> wrote $RELEASE_OUT/update.json"

# ──────────────────────────────────────────────────────────────────────────────
# Step 4 (optional) publish to GitHub Releases. Skipped by default in local
# dev. CI sets GITHUB_TOKEN + a non-empty GH_TOKEN-derived variable to enable.
# ──────────────────────────────────────────────────────────────────────────────

if [ "${FLOWIX_SKIP_PUBLISH:-1}" = "1" ] || [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "==> publish skipped (set GH_TOKEN + FLOWIX_SKIP_PUBLISH=0 to enable)"
  exit 0
fi

echo "==> creating GitHub release ${TAG}"
GH="${GH:-$(command -v gh || true)}"
if [ -z "$GH" ]; then
  echo "release.sh: gh CLI not on PATH; aborting publish phase" >&2
  exit 3
fi

upload () {
  local file="$1"
  local name="$(basename "$file")"
  GH_TOKEN="$GH_TOKEN" "$GH" release upload \
    --repo "${GH_OWNER}/${GH_REPO}" --tag "${TAG}" --clobber --name "$name" "$file"
}

"$GH" release create "$TAG" \
  --repo "${GH_OWNER}/${GH_REPO}" \
  --title "Flowix ${VERSION}" \
  --notes-file "$RELEASE_OUT/.notes.md" \
  --draft \
  || { echo "release.sh: gh release create failed" >&2; exit 3; }

upload "$RELEASE_OUT/Flowix_${VERSION}_aarch64.app.tar.gz"
upload "$RELEASE_OUT/update.json"

echo "==> done. release ${TAG} draft: https://github.com/${GH_OWNER}/${GH_REPO}/releases/tag/${TAG}"
