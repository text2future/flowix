#!/usr/bin/env bash
# sign-cli.sh ── 对 `scripts/build-cli.sh` 编出的 flowix-cli sidecar 走代码签名。
#
# 用法:
#   bash scripts/sign-cli.sh --host=<triple>
#   例: bash scripts/sign-cli.sh --host=x86_64-pc-windows-msvc
#
# 平台分流 (按 host 三元组):
#   - *apple*  → codesign --options runtime --timestamp + xcrun notarytool + stapler staple
#   - *windows* → signtool sign /fd sha256 /tr <timestamp> /td sha256 /f <pfx>
#   - 其它 (linux) → noop, Linux 发行版不强制签名
#
# env vars (CI secret 注入, dev 本地可不设):
#   APPLE_SIGNING_IDENTITY    keychain 里的 identity 名称 (e.g. "Developer ID Application: ...")
#   APPLE_TEAM_ID             Apple Team ID (e.g. "ABCDE12345")
#   APPLE_KEYCHAIN_PROFILE    xcrun notarytool 的 keychain profile
#   WINDOWS_CERTIFICATE       base64 编码的 .pfx 内容
#   WINDOWS_CERTIFICATE_PASSWORD  .pfx 导出密码
#   WINDOWS_TIMESTAMP_URL      RFC 3161 timestamp URL (默认 http://timestamp.sectigo.com)
#
# Fallback (dev 本地无证书, 跟 `cli:build:all` 一起跑不挂):
#   APPLE_SIGNING_IDENTITY='-'  → ad-hoc 签 (`codesign --sign -`), 跳过 notarization
#   APPLE_SIGNING_IDENTITY 空    → 打印 skip 后退出 0
#   WINDOWS_CERTIFICATE 空       → 打印 skip 后退出 0
#
# 退出码: 0 = 成功 (含 skip / ad-hoc), 1 = 真出错。

set -euo pipefail

# repo root 解析 ── 跟 `build-cli.sh` 一致, 走脚本自身位置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARIES_DIR="$REPO_ROOT/app/flowix-desktop/binaries"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HOST=""
for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    -h|--help)
      sed -n '2,28p' "$0"   # 顶部 doc 段
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "Usage: $0 --host=<rustc-target-triple>" >&2
  echo "  e.g. $0 --host=aarch64-apple-darwin" >&2
  exit 2
fi

# =================== macOS ===================
sign_macos() {
  local host="$1"
  local bin="$BINARIES_DIR/flowix-cli-$host"
  if [[ ! -f "$bin" ]]; then
    echo "[sign] skip: $bin not found (run scripts/build-cli.sh first)"
    return 0
  fi

  local identity="${APPLE_SIGNING_IDENTITY:-}"
  if [[ -z "$identity" ]]; then
    echo "[sign] APPLE_SIGNING_IDENTITY not set, skip codesign (本地开发)"
    return 0
  fi

  if [[ "$identity" == "-" ]]; then
    # ad-hoc 模式 ── 本地调试用, Gatekeeper 会拦截但本地跑得动
    echo "[sign] macOS ad-hoc signing (no Developer ID)"
    codesign --force --sign - "$bin"
    return 0
  fi

  echo "[sign] codesign --options runtime --timestamp --sign $identity $bin"
  codesign --force --options runtime --timestamp --sign "$identity" "$bin"

  # notarize ── 跳过 if 没配 keychain profile (dev 跳过)
  if [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    echo "[sign] APPLE_KEYCHAIN_PROFILE not set, skip notarization (本地 / 仅 codesign)"
    return 0
  fi

  echo "[sign] notarytool submit (keychain profile: $APPLE_KEYCHAIN_PROFILE) ..."
  xcrun notarytool submit "$bin" \
    --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
    --wait

  echo "[sign] stapler staple $bin"
  xcrun stapler staple "$bin"
}

# =================== Windows ===================
sign_windows() {
  local bin="$BINARIES_DIR/flowix-cli-x86_64-pc-windows-msvc.exe"
  if [[ ! -f "$bin" ]]; then
    echo "[sign] skip: $bin not found (run scripts/build-cli.sh first)"
    return 0
  fi

  if [[ -z "${WINDOWS_CERTIFICATE:-}" ]]; then
    echo "[sign] WINDOWS_CERTIFICATE not set, skip signtool (本地开发)"
    return 0
  fi

  local pfx="$TMP_DIR/flowix.pfx"
  echo "[sign] decode WINDOWS_CERTIFICATE (base64) → $pfx"
  echo "$WINDOWS_CERTIFICATE" | base64 -d > "$pfx"

  local ts="${WINDOWS_TIMESTAMP_URL:-http://timestamp.sectigo.com}"
  echo "[sign] signtool sign /fd sha256 /tr $ts /td sha256 /f $pfx $bin"
  signtool sign /fd sha256 /tr "$ts" /td sha256 \
    /f "$pfx" /p "$WINDOWS_CERTIFICATE_PASSWORD" "$bin"

  echo "[sign] signtool verify /pa $bin"
  signtool verify /pa "$bin"
}

# =================== dispatch ===================
case "$HOST" in
  *apple*)
    sign_macos "$HOST"
    ;;
  *windows*)
    sign_windows
    ;;
  *linux*)
    echo "[sign] linux host, no signing required"
    ;;
  *)
    echo "[sign] unknown host: $HOST" >&2
    exit 2
    ;;
esac

echo "[sign] done for $HOST"
