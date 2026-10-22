#!/usr/bin/env bash
# fetch-bun.sh — Tải bun 1.4.2 chính thức (oven-sh/bun) theo platform + verify checksum 2 LỚP.
#
# Dùng chung CI/local cho gói đóng gói engine (spec engine-packaging-spec-v1.md §6.2, quyết định D3).
#   Lớp 1: sha256 của asset tải về phải khớp BẢNG PIN ghi cứng trong script này.
#          Bảng pin lấy từ SHASUMS256.txt chính thức của release bun-v1.4.2
#          (https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt,
#           truy xuất 2026-10-22; bản sao lưu kèm: SHASUMS256-bun-v1.4.2.official.txt cùng thư mục).
#   Lớp 2: tải SHASUMS256.txt kèm release tại thời điểm chạy và đối chiếu chéo với pin
#          TRƯỚC khi tin asset (pin != shasums release -> DỪNG, không dùng asset).
# Sau giải nén: chạy `bun --version` phải in đúng "1.4.2" (chỉ khi binary chạy được trên host;
# đóng gói chéo platform khác -> bỏ qua bước chạy, đã ghi chú rõ trong output).
#
# Dùng: fetch-bun.sh --platform <linux-x64|win32-x64|darwin-x64|darwin-arm64> --out <thư-mục-đích>
# Mã thoát: 0 ok | 2 tham số | 20 tải lỗi | 21 lệch pin lớp 1 | 22 lệch đối chiếu lớp 2 | 23 --version sai

set -euo pipefail

BUN_VERSION="1.4.2"
RELEASE_BASE="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

# --- Bảng pin SHA256 (lớp 1) — giá trị THẬT từ SHASUMS256.txt của bun-v1.4.2 ---
declare -A PIN_SHA256=(
  [bun-linux-x64.zip]="36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"
  [bun-windows-x64.zip]="ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405"
  [bun-darwin-x64.zip]="80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012"
  [bun-darwin-aarch64.zip]="90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"
)

PLATFORM=""
OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:?--platform cần giá trị}"; shift 2 ;;
    --out)      OUT_DIR="${2:?--out cần giá trị}"; shift 2 ;;
    *) echo "fetch-bun: tham số không rõ: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PLATFORM" ] && [ -n "$OUT_DIR" ] || { echo "fetch-bun: thiếu --platform/--out" >&2; exit 2; }

case "$PLATFORM" in
  linux-x64)   ASSET="bun-linux-x64.zip";       BIN_NAME="bun" ;;
  win32-x64)   ASSET="bun-windows-x64.zip";     BIN_NAME="bun.exe" ;;
  darwin-x64)  ASSET="bun-darwin-x64.zip";      BIN_NAME="bun" ;;
  darwin-arm64) ASSET="bun-darwin-aarch64.zip"; BIN_NAME="bun" ;;
  *) echo "fetch-bun: platform không hỗ trợ: $PLATFORM" >&2; exit 2 ;;
esac

PIN="${PIN_SHA256[$ASSET]:-}"
if [ -z "$PIN" ] || [ "$PIN" = "<<PIN-UNKNOWN>>" ]; then
  echo "fetch-bun: CHƯA CÓ PIN cho $ASSET — không tải. Cập nhật bảng pin từ SHASUMS256.txt chính thức trước." >&2
  exit 21
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetch-bun: tải $ASSET (bun v$BUN_VERSION, platform $PLATFORM)"
curl -fSL --retry 3 -o "$WORK/$ASSET" "$RELEASE_BASE/$ASSET" || { echo "fetch-bun: tải asset lỗi" >&2; exit 20; }
curl -fSL --retry 3 -o "$WORK/SHASUMS256.txt" "$RELEASE_BASE/SHASUMS256.txt" || { echo "fetch-bun: tải SHASUMS256.txt lỗi" >&2; exit 20; }

# --- Lớp 2: đối chiếu chéo pin <-> SHASUMS256.txt của release ---
RELEASE_SHA="$(awk -v a="$ASSET" '$2==a {print $1}' "$WORK/SHASUMS256.txt")"
if [ "$RELEASE_SHA" != "$PIN" ]; then
  echo "fetch-bun: LỆCH LỚP 2 — pin trong script ($PIN) != SHASUMS256.txt của release ($RELEASE_SHA) cho $ASSET. DỪNG." >&2
  exit 22
fi
echo "fetch-bun: lớp 2 OK — pin khớp SHASUMS256.txt của release"

# --- Lớp 1: sha256 của asset tải về <-> pin ---
ACTUAL_SHA="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$PIN" ]; then
  echo "fetch-bun: LỆCH LỚP 1 — sha256 asset ($ACTUAL_SHA) != pin ($PIN). DỪNG." >&2
  exit 21
fi
echo "fetch-bun: lớp 1 OK — sha256 asset khớp pin"

unzip -o -q "$WORK/$ASSET" -d "$WORK/extract"
SRC_BIN="$(find "$WORK/extract" -name "$BIN_NAME" -type f | head -n 1)"
[ -n "$SRC_BIN" ] || { echo "fetch-bun: không thấy $BIN_NAME trong asset" >&2; exit 20; }

mkdir -p "$OUT_DIR"
cp "$SRC_BIN" "$OUT_DIR/$BIN_NAME"
chmod +x "$OUT_DIR/$BIN_NAME" 2>/dev/null || true

# --- Kiểm --version: chỉ khi binary đích chạy được trên host hiện tại ---
HOST_OS="$(uname -s)"
RUNNABLE=0
case "$PLATFORM" in
  linux-x64)   [ "$HOST_OS" = "Linux" ] && RUNNABLE=1 ;;
  darwin-x64|darwin-arm64) [ "$HOST_OS" = "Darwin" ] && RUNNABLE=1 ;;
  win32-x64)   RUNNABLE=0 ;;
esac
if [ "$RUNNABLE" = "1" ]; then
  GOT_VERSION="$("$OUT_DIR/$BIN_NAME" --version)"
  if [ "$GOT_VERSION" != "$BUN_VERSION" ]; then
    echo "fetch-bun: bun --version = '$GOT_VERSION', kỳ vọng '$BUN_VERSION'. DỪNG." >&2
    exit 23
  fi
  echo "fetch-bun: bun --version = $GOT_VERSION OK"
else
  echo "fetch-bun: LƯU Ý — binary đích ($PLATFORM) không chạy được trên host ($HOST_OS) nên chưa kiểm --version tại đây; assert tầng binary của spec §6 phải chạy trên bản extract đúng platform."
fi

echo "fetch-bun: XONG — $OUT_DIR/$BIN_NAME (sha256 zip: $ACTUAL_SHA)"
