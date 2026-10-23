#!/usr/bin/env bash
# =============================================================================
# verify-engine-payload.sh — BẢN BINARY (CB-3b, lane BUILD-QA-B, cổng alpha.40
# đường (B) COMPILE). THAY NỘI DUNG file build/engine/verify-engine-payload.sh
# trong repo c2t-ide; workflow KHÔNG đổi đường gọi (w3-stage-binary.md §4.2):
#   linux: bash build/engine/verify-engine-payload.sh .build/engine-verify/usr/share/ide-code
#   win32: bash build/engine/verify-engine-payload.sh ../VSCode-win32-x64
#
# Assert HẬU ĐÓNG GÓI cho payload engine DẠNG BINARY (thay đường cây
# node_modules + bun runtime của bản verify cũ ở w37-aprime/):
#   staged = resources/app/engine/{ opencode[.exe], rg[.exe], LICENSE,
#            ENGINE-MANIFEST.json (schema binary-v1), ENGINE-VERSION.json }
#
# Cách dùng:
#   verify-engine-payload.sh <app-root> [--platform linux-x64|win32-x64]
#                                       [--smoke-timeout <giây>]
#   <app-root> là thư mục CHỨA resources/app/ (cây extract của .deb, cây
#   packaged VSCode-<platform>-x64, hoặc cây rehearsal packaged/).
#   --platform: platform ĐÍCH kỳ vọng của job. Mặc định suy từ host
#   (Linux x86_64 -> linux-x64; MINGW/MSYS/CYGWIN -> win32-x64). CI alpha.40
#   chạy mỗi job trên runner khớp platform nên mặc định này đúng ở CI;
#   rehearsal lệch host truyền --platform tường minh.
#   --smoke-timeout: mặc định 120 giây.
#
# Thứ tự kiểm — FAIL-CLOSED, dừng ở cổng fail đầu tiên:
#   (a) ENGINE-MANIFEST.json tồn tại + parse được + schema binary-v1:
#       format == "engine-binary-manifest-v1", platform == platform kỳ vọng,
#       arch == "x64", có đủ binary/rg/license với {path,size,sha256},
#       binary.path/rg.path đúng tên theo platform (opencode[.exe]/rg[.exe]).
#   (b) binary opencode[.exe] tồn tại tại resources/app/engine/, size +
#       sha256 khớp manifest TUYỆT ĐỐI (tái hash toàn bộ file).
#   (c) Định dạng platform của binary:
#       linux = ELF 64-bit x86-64 (magic 7f 'E' 'L' 'F', EI_CLASS=2,
#               e_machine=0x003E little-endian);
#       win32 = PE32+ machine 0x8664 (MZ, chữ ký 'PE\0\0' tại offset ở 0x3C,
#               machine=0x8664, optional-header magic=0x020B).
#       Kiểm bằng python3 đọc header trực tiếp (công cụ có trên mọi runner;
#       tương đương `file`/`od` mà CB-1 đã dùng, nhưng không phụ thuộc
#       `file` có mặt trên runner Windows).
#   (d) rg[.exe] tồn tại, size + sha256 khớp manifest; LICENSE cũng được
#       đối chiếu size + sha256 với manifest (cùng cổng 11).
#   (e) SERVE SMOKE — chỉ khi host chạy được binary (host platform ==
#       target platform): spawn binary staged TRỰC TIẾP (không bun,
#       không --preload):
#         <engine>/opencode[.exe] serve --port <cổng-trống> --hostname 127.0.0.1
#       với cwd = thư mục tạm cách ly, HOME/XDG cách ly vào thư mục tạm,
#       OPENCODE_PASSWORD do verify tự đặt qua env, PATH prepend thư mục
#       engine (đúng hành vi adapter CB-4: rg cạnh binary được tìm qua PATH).
#       Poll GET /api/info (Basic auth user "opencode" + password trên)
#       tới HTTP 200, timeout hào phóng (mặc định 120s). TUYỆT ĐỐI KHÔNG
#       dùng /global/health. Quét log: bất kỳ dòng "Cannot find module"
#       nào = FAIL. Tắt sạch process (TERM cả process-group rồi KILL,
#       kiểm không sót process theo cổng).
#       Khi host KHÔNG chạy được binary (host platform != target platform):
#       chỉ làm (a)-(d) và in đúng dòng
#         SMOKE DEFERRED: host platform != target platform
#       kèm chi tiết host/target. Trạng thái này CHỈ chấp nhận ở rehearsal
#       lệch host; ở CI alpha.40 cả 2 job đều chạy trên runner khớp
#       platform nên smoke luôn thực thi tại CI. Deferred KHÔNG được tính
#       là PASS smoke (dòng kết quả ghi rõ PASS-WITHOUT-SMOKE).
#
# Bản đồ mã thoát (xem thêm w3b-verify-d6.md):
#   0   PASS (a)-(e); hoặc PASS (a)-(d) + SMOKE DEFERRED ở rehearsal lệch host
#   2   lỗi cách dùng / thiếu công cụ (python3, curl khi cần smoke)
#   11  payload thiếu/không đầy đủ — GIỮ NGUYÊN Ý NGHĨA BẢN CŨ (w37: exit 11
#       = FAIL tầng 1 tĩnh): thiếu manifest/binary/rg/LICENSE, manifest
#       không parse được / sai schema / sai platform-arch so với job,
#       size/sha256 lệch manifest.
#   12  sai định dạng platform của binary (không phải ELF64 x86-64 / PE32+
#       0x8664 như platform đòi). (Bản cũ: 12 = bun --version sai; payload
#       binary không còn bun nên 12 chuyển sang cổng định dạng — ghi rõ ở
#       hồ sơ w3b để run-watch không đọc nhầm.)
#   13  smoke fail: spawn chết ngay / chết giữa chừng, /api/info không lên
#       200 trong timeout, log chứa "Cannot find module", hoặc còn sót
#       process sau khi tắt. (Cùng số với FAIL tầng 3 của bản cũ.)
# Mọi kiểm fail đều in chẩn đoán rõ: thiếu gì, lệch gì (thực tế vs kỳ vọng).
# =============================================================================

set -u

# CI Windows: stdout của runner là cp1252 — các heredoc python3 bên dưới in
# chữ Việt (ớ U+1EDB, đ, …). Ép stdio của python sang UTF-8 để không
# UnicodeEncodeError (run alpha.40 Windows từng đỏ ở gate (b) vì ký tự này).
# PYTHONIOENCODING chỉ đổi stdio, không đổi fs encoding — an toàn cho mọi
# heredoc hiện tại và sau này trong file này.
export PYTHONIOENCODING=utf-8

EXIT_USAGE=2
EXIT_PAYLOAD=11
EXIT_FORMAT=12
EXIT_SMOKE=13
SMOKE_TIMEOUT_S=120

APP_ROOT=""
EXPECT_PLATFORM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --platform thiếu giá trị" >&2; exit $EXIT_USAGE; }
      case "$2" in linux-x64|win32-x64) EXPECT_PLATFORM="$2" ;; *)
        echo "LỖI DÙNG: --platform phải là linux-x64|win32-x64" >&2; exit $EXIT_USAGE ;; esac
      shift 2 ;;
    --smoke-timeout)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --smoke-timeout thiếu giá trị" >&2; exit $EXIT_USAGE; }
      SMOKE_TIMEOUT_S="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,70p' "$0"; exit 0 ;;
    -*)
      echo "LỖI DÙNG: tham số không rõ: $1" >&2; exit $EXIT_USAGE ;;
    *)
      if [ -z "$APP_ROOT" ]; then APP_ROOT="$1"; else
        echo "LỖI DÙNG: thừa tham số vị trí: $1" >&2; exit $EXIT_USAGE; fi
      shift ;;
  esac
done

command -v python3 >/dev/null 2>&1 || {
  echo "LỖI DÙNG: thiếu công cụ bắt buộc: python3" >&2; exit $EXIT_USAGE; }

# --- platform của host (để quyết định smoke chạy được hay deferred) ---
host_platform() {
  case "$(uname -s 2>/dev/null)" in
    Linux)  [ "$(uname -m 2>/dev/null)" = "x86_64" ] && { echo "linux-x64"; return; } ;;
    MINGW*|MSYS*|CYGWIN*) echo "win32-x64"; return ;;
  esac
  echo "unknown"
}
HOST_PLATFORM="$(host_platform)"
EXPECT_PLATFORM="${EXPECT_PLATFORM:-$HOST_PLATFORM}"
if [ "$EXPECT_PLATFORM" = "unknown" ]; then
  echo "LỖI DÙNG: không suy được platform kỳ vọng từ host (uname -s=$(uname -s), uname -m=$(uname -m)) — truyền --platform linux-x64|win32-x64" >&2
  exit $EXIT_USAGE
fi

[ -n "$APP_ROOT" ] || {
  echo "LỖI DÙNG: thiếu <app-root>. Xem --help." >&2; exit $EXIT_USAGE; }
[ -d "$APP_ROOT" ] || {
  echo "FAIL [11]: thư mục app-root không tồn tại: $APP_ROOT (payload thiếu — không có cây để kiểm)" >&2
  exit $EXIT_PAYLOAD; }
# Canonical hoá thành đường TUYỆT ĐỐI: tầng smoke spawn với cwd = thư mục
# tạm cách ly nên mọi đường tương đối tính từ app-root sẽ gãy (đã bắt được
# ở rehearsal CB-3b lượt 1: setsid báo No such file or directory cho binary).
APP_ROOT="$(cd "$APP_ROOT" && pwd)"

ENGINE_DIR="$APP_ROOT/resources/app/engine"
MANIFEST="$ENGINE_DIR/ENGINE-MANIFEST.json"

case "$EXPECT_PLATFORM" in
  linux-x64) BIN_NAME="opencode"; RG_NAME="rg" ;;
  win32-x64) BIN_NAME="opencode.exe"; RG_NAME="rg.exe" ;;
esac

echo "== verify-engine-payload (BINARY, CB-3b) =="
echo "app-root      : $APP_ROOT"
echo "engine dir    : $ENGINE_DIR"
echo "target platform: $EXPECT_PLATFORM (binary=$BIN_NAME, rg=$RG_NAME)"
echo "host platform : $HOST_PLATFORM"

# =============================================================================
# (a) MANIFEST tồn tại + parse + schema binary-v1 + platform/arch của job
# (b) binary tồn tại + size/sha khớp manifest
# (d) rg + LICENSE tồn tại + size/sha khớp manifest
#   -> cả ba cổng tĩnh này chạy trong 1 khối python, thoát 11 khi fail.
# (c) định dạng chạy NGAY SAU (b) trong cùng khối python nhưng thoát 12,
#     để thứ tự cổng đúng (a)->(b)->(c)->(d): python in marker cổng và
#     dùng mã thoát riêng cho từng cổng; (d) chỉ chạy khi (c) đã PASS.
# =============================================================================
echo "-- (a) ENGINE-MANIFEST.json: tồn tại + parse + schema binary-v1 + platform/arch"
echo "-- (b) binary: tồn tại + size/sha256 khớp manifest tuyệt đối"
echo "-- (c) binary: định dạng platform (linux=ELF64 x86-64, win32=PE32+ 0x8664)"
echo "-- (d) rg + LICENSE: tồn tại + size/sha256 khớp manifest"

ENGINE_DIR="$ENGINE_DIR" EXPECT_PLATFORM="$EXPECT_PLATFORM" \
BIN_NAME="$BIN_NAME" RG_NAME="$RG_NAME" python3 - <<'PYEOF'
import hashlib, json, os, struct, sys

EXIT_PAYLOAD, EXIT_FORMAT = 11, 12
engine = os.environ["ENGINE_DIR"]
platform = os.environ["EXPECT_PLATFORM"]
bin_name, rg_name = os.environ["BIN_NAME"], os.environ["RG_NAME"]
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

# ---- (a) manifest ----
if not os.path.isdir(engine):
    fail(EXIT_PAYLOAD, f"thiếu thư mục engine: {engine} (mong đợi resources/app/engine/ trong app-root)")
if not os.path.isfile(manifest_path):
    fail(EXIT_PAYLOAD, f"thiếu ENGINE-MANIFEST.json tại {manifest_path}")
try:
    with open(manifest_path, encoding="utf-8") as fh:
        m = json.load(fh)
except Exception as e:
    fail(EXIT_PAYLOAD, f"ENGINE-MANIFEST.json không parse được: {e}")
if not isinstance(m, dict):
    fail(EXIT_PAYLOAD, f"ENGINE-MANIFEST.json phải là OBJECT schema binary-v1; nhận được kiểu {type(m).__name__} (mảng trần = schema đường cây cũ, không áp cho payload binary)")
if m.get("format") != "engine-binary-manifest-v1":
    fail(EXIT_PAYLOAD, f"manifest format = {m.get('format')!r}, mong đợi 'engine-binary-manifest-v1'")
if m.get("platform") != platform:
    fail(EXIT_PAYLOAD, f"manifest platform = {m.get('platform')!r}, mong đợi {platform!r} của job này (payload đóng cho platform khác)")
if m.get("arch") != "x64":
    fail(EXIT_PAYLOAD, f"manifest arch = {m.get('arch')!r}, mong đợi 'x64'")
for key in ("binary", "rg", "license"):
    e = m.get(key)
    if not isinstance(e, dict) or not all(k in e for k in ("path", "size", "sha256")):
        fail(EXIT_PAYLOAD, f"manifest thiếu/không đúng mục '{key}' dạng {{path,size,sha256}}: {e!r}")
if m["binary"]["path"] != bin_name:
    fail(EXIT_PAYLOAD, f"manifest binary.path = {m['binary']['path']!r}, mong đợi {bin_name!r} cho {platform}")
if m["rg"]["path"] != rg_name:
    fail(EXIT_PAYLOAD, f"manifest rg.path = {m['rg']['path']!r}, mong đợi {rg_name!r} cho {platform}")
print(f"  OK (a): manifest binary-v1, platform={m['platform']}, arch=x64, "
      f"engineVersion={m.get('engineVersion')!r}, engineRef={m.get('engineRef')!r}, "
      f"rg.version={m['rg'].get('version')!r}")

def check_file(key):
    e = m[key]
    p = os.path.join(engine, e["path"])
    if not os.path.isfile(p):
        fail(EXIT_PAYLOAD, f"thiếu file {key}: {p} (manifest khai size={e['size']}, sha256={e['sha256']})")
    size = os.path.getsize(p)
    if size != e["size"]:
        fail(EXIT_PAYLOAD, f"{key} ({e['path']}) lệch SIZE: thực tế {size} byte, manifest {e['size']} byte")
    sha = sha256_of(p)
    if sha != e["sha256"]:
        fail(EXIT_PAYLOAD, f"{key} ({e['path']}) lệch SHA256: thực tế {sha}, manifest {e['sha256']}")
    print(f"  OK: {key} {e['path']} — {size} byte, sha256 khớp manifest ({sha})")
    return p

# ---- (b) binary size/sha ----
bin_path = check_file("binary")
print("  OK (b): binary khớp manifest tuyệt đối (size + sha256)")

# ---- (c) định dạng platform ----
with open(bin_path, "rb") as f:
    head = f.read(4096)
if platform == "linux-x64":
    ok = (len(head) >= 20 and head[0:4] == b"\x7fELF" and head[4] == 2
          and head[5] == 1 and struct.unpack("<H", head[18:20])[0] == 0x3E)
    if not ok:
        desc = head[0:4]
        fail(EXIT_FORMAT, f"binary KHÔNG phải ELF 64-bit x86-64: 4 byte đầu={desc!r}, EI_CLASS={head[4] if len(head)>4 else '?'}, e_machine={struct.unpack('<H', head[18:20])[0] if len(head)>=20 else '?'} (mong đợi magic ELF, class=2, e_machine=0x3E=62)")
    print("  OK (c): ELF 64-bit x86-64 (magic ELF, EI_CLASS=2, e_machine=0x3E)")
else:
    if len(head) < 0x40 or head[0:2] != b"MZ":
        fail(EXIT_FORMAT, "binary KHÔNG phải PE: thiếu chữ ký 'MZ' ở đầu file")
    pe_off = struct.unpack("<I", head[0x3C:0x40])[0]
    if len(head) < pe_off + 26 or head[pe_off:pe_off+4] != b"PE\x00\x00":
        fail(EXIT_FORMAT, f"binary KHÔNG phải PE: không thấy chữ ký 'PE\\0\\0' tại offset {pe_off} (từ 0x3C)")
    machine = struct.unpack("<H", head[pe_off+4:pe_off+6])[0]
    opt_magic = struct.unpack("<H", head[pe_off+24:pe_off+26])[0]
    if machine != 0x8664 or opt_magic != 0x20B:
        fail(EXIT_FORMAT, f"binary PE sai loại: machine=0x{machine:04x}, optional-header magic=0x{opt_magic:04x} (mong đợi machine=0x8664 PE32+ x86-64, magic=0x020B)")
    print("  OK (c): PE32+ x86-64 (MZ + PE\\0\\0, machine=0x8664, magic=0x020B)")

# ---- (d) rg + LICENSE ----
check_file("rg")
check_file("license")
print("  OK (d): rg + LICENSE khớp manifest (size + sha256)")
PYEOF
STATIC_RC=$?
if [ "$STATIC_RC" -ne 0 ]; then
  echo "== KẾT QUẢ: FAIL (mã $STATIC_RC — xem chẩn đoán ở trên) =="
  exit $STATIC_RC
fi

BIN_PATH="$ENGINE_DIR/$BIN_NAME"
if [ "$EXPECT_PLATFORM" = "linux-x64" ] && [ ! -x "$BIN_PATH" ]; then
  echo "FAIL [11]: binary thiếu bit thực thi (+x): $BIN_PATH"
  exit $EXIT_PAYLOAD
fi

# =============================================================================
# (e) SERVE SMOKE — chỉ khi host chạy được binary
# =============================================================================
if [ "$HOST_PLATFORM" != "$EXPECT_PLATFORM" ]; then
  echo "-- (e) serve smoke: KHÔNG chạy được trên host này"
  echo "SMOKE DEFERRED: host platform != target platform (host=$HOST_PLATFORM, target=$EXPECT_PLATFORM)"
  echo "== KẾT QUẢ: PASS (a)-(d) — SMOKE DEFERRED (chỉ chấp nhận ở rehearsal lệch host; KHÔNG tính là PASS smoke; CI khớp platform sẽ chạy smoke thật) =="
  exit 0
fi

command -v curl >/dev/null 2>&1 || {
  echo "LỖI DÙNG: thiếu công cụ bắt buộc cho smoke: curl" >&2; exit $EXIT_USAGE; }

echo "-- (e) serve smoke: spawn binary staged, poll GET /api/info tới 200 (timeout ${SMOKE_TIMEOUT_S}s)"
WORK_DIR="$(mktemp -d /tmp/engine-verify-binary.XXXXXXXX)"
ENGINE_LOG="$WORK_DIR/engine.log"
TEST_PASSWORD="cb3b-verify-password-$$"
SERVER_PID=""

cleanup_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in 1 2 3 4 5; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -KILL -- "-$SERVER_PID" 2>/dev/null || kill -KILL "$SERVER_PID" 2>/dev/null
      sleep 1
    fi
  fi
}
trap cleanup_server EXIT INT TERM

PORT="$(python3 - <<'PYEOF'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PYEOF
)"
mkdir -p "$WORK_DIR/cwd" "$WORK_DIR/home"
echo "  cổng thử: $PORT; cwd tạm cách ly: $WORK_DIR/cwd; OPENCODE_PASSWORD do verify tự đặt qua env"
echo "  spawn argv: $BIN_PATH serve --port $PORT --hostname 127.0.0.1 (PATH prepend $ENGINE_DIR — hành vi adapter CB-4)"

(
  cd "$WORK_DIR/cwd" || exit 99
  HOME="$WORK_DIR/home" \
  XDG_DATA_HOME="$WORK_DIR/home/.local/share" \
  XDG_CONFIG_HOME="$WORK_DIR/home/.config" \
  XDG_CACHE_HOME="$WORK_DIR/home/.cache" \
  OPENCODE_PASSWORD="$TEST_PASSWORD" \
  PATH="$ENGINE_DIR:$PATH" \
  setsid "$BIN_PATH" serve --port "$PORT" --hostname 127.0.0.1 >"$ENGINE_LOG" 2>&1 &
  echo $! >"$WORK_DIR/server.pid"
)
sleep 1
SERVER_PID="$(cat "$WORK_DIR/server.pid" 2>/dev/null || true)"
if [ -z "$SERVER_PID" ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "FAIL [13]: binary chết ngay khi spawn serve. Log engine:"
  sed 's/^/    /' "$ENGINE_LOG" 2>/dev/null | head -n 50
  exit $EXIT_SMOKE
fi
echo "  engine PID: $SERVER_PID"

HTTP_CODE="000"
ELAPSED=0
while [ "$ELAPSED" -lt "$SMOKE_TIMEOUT_S" ]; do
  HTTP_CODE="$(curl -s -o "$WORK_DIR/api-info.json" -w '%{http_code}' --max-time 3 \
    -u "opencode:$TEST_PASSWORD" "http://127.0.0.1:$PORT/api/info" 2>/dev/null || echo 000)"
  [ "$HTTP_CODE" = "200" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 2; ELAPSED=$((ELAPSED + 2))
done

# Quét log TRƯỚC khi kết luận: "Cannot find module" ở bất kỳ thời điểm nào = FAIL,
# kể cả khi /api/info đã lên 200 (module thiếu có thể chỉ lộ ở log nền).
if grep -q "Cannot find module" "$ENGINE_LOG" 2>/dev/null; then
  echo "FAIL [13]: log engine chứa 'Cannot find module' (payload binary thiếu module nhúng):"
  grep -n "Cannot find module" "$ENGINE_LOG" | head -n 10 | sed 's/^/    /'
  exit $EXIT_SMOKE
fi

if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL [13]: GET /api/info không trả 200 sau ~${ELAPSED}s (mã cuối: $HTTP_CODE; mong đợi 200 với Basic auth opencode:<OPENCODE_PASSWORD tự đặt>). Log engine (50 dòng cuối):"
  tail -n 50 "$ENGINE_LOG" 2>/dev/null | sed 's/^/    /'
  exit $EXIT_SMOKE
fi
echo "  OK: GET /api/info → 200 sau ~${ELAPSED}s; body: $(head -c 300 "$WORK_DIR/api-info.json" 2>/dev/null)"

cleanup_server
trap - EXIT INT TERM
sleep 1
LEFTOVER="$(pgrep -f "serve --port $PORT" 2>/dev/null || true)"
if [ -n "$LEFTOVER" ]; then
  echo "FAIL [13]: còn sót tiến trình engine sau khi tắt: PID $LEFTOVER"
  exit $EXIT_SMOKE
fi
echo "  OK: đã tắt engine, không sót tiến trình (pgrep theo 'serve --port $PORT': rỗng); log không có 'Cannot find module'"
echo "PASS (e)"
echo "== KẾT QUẢ: PASS (a)-(e) — payload binary $EXPECT_PLATFORM đầy đủ + serve smoke 200 =="
exit 0
