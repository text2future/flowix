#!/usr/bin/env bash
# Full Apple Developer ID signing + notarization pipeline for Flowix.
#
# Pre-requisites on the machine running this script:
#   • The Developer ID Application identity is in the login Keychain
#     (verify with:   security find-identity -v -p codesigning  )
#   • An Apple App-Specific Password has been generated from appleid.apple.com
#     and is supplied via $APPLE_APP_SPECIFIC_PASSWORD below
#
# Required env vars (none of these should ever be inlined into the script):
#   APPLE_SIGNING_IDENTITY          e.g. "Developer ID Application: Your Name (ABCDE12345)"
#                                   (output of `security find-identity -v -p codesigning`)
#   APPLE_TEAM_ID                   10-character Team ID from Membership Details
#   APPLE_ID                        Apple Account email
#
# Notarization auth - EXACTLY ONE of these two:
#   APPLE_KEYCHAIN_PROFILE          (preferred) Profile name previously stored via
#                                   `xcrun notarytool store-credentials <name> ...`
#                                   Password lives only in macOS Keychain.
#   APPLE_APP_SPECIFIC_PASSWORD     (fallback) 16-char App-Specific Password (NOT Apple ID password).
#                                   Use this if you don't have store-credentials set up.
#   APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER
#                                   App Store Connect API key authentication.
#
# Optional env vars:
#   SKIP_BUILD=1                    Skip `tauri build`, use existing target/
#   SKIP_NOTARIZE=1                 Build + sign only, don't submit to notary
#   DMG_PATH                        (ignored in dual-target mode) override a single .dmg
#
# macOS 发版生成 Apple Silicon 与 Intel 两个独立 DMG。每个 DMG 都会
# 单独验证架构、签名、公证、staple，并通过 Gatekeeper 校验。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/app/flowix-desktop"
ENTITLEMENTS="$DESKTOP_DIR/entitlements.plist"
VERIFY_RELEASE="$REPO_ROOT/scripts/verify-macos-release.sh"

# CARGO_TARGET_DIR is exported by scripts/build-cli.mjs - usually
# $REPO_ROOT/.build/cargo-target. Tauri's bundle output goes there, NOT
# under app/flowix-desktop/target/release.
# `tauri build --target <triple>` 把 bundle 落到 $CARGO_TARGET_DIR/<triple>/release/bundle/,
# 跟 host 路径 ($CARGO_TARGET_DIR/release/bundle/) 分开, 两个 target 互不覆盖。
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
MACOS_TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)

# ---- 0. Validate inputs ----
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY not set - run \`security find-identity -v -p codesigning\` and copy the full string}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set - find in developer.apple.com -> Membership Details}"

# Notarization auth: pick one of two paths. A signed-only validation run does
# not need notary credentials because it never contacts Apple's service.
NOTARY_AUTH_FLAGS=()
if [ -n "${SKIP_NOTARIZE:-}" ]; then
  echo "==> Notarization disabled (SKIP_NOTARIZE=1); credentials not required"
else
  auth_count=0
  [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ] && auth_count=$((auth_count + 1))
  [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && auth_count=$((auth_count + 1))
  [ -n "${APPLE_API_KEY_PATH:-}" ] && auth_count=$((auth_count + 1))
  if [ "$auth_count" -gt 1 ]; then
    echo "ERROR: Configure exactly one notarization auth method." >&2
    exit 2
  fi
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID not set - required with APPLE_API_KEY_PATH}"
    : "${APPLE_API_ISSUER:?APPLE_API_ISSUER not set - required with APPLE_API_KEY_PATH}"
    if [ ! -f "$APPLE_API_KEY_PATH" ]; then
      echo "ERROR: APPLE_API_KEY_PATH does not exist: $APPLE_API_KEY_PATH" >&2
      exit 2
    fi
    NOTARY_AUTH_FLAGS=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
    echo "==> Notarization auth: App Store Connect API key '$APPLE_API_KEY_ID'"
  elif [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ] && [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    echo "ERROR: Notarization auth not configured. Choose ONE of:" >&2
    echo "  (preferred)  export APPLE_KEYCHAIN_PROFILE='name'" >&2
    echo "               (run once: xcrun notarytool store-credentials NAME --apple-id ... --team-id ... --password ...)" >&2
    echo "  (fallback)   export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'" >&2
    exit 2
  fi

  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    : # API key flags were assembled above.
  elif [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
    NOTARY_AUTH_FLAGS=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
    echo "==> Notarization auth: Keychain profile '$APPLE_KEYCHAIN_PROFILE' (password NEVER in env)"
  else
    : "${APPLE_ID:?APPLE_ID not set - required with APPLE_APP_SPECIFIC_PASSWORD auth}"
    NOTARY_AUTH_FLAGS=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
    echo "==> Notarization auth: App-Specific Password fallback (password in env)"
  fi
fi

# Friendly Team ID sanity check
if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ERROR: APPLE_TEAM_ID should be 10 alphanumeric characters, got: $APPLE_TEAM_ID" >&2
  exit 2
fi

# Verify the identity actually exists in the keychain before doing anything
# destructive (codesigning a half-broken build is the worst kind of waste)
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "ERROR: '$APPLE_SIGNING_IDENTITY' is not in the codesigning identity list." >&2
  echo "       Run \`security find-identity -v -p codesigning\` and pick the right one." >&2
  exit 1
fi

if [ ! -f "$ENTITLEMENTS" ]; then
  echo "ERROR: $ENTITLEMENTS missing - the project no longer matches the docs." >&2
  exit 1
fi
if [ ! -f "$VERIFY_RELEASE" ]; then
  echo "ERROR: $VERIFY_RELEASE missing - release verification cannot run." >&2
  exit 1
fi

cd "$REPO_ROOT"

# ---- 1. Build ----
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> [build] Building Flowix.app + Flowix.dmg for ${MACOS_TARGETS[*]} (3-6 min)"
  echo "         (build-tauri-production.mjs builds and signs both targets per tauri.conf.production.json)"
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
  fi
  # Apple's RFC 3161 timestamp service is intermittently unavailable, and Tauri's
  # internal codesign step uses it. Wrap the build in a retry loop so a transient
  # timestamp hiccup doesn't kill the whole release (memory
  # `flowix-release-build-detached-timestamp-retry`).
  bash "$SCRIPT_DIR/with-timestamp-retry.sh" -- npm run tauri:build:prod
else
  echo "==> [build] Skipping build (SKIP_BUILD=1)"
fi

# ---- 2-4. Per-target: verify the final DMG, notarize + staple, verify again ----
# 方案 B: macOS 出 ARM + Intel 两个独立 DMG, 每个 target 各走一遍签名 + notarize。
# `build-cli.mjs` prepares the staging sidecar, then Tauri signs the nested code
# and outer app before creating the DMG. Do not mutate the .app after that point:
# doing so would leave the already-created DMG stale.
if [ -n "${DMG_PATH:-}" ]; then
  echo "WARN: DMG_PATH is set but dual-target mode signs both aarch64 + x64; DMG_PATH ignored." >&2
fi

sign_and_notarize_target() {
  local triple="$1"
  local bundle_dmg="$CARGO_TARGET_DIR/$triple/release/bundle/dmg"

  echo
  echo ":::::::::::::::::::::::::::::::::::::::::::::::::::::::::"
  echo "  Target: $triple"
  echo ":::::::::::::::::::::::::::::::::::::::::::::::::::::::::"

  # Locate the .dmg (newest in this target's dmg dir)
  local dmg
  dmg="$(ls -t "$bundle_dmg/"*.dmg 2>/dev/null | head -1 || true)"
  if [ -z "$dmg" ] || [ ! -f "$dmg" ]; then
    echo "ERROR: .dmg not found under $bundle_dmg for $triple." >&2
    echo "       Run a full tauri:build:prod first." >&2
    exit 1
  fi

  echo "==> Verifying the exact DMG before notarization"
  APPLE_TEAM_ID="$APPLE_TEAM_ID" bash "$VERIFY_RELEASE" --pre-notarize "$dmg" "$triple"

  if [ -z "${SKIP_NOTARIZE:-}" ]; then
    echo "==> Submitting $dmg to Apple notary (can take 1-5 min)"
    xcrun notarytool submit "$dmg" "${NOTARY_AUTH_FLAGS[@]}" --wait

    echo "==> Stapling notarization ticket back onto the .dmg"
    xcrun stapler staple "$dmg"
    APPLE_TEAM_ID="$APPLE_TEAM_ID" bash "$VERIFY_RELEASE" --notarized "$dmg" "$triple"
  else
    echo "==> Skipping notarization + stapling (SKIP_NOTARIZE=1)"
  fi

  SIGNED_DMGS+=("$dmg")

  echo
  echo "  DMG ($triple): $dmg"
  echo "  SHA-256:"
  shasum -a 256 "$dmg" | awk '{print "    " $1}'
}

SIGNED_DMGS=()
for triple in "${MACOS_TARGETS[@]}"; do
  sign_and_notarize_target "$triple"
done

# ---- Done ----
echo
echo "================================================="
if [ -n "${SKIP_NOTARIZE:-}" ]; then
  echo "  Signed DMGs verified; notarization skipped (${#SIGNED_DMGS[@]} targets):"
else
  echo "  Notarized DMGs ready (${#SIGNED_DMGS[@]} targets):"
fi
for dmg in "${SIGNED_DMGS[@]}"; do
  echo "    $dmg"
done
echo
echo "  SHA-256 (paste into release notes so users can verify):"
for dmg in "${SIGNED_DMGS[@]}"; do
  shasum -a 256 "$dmg" | awk -v d="$dmg" '{print "    " $1 "  " d}'
done
echo "================================================="
