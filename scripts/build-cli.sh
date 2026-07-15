#!/usr/bin/env bash
# Build flowix-cli (the standalone CLI sidecar) and copy the binary into
# `app/flowix-desktop/binaries/` so Tauri's externalBin can pick it up.
#
# Usage:
#   bash scripts/build-cli.sh              # release build, current host
#   bash scripts/build-cli.sh --debug      # debug build, current host
#   bash scripts/build-cli.sh --all        # build all 3 host triples into binaries/
#
# Side-effect:
# - writes `app/flowix-desktop/binaries/flowix-cli-<host-triple>` (with the right
#   extension on Windows, but Tauri will rename it on copy).
# - does NOT touch the workspace `target/` (cargo decides where to put it).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../app" && pwd)"
BINARIES_DIR="$APP_DIR/flowix-desktop/binaries"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
export CARGO_TARGET_DIR

PROFILE="release"
BUILD_ALL=0

for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE="debug" ;;
    --all)   BUILD_ALL=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# --debug + --all 是矛盾的: --all 强制走 release 链路, --debug 期望 debug 产物。
# 显式拒绝, 避免调用者拿到一个跟意图不符的 binary。
if [ "$BUILD_ALL" = "1" ] && [ "$PROFILE" = "debug" ]; then
  echo "error: --debug and --all are mutually exclusive (--all pins release)" >&2
  exit 2
fi

# ── helpers ──────────────────────────────────────────────────────────
host_triple() {
  rustc -vV | sed -n 's|host: ||p'
}

# Tauri externalBin 期待: binaries/flowix-cli (无后缀)。 Windows 上仍用
# 同名 (Tauri 内部加 .exe), Unix 也不加后缀。
copy_to_binaries() {
  local host="$1"
  local src="$2"
  local ext=""
  if [[ "$host" == *windows* ]]; then
    ext=".exe"
  fi
  local dst="$BINARIES_DIR/flowix-cli-$host$ext"
  mkdir -p "$BINARIES_DIR"
  cp "$src" "$dst"
  echo "  → $dst"
}

# Dev-mode 入口: `binaries/flowix-cli` (无 triple / 扩展名) 是 Tauri 2 在
# `cargo tauri dev` 时的 sidecar 源文件名 (没有就走 fallback 失败)。
# 这里在 `binaries/flowix-cli-<host>` 旁建一个同名 symlink 指向它 ──
# 只在单 host build 时跑, --all 模式跨平台, symlink 没法统一指向。
#
# Windows 上 Git Bash 在没开 Developer Mode 时建不出 symlink; 失败就
# 退化成 cp -f。 dev 本地完全够用, 只是 dev 期改 src 后 CLI sidecar
# 跟大 binary 同步更新反而更可控 (不会出现 symlink 指向陈旧 target 的
# 视觉残留)。
create_dev_symlink() {
  local host="$1"
  local ext=""
  if [[ "$host" == *windows* ]]; then
    ext=".exe"
  fi
  local target="flowix-cli-$host$ext"
  local link="$BINARIES_DIR/flowix-cli"
  [[ -n "$ext" ]] && link="${link}${ext}"
  # 旧的 symlink / 文件残留先清掉, ln -sf 跨平台会覆盖, 这里显式 rm 防止奇怪状态。
  rm -f "$link"
  if ln -s "$target" "$link" 2>/dev/null; then
    echo "  → dev symlink: $link -> $target"
  else
    cp -f "$BINARIES_DIR/$target" "$link"
    echo "  → dev copy (symlink unavailable): $link"
  fi
}

# ── main ────────────────────────────────────────────────────────────
echo "▸ flowix-cli build (profile=$PROFILE)"

if [ "$BUILD_ALL" = "1" ]; then
  # CI 用 ── 三平台全编。
  for triple in \
    x86_64-unknown-linux-gnu \
    x86_64-apple-darwin \
    aarch64-apple-darwin \
    x86_64-pc-windows-msvc
  do
    host="$triple"
    echo "▸ build for $host"
    cargo build \
      --manifest-path "$APP_DIR/Cargo.toml" \
      --bin flowix-cli \
      --target "$triple" \
      --release
    bin_path="$CARGO_TARGET_DIR/$triple/release/flowix-cli"
    [[ "$triple" == *windows* ]] && bin_path="${bin_path}.exe"
    copy_to_binaries "$host" "$bin_path"
    # 签名 ── macOS / Windows 走 codesign / signtool, Linux 跳过。
    # `|| true` 让 dev 本地无证书时 build 不挂。
    bash "$SCRIPT_DIR/sign-cli.sh" --host="$host" || true
  done
else
  host="$(host_triple)"
  echo "▸ host = $host"
  cargo build \
    --manifest-path "$APP_DIR/Cargo.toml" \
    --bin flowix-cli \
    $([ "$PROFILE" = "release" ] && echo "--release")
  bin_path="$CARGO_TARGET_DIR/$PROFILE/flowix-cli"
  if [ ! -f "$bin_path" ]; then
    # If callers override CARGO_TARGET_DIR or Cargo uses host-specific output,
    # keep a fallback that mirrors explicit --target builds.
    bin_path="$CARGO_TARGET_DIR/$host/$PROFILE/flowix-cli"
  fi
  copy_to_binaries "$host" "$bin_path"
  bash "$SCRIPT_DIR/sign-cli.sh" --host="$host" || true
fi

# Dev-mode symlink: 让 `cargo tauri dev` 能找到 `binaries/flowix-cli`。
# --all 模式 (CI) 跳过 ── 跨平台 symlink 没意义, 让 dev 本地 build 时跑。
if [ "$BUILD_ALL" = "0" ]; then
  create_dev_symlink "$host"
else
  echo "  (skip dev symlink in --all mode)"
fi

echo "✓ done"
