#!/usr/bin/env bash
# stage-engine-binary.sh — STAGING ENGINE OpenCode DẠNG BINARY cho installer
# (CB-3, lane BUILD-QA-B, gói cổng alpha.40 đường (B) COMPILE).
#
# Thay thế đường staging CÂY node_modules của stage-engine.sh (đã gated,
# sha 1cfe1cf9…9891) bằng đường COMPILE:
#   checkout engine @ ENGINE_REF -> full install + install ép native mọi
#   platform (xem [c]) -> Bun.build({compile}) qua build-engine.ts
#   (standalone hoá script/build.ts của fork, theo POC-1/CB-1 đã PASS)
#   -> 1 binary opencode[.exe] + rg file thật + ENGINE-MANIFEST.json.
#
# Bố cục --out (= thư mục engine staged; gulp chép nguyên thư mục này vào
# resources/app/engine/ của cây đóng gói):
#   opencode | opencode.exe   binary engine đã compile (native của platform
#                             đích nhúng trong binary — cổng [e] kiểm TRƯỚC)
#   rg | rg.exe               ripgrep 15.1.0 file thật từ release chính thức,
#                             sha256 ghim 2 lớp (archive + binary, xem [b2])
#   LICENSE                   LICENSE gốc của engine (chuẩn hoá LF khi
#                             staging — F-E1; no-op nếu đầu vào đã LF)
#   ENGINE-VERSION.json       bản tương thích (version/engineRef/bunVersion…)
#   ENGINE-MANIFEST.json      schema MỚI binary-v1 (xem mục [g] + w3 §3)
#
# BỎ HẲN so với stage-engine.sh cũ: copy closure 17 package, bun install
# --production + prune platform, kiểm preload trong cây, và ĐẶC BIỆT: KHÔNG
# ship bun runtime nữa (quyết định D3 mới) — bun 1.4.2 chỉ là công cụ
# BUILD-TIME, lấy qua fetch-bun.sh (checksum 2 lớp) ở mục [b], không bao
# giờ được chép vào --out.
#
# Dùng:
#   stage-engine-binary.sh --src <thư-mục-engine> --out <thư-mục-đích> \
#       --platform <linux-x64|win32-x64> [--engine-ref <sha>] \
#       [--bun-bin <đường-bun-1.4.2>] [--build-script <đường-build-engine.ts>] \
#       [--rg-file <file-rg-có-sẵn> [--rg-sha256 <hex-kỳ-vọng>]] [--skip-install]
#
#   --src          checkout engine TƯƠI tại ENGINE_REF (CI) hoặc cây đã cài
#                  sẵn kèm --skip-install (rehearsal trên cây stage w28).
#   --build-script mặc định: build-engine.ts CẠNH script này (trong repo
#                  c2t-ide: build/engine/build-engine.ts). Script chép nó vào
#                  <src>/packages/cli/script/build-engine.ts (file mới trong
#                  checkout) rồi chạy từ đó.
#   --rg-file      dùng rg có sẵn thay vì tải: sha256 của file PHẢI khớp pin
#                  binary của platform (hoặc --rg-sha256 nếu được truyền) —
#                  lệch là DỪNG (exit 17), không có đường bỏ qua.
#
# Mã thoát: 0 ok | 2 tham số/môi trường/--out không rỗng | 10 thiếu entry
#   nguồn | 12 install lỗi | 13 bun build-time lỗi (fetch/version) |
#   15 thiếu native THẬT của platform đích trước compile (cổng CB-1) |
#   16 compile lỗi | 17 rg lỗi (thiếu/tải lỗi/sha lệch — fail-closed) |
#   18 hậu kiểm staging lỗi (binary/manifest lệch, smoke --version lỗi)
#
# Kỷ luật: script KHÔNG stub native, KHÔNG tự vá nguồn engine. Native của
# platform KHÁC platform đích không cần là bản thật trong CI (install
# --os="*" --cpu="*" ở [c] vốn cung cấp bản thật cho cả chúng); thiếu native
# của platform ĐÍCH = exit 15, vì compile với stub sẽ cho binary "xanh giả"
# (bài học CB-1: binary win32 POC nhúng stub opentui/watcher/FFF).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_VERSION="1.4.2"
RG_VERSION="15.1.0"

# --- Pin ripgrep 15.1.0 (release chính thức BurntSushi/ripgrep) ---
# Đo thật + đối chiếu sidecar .sha256 chính thức ngày 2026-10-23 (w3 §4):
#   archive linux-musl sha khớp sidecar chính thức; archive win32 sha khớp
#   sidecar (định dạng CertUtil) chính thức. Binary sha/size đo từ bản giải
#   nén của ĐÚNG archive đã verify đó. Version 15.1.0 = đúng VERSION mà
#   engine tự tải lúc runtime (packages/core/src/ripgrep/binary.ts) và đúng
#   cặp platform x86_64-unknown-linux-musl / x86_64-pc-windows-msvc.
declare -A RG_ASSET=(
  [linux-x64]="ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  [win32-x64]="ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip"
)
declare -A RG_ARCHIVE_SHA256=(
  [linux-x64]="1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599"
  [win32-x64]="124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"
)
declare -A RG_BIN_SHA256=(
  [linux-x64]="ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2"
  [win32-x64]="decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408"
)
declare -A RG_BIN_SIZE=(
  [linux-x64]="5445512"
  [win32-x64]="4266496"
)
RG_RELEASE_BASE="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}"

SRC=""; OUT=""; PLATFORM=""; ENGINE_REF=""; SKIP_INSTALL=0
BUN_BIN="${BUN_BIN:-}"; BUILD_SCRIPT=""; RG_FILE=""; RG_SHA256_EXPECTED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --src)          SRC="${2:?--src cần giá trị}"; shift 2 ;;
    --out)          OUT="${2:?--out cần giá trị}"; shift 2 ;;
    --platform)     PLATFORM="${2:?--platform cần giá trị}"; shift 2 ;;
    --engine-ref)   ENGINE_REF="${2:?--engine-ref cần giá trị}"; shift 2 ;;
    --bun-bin)      BUN_BIN="${2:?--bun-bin cần giá trị}"; shift 2 ;;
    --build-script) BUILD_SCRIPT="${2:?--build-script cần giá trị}"; shift 2 ;;
    --rg-file)      RG_FILE="${2:?--rg-file cần giá trị}"; shift 2 ;;
    --rg-sha256)    RG_SHA256_EXPECTED="${2:?--rg-sha256 cần giá trị}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "stage-engine-binary: tham số không rõ: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SRC" ] && [ -n "$OUT" ] && [ -n "$PLATFORM" ] || { echo "stage-engine-binary: thiếu --src/--out/--platform" >&2; exit 2; }
case "$PLATFORM" in
  linux-x64) BIN_NAME="opencode"; RG_NAME="rg" ;;
  win32-x64) BIN_NAME="opencode.exe"; RG_NAME="rg.exe" ;;
  *) echo "stage-engine-binary: platform không hỗ trợ: $PLATFORM (chỉ linux-x64|win32-x64 cho alpha.40)" >&2; exit 2 ;;
esac
ARCH="x64"
for tool in python3 curl sha256sum tar unzip; do
  command -v "$tool" >/dev/null || { echo "stage-engine-binary: thiếu công cụ: $tool" >&2; exit 2; }
done
[ -d "$SRC" ] || { echo "stage-engine-binary: --src không tồn tại: $SRC" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"
BUILD_SCRIPT="${BUILD_SCRIPT:-$SCRIPT_DIR/build-engine.ts}"
[ -f "$BUILD_SCRIPT" ] || { echo "stage-engine-binary: không thấy build script: $BUILD_SCRIPT" >&2; exit 2; }
BUILD_SCRIPT_SHA="$(sha256sum "$BUILD_SCRIPT" | awk '{print $1}')"

WORK="$(mktemp -d)"
cleanup_work() { rm -rf "$WORK"; }
trap cleanup_work EXIT

# Chép file theo kỷ luật phá-link: ghi ra file tạm CÙNG thư mục đích rồi mv
# thay entry — không bao giờ ghi đè nội dung lên inode đang hardlink dùng
# chung (kỷ luật POC-1/CB-1 cho cây hardlink; vô hại trên checkout tươi).
safe_place() {
  local src_file="$1" dst_file="$2" tmp
  tmp="$dst_file.tmp-cb3-$$"
  cp "$src_file" "$tmp" && mv -f "$tmp" "$dst_file"
}

# ============ a. TIỀN KIỂM NGUỒN ============
echo "== [a] Tiền kiểm nguồn: $SRC"
[ -f "$SRC/packages/cli/src/index.ts" ] || { echo "stage-engine-binary: THIẾU entry serve packages/cli/src/index.ts" >&2; exit 10; }
[ -f "$SRC/packages/cli/package.json" ] || { echo "stage-engine-binary: THIẾU packages/cli/package.json" >&2; exit 10; }
[ -f "$SRC/packages/cli/script/opencode-pty.ts" ] || { echo "stage-engine-binary: THIẾU packages/cli/script/opencode-pty.ts (build-engine.ts import nó theo vị trí)" >&2; exit 10; }
[ -f "$SRC/LICENSE" ] && [ -s "$SRC/LICENSE" ] || { echo "stage-engine-binary: THIẾU LICENSE gốc engine tại \$SRC/LICENSE — DỪNG" >&2; exit 10; }
ENGINE_VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$SRC/packages/cli/package.json")"
echo "   entry serve + cli package.json (version $ENGINE_VERSION) + LICENSE: OK"

# ============ b. BUN BUILD-TIME 1.4.2 (fetch-bun, checksum 2 lớp) ============
# D3 MỚI: bun chỉ ghim ở build-time. Binary bun KHÔNG vào --out.
echo "== [b] Bun build-time $BUN_VERSION (chỉ build-time, không ship)"
if [ -n "$BUN_BIN" ]; then
  [ -x "$BUN_BIN" ] || { echo "stage-engine-binary: --bun-bin không thực thi được: $BUN_BIN" >&2; exit 2; }
  GOT_BUN_VERSION="$("$BUN_BIN" --version 2>/dev/null || true)"
  [ "$GOT_BUN_VERSION" = "$BUN_VERSION" ] || { echo "stage-engine-binary: bun --version = '$GOT_BUN_VERSION', kỳ vọng '$BUN_VERSION'. DỪNG." >&2; exit 13; }
  echo "   dùng bun do caller cấp: $BUN_BIN (--version $GOT_BUN_VERSION OK)"
else
  FETCH_BUN="$SCRIPT_DIR/fetch-bun.sh"
  [ -f "$FETCH_BUN" ] || { echo "stage-engine-binary: không thấy fetch-bun.sh cạnh script ($FETCH_BUN) và --bun-bin chưa đặt. DỪNG." >&2; exit 13; }
  host_platform=""; host_bin="bun"
  case "$(uname -s)" in
    Linux)  [ "$(uname -m)" = "x86_64" ] && host_platform="linux-x64" ;;
    Darwin) case "$(uname -m)" in x86_64) host_platform="darwin-x64" ;; arm64) host_platform="darwin-arm64" ;; esac ;;
    MINGW*|MSYS*|CYGWIN*) host_platform="win32-x64"; host_bin="bun.exe" ;;
  esac
  [ -n "$host_platform" ] || { echo "stage-engine-binary: không xác định được platform của host để fetch bun (uname -s=$(uname -s), uname -m=$(uname -m)) — hãy đặt --bun-bin thủ công" >&2; exit 2; }
  # Bun build-time được fetch theo platform của HOST (máy chạy build), độc
  # lập với platform ĐÍCH: compile là cross-compile qua compile.target.
  "$FETCH_BUN" --platform "$host_platform" --out "$WORK/bun-host" \
    || { echo "stage-engine-binary: fetch-bun cho host LỖI" >&2; exit 13; }
  BUN_BIN="$WORK/bun-host/$host_bin"
  [ -x "$BUN_BIN" ] || { echo "stage-engine-binary: fetch-bun xong nhưng không thấy binary: $BUN_BIN" >&2; exit 13; }
  echo "   bun build-time (host $host_platform): $BUN_BIN"
fi
case "$BUN_BIN" in
  */*) BUN_DIR="$(dirname "$BUN_BIN")" ;;
  *)   BUN_DIR="$(dirname "$(command -v "$BUN_BIN")")" ;;
esac

# ============ b2. RG FILE THẬT (ghim sha, fail-closed) ============
echo "== [b2] ripgrep $RG_VERSION file thật cho $PLATFORM (fail-closed)"
RG_STAGED="$WORK/$RG_NAME"
if [ -n "$RG_FILE" ]; then
  [ -f "$RG_FILE" ] || { echo "stage-engine-binary: --rg-file không tồn tại: $RG_FILE — DỪNG (staging thiếu rg)" >&2; exit 17; }
  EXPECTED_SHA="${RG_SHA256_EXPECTED:-${RG_BIN_SHA256[$PLATFORM]}}"
  ACTUAL_SHA="$(sha256sum "$RG_FILE" | awk '{print $1}')"
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "stage-engine-binary: sha256 của --rg-file ($ACTUAL_SHA) != kỳ vọng ($EXPECTED_SHA) — DỪNG (fail-closed)" >&2
    exit 17
  fi
  cp "$RG_FILE" "$RG_STAGED"
  echo "   rg từ --rg-file: sha256 khớp kỳ vọng ($ACTUAL_SHA)"
else
  ASSET="${RG_ASSET[$PLATFORM]}"
  echo "   tải $ASSET từ release ripgrep chính thức $RG_VERSION"
  curl -fSL --retry 3 -o "$WORK/$ASSET" "$RG_RELEASE_BASE/$ASSET" \
    || { echo "stage-engine-binary: tải ripgrep LỖI — DỪNG (staging thiếu rg)" >&2; exit 17; }
  ARCHIVE_SHA="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
  if [ "$ARCHIVE_SHA" != "${RG_ARCHIVE_SHA256[$PLATFORM]}" ]; then
    echo "stage-engine-binary: sha256 archive ripgrep ($ARCHIVE_SHA) != pin (${RG_ARCHIVE_SHA256[$PLATFORM]}) — DỪNG (fail-closed)" >&2
    exit 17
  fi
  echo "   lớp archive: sha256 khớp pin ($ARCHIVE_SHA)"
  mkdir -p "$WORK/rg-extract"
  case "$ASSET" in
    *.tar.gz) tar -xzf "$WORK/$ASSET" -C "$WORK/rg-extract" ;;
    *.zip)    unzip -o -q "$WORK/$ASSET" -d "$WORK/rg-extract" ;;
  esac
  FOUND_RG="$(find "$WORK/rg-extract" -name "$RG_NAME" -type f | head -n 1)"
  [ -n "$FOUND_RG" ] || { echo "stage-engine-binary: archive ripgrep không chứa $RG_NAME — DỪNG" >&2; exit 17; }
  BIN_SHA="$(sha256sum "$FOUND_RG" | awk '{print $1}')"
  BIN_SIZE="$(stat -c %s "$FOUND_RG")"
  if [ "$BIN_SHA" != "${RG_BIN_SHA256[$PLATFORM]}" ] || [ "$BIN_SIZE" != "${RG_BIN_SIZE[$PLATFORM]}" ]; then
    echo "stage-engine-binary: rg đã giải nén lệch pin (sha $BIN_SHA, size $BIN_SIZE; kỳ vọng sha ${RG_BIN_SHA256[$PLATFORM]}, size ${RG_BIN_SIZE[$PLATFORM]}) — DỪNG (fail-closed)" >&2
    exit 17
  fi
  cp "$FOUND_RG" "$RG_STAGED"
  echo "   lớp binary: sha256 + size khớp pin ($BIN_SHA, $BIN_SIZE byte)"
fi
chmod +x "$RG_STAGED" 2>/dev/null || true

# ============ c. INSTALL PHỤC VỤ BUILD (bỏ qua khi --skip-install) ============
if [ "$SKIP_INSTALL" = "1" ]; then
  echo "== [c] BỎ QUA install (--skip-install: cây nguồn đã cài sẵn — chế độ rehearsal)"
else
  echo "== [c] Full install tại gốc engine + install ép native mọi platform"
  # Full install (KHÔNG --production): script build của fork cần
  # @opencode/script (devDependency) và src của cli import tĩnh
  # @opencode/protocol (devDependency) — cây production-pruned thiếu cả hai
  # (finding S1/S2, POC-1 §1.1). PATH prepend thư mục bun: postinstall của
  # engine gọi `bun` theo tên (kinh nghiệm stage-engine.sh cũ mục [c]).
  ( cd "$SRC" && PATH="$BUN_DIR:$PATH" "$BUN_BIN" install ) \
    || { echo "stage-engine-binary: bun install (full) LỖI" >&2; exit 12; }
  # Ép native MỌI platform cho 4 họ native — quyết định theo bằng chứng CB-1
  # (w3 §2.2): bước install --os="*" --cpu="*" của fork CHỈ phủ
  # @opentui/core + @opencode-ai/pty; watcher (@parcel/watcher) và FFF
  # (@ff-labs/fff-bun) phải ép riêng ở package sở hữu chúng. Version đọc từ
  # chính cây nguồn (catalog / package.json), không ghim số lạ.
  OTUI_VER="$(python3 - "$SRC/package.json" <<'PYEOF' || echo 0.5.17
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("workspaces", {}).get("catalog", {}).get("@opentui/core", "0.5.17"))
PYEOF
)"
  PTY_VER="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['dependencies']['@opencode-ai/pty'])" "$SRC/packages/cli/package.json")"
  WATCHER_VER="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['dependencies']['@parcel/watcher'])" "$SRC/packages/core/package.json")"
  FFF_VER="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['dependencies']['@ff-labs/fff-bun'])" "$SRC/packages/core/package.json")"
  echo "   version native: @opentui/core@$OTUI_VER @opencode-ai/pty@$PTY_VER @parcel/watcher@$WATCHER_VER @ff-labs/fff-bun@$FFF_VER"
  ( cd "$SRC/packages/cli" && PATH="$BUN_DIR:$PATH" "$BUN_BIN" install --os="*" --cpu="*" "@opentui/core@$OTUI_VER" "@opencode-ai/pty@$PTY_VER" "@parcel/watcher@$WATCHER_VER" ) \
    || { echo "stage-engine-binary: install ép native (packages/cli) LỖI" >&2; exit 12; }
  ( cd "$SRC/packages/core" && PATH="$BUN_DIR:$PATH" "$BUN_BIN" install --os="*" --cpu="*" "@ff-labs/fff-bun@$FFF_VER" "@parcel/watcher@$WATCHER_VER" ) \
    || { echo "stage-engine-binary: install ép native (packages/core) LỖI" >&2; exit 12; }
fi

# ============ e. CỔNG NATIVE THẬT CỦA PLATFORM ĐÍCH (trước compile) ============
echo "== [e] Kiểm native THẬT của $PLATFORM trong cây nguồn (cổng CB-1, exit 15)"
find_native() { # $1=fragment đường dẫn gói, $2=tên file native
  find "$SRC/packages" "$SRC/node_modules" -path "*$1*" -name "$2" -type f 2>/dev/null | head -n 1
}
NATIVE_FAIL=0
check_native() { # $1=fragment, $2=file, $3=nhãn
  local hit
  hit="$(find_native "$1" "$2")"
  if [ -n "$hit" ]; then
    echo "   OK $3: $hit ($(stat -c %s "$hit") byte)"
  else
    echo "stage-engine-binary: THIẾU native thật $3 (gói *$1*, file $2) — compile lúc này sẽ nhúng stub/rỗng. DỪNG (fail-closed, bài học CB-1)." >&2
    NATIVE_FAIL=1
  fi
}
if [ "$PLATFORM" = "linux-x64" ]; then
  check_native "@opentui/core-linux-x64" "libopentui.so" "@opentui/core linux-x64"
  check_native "@parcel/watcher-linux-x64-glibc" "watcher.node" "@parcel/watcher linux-x64-glibc"
  check_native "@ff-labs/fff-bin-linux-x64-gnu" "libfff_c.so" "FFF linux-x64-gnu"
  check_native "@opencode-ai/pty-linux-x64-gnu" "opencode-pty" "@opencode-ai/pty linux-x64-gnu"
else
  check_native "@opentui/core-win32-x64" "opentui.dll" "@opentui/core win32-x64"
  check_native "@parcel/watcher-win32-x64" "watcher.node" "@parcel/watcher win32-x64"
  check_native "@ff-labs/fff-bin-win32-x64" "fff_c.dll" "FFF win32-x64"
  echo "   (win32: @opencode-ai/pty = undefined theo thiết kế fork — không kiểm)"
fi
[ "$NATIVE_FAIL" = "0" ] || exit 15

# ============ f. COMPILE (build-engine.ts, bun 1.4.2) ============
echo "== [f] Compile binary $PLATFORM bằng build-engine.ts (buildScriptSha=$BUILD_SCRIPT_SHA)"
PLACED_BUILD="$SRC/packages/cli/script/build-engine.ts"
safe_place "$BUILD_SCRIPT" "$PLACED_BUILD"
BUILD_OUT="$WORK/build-out"
( cd "$SRC/packages/cli" && PATH="$BUN_DIR:$PATH" BUILD_ENGINE_OUT="$BUILD_OUT" "$BUN_BIN" run script/build-engine.ts --target="$PLATFORM" --mode=compile ) \
  || { echo "stage-engine-binary: COMPILE LỖI" >&2; exit 16; }
COMPILED_BIN="$BUILD_OUT/compile/$BIN_NAME"
[ -f "$COMPILED_BIN" ] || { echo "stage-engine-binary: compile báo xong nhưng không thấy binary: $COMPILED_BIN" >&2; exit 16; }
echo "   binary compile: $COMPILED_BIN ($(stat -c %s "$COMPILED_BIN") byte)"

# ============ g. ASSEMBLE --out + ENGINE-MANIFEST.json (schema binary-v1) ============
echo "== [g] Assemble cây staged -> $OUT"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "stage-engine-binary: --out đã tồn tại và không rỗng: $OUT (xoá trước khi chạy lại)" >&2; exit 2
fi
mkdir -p "$OUT"
safe_place "$COMPILED_BIN" "$OUT/$BIN_NAME"
safe_place "$RG_STAGED" "$OUT/$RG_NAME"
# F-E1 (AI-31 FAIL): checkout engine trên runner Windows theo autocrlf
# biến LICENSE thành CRLF (1.086 B, sha b5c625d1…bbdd) — lệch canonical
# LF (1.065 B, sha 625f0f61…cb6b) mà F-E1 nghiệm thu. Chuẩn hoá LF ngay
# tại staging, MỌI platform: strip mọi CR khi ghi LICENSE (ghi qua file
# tạm cùng thư mục rồi mv, đúng kỷ luật safe_place). Phép này IDEMPOTENT:
# đầu vào đã LF thì là no-op byte-exact (linux alpha.40 staging vốn LF —
# đối chứng D6-3 PASS; B4 của AI-32 kiểm đúng tính chất này).
tr -d '\r' < "$SRC/LICENSE" > "$OUT/.LICENSE.tmp-cb3-$$"
mv -f "$OUT/.LICENSE.tmp-cb3-$$" "$OUT/LICENSE"
echo "   LICENSE: đã chuẩn hoá LF (strip CR) -> $(stat -c %s "$OUT/LICENSE") byte, sha256 $(sha256sum "$OUT/LICENSE" | awk '{print $1}')"
if [ "$PLATFORM" = "linux-x64" ]; then chmod +x "$OUT/$BIN_NAME" "$OUT/$RG_NAME"; fi
STAGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$OUT/ENGINE-VERSION.json" "$ENGINE_VERSION" "${ENGINE_REF:-}" "$BUN_VERSION" "$PLATFORM" "$STAGED_AT" <<'PYEOF'
import json, sys
path, ver, ref, bunver, platform, staged_at = sys.argv[1:7]
json.dump({
    "version": ver,
    "engineRef": ref if ref else None,
    "bunVersion": bunver,
    "platform": platform,
    "stagedAt": staged_at,
    "mode": "binary",
}, open(path, "w"), indent=2)
PYEOF
python3 - "$OUT" "$BIN_NAME" "$RG_NAME" "$PLATFORM" "$ARCH" "$ENGINE_VERSION" "${ENGINE_REF:-}" "$BUN_VERSION" "$BUILD_SCRIPT_SHA" "$RG_VERSION" "$STAGED_AT" <<'PYEOF'
import hashlib, json, os, sys

out, bin_name, rg_name, platform, arch, eng_ver, eng_ref, bun_ver, script_sha, rg_ver, staged_at = sys.argv[1:12]

def describe(name):
    p = os.path.join(out, name)
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return {"path": name, "size": os.path.getsize(p), "sha256": h.hexdigest()}

manifest = {
    "format": "engine-binary-manifest-v1",
    "platform": platform,
    "arch": arch,
    "engineVersion": eng_ver,
    "engineRef": eng_ref if eng_ref else None,
    "bunBuildVersion": bun_ver,
    "buildScript": "build-engine.ts",
    "buildScriptSha": script_sha,
    "stagedAt": staged_at,
    "binary": describe(bin_name),
    "rg": {**describe(rg_name), "version": rg_ver},
    "license": describe("LICENSE"),
}
with open(os.path.join(out, "ENGINE-MANIFEST.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest, indent=2))
PYEOF

# ============ h. HẬU KIỂM (đối chiếu manifest vừa sinh, fail-closed) ============
echo "== [h] Hậu kiểm staging"
python3 - "$OUT" <<'PYEOF' || { echo "stage-engine-binary: HẬU KIỂM LỖI — manifest không khớp file thật trên đĩa" >&2; exit 18; }
import hashlib, json, os, sys

out = sys.argv[1]
m = json.load(open(os.path.join(out, "ENGINE-MANIFEST.json")))
problems = []
for key in ("binary", "rg", "license"):
    e = m[key]
    p = os.path.join(out, e["path"])
    if not os.path.isfile(p):
        problems.append(f"{key}: thiếu file {e['path']}")
        continue
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != e["sha256"] or os.path.getsize(p) != e["size"]:
        problems.append(f"{key}: lệch sha/size so với manifest")
if m["binary"]["size"] < 50_000_000:
    problems.append(f"binary nhỏ bất thường: {m['binary']['size']} byte (kỳ vọng ~150-200 MB)")
if problems:
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)
print(f"  OK: binary {m['binary']['size']} byte sha256={m['binary']['sha256']}")
print(f"  OK: rg {m['rg']['size']} byte sha256={m['rg']['sha256']}")
PYEOF
# Smoke tối thiểu khi binary chạy được trên host (linux host + linux target).
# win32 target trên host khác: KHÔNG chạy được — verify thuộc CI Windows
# (UNKNOWN-BY-HOST, xem w3 §6).
if [ "$PLATFORM" = "linux-x64" ] && [ "$(uname -s)" = "Linux" ]; then
  VERSION_OUT="$("$OUT/$BIN_NAME" --version 2>&1 | head -n 1 || true)"
  echo "   smoke: $BIN_NAME --version -> $VERSION_OUT"
  [ -n "$VERSION_OUT" ] || { echo "stage-engine-binary: smoke --version không có output — DỪNG" >&2; exit 18; }
fi

TOTAL_BYTES="$(du -sb "$OUT" | awk '{print $1}')"
echo "== XONG staging binary $PLATFORM: $OUT (tổng $TOTAL_BYTES byte, gồm binary + rg + LICENSE + 2 file json)"
echo "   ENGINE-MANIFEST.json ở trên là bản manifest chính thức của lượt staging này."
