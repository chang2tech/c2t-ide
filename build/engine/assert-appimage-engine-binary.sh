#!/usr/bin/env bash
# =============================================================================
# assert-appimage-engine-binary.sh — D6 BẢN BINARY (CB-3b, lane BUILD-QA-B,
# cổng alpha.40 đường (B) COMPILE). Biến thể binary của D6 cũ ở
# w9-d6-appimage-assert/assert-appimage-engine.sh (đường cây: B1 entry .ts +
# B2 bin/bun + B5 bun --version — cả ba đều KHÔNG còn áp dụng cho payload
# binary: không còn packages/, không còn bin/bun).
#
# Đích danh khi áp vào repo c2t-ide: build/engine/assert-appimage-engine-binary.sh
# (cạnh verify-engine-payload.sh bản binary), cộng 1 step trong workflow ngay
# sau step "Build AppImage" của job build-linux-x64 (neo tên step như D6 cũ:
# sau `name: Build AppImage`, trước step `id: ver`) — xem w3b-verify-d6.md §D6.
#
# Phạm vi assert (đúng tinh thần W3 §5.3 cho tầng AppImage: cây AppImage là
# `cp -a` nguyên văn của cây packaged đã qua verify ở tầng .deb, nên D6 chỉ
# kiểm ĐIỂM những gì một lỗi đóng gói riêng của AppImage có thể làm hỏng —
# payload engine bị rơi/thiếu/lệch khi copy + squash):
#   D6-1  ENGINE-MANIFEST.json tồn tại trong artifact, parse được, schema
#         binary-v1, platform khớp platform kỳ vọng.
#   D6-2  opencode[.exe] tồn tại tại resources/app/engine/ TRONG artifact,
#         size + sha256 khớp manifest TRONG artifact (tái hash file thật
#         trong layout đã giải nén/mount — bắt được copy thiếu/squash lỗi).
#   D6-3  rg[.exe] tồn tại, size + sha256 khớp manifest trong artifact;
#         LICENSE cũng đối chiếu size + sha256.
#   D6-4  Định dạng binary: linux = ELF 64-bit x86-64; win32 = PE32+
#         machine 0x8664 (cùng kiểm header như verify (c)).
# Cố ý KHÔNG làm ở tầng này (như D6 cũ, theo W3 §5.4): KHÔNG spawn serve —
# smoke thuộc verify-engine-payload (tầng .deb / packaged tree) và harness
# boot-test, không thuộc gate AppImage.
#
# Cách dùng:
#   assert-appimage-engine-binary.sh <file.AppImage> [--workdir <thư-mục>] [--keep]
#   assert-appimage-engine-binary.sh --from-dir <thư-mục-layout> [--platform linux-x64|win32-x64]
#
#   <file.AppImage>: extract bằng --appimage-extract trong --workdir (mặc
#   định: thư mục cạnh script /.appimage-assert-work — TRÊN ĐĨA THẬT, không
#   /tmp vì /tmp của máy lane là tmpfs 512MB; CI truyền --workdir tường minh
#   .build/appimage-assert). Extract xong assert trên squashfs-root/usr/.
#   --from-dir: assert thẳng trên layout sẵn có, KHÔNG extract, KHÔNG xoá.
#   Thư mục được nhận diện linh hoạt theo đúng các layout artifact thật:
#     - squashfs-root của AppImage:  <dir>/usr/resources/app/engine/
#     - app-root (packaged / .deb extract / cây zip win32 giải nén):
#                                    <dir>/resources/app/engine/
#     - gốc extract của .deb:        <dir>/usr/share/ide-code/resources/app/engine/
#   Áp cho .deb:  dpkg-deb -x <file.deb> <extract> rồi
#                 --from-dir <extract>/usr/share/ide-code   (hoặc <extract> —
#                 script tự tìm theo 3 đường trên).
#   Áp cho zip win32: giải nén zip rồi --from-dir <thư-mục-gốc-đã-giải-nén>
#                 --platform win32-x64 (assert D6-1..D6-4 trên cây zip;
#                 installer .exe Inno không có extractor trong workflow —
#                 UNKNOWN-BY-HOST, xem hồ sơ w3b §D6).
#
# Mã thoát (nhất quán với verify-engine-payload bản binary):
#   0   PASS D6-1..D6-4
#   2   lỗi cách dùng / thiếu công cụ / không extract được AppImage
#   11  FAIL D6-1/D6-2/D6-3 (thiếu manifest/binary/rg/LICENSE trong artifact,
#       manifest sai schema/platform, size/sha256 lệch manifest)
#   12  FAIL D6-4 (binary sai định dạng platform)
# =============================================================================

set -u

EXIT_USAGE=2
EXIT_PAYLOAD=11
EXIT_FORMAT=12

APPIMAGE=""
FROM_DIR=""
WORKDIR=""
KEEP=0
EXPECT_PLATFORM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --from-dir thiếu giá trị" >&2; exit $EXIT_USAGE; }
      FROM_DIR="$2"; shift 2 ;;
    --workdir)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --workdir thiếu giá trị" >&2; exit $EXIT_USAGE; }
      WORKDIR="$2"; shift 2 ;;
    --platform)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --platform thiếu giá trị" >&2; exit $EXIT_USAGE; }
      case "$2" in linux-x64|win32-x64) EXPECT_PLATFORM="$2" ;; *)
        echo "LỖI DÙNG: --platform phải là linux-x64|win32-x64" >&2; exit $EXIT_USAGE ;; esac
      shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    -*)
      echo "LỖI DÙNG: tham số không rõ: $1" >&2; exit $EXIT_USAGE ;;
    *)
      if [ -z "$APPIMAGE" ]; then APPIMAGE="$1"; else
        echo "LỖI DÙNG: thừa tham số vị trí: $1" >&2; exit $EXIT_USAGE; fi
      shift ;;
  esac
done

if [ -n "$APPIMAGE" ] && [ -n "$FROM_DIR" ]; then
  echo "LỖI DÙNG: chỉ dùng MỘT trong hai: <file.AppImage> hoặc --from-dir <thư-mục-layout>" >&2
  exit $EXIT_USAGE
fi
if [ -z "$APPIMAGE" ] && [ -z "$FROM_DIR" ]; then
  echo "LỖI DÙNG: thiếu <file.AppImage> hoặc --from-dir <thư-mục-layout>. Xem --help." >&2
  exit $EXIT_USAGE
fi
command -v python3 >/dev/null 2>&1 || {
  echo "LỖI DÙNG: thiếu công cụ bắt buộc: python3" >&2; exit $EXIT_USAGE; }
EXPECT_PLATFORM="${EXPECT_PLATFORM:-linux-x64}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR=""
cleanup_run_dir() {
  if [ -n "$RUN_DIR" ] && [ "$KEEP" -eq 0 ]; then
    rm -rf "$RUN_DIR"
    echo "đã dọn thư mục extract: $RUN_DIR (dùng --keep để giữ lại)"
  elif [ -n "$RUN_DIR" ]; then
    echo "--keep: giữ lại thư mục extract: $RUN_DIR"
  fi
}
trap cleanup_run_dir EXIT

echo "== assert-appimage-engine-binary (D6 BẢN BINARY, CB-3b) =="
echo "target platform: $EXPECT_PLATFORM"

ROOT=""
if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR" ] || {
    echo "FAIL [11]: --from-dir không tồn tại hoặc không phải thư mục: $FROM_DIR" >&2
    exit $EXIT_PAYLOAD; }
  ROOT="$FROM_DIR"
  echo "chế độ        : --from-dir (không extract, không xoá gì)"
  echo "layout        : $ROOT"
else
  [ -f "$APPIMAGE" ] || {
    echo "FAIL [2]: không thấy file AppImage: $APPIMAGE" >&2; exit $EXIT_USAGE; }
  APPIMAGE_ABS="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"
  echo "AppImage      : $APPIMAGE_ABS ($(stat -c %s "$APPIMAGE_ABS") byte)"
  WORKDIR="${WORKDIR:-$SCRIPT_DIR/.appimage-assert-work}"
  mkdir -p "$WORKDIR" || {
    echo "FAIL [2]: không tạo được --workdir: $WORKDIR" >&2; exit $EXIT_USAGE; }
  RUN_DIR="$(mktemp -d "$WORKDIR/run.XXXXXXXX")"
  APPIMAGE_RUN="$APPIMAGE_ABS"
  if [ ! -x "$APPIMAGE_ABS" ]; then
    cp -a "$APPIMAGE_ABS" "$RUN_DIR/appimage-copy.AppImage"
    chmod +x "$RUN_DIR/appimage-copy.AppImage"
    APPIMAGE_RUN="$RUN_DIR/appimage-copy.AppImage"
    echo "  (file gốc thiếu bit +x → copy vào thư mục chạy và chmod +x bản copy; file gốc không bị sửa)"
  fi
  ( cd "$RUN_DIR" && "$APPIMAGE_RUN" --appimage-extract > extract.log 2>&1 )
  EXTRACT_RC=$?
  if [ "$EXTRACT_RC" -ne 0 ] || [ ! -d "$RUN_DIR/squashfs-root" ]; then
    echo "FAIL [2]: --appimage-extract thất bại (exit $EXTRACT_RC); 20 dòng cuối extract.log:" >&2
    tail -n 20 "$RUN_DIR/extract.log" 2>/dev/null | sed 's/^/    /' >&2
    exit $EXIT_USAGE
  fi
  ROOT="$RUN_DIR/squashfs-root"
  echo "extract       : xong → $ROOT"
fi

# --- định vị engine trong layout (3 đường layout thật, xem header) ---
ENGINE_DIR=""
for cand in \
  "$ROOT/usr/resources/app/engine" \
  "$ROOT/resources/app/engine" \
  "$ROOT/usr/share/ide-code/resources/app/engine"; do
  if [ -d "$cand" ]; then ENGINE_DIR="$cand"; break; fi
done
if [ -z "$ENGINE_DIR" ]; then
  FOUND="$(find "$ROOT" -type d -path '*/resources/app/engine' -print -quit 2>/dev/null)"
  if [ -n "$FOUND" ]; then
    ENGINE_DIR="$FOUND"
    echo "LƯU Ý: engine không ở 3 đường layout chuẩn, tìm thấy ở: $ENGINE_DIR"
  else
    echo "FAIL [11]: không tìm thấy resources/app/engine ở bất cứ đâu trong layout:"
    echo "  đã tìm: $ROOT/usr/resources/app/engine | $ROOT/resources/app/engine | $ROOT/usr/share/ide-code/resources/app/engine | find '*/resources/app/engine'"
    echo "  → artifact này KHÔNG mang engine đóng gói (đúng chữ ký các bản alpha trước gói engine)."
    exit $EXIT_PAYLOAD
  fi
fi
echo "engine dir    : $ENGINE_DIR"

# --- D6-1..D6-4 trong 1 khối python (mã thoát riêng từng cổng) ---
ENGINE_DIR="$ENGINE_DIR" EXPECT_PLATFORM="$EXPECT_PLATFORM" python3 - <<'PYEOF'
import hashlib, json, os, struct, sys

EXIT_PAYLOAD, EXIT_FORMAT = 11, 12
engine = os.environ["ENGINE_DIR"]
platform = os.environ["EXPECT_PLATFORM"]
bin_name = "opencode" if platform == "linux-x64" else "opencode.exe"
rg_name = "rg" if platform == "linux-x64" else "rg.exe"
manifest_path = os.path.join(engine, "ENGINE-MANIFEST.json")

def fail(code, msg):
    print(f"FAIL [{code}]: {msg}")
    sys.exit(code)

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

print("-- D6-1: ENGINE-MANIFEST.json trong artifact — tồn tại + parse + binary-v1 + platform")
if not os.path.isfile(manifest_path):
    fail(EXIT_PAYLOAD, f"thiếu ENGINE-MANIFEST.json trong artifact tại {manifest_path}")
try:
    with open(manifest_path, encoding="utf-8") as fh:
        m = json.load(fh)
except Exception as e:
    fail(EXIT_PAYLOAD, f"ENGINE-MANIFEST.json trong artifact không parse được: {e}")
if not isinstance(m, dict) or m.get("format") != "engine-binary-manifest-v1":
    fail(EXIT_PAYLOAD, f"manifest trong artifact không phải schema binary-v1 (format={m.get('format') if isinstance(m, dict) else type(m).__name__!r})")
if m.get("platform") != platform:
    fail(EXIT_PAYLOAD, f"manifest platform = {m.get('platform')!r}, mong đợi {platform!r}")
for key in ("binary", "rg", "license"):
    e = m.get(key)
    if not isinstance(e, dict) or not all(k in e for k in ("path", "size", "sha256")):
        fail(EXIT_PAYLOAD, f"manifest thiếu/không đúng mục '{key}': {e!r}")
if m["binary"]["path"] != bin_name or m["rg"]["path"] != rg_name:
    fail(EXIT_PAYLOAD, f"manifest khai binary.path={m['binary']['path']!r} rg.path={m['rg']['path']!r}, mong đợi {bin_name!r}/{rg_name!r} cho {platform}")
print(f"  OK D6-1: manifest binary-v1 platform={platform}, engineVersion={m.get('engineVersion')!r}")

def check_file(key, label):
    e = m[key]
    p = os.path.join(engine, e["path"])
    if not os.path.isfile(p):
        fail(EXIT_PAYLOAD, f"thiếu {label} trong artifact: {p} (manifest khai size={e['size']}, sha256={e['sha256']})")
    size = os.path.getsize(p)
    if size != e["size"]:
        fail(EXIT_PAYLOAD, f"{label} ({e['path']}) lệch SIZE trong artifact: thực tế {size}, manifest {e['size']}")
    sha = sha256_of(p)
    if sha != e["sha256"]:
        fail(EXIT_PAYLOAD, f"{label} ({e['path']}) lệch SHA256 trong artifact: thực tế {sha}, manifest {e['sha256']}")
    print(f"  OK {label}: {e['path']} — {size} byte, sha256 trong artifact khớp manifest trong artifact ({sha})")
    return p

print("-- D6-2: binary trong artifact — tồn tại + size/sha256 khớp manifest trong artifact")
bin_path = check_file("binary", "D6-2")
print("-- D6-3: rg + LICENSE trong artifact — tồn tại + size/sha256 khớp manifest")
check_file("rg", "D6-3")
check_file("license", "D6-3")

print("-- D6-4: định dạng binary trong artifact")
with open(bin_path, "rb") as f:
    head = f.read(4096)
if platform == "linux-x64":
    ok = (len(head) >= 20 and head[0:4] == b"\x7fELF" and head[4] == 2
          and head[5] == 1 and struct.unpack("<H", head[18:20])[0] == 0x3E)
    if not ok:
        fail(EXIT_FORMAT, "binary trong artifact KHÔNG phải ELF 64-bit x86-64")
    print("  OK D6-4: ELF 64-bit x86-64")
else:
    if len(head) < 0x40 or head[0:2] != b"MZ":
        fail(EXIT_FORMAT, "binary trong artifact KHÔNG phải PE: thiếu 'MZ'")
    pe_off = struct.unpack("<I", head[0x3C:0x40])[0]
    if len(head) < pe_off + 26 or head[pe_off:pe_off+4] != b"PE\x00\x00":
        fail(EXIT_FORMAT, "binary trong artifact KHÔNG phải PE: thiếu chữ ký 'PE\\0\\0'")
    machine = struct.unpack("<H", head[pe_off+4:pe_off+6])[0]
    opt_magic = struct.unpack("<H", head[pe_off+24:pe_off+26])[0]
    if machine != 0x8664 or opt_magic != 0x20B:
        fail(EXIT_FORMAT, f"binary PE trong artifact sai loại: machine=0x{machine:04x}, magic=0x{opt_magic:04x} (mong đợi 0x8664/0x020B)")
    print("  OK D6-4: PE32+ x86-64 (machine=0x8664)")
PYEOF
D6_RC=$?
if [ "$D6_RC" -ne 0 ]; then
  echo "== KẾT QUẢ D6: FAIL (mã $D6_RC — xem chẩn đoán ở trên) =="
  exit $D6_RC
fi
echo "== KẾT QUẢ D6: PASS D6-1..D6-4 — engine binary trong artifact khớp manifest trong artifact =="
exit 0
