#!/usr/bin/env bash
# Build signed Tauri updater artifacts, publish them to R2, and deploy the
# stable updater manifest through the flowix-home Pages site.
#
# Useful overrides:
#   FLOWIX_HOME_DIR          local flowix-home checkout
#   FLOWIX_TARGETS           space-separated Rust targets to collect
#   FLOWIX_R2_BUCKET         R2 bucket name (default: flowix-downloads)
#   FLOWIX_R2_PREFIX         object prefix for versioned artifacts (default: v${VERSION})
#   FLOWIX_R2_UPDATER_PREFIX object prefix for stable per-platform updater manifests
#                            (default: updater) ── written to
#                            ${BUCKET}/${PREFIX}/{macos,windows,linux}/latest.json
#   FLOWIX_R2_PUBLIC_BASE    public package origin
#   TAURI_SIGNING_PRIVATE_KEY           Tauri updater private key (or use PATH)
#   TAURI_SIGNING_PRIVATE_KEY_PATH      path to the Tauri updater private key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  optional Tauri updater key password
#   FLOWIX_SKIP_BUILD=1       collect artifacts already present in CARGO_TARGET_DIR
#   FLOWIX_PUBLISH=1          upload R2; full releases also deploy flowix-home
#   FLOWIX_UPDATE_NOTIFY     whether installed clients show update prompts
#                            (default: true; set false for silent releases)
#
# This is the only production publication path for the Flowix updater. The
# GitHub release workflow creates draft artifacts but does not update the
# configured updater endpoint. The default mode here is build + manifest
# generation only; publishing is explicit so a local build cannot accidentally
# replace the production manifest.
#
# Release scope (auto-detected from FLOWIX_TARGETS):
#   * full   = all three platform groups (macos, windows, linux) are covered
#              → per-platform updater manifests uploaded and flowix-home
#                rebuilt/deployed for the website downloads.
#   * partial = one or two platform groups only
#              → only the covered per-platform updater manifests are
#                uploaded; flowix-home is left alone (lagging platforms keep
#                whatever the site already shows, which is correct because
#                they were not released this time).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
export CARGO_TARGET_DIR

VERSION="$(awk -F'"' '/^version *=/{print $2; exit}' "$REPO_ROOT/app/Cargo.toml")"
FLOWIX_HOME_DIR="${FLOWIX_HOME_DIR:-$REPO_ROOT/../flowix-home}"
FLOWIX_R2_BUCKET="${FLOWIX_R2_BUCKET:-flowix-downloads}"
FLOWIX_R2_PREFIX="${FLOWIX_R2_PREFIX:-v${VERSION}}"
FLOWIX_R2_UPDATER_PREFIX="${FLOWIX_R2_UPDATER_PREFIX:-updater}"
FLOWIX_R2_PUBLIC_BASE="${FLOWIX_R2_PUBLIC_BASE:-https://download.flowix.cc}"
FLOWIX_HOME_PROJECT="${FLOWIX_HOME_PROJECT:-flowix-home}"
FLOWIX_HOME_BRANCH="${FLOWIX_HOME_BRANCH:-main}"
RELEASE_OUT="${RELEASE_OUT:-$CARGO_TARGET_DIR/release/updater}"

SIGNING_KEY_AVAILABLE=0
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" || -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  SIGNING_KEY_AVAILABLE=1
elif [[ "$(uname -s)" == "Darwin" ]]; then
  TAURI_SIGNING_PRIVATE_KEY_KEYCHAIN_SERVICE="${TAURI_SIGNING_PRIVATE_KEY_KEYCHAIN_SERVICE:-com.flowix.minisign.private-key}"
  if security find-generic-password -s "$TAURI_SIGNING_PRIVATE_KEY_KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
    SIGNING_KEY_AVAILABLE=1
  fi
fi
if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" && "$SIGNING_KEY_AVAILABLE" != "1" ]]; then
  echo "release.sh: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required for signed Flowix updater artifacts" >&2
  exit 1
fi
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" \
  && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" \
  && ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
  echo "release.sh: signing key path does not exist: $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
  exit 1
fi

if [[ -z "${FLOWIX_TARGETS:-}" ]]; then
  case "$(uname -s)" in
    Darwin) FLOWIX_TARGETS="aarch64-apple-darwin" ;;
    MINGW*|MSYS*|CYGWIN*) FLOWIX_TARGETS="x86_64-pc-windows-msvc" ;;
    *) FLOWIX_TARGETS="x86_64-unknown-linux-gnu" ;;
  esac
fi
if [[ "${FLOWIX_PUBLISH:-0}" == "1" ]]; then
  if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" ]]; then
    echo "release.sh: production publishing requires FLOWIX_SKIP_BUILD=1" >&2
    exit 1
  fi
  # Per-platform updater manifests make partial releases safe: mac and win
  # can now ship different latest versions on independent cadences. Full
  # releases also refresh the website; partial releases skip that step.
fi

rm -rf "$RELEASE_OUT"
mkdir -p "$RELEASE_OUT"

if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building Flowix ${VERSION}"
  cd "$REPO_ROOT"
  npm run tauri:build:prod
fi

find_artifact() {
  local target="$1"
  local search_root
  local artifact_pattern
  case "$target" in
    *apple-darwin) artifact_pattern='Flowix.app.tar.gz' ;;
    *windows-msvc) artifact_pattern="Flowix_${VERSION}_*-setup.exe" ;;
    *linux-gnu) artifact_pattern="Flowix_${VERSION}_*.AppImage.tar.gz" ;;
    *) return 1 ;;
  esac
  for search_root in \
    "$CARGO_TARGET_DIR/$target/release/bundle" \
    "$CARGO_TARGET_DIR/release/bundle"; do
    [[ -d "$search_root" ]] || continue
    candidate="$(find "$search_root" -type f \( \
      -name "$artifact_pattern" \
    \) ! -name '*.sig' -print | sort | tail -n 1)"
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
}

platform_for_target() {
  case "$1" in
    aarch64-apple-darwin) echo "darwin-aarch64" ;;
    x86_64-apple-darwin) echo "darwin-x86_64" ;;
    x86_64-pc-windows-msvc) echo "windows-x86_64" ;;
    x86_64-unknown-linux-gnu) echo "linux-x86_64" ;;
    *) echo "" ;;
  esac
}

artifact_suffix_for_target() {
  case "$1" in
    *apple-darwin) echo "app.tar.gz" ;;
    *windows-msvc) echo "nsis.exe" ;;
    *linux-gnu) echo "AppImage.tar.gz" ;;
    *) echo "" ;;
  esac
}

# Per-release-group 名: macos/windows/linux ── 用于拆 manifest 与 R2 路径。
# 每个 group 的 manifest 互相独立, 允许 mac/win 在不同版本独立发布。
platform_group_for_target() {
  case "$1" in
    *apple-darwin) echo "macos" ;;
    *windows-msvc) echo "windows" ;;
    *linux-gnu) echo "linux" ;;
    *) echo "" ;;
  esac
}

# 写出单个 signed manifest。rows 是 "platform|name" 字符串数组。
write_manifest() {
  local output="$1"
  shift
  local rows=("$@")

  FLOWIX_MANIFEST_OUT="$output" \
  FLOWIX_RELEASE_OUT="$RELEASE_OUT" \
  FLOWIX_VERSION="$VERSION" \
  FLOWIX_R2_PUBLIC_BASE="$FLOWIX_R2_PUBLIC_BASE" \
  FLOWIX_R2_PREFIX="$FLOWIX_R2_PREFIX" \
  node "$REPO_ROOT/scripts/build-updater-manifest.mjs" "${rows[@]}"
}

# 用 verify-updater-release.mjs 校验单个 manifest。
verify_manifest() {
  local manifest="$1"
  shift
  local required_platforms=("$@")
  node "$REPO_ROOT/scripts/verify-updater-release.mjs" \
    --release-dir "$RELEASE_OUT" \
    "$manifest" "$VERSION" "$FLOWIX_R2_PREFIX" "${required_platforms[@]}"
}

append_group_row() {
  # Uppercase the group name so callers can pass either "macos" or "MACOS".
  # append_group_row macos -> GROUP_ROWS_MACOS (bash 3.2 兼容).
  local group row platform; group="$(echo "$1" | tr "[:lower:]" "[:upper:]")"; row="$2"; platform="$3"
  case "$group" in
    MACOS)
      GROUP_ROWS_MACOS+="$row"$'\n'
      GROUP_PLATFORMS_MACOS+="$platform "
      ;;
    WINDOWS)
      GROUP_ROWS_WINDOWS+="$row"$'\n'
      GROUP_PLATFORMS_WINDOWS+="$platform "
      ;;
    LINUX)
      GROUP_ROWS_LINUX+="$row"$'\n'
      GROUP_PLATFORMS_LINUX+="$platform "
      ;;
  esac
}

group_rows_var()    { echo "GROUP_ROWS_$(echo "$1" | tr "[:lower:]" "[:upper:]")"; }
group_platforms_var(){ echo "GROUP_PLATFORMS_$(echo "$1" | tr "[:lower:]" "[:upper:]")"; }
# bash 3.2 的间接引用: ${!name} 其中 name 持有变量名。不走 eval ── 既有内容
# (含换行) 原样透传, 也不存在注入面。白名单限定只读 group 变量。
group_value() {
  local name="$1"
  case "$name" in
    GROUP_ROWS_MACOS|GROUP_ROWS_WINDOWS|GROUP_ROWS_LINUX|\
    GROUP_PLATFORMS_MACOS|GROUP_PLATFORMS_WINDOWS|GROUP_PLATFORMS_LINUX)
      printf '%s' "${!name}"
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}
# has_rows 放在 group_value 之后定义, 但调用是 lazy 的 ── 运行到时已经定义。
group_has_rows()    { [[ -n "$(group_value "$1")" ]]; }

declare -a UPLOAD_FILES=()
# Per-group staging (保持 bash 3.2 兼容 ── 用 plain 变量, 不用 declare -A)。
# 每个 group 的 rows 串成 "$platform|$name\n..."; platforms 是空格分隔。
GROUP_ROWS_MACOS=""
GROUP_ROWS_WINDOWS=""
GROUP_ROWS_LINUX=""
GROUP_PLATFORMS_MACOS=""
GROUP_PLATFORMS_WINDOWS=""
GROUP_PLATFORMS_LINUX=""
for target in $FLOWIX_TARGETS; do
  platform="$(platform_for_target "$target")"
  group="$(platform_group_for_target "$target")"
  suffix="$(artifact_suffix_for_target "$target")"
  [[ -n "$platform" && -n "$group" && -n "$suffix" ]] || {
    echo "release.sh: unsupported target $target" >&2
    exit 1
  }

  source_path="$(find_artifact "$target" || true)"
  if [[ -z "$source_path" || ! -f "$source_path" ]]; then
    echo "release.sh: no updater artifact found for $target" >&2
    exit 1
  fi
  signature_path="${source_path}.sig"
  if [[ ! -f "$signature_path" ]]; then
    echo "release.sh: missing Flowix updater signature $signature_path" >&2
    exit 1
  fi
  output_name="Flowix_${VERSION}_${platform}.${suffix}"
  cp "$source_path" "$RELEASE_OUT/$output_name"
  cp "$signature_path" "$RELEASE_OUT/$output_name.sig"
  node "$REPO_ROOT/scripts/verify-flowix-package.mjs" "$RELEASE_OUT/$output_name"
  UPLOAD_FILES+=("$output_name" "$output_name.sig")
  echo "==> collected signed updater $platform: $output_name"

  # Keep the human-facing macOS DMG available for flowix-home. The updater
  # itself uses the signed .app.tar.gz archive above.
  if [[ "$group" == "macos" ]]; then
    installer_path=""
    for search_root in \
      "$CARGO_TARGET_DIR/$target/release/bundle" \
      "$CARGO_TARGET_DIR/release/bundle"; do
      [[ -d "$search_root" ]] || continue
      installer_path="$(find "$search_root" -type f -name "Flowix_${VERSION}_*.dmg" -print | sort | tail -n 1)"
      [[ -n "$installer_path" ]] && break
    done
    if [[ -z "$installer_path" || ! -f "$installer_path" ]]; then
      echo "release.sh: no macOS DMG found for $target" >&2
      exit 1
    fi
    installer_name="Flowix_${VERSION}_${platform}.dmg"
    cp "$installer_path" "$RELEASE_OUT/$installer_name"
    UPLOAD_FILES+=("$installer_name")
    echo "==> collected website installer $platform: $installer_name"
  fi

  append_group_row "$group" "$platform|$output_name" "$platform"
done

export FLOWIX_RELEASE_OUT="$RELEASE_OUT"
export FLOWIX_VERSION="$VERSION"
export FLOWIX_R2_PUBLIC_BASE
export FLOWIX_R2_PREFIX

# 收集有产出的 group (顺序固定为 macos -> windows -> linux, 方便日志比对)
declare -a ACTIVE_GROUPS=()
for group in macos windows linux; do
  if group_has_rows "$(group_rows_var "$group")"; then
    ACTIVE_GROUPS+=("$group")
  fi
done
IS_FULL_RELEASE=0
if [[ ${#ACTIVE_GROUPS[@]} -eq 3 ]]; then
  IS_FULL_RELEASE=1
fi
if [[ $IS_FULL_RELEASE -eq 1 ]]; then
  echo "==> release scope: full (all three platform groups covered)"
else
  echo "==> release scope: partial (only: ${ACTIVE_GROUPS[*]})"
fi

# 写出每个 group 自己的 updater manifest (供 app 内 updater 直连)。
# 不结转滞后平台 ── 该 platform 这次没产出, manifest 里就不该有它的 key,
# 否则 Tauri updater 会以为它存在并比 version, 触发「无限重装」的老 bug。
for group in "${ACTIVE_GROUPS[@]}"; do
  group_rows=()
  while IFS= read -r row; do
    [[ -n "$row" ]] && group_rows+=("$row")
  done <<< "$(group_value "$(group_rows_var "$group")")"

  group_out="$RELEASE_OUT/updater/$group/latest.json"
  mkdir -p "$(dirname "$group_out")"
  write_manifest "$group_out" "${group_rows[@]}"

  read -r -a group_required <<< "$(group_value "$(group_platforms_var "$group")")"
  verify_manifest "$group_out" "${group_required[@]}"
done

if [[ "${FLOWIX_PUBLISH:-0}" != "1" ]]; then
  echo "==> publish skipped (set FLOWIX_PUBLISH=1 to upload R2)"
  exit 0
fi

WRANGLER="${WRANGLER:-$(command -v wrangler || true)}"
if [[ -z "$WRANGLER" ]]; then
  echo "release.sh: wrangler is required when FLOWIX_PUBLISH=1" >&2
  exit 1
fi

if [[ "$IS_FULL_RELEASE" -eq 1 && ! -d "$FLOWIX_HOME_DIR" ]]; then
  echo "release.sh: flowix-home checkout not found at $FLOWIX_HOME_DIR" >&2
  exit 1
fi

# Versioned artifacts 上传到版本前缀路径 (immutable)。同时发布签名 updater
# archive 和官网下载用的 DMG；Windows NSIS 包两者共用同一文件。
for name in "${UPLOAD_FILES[@]}"; do
  echo "==> uploading $name to R2"
  "$WRANGLER" r2 object put "$FLOWIX_R2_BUCKET/$FLOWIX_R2_PREFIX/$name" \
    --file "$RELEASE_OUT/$name" --remote
done

# Publish manifests only after every referenced artifact has uploaded.
# Production 1.5.0/1.5.1 bundled Pi and embedded updater/pi/<group>/latest.json.
# Keep that address working for installed clients alongside the canonical path.
for group in "${ACTIVE_GROUPS[@]}"; do
  group_manifest="$RELEASE_OUT/updater/$group/latest.json"
  for manifest_key in "$FLOWIX_R2_UPDATER_PREFIX/$group/latest.json" "$FLOWIX_R2_UPDATER_PREFIX/pi/$group/latest.json"; do
    echo "==> uploading $group updater manifest to R2: $manifest_key"
    "$WRANGLER" r2 object put "$FLOWIX_R2_BUCKET/$manifest_key" \
      --file "$group_manifest" --content-type application/json --remote
  done
done

if [[ "$IS_FULL_RELEASE" -eq 1 ]]; then
  # flowix-home 使用模板中的静态下载链接, 全量发布时重新构建并部署站点。
  npm --prefix "$FLOWIX_HOME_DIR" run build
  echo "==> deploying flowix-home"
  "$WRANGLER" pages deploy "$FLOWIX_HOME_DIR/_site" \
    --project-name "$FLOWIX_HOME_PROJECT" --branch "$FLOWIX_HOME_BRANCH"
else
  echo "==> flowix-home deployment skipped for partial release"
fi

echo "==> published Flowix ${VERSION}"
for group in "${ACTIVE_GROUPS[@]}"; do
  echo "    updater[$group]: $FLOWIX_R2_PUBLIC_BASE/$FLOWIX_R2_UPDATER_PREFIX/$group/latest.json"
done
echo "    artifacts: $FLOWIX_R2_PUBLIC_BASE/$FLOWIX_R2_PREFIX/"
