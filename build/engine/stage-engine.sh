#!/usr/bin/env bash
# stage-engine.sh — STAGING ENGINE OpenCode cho installer (DRAFT vòng BUILD-VERIFY-8, CHƯA ÁP VÀO CÂY THẬT)
#
# Nguồn chuẩn: engine-packaging-spec-v1.md (parent đã duyệt nguyên trạng, quyết định P8-1):
#   §1 bố cục đích resources/app/engine/ — script này sinh đúng cây đó tại --out.
#   §2 closure 17 workspace package + cài production cô lập (phương pháp W1 vòng 7, kế thừa nguyên văn).
#   §3 HAI SỬA TIÊN QUYẾT phía engine — staging KHÔNG tự vá (§6.3). Căn lại
#      theo PHÂN XỬ F-W4-1 hướng N1 (W6, gấp bởi W8): sửa §3.2
#      (@effect/platform-node trong dependencies của @opencode/core) là CỔNG
#      CỨNG DUY NHẤT phía nguồn — thiếu -> thoát mã 11 + thông điệp rõ. Sửa
#      §3.1 (preload tương đối ở bunfig gốc) HẠ XUỐNG CẢNH BÁO (N1 làm nó
#      không còn cần cho serve bundled: adapter truyền --preload tuyệt
#      đối). Thay vào đó, SAU cài production staging kiểm CỨNG sự tồn tại
#      của file preload trong cây staging — thiếu -> thoát mã 14.
#   §6 bun 1.4.2 qua fetch-bun.sh (verify checksum 2 lớp).
#
# Dùng:
#   stage-engine.sh --src <thư-mục-engine> --out <thư-mục-đích> \
#                   --platform <linux-x64|win32-x64|darwin-x64|darwin-arm64> \
#                   [--engine-ref <sha>] [--skip-install]
#
# Yêu cầu môi trường: bash, rsync, python3, curl, unzip, sha256sum, và `bun` trên PATH
# (đúng 1.4.2; dùng để cài production — binary bun ĐI KÈM installer được fetch riêng bởi fetch-bun.sh).
# Biến môi trường tuỳ chọn: BUN_BIN (đường dẫn bun dùng cho install, mặc định "bun").
#
# Mã thoát: 0 ok | 2 tham số/môi trường | 10 thiếu entry bắt buộc | 11 thiếu sửa tiên quyết §3.2 (cổng cứng)
#           | 12 bun install lỗi | 13 fetch-bun lỗi
#           | 14 thiếu file preload @opentui/solid trong cây staging sau cài production (cổng cứng N1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_VERSION="1.4.2"

# Closure production tối thiểu từ @opencode/cli — đúng 17 package (spec §2, W1 vòng 7 kiểm lại từ package.json thật).
CLOSURE_PKGS=(ai cli client codemode core latex merman plugin plugin-browser protocol schema server simulation theme tui ui util)

# Mẫu loại trừ khi copy source (nguyên văn báo cáo W1 vòng 7 §2 — loại test/fixtures/docs):
RSYNC_EXCLUDES=(
  --exclude='node_modules' --exclude='test' --exclude='tests' --exclude='__tests__'
  --exclude='fixtures' --exclude='fixture' --exclude='docs'
  --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' --exclude='*.spec.tsx'
)

SRC=""; OUT=""; PLATFORM=""; ENGINE_REF=""; SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --src)         SRC="${2:?--src cần giá trị}"; shift 2 ;;
    --out)         OUT="${2:?--out cần giá trị}"; shift 2 ;;
    --platform)    PLATFORM="${2:?--platform cần giá trị}"; shift 2 ;;
    --engine-ref)  ENGINE_REF="${2:?--engine-ref cần giá trị}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "stage-engine: tham số không rõ: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SRC" ] && [ -n "$OUT" ] && [ -n "$PLATFORM" ] || { echo "stage-engine: thiếu --src/--out/--platform" >&2; exit 2; }
case "$PLATFORM" in
  linux-x64|win32-x64|darwin-x64|darwin-arm64) ;;
  *) echo "stage-engine: platform không hỗ trợ: $PLATFORM" >&2; exit 2 ;;
esac
for tool in rsync python3 curl unzip sha256sum; do
  command -v "$tool" >/dev/null || { echo "stage-engine: thiếu công cụ: $tool" >&2; exit 2; }
done
[ -d "$SRC" ] || { echo "stage-engine: --src không tồn tại: $SRC" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"
BUN_BIN="${BUN_BIN:-bun}"

fail_prereq() {
  echo "stage-engine: ENGINE_REF chưa chứa sửa tiên quyết §3 — $1" >&2
  echo "stage-engine: DỪNG theo spec §6.3 (staging không tự vá). Áp sửa tiên quyết còn thiếu (cổng cứng §3.2) vào repo engine rồi pin ENGINE_REF mới." >&2
  exit 11
}

# ============ a. TIỀN KIỂM NGUỒN ============
echo "== [a] Tiền kiểm nguồn: $SRC"
[ -f "$SRC/packages/cli/src/index.ts" ] || { echo "stage-engine: THIẾU entry serve packages/cli/src/index.ts" >&2; exit 10; }
[ -f "$SRC/packages/core/src/indexing/cli.ts" ] || { echo "stage-engine: THIẾU entry indexing packages/core/src/indexing/cli.ts" >&2; exit 10; }
echo "   entry serve + entry indexing: OK"
# Điều kiện C-2/S1 (cổng engine ae5): LICENSE gốc của engine phải tồn tại ở nguồn;
# thiếu = dừng ngay, vì mục [b] chép nó vào gốc cây staging trước khi sinh manifest.
[ -f "$SRC/LICENSE" ] && [ -s "$SRC/LICENSE" ] || { echo "stage-engine: THIẾU LICENSE gốc engine tại \$SRC/LICENSE — DỪNG (điều kiện C-2/S1)" >&2; exit 10; }
echo "   LICENSE gốc engine: OK ($(sha256sum "$SRC/LICENSE" | cut -d' ' -f1))"

# Sửa §3.1 — preload Solid dùng ĐƯỜNG TƯƠNG ĐỐI trong bunfig ở GỐC engine.
# PHÂN XỬ F-W4-1/N1 (W6): mục này HẠ XUỐNG CẢNH BÁO, KHÔNG còn là cổng chặn.
# Lý do: Bun chỉ nạp bunfig tại đúng cwd nên dòng preload tương đối này vô
# hiệu khi spawn bundled với cwd = user-data (spec §4); hướng N1 xử ở phía
# adapter (truyền --preload tuyệt đối) nên serve bundled không còn cần sửa
# §3.1. Giữ kiểm để cảnh báo: sửa này vẫn vô hại và giúp spawn từ gốc
# engine (dev/chẩn đoán), nhưng thiếu nó KHÔNG được chặn staging — thứ N1
# thật sự phụ thuộc là file preload TỒN TẠI trong closure, được kiểm cứng
# sau cài production (mục c2, exit 14).
ROOT_BUNFIG="$SRC/bunfig.toml"
if [ ! -f "$ROOT_BUNFIG" ] || ! grep -Eq 'preload[[:space:]]*=' "$ROOT_BUNFIG" \
   || ! grep -Fq './packages/cli/node_modules/@opentui/solid/scripts/preload.js' "$ROOT_BUNFIG"; then
  echo "stage-engine: CẢNH BÁO sửa §3.1: bunfig.toml gốc chưa có preload Solid bằng đường tương đối (./packages/cli/node_modules/@opentui/solid/scripts/preload.js) — KHÔNG chặn staging theo phân xử F-W4-1/N1 (adapter bundled dùng --preload tuyệt đối); chỉ mất lớp hardening cho spawn từ gốc engine." >&2
else
  echo "   sửa §3.1 (preload bunfig đường tương đối): OK (không còn là cổng cứng — phân xử N1)"
fi

# Sửa tiên quyết §3.2 — @effect/platform-node nằm trong dependencies (KHÔNG chỉ devDependencies) của @opencode/core.
if ! python3 - "$SRC/packages/core/package.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if "@effect/platform-node" in d.get("dependencies", {}) else 1)
PYEOF
then
  fail_prereq "@opencode/core chưa có @effect/platform-node trong dependencies (mới ở devDependencies hoặc chưa khai)"
fi
echo "   sửa §3.2 (@effect/platform-node trong dependencies của @opencode/core): OK"

# ============ b. COPY CLOSURE ============
echo "== [b] Copy closure 17 package -> $OUT"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "stage-engine: --out đã tồn tại và không rỗng: $OUT (xoá trước khi chạy lại)" >&2; exit 2
fi
mkdir -p "$OUT/packages"
for pkg in "${CLOSURE_PKGS[@]}"; do
  [ -d "$SRC/packages/$pkg" ] || { echo "stage-engine: THIẾU package closure: packages/$pkg" >&2; exit 10; }
  rsync -a "${RSYNC_EXCLUDES[@]}" "$SRC/packages/$pkg/" "$OUT/packages/$pkg/"
done
# File gốc đi kèm (W1 vòng 7 §2): patches/ (cho patchedDependencies), bunfig.toml gốc, tsconfig.json gốc.
# KHÔNG copy bun.lock gốc (chứa toàn monorepo) — bun resolve tươi cho subset, đúng phương pháp W1.
rsync -a --exclude='node_modules' "$SRC/patches/" "$OUT/patches/"
cp "$SRC/bunfig.toml" "$OUT/bunfig.toml"
cp "$SRC/tsconfig.json" "$OUT/tsconfig.json"
# Điều kiện C-2/S1: chép LICENSE gốc của engine vào GỐC cây staging (đích cuối:
# resources/app/engine/LICENSE). Bắt buộc TRƯỚC mục [e] sinh manifest để manifest
# có mục "path": "LICENSE"; chép nguyên byte, không sửa nội dung.
cp "$SRC/LICENSE" "$OUT/LICENSE"

# package.json gốc của staging = bản TỐI THIỂU hoá theo W1 vòng 7 §2:
# giữ catalog/overrides/patchedDependencies/trustedDependencies + script postinstall;
# workspaces.packages thu còn ["packages/*"]; BỎ toàn bộ root dependencies/devDependencies
# (bản gốc chứa workspace package ngoài closure). Riêng dependencies chỉ giữ
# @tsconfig/bun + @tsconfig/node22 (catalog) — đúng trạng thái bản copy cuối của W1 đã serve PASS.
python3 - "$SRC/package.json" "$OUT/package.json" <<'PYEOF'
import json, sys
src = json.load(open(sys.argv[1]))
out = {}
for k in ("$schema", "name", "description", "version", "private", "type", "packageManager"):
    if k in src: out[k] = src[k]
out["scripts"] = {"postinstall": src.get("scripts", {}).get("postinstall", "bun run --cwd packages/core fix-node-pty")}
out["workspaces"] = {"packages": ["packages/*"], "catalog": src["workspaces"]["catalog"]}
for k in ("overrides", "patchedDependencies", "trustedDependencies"):
    if k in src: out[k] = src[k]
out["dependencies"] = {"@tsconfig/bun": "catalog:", "@tsconfig/node22": "catalog:"}
json.dump(out, open(sys.argv[2], "w"), indent=2)
PYEOF

# Strip devDependencies khỏi 17 package.json của bản staging (W1 vòng 7 §2 — bắt buộc:
# bun vẫn resolve devDependencies của workspace package kể cả với --production;
# không strip thì install FAIL vì 3 workspace package ngoài closure: http-recorder/script/httpapi-codegen).
python3 - "$OUT" "${CLOSURE_PKGS[@]}" <<'PYEOF'
import json, sys
root, pkgs = sys.argv[1], sys.argv[2:]
for p in pkgs:
    path = f"{root}/packages/{p}/package.json"
    d = json.load(open(path))
    d.pop("devDependencies", None)
    json.dump(d, open(path, "w"), indent=2)
PYEOF
SRC_BYTES="$(du -sb "$OUT" | awk '{print $1}')"
echo "   source closure sau loại trừ: $SRC_BYTES byte"

# ============ c. CÀI PRODUCTION CÔ LẬP + PRUNE THEO PLATFORM ============
if [ "$SKIP_INSTALL" = "1" ]; then
  echo "== [c] BỎ QUA cài production (--skip-install) — cây staging CHƯA chạy được, chỉ để soi cấu trúc"
else
  echo "== [c] Cài production cô lập (bun install --production) trong cây staging"
  command -v "$BUN_BIN" >/dev/null || { echo "stage-engine: không thấy bun trên PATH (BUN_BIN=$BUN_BIN)" >&2; exit 2; }
  HOST_BUN_VERSION="$("$BUN_BIN" --version)"
  [ "$HOST_BUN_VERSION" = "$BUN_VERSION" ] || echo "   LƯU Ý: bun dùng để install = $HOST_BUN_VERSION, kỳ vọng $BUN_VERSION (số đo vòng 7 dùng đúng $BUN_VERSION)"
  ( cd "$OUT" && "$BUN_BIN" install --production ) || { echo "stage-engine: bun install --production LỖI" >&2; exit 12; }

  # Prune biến thể native của platform KHÁC: bun install (isolated linker) nạp MỌI biến thể
  # platform vào kho node_modules/.bun (W1 vòng 7 §3: cả glibc+musl, mọi OS/arch — ~23MB+ trọng lượng chết).
  # Cách làm: xoá nguyên entry kho .bun mà TÊN mã hoá platform khác platform đích, rồi xoá symlink
  # treo (trong packages/*/node_modules và node_modules gốc) trỏ vào entry đã xoá.
  # Lý do an toàn: runtime chỉ resolve biến thể khớp platform của nó; entry platform khác không bao
  # giờ được nạp. KHÔNG prune bên trong từng package (vd prebuild của tree-sitter-bash nằm chung
  # 1 entry đa platform) — giữ nguyên để tránh phá cấu trúc package.
  case "$PLATFORM" in
    linux-x64)   DROP_RE='(darwin|win32|musl|arm64|freebsd|android)' ;;
    win32-x64)   DROP_RE='(darwin|linux|musl|arm64|freebsd|android)' ;;
    darwin-x64)  DROP_RE='(linux|win32|musl|arm64|freebsd|android)' ;;
    darwin-arm64) DROP_RE='(linux|win32|musl|freebsd|android)' ;;
  esac
  # darwin-arm64: thêm luật riêng — entry mã hoá -x64 của darwin cũng là platform khác.
  PRUNED_LIST="$(mktemp)"
  if [ -d "$OUT/node_modules/.bun" ]; then
    for entry in "$OUT"/node_modules/.bun/*/; do
      name="$(basename "$entry")"
      drop=0
      if echo "$name" | grep -Eq "$DROP_RE"; then drop=1; fi
      if [ "$PLATFORM" = "darwin-arm64" ] && echo "$name" | grep -Eq '(darwin|core)-?x64'; then drop=1; fi
      # Chỉ prune entry có dấu hiệu platform rõ ràng trong tên (chứa token OS/arch/libc);
      # entry generic (không token platform) luôn giữ.
      if [ "$drop" = "1" ] && echo "$name" | grep -Eq '(darwin|win32|linux|musl|glibc|gnu|arm64|x64|freebsd|android)'; then
        entry_bytes="$(du -sb "$entry" | awk '{print $1}')"
        echo "$entry_bytes" >> "$PRUNED_LIST"
        echo "$name" >> "$PRUNED_LIST.names"
        echo "   prune: $name ($entry_bytes byte)"
        rm -rf "$entry"
      fi
    done
    # Xoá symlink treo trỏ vào entry đã prune.
    find "$OUT/packages" "$OUT/node_modules" -type l 2>/dev/null | while read -r link; do
      [ -e "$link" ] || rm -f "$link"
    done
  fi
  PRUNED_BYTES="$(awk '{s+=$1} END {print s+0}' "$PRUNED_LIST")"
  PRUNED_COUNT="$(grep -c . "$PRUNED_LIST.names" 2>/dev/null || echo 0)"
  echo "   prune platform khác ($PLATFORM): $PRUNED_COUNT entry kho .bun, $PRUNED_BYTES byte (tên từng entry ở các dòng 'prune:' ngay trên)"
  rm -f "$PRUNED_LIST" "$PRUNED_LIST.names"
fi

# ============ c2. KIỂM CỨNG PRELOAD TRONG CÂY STAGING (phân xử F-W4-1/N1) ============
# Adapter production (sau delta N1 của patch W3) spawn bản bundled bằng
# `bun --preload <enginePath>/packages/cli/node_modules/@opentui/solid/scripts/preload.js ...`
# nên file này PHẢI tồn tại trong cây staging sau cài production. Thiếu =
# closure staging lỗi -> exit 14 riêng, thông điệp rõ. Chỉ kiểm khi đã cài
# thật (--skip-install thì cây chưa có node_modules, kiểm sẽ sai bản chất).
if [ "$SKIP_INSTALL" = "1" ]; then
  echo "== [c2] BỎ QUA kiểm preload (--skip-install: chưa cài production nên chưa có file để kiểm)"
else
  echo "== [c2] Kiểm cứng file preload @opentui/solid trong cây staging"
  STAGED_PRELOAD="$OUT/packages/cli/node_modules/@opentui/solid/scripts/preload.js"
  if [ ! -f "$STAGED_PRELOAD" ]; then
    echo "stage-engine: THIẾU file preload của @opentui/solid trong cây staging: packages/cli/node_modules/@opentui/solid/scripts/preload.js — closure staging lỗi (adapter bundled sẽ --preload đúng file này theo phân xử F-W4-1/N1)" >&2
    exit 14
  fi
  echo "   preload @opentui/solid trong cây staging: OK ($STAGED_PRELOAD)"
fi

# ============ d. FETCH BUN ĐI KÈM ============
echo "== [d] Fetch bun $BUN_VERSION ($PLATFORM) qua fetch-bun.sh"
"$SCRIPT_DIR/fetch-bun.sh" --platform "$PLATFORM" --out "$OUT/bin" || { echo "stage-engine: fetch-bun LỖI" >&2; exit 13; }

# ============ e. ENGINE-VERSION.json + ENGINE-MANIFEST.json ============
echo "== [e] Sinh ENGINE-VERSION.json + ENGINE-MANIFEST.json"
ENGINE_VERSION="$(python3 -c "import json;print(json.load(open('$OUT/packages/cli/package.json'))['version'])")"
STAGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$OUT/ENGINE-VERSION.json" "$ENGINE_VERSION" "${ENGINE_REF:-}" "$PLATFORM" "$BUN_VERSION" "$STAGED_AT" <<'PYEOF'
import json, sys
path, ver, ref, platform, bunver, staged_at = sys.argv[1:7]
json.dump({
    "version": ver,
    "engineRef": ref if ref else None,
    "bunVersion": bunver,
    "platform": platform,
    "stagedAt": staged_at,
}, open(path, "w"), indent=2)
PYEOF

# Manifest: mọi file trong cây đích trừ chính ENGINE-MANIFEST.json.
# File thường: sha256 theo nội dung. Symlink: size = độ dài chuỗi đích, sha256 = sha256 của chuỗi đích
# (bun isolated linker dùng symlink từ packages/*/node_modules vào kho .bun — phải ghi để assert hậu đóng gói).
python3 - "$OUT" <<'PYEOF'
import hashlib, json, os, sys
root = sys.argv[1]
entries = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root)
        if rel == "ENGINE-MANIFEST.json":
            continue
        if os.path.islink(full):
            target = os.readlink(full)
            entries.append({"path": rel, "size": len(target), "sha256": hashlib.sha256(target.encode()).hexdigest()})
        else:
            h = hashlib.sha256()
            with open(full, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            entries.append({"path": rel, "size": os.path.getsize(full), "sha256": h.hexdigest()})
json.dump(entries, open(os.path.join(root, "ENGINE-MANIFEST.json"), "w"), indent=1)
total = sum(e["size"] for e in entries)
print(f"MANIFEST_COUNT={len(entries)}")
print(f"MANIFEST_BYTES={total}")
PYEOF

# ============ f. TÓM TẮT ============
TOTAL_BYTES="$(du -sb "$OUT" | awk '{print $1}')"
FILE_COUNT="$(find "$OUT" -type f | wc -l | tr -d ' ')"
echo "== [f] TÓM TẮT STAGING"
echo "   platform      : $PLATFORM"
echo "   engine version: $ENGINE_VERSION (engineRef: ${ENGINE_REF:-<không ghi>})"
echo "   số file (find -type f): $FILE_COUNT"
echo "   tổng byte cây đích (du -sb): $TOTAL_BYTES"
echo "   cây đích: $OUT"
