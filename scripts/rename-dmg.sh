#!/usr/bin/env bash
# scripts/rename-dmg.sh — rename tauri-built .dmg files to the human-friendly
# release naming scheme. Leaves everything else (signing, update.json, GH
# upload) to scripts/release.sh or the operator.
#
# Default: rewrites every .dmg found under .build/cargo-target/*/release/bundle/dmg/
# in place. Pass an explicit output directory as the first argument to write
# the renamed copies there (the originals are left untouched).
#
# Naming scheme:
#   Flowix_${VERSION}_aarch64.dmg → Flowix-${VERSION}-macOS-Apple-Silicon.dmg
#   Flowix_${VERSION}_x64.dmg      → Flowix-${VERSION}-macOS-Intel.dmg
#
# Examples:
#   ./scripts/rename-dmg.sh                       # rename in place
#   ./scripts/rename-dmg.sh .build/release-1.0.10 # copy + rename into out dir
#
# Exit codes:
#   0  at least one .dmg was renamed
#   1  no .dmg matched (likely nothing was built yet)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
VERSION="$(awk -F'"' '/^version *=/{print $2; exit}' "$REPO_ROOT/app/Cargo.toml")"

OUT_DIR="${1:-}"

suffix_for_arch() {
  case "$1" in
    aarch64) echo "macOS-Apple-Silicon" ;;
    x64)     echo "macOS-Intel" ;;
    *)       return 1 ;;
  esac
}

count=0
if [ -n "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR"
fi
shopt -s nullglob
for src in "$CARGO_TARGET_DIR"/*/release/bundle/dmg/Flowix_"$VERSION"_*.dmg; do
  filename="$(basename "$src")"
  arch="${filename%.dmg}"
  arch="${arch##*_}"
  if ! suffix="$(suffix_for_arch "$arch")"; then
    echo "rename-dmg.sh: skip $filename (no mapping for arch=$arch)" >&2
    continue
  fi

  target_name="Flowix-${VERSION}-${suffix}.dmg"

  if [ -n "$OUT_DIR" ]; then
    mkdir -p "$OUT_DIR"
    cp "$src" "$OUT_DIR/$target_name"
    echo "==> $filename -> $OUT_DIR/$target_name"
  else
    if [ "$(basename "$src")" = "$target_name" ]; then
      echo "==> $filename (already friendly-named)"
    else
      mv "$src" "$(dirname "$src")/$target_name"
      echo "==> $filename -> $target_name"
    fi
  fi
  count=$((count + 1))
done

# Also pick up already-friendly-named dmg files when OUT_DIR is set, so the
# operator can re-run the script safely to refresh an output directory.
if [ -n "$OUT_DIR" ]; then
  for src in "$CARGO_TARGET_DIR"/*/release/bundle/dmg/Flowix-"$VERSION"-macOS-*.dmg; do
    [ -e "$src" ] || continue
    filename="$(basename "$src")"
    if [ -e "$OUT_DIR/$filename" ]; then
      continue
    fi
    cp "$src" "$OUT_DIR/$filename"
    echo "==> $filename -> $OUT_DIR/$filename (already friendly-named, copied)"
    count=$((count + 1))
  done
fi

if [ "$count" -eq 0 ]; then
  echo "rename-dmg.sh: no Flowix_${VERSION}_*.dmg found under $CARGO_TARGET_DIR; nothing to rename (already friendly-named? or did you build yet?)" >&2
  exit 0
fi

echo "==> renamed $count dmg file(s)"
