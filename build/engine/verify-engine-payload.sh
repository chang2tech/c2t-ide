#!/usr/bin/env bash
# =============================================================================
# verify-engine-payload.sh — DRAFT (lane BUILD-QA-B, vòng BUILD-VERIFY-8, W4;
# cập nhật W8: gấp phân xử F-W4-1 hướng N1 — tầng 1 kiểm file preload,
# tầng 3 mặc định spawn kèm --preload kiểu adapter production)
#
# Assert HẬU ĐÓNG GÓI 3 tầng cho engine OpenCode trong payload IDE đã extract,
# theo spec đã duyệt `engine-packaging-spec-v1.md` §6 mục 4 (assert 3 tầng).
# CHỈ LÀ BẢN NHÁP CHUẨN BỊ — chưa áp vào CI/repo nào.
#
# Cách dùng:
#   verify-engine-payload.sh <thư-mục-payload-đã-extract> [--engine-subdir engine]
#                            [--spawn-cwd temp|engine-root]
#   verify-engine-payload.sh --generate-manifest <thư-mục-engine>
#
#   <thư-mục-payload-đã-extract> là cây CHỨA resources/app/ (vd cây extract của
#   .deb: .../usr/share/ide-code, hoặc của AppImage: .../squashfs-root/usr).
#   Engine được kỳ vọng tại: <payload>/resources/app/<engine-subdir>/
#   (mặc định engine-subdir = "engine" → resources/app/engine/, đúng bố cục §1
#   của spec: ngang hàng out/, extensions/).
#
# Ba tầng (chạy tuần tự, dừng ở tầng fail đầu tiên):
#   Tầng 1 TĨNH   : tồn tại entry serve + entry indexing + bin/bun[.exe]
#                   + file preload của @opentui/solid
#                   (packages/cli/node_modules/@opentui/solid/scripts/preload.js
#                   — adapter production sẽ --preload file này, xem tầng 3)
#                   + ENGINE-MANIFEST.json + ENGINE-VERSION.json; cây engine
#                   đối chiếu MANIFEST (sha256 từng file, số file, tổng byte).
#   Tầng 2 BINARY : bun trong payload chạy `--version` phải đúng 1.4.2 (D3).
#   Tầng 3 SPAWN  : spawn `bun --preload <đường-preload-tuyệt-đối>
#                   <engine>/packages/cli/src/index.ts serve
#                   --port <cổng-trống> --hostname 127.0.0.1`, cwd = thư mục tạm
#                   ghi được (mặc định; đúng spec §6(iii) + phán quyết cwd §4).
#                   Cờ --preload ở chế độ mặc định phản ánh ĐÚNG cách adapter
#                   production spawn bản bundled sau delta N1 của patch W3
#                   (phân xử F-W4-1, w6-f-w4-1-experiment.md §6.1): Bun chỉ
#                   nạp bunfig.toml tại đúng cwd nên spawn trơn từ cwd tạm
#                   sẽ FAIL oan payload đúng (chữ ký react/jsx-dev-runtime),
#                   env OPENCODE_PASSWORD đặt giá trị thử, HOME/XDG cách ly vào
#                   thư mục tạm; poll GET /api/info (Basic auth user "opencode")
#                   tới khi HTTP 200, timeout 60s.
#                   TUYỆT ĐỐI KHÔNG dùng /global/health: route này trả 500 kể
#                   cả trên checkout gốc vì thiếu packages/app/dist (spec §3).
#                   Tắt sạch tiến trình con bằng trap; kiểm không sót process.
#
#   --spawn-cwd engine-root: CHẾ ĐỘ CHẨN ĐOÁN (không phải mặc định spec) —
#   spawn TRƠN (KHÔNG --preload, giữ nguyên hành vi cũ) với cwd = gốc
#   engine. Dùng để phân biệt "payload thiếu file" với "thiếu preload khi
#   spawn từ cwd lạ" (Bun chỉ nạp bunfig.toml tại đúng cwd — bằng chứng ở
#   w4-report.md + phân xử W6). Kết quả ở chế độ này KHÔNG được báo là
#   PASS spec.
#
# Mã thoát (phân biệt từng tầng):
#   0  PASS cả 3 tầng
#   2  lỗi cách dùng / thiếu công cụ (python3, curl)
#   11 FAIL tầng 1 (tĩnh)
#   12 FAIL tầng 2 (binary)
#   13 FAIL tầng 3 (spawn thử; gồm cả trường hợp dọn dẹp còn sót process)
#
# Định dạng ENGINE-MANIFEST.json — CHUẨN LÀ BÊN SINH (stage-engine.sh của
# W1, mục e; phán quyết coordinator vòng BUILD-VERIFY-8, W7 căn hợp đồng):
#   MẢNG TRẦN, không bọc object:
#     [ {"path": "<relpath, tính từ gốc engine>", "size": <int>,
#        "sha256": "<hex>"}, ... ]
#   (không có format/fileCount/totalBytes/files/dirLinks — số file và tổng
#   byte là giá trị SUY RA từ mảng: len(mảng) và sum(size).)
#   Luật đi cây (walk) dùng chung cho sinh + kiểm — MỘT LUẬT DUY NHẤT, sao
#   đúng mã python của stage-engine.sh mục e:
#   - os.walk KHÔNG đi theo symlink thư mục (mặc định followlinks=False);
#     symlink-tới-thư-mục KHÔNG xuất hiện trong MANIFEST và các file phía
#     sau nó cũng KHÔNG xuất hiện qua đường symlink đó (bun dùng symlink
#     farm trong node_modules của từng package trỏ vào kho
#     node_modules/.bun — kho đó là thư mục THẬT nên nội dung vẫn được
#     liệt kê đầy đủ ở đường thật của kho).
#   - Symlink tới file (nằm trong filenames của os.walk): size = ĐỘ DÀI
#     CHUỖI ĐÍCH (len của readlink), sha256 = sha256 CỦA CHUỖI ĐÍCH
#     (target.encode()) — KHÔNG hash nội dung đích.
#   - File thường: size = kích thước nội dung, sha256 theo nội dung.
#   - ENGINE-MANIFEST.json ở gốc engine KHÔNG tự liệt kê chính nó.
#     ENGINE-VERSION.json CÓ được liệt kê như file thường.
#   Giới hạn đã biết (kế thừa luật W1): nội dung chỉ tới được qua một
#   symlink thư mục "lạ" trỏ ra ngoài cây không được liệt kê/hash ở tầng 1;
#   tầng 3 là lưới chặn thực tế cho trường hợp đó.
#
# Định dạng ENGINE-VERSION.json (đúng stage-engine.sh mục e; tầng 1 đòi):
#   {"version": "...", "engineRef": "<full commit SHA nguồn engine>",
#    "bunVersion": "1.4.2", "platform": "linux-x64", "stagedAt": "..."}
#   LƯU Ý: trường phiên bản tên là "version", KHÔNG phải "engineVersion".
# =============================================================================

set -u

EXPECTED_BUN_VERSION="1.4.2"
SPAWN_TIMEOUT_S=60

EXIT_USAGE=2
EXIT_TIER1=11
EXIT_TIER2=12
EXIT_TIER3=13

PAYLOAD_DIR=""
ENGINE_SUBDIR="engine"
SPAWN_CWD_MODE="temp"
GENERATE_MANIFEST_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --engine-subdir)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --engine-subdir thiếu giá trị" >&2; exit $EXIT_USAGE; }
      ENGINE_SUBDIR="$2"; shift 2 ;;
    --spawn-cwd)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --spawn-cwd thiếu giá trị" >&2; exit $EXIT_USAGE; }
      case "$2" in temp|engine-root) SPAWN_CWD_MODE="$2" ;; *)
        echo "LỖI DÙNG: --spawn-cwd phải là temp|engine-root" >&2; exit $EXIT_USAGE ;; esac
      shift 2 ;;
    --generate-manifest)
      [ $# -ge 2 ] || { echo "LỖI DÙNG: --generate-manifest thiếu thư mục engine" >&2; exit $EXIT_USAGE; }
      GENERATE_MANIFEST_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,80p' "$0"; exit 0 ;;
    -*)
      echo "LỖI DÙNG: tham số không rõ: $1" >&2; exit $EXIT_USAGE ;;
    *)
      if [ -z "$PAYLOAD_DIR" ]; then PAYLOAD_DIR="$1"; else
        echo "LỖI DÙNG: thừa tham số vị trí: $1" >&2; exit $EXIT_USAGE; fi
      shift ;;
  esac
done

for tool in python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "LỖI DÙNG: thiếu công cụ bắt buộc: $tool" >&2; exit $EXIT_USAGE; }
done

# -----------------------------------------------------------------------------
# Chế độ sinh MANIFEST (dùng cho fixture/staging; luật walk ở khối python dưới)
# -----------------------------------------------------------------------------
if [ -n "$GENERATE_MANIFEST_DIR" ]; then
  [ -d "$GENERATE_MANIFEST_DIR" ] || {
    echo "FAIL [generate-manifest]: không thấy thư mục engine: $GENERATE_MANIFEST_DIR" >&2
    exit $EXIT_USAGE; }
  ENGINE_DIR="$GENERATE_MANIFEST_DIR" python3 - <<'PYEOF'
# Sinh MANIFEST ĐÚNG luật của bên sinh W1 (stage-engine.sh mục e) — sao
# nguyên văn thuật toán: mảng trần, symlink-tới-file ghi chuỗi đích.
import hashlib, json, os, sys

root = os.environ["ENGINE_DIR"]
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
print(f"Đã sinh {os.path.join(root, 'ENGINE-MANIFEST.json')}: {len(entries)} mục, {total} byte (mảng trần, luật W1)")
PYEOF
  exit $?
fi

[ -n "$PAYLOAD_DIR" ] || {
  echo "LỖI DÙNG: thiếu <thư-mục-payload-đã-extract>. Xem --help." >&2; exit $EXIT_USAGE; }
[ -d "$PAYLOAD_DIR" ] || {
  echo "FAIL [tầng 0]: thư mục payload không tồn tại: $PAYLOAD_DIR" >&2; exit $EXIT_USAGE; }

APP_DIR="$PAYLOAD_DIR/resources/app"
ENGINE_DIR="$APP_DIR/$ENGINE_SUBDIR"
# File preload của @opentui/solid trong closure payload — đường tính từ
# payload, đúng file adapter production sẽ --preload (phân xử F-W4-1/N1).
PRELOAD_FILE="$ENGINE_DIR/packages/cli/node_modules/@opentui/solid/scripts/preload.js"

echo "== verify-engine-payload (DRAFT) =="
echo "payload      : $PAYLOAD_DIR"
echo "engine dir   : $ENGINE_DIR"
echo "spawn cwd mode: $SPAWN_CWD_MODE"

# =============================================================================
# TẦNG 1 — TĨNH
# =============================================================================
echo "-- TẦNG 1 (tĩnh): tồn tại bắt buộc + đối chiếu ENGINE-MANIFEST.json"
T1_FAIL=0
t1_missing() { echo "  THIẾU: $1"; T1_FAIL=1; }

[ -d "$APP_DIR" ]    || t1_missing "thư mục resources/app/ (payload không đúng cây extract?)"
[ -d "$ENGINE_DIR" ] || t1_missing "thư mục engine: resources/app/$ENGINE_SUBDIR/"

if [ -d "$ENGINE_DIR" ]; then
  [ -f "$ENGINE_DIR/packages/cli/src/index.ts" ]        || t1_missing "entry serve: engine/packages/cli/src/index.ts"
  [ -f "$ENGINE_DIR/packages/core/src/indexing/cli.ts" ] || t1_missing "entry indexing: engine/packages/core/src/indexing/cli.ts"
  if [ -f "$ENGINE_DIR/bin/bun" ]; then
    BUN_BIN="$ENGINE_DIR/bin/bun"
  elif [ -f "$ENGINE_DIR/bin/bun.exe" ]; then
    BUN_BIN="$ENGINE_DIR/bin/bun.exe"
  else
    BUN_BIN=""
    t1_missing "binary bun: engine/bin/bun hoặc engine/bin/bun.exe"
  fi
  [ -f "$PRELOAD_FILE" ] || t1_missing "thiếu preload của @opentui/solid — closure staging lỗi: engine/packages/cli/node_modules/@opentui/solid/scripts/preload.js"
  [ -f "$ENGINE_DIR/ENGINE-MANIFEST.json" ] || t1_missing "engine/ENGINE-MANIFEST.json"
  [ -f "$ENGINE_DIR/ENGINE-VERSION.json" ]  || t1_missing "engine/ENGINE-VERSION.json"
else
  BUN_BIN=""
fi

if [ "$T1_FAIL" -ne 0 ]; then
  echo "FAIL TẦNG 1: payload thiếu thành phần engine bắt buộc (danh sách THIẾU ở trên)."
  exit $EXIT_TIER1
fi
echo "  OK: đủ entry serve + entry indexing + bin/bun + preload @opentui/solid + MANIFEST + VERSION"

# Đối chiếu cây engine với MANIFEST + kiểm ENGINE-VERSION.json (python3, cùng
# luật walk với --generate-manifest)
ENGINE_DIR="$ENGINE_DIR" python3 - <<'PYEOF'
import hashlib, json, os, sys

root = os.environ["ENGINE_DIR"]
manifest_path = os.path.join(root, "ENGINE-MANIFEST.json")
version_path = os.path.join(root, "ENGINE-VERSION.json")
problems = []

try:
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
except Exception as e:
    print(f"  MANIFEST không đọc được: {e}")
    sys.exit(1)

try:
    with open(version_path, encoding="utf-8") as fh:
        version = json.load(fh)
    for field in ("version", "engineRef", "bunVersion"):
        if field not in version:
            problems.append(f"ENGINE-VERSION.json thiếu trường bắt buộc: {field}")
    print(f"  ENGINE-VERSION: version={version.get('version')!r} "
          f"engineRef={version.get('engineRef')!r} bunVersion={version.get('bunVersion')!r} "
          f"platform={version.get('platform')!r}")
except Exception as e:
    problems.append(f"ENGINE-VERSION.json không đọc được: {e}")

# MANIFEST chuẩn W1 là MẢNG TRẦN [{path, size, sha256}, ...] — object kiểu
# cũ {format, files[], dirLinks[]} phải FAIL rõ chữ, không im lặng hiểu sai.
if not isinstance(manifest, list):
    problems.append(
        "ENGINE-MANIFEST.json không phải mảng trần [{path, size, sha256}, ...] "
        f"theo chuẩn W1 (stage-engine.sh mục e); nhận được kiểu {type(manifest).__name__}")
    manifest = []

def walk_entries(base):
    # Thuật toán sao nguyên văn stage-engine.sh mục e (một luật duy nhất):
    # os.walk mặc định không theo symlink thư mục; symlink-tới-file ghi
    # size = len(chuỗi đích), sha256 = sha256(chuỗi đích).
    entries = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base)
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
    return entries

actual_files = walk_entries(root)
actual_by_path = {f["path"]: f for f in actual_files}
manifest_files = manifest
manifest_by_path = {}
for entry in manifest_files:
    if not isinstance(entry, dict) or not all(k in entry for k in ("path", "size", "sha256")):
        problems.append(f"mục MANIFEST không đúng dạng {{path, size, sha256}}: {entry!r}")
        continue
    if entry["path"] in manifest_by_path:
        problems.append(f"path trùng lặp trong MANIFEST: {entry['path']}")
    manifest_by_path[entry["path"]] = entry

for path, entry in manifest_by_path.items():
    got = actual_by_path.get(path)
    if got is None:
        problems.append(f"file trong MANIFEST nhưng không có trên đĩa: {path}")
    elif got["size"] != entry["size"] or got["sha256"] != entry["sha256"]:
        problems.append(f"file lệch MANIFEST (size/sha256): {path}")
for path in actual_by_path:
    if path not in manifest_by_path:
        problems.append(f"file trên đĩa nhưng không có trong MANIFEST: {path}")

if len(actual_files) != len(manifest_files):
    problems.append(f"số mục trên đĩa={len(actual_files)} != MANIFEST={len(manifest_files)}")
actual_bytes = sum(f["size"] for f in actual_files)
manifest_bytes = sum(e["size"] for e in manifest_by_path.values())
if manifest_bytes != actual_bytes:
    problems.append(f"tổng byte (sum size) trên đĩa={actual_bytes} != MANIFEST={manifest_bytes}")

if problems:
    print(f"  LỆCH MANIFEST: {len(problems)} vấn đề (hiển thị tối đa 20):")
    for p in problems[:20]:
        print(f"    - {p}")
    sys.exit(1)

print(f"  OK: cây engine khớp MANIFEST — {len(actual_files)} mục, {actual_bytes} byte "
      f"(mảng trần luật W1; sha256 tái tính toàn bộ, symlink-tới-file tính theo chuỗi đích)")
PYEOF
if [ $? -ne 0 ]; then
  echo "FAIL TẦNG 1: cây engine không khớp ENGINE-MANIFEST.json / ENGINE-VERSION.json không hợp lệ."
  exit $EXIT_TIER1
fi
echo "PASS TẦNG 1"

# =============================================================================
# TẦNG 2 — BINARY: bun trong payload --version == 1.4.2
# =============================================================================
echo "-- TẦNG 2 (binary): '$BUN_BIN' --version phải đúng $EXPECTED_BUN_VERSION"
if [ ! -x "$BUN_BIN" ]; then
  echo "FAIL TẦNG 2: bun trong payload không thực thi được (thiếu bit +x?): $BUN_BIN"
  exit $EXIT_TIER2
fi
BUN_VERSION_OUT="$("$BUN_BIN" --version 2>&1 | head -n 1 | tr -d '[:space:]')"
if [ "$BUN_VERSION_OUT" != "$EXPECTED_BUN_VERSION" ]; then
  echo "FAIL TẦNG 2: bun --version = '$BUN_VERSION_OUT' (kỳ vọng '$EXPECTED_BUN_VERSION')"
  exit $EXIT_TIER2
fi
echo "  OK: bun --version = $BUN_VERSION_OUT"
echo "PASS TẦNG 2"

# =============================================================================
# TẦNG 3 — SPAWN THỬ: serve + poll /api/info (KHÔNG dùng /global/health)
# =============================================================================
echo "-- TẦNG 3 (spawn thử): bun serve, poll /api/info (timeout ${SPAWN_TIMEOUT_S}s)"
WORK_DIR="$(mktemp -d /tmp/engine-verify.XXXXXXXX)"
ENGINE_LOG="$WORK_DIR/engine.log"
TEST_PASSWORD="w4-verify-password-$$"
SERVER_PID=""

cleanup_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # SERVER_PID là PID của setsid → cũng là PGID của cây tiến trình con
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

# Chọn cổng trống
PORT="$(python3 - <<'PYEOF'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PYEOF
)"
echo "  cổng thử: $PORT; thư mục làm việc tạm: $WORK_DIR"

case "$SPAWN_CWD_MODE" in
  temp)        SPAWN_CWD="$WORK_DIR/cwd" ;;
  engine-root) SPAWN_CWD="$ENGINE_DIR" ;;
esac
mkdir -p "$SPAWN_CWD" "$WORK_DIR/home"
echo "  spawn cwd ($SPAWN_CWD_MODE): $SPAWN_CWD"

# F-W4-1 / phân xử N1 (W6): chế độ mặc định (temp) spawn ĐÚNG cách adapter
# production spawn bản bundled sau delta N1 của patch W3 — kèm
# `--preload <đường-tuyệt-đối-tính-từ-payload>` TRƯỚC entry. Chế độ chẩn
# đoán engine-root spawn TRƠN (không --preload) như hành vi cũ, để còn
# phân biệt được nguyên nhân khi debug (bunfig tại cwd gốc engine tự nạp
# được preload tương đối).
if [ "$SPAWN_CWD_MODE" = "temp" ]; then
  PRELOAD_ARGS=(--preload "$PRELOAD_FILE")
  echo "  spawn argv: bun --preload $PRELOAD_FILE <entry> serve (kiểu adapter production, N1)"
else
  PRELOAD_ARGS=()
  echo "  spawn argv: bun <entry> serve — TRƠN, không --preload (chế độ chẩn đoán engine-root)"
fi

(
  cd "$SPAWN_CWD" || exit 99
  HOME="$WORK_DIR/home" \
  XDG_DATA_HOME="$WORK_DIR/home/.local/share" \
  XDG_CONFIG_HOME="$WORK_DIR/home/.config" \
  XDG_CACHE_HOME="$WORK_DIR/home/.cache" \
  OPENCODE_PASSWORD="$TEST_PASSWORD" \
  setsid "$BUN_BIN" ${PRELOAD_ARGS[@]+"${PRELOAD_ARGS[@]}"} "$ENGINE_DIR/packages/cli/src/index.ts" serve \
    --port "$PORT" --hostname 127.0.0.1 >"$ENGINE_LOG" 2>&1 &
  echo $! >"$WORK_DIR/server.pid"
)
sleep 1
SERVER_PID="$(cat "$WORK_DIR/server.pid" 2>/dev/null || true)"
if [ -z "$SERVER_PID" ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "FAIL TẦNG 3: tiến trình engine chết ngay khi spawn. Log engine:"
  sed 's/^/    /' "$ENGINE_LOG" 2>/dev/null | head -n 50
  exit $EXIT_TIER3
fi
echo "  engine PID: $SERVER_PID"

HTTP_CODE="000"
ELAPSED=0
while [ "$ELAPSED" -lt "$SPAWN_TIMEOUT_S" ]; do
  HTTP_CODE="$(curl -s -o "$WORK_DIR/api-info.json" -w '%{http_code}' --max-time 3 \
    -u "opencode:$TEST_PASSWORD" "http://127.0.0.1:$PORT/api/info" 2>/dev/null || echo 000)"
  [ "$HTTP_CODE" = "200" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break  # engine chết giữa chừng → dừng chờ
  sleep 1; ELAPSED=$((ELAPSED + 1))
done

if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL TẦNG 3: GET /api/info không trả 200 sau ${ELAPSED}s (mã cuối: $HTTP_CODE). Log engine (50 dòng cuối):"
  tail -n 50 "$ENGINE_LOG" 2>/dev/null | sed 's/^/    /'
  exit $EXIT_TIER3
fi
echo "  OK: GET /api/info → 200 sau ~${ELAPSED}s; body: $(head -c 300 "$WORK_DIR/api-info.json")"

# Tắt sạch + kiểm không sót process
cleanup_server
trap - EXIT INT TERM
sleep 1
LEFTOVER="$(pgrep -f "packages/cli/src/index.ts serve --port $PORT" 2>/dev/null || true)"
if [ -n "$LEFTOVER" ]; then
  echo "FAIL TẦNG 3: còn sót tiến trình engine sau khi tắt: PID $LEFTOVER"
  exit $EXIT_TIER3
fi
echo "  OK: đã tắt engine, không sót tiến trình (pgrep theo entry+port: rỗng)"
echo "PASS TẦNG 3"
echo "== KẾT QUẢ: PASS cả 3 tầng (spawn-cwd mode: $SPAWN_CWD_MODE) =="
if [ "$SPAWN_CWD_MODE" != "temp" ]; then
  echo "LƯU Ý: PASS ở chế độ chẩn đoán --spawn-cwd $SPAWN_CWD_MODE, KHÔNG tương đương PASS spec (mặc định temp)."
fi
exit 0
