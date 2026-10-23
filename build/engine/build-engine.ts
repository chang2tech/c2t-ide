#!/usr/bin/env bun
/**
 * build-engine.ts — CB-3 (lane BUILD-QA-B, gói cổng alpha.40 đường (B) COMPILE).
 *
 * Script build engine DẠNG BINARY (Bun.build compile) dùng trong CI — bản
 * standalone hoá của pipeline compile SẴN CÓ của fork
 * (`packages/cli/script/build.ts`), theo đúng bản POC đã PASS:
 * `poc-compile/build-poc.ts` (linux, POC-1) + `poc-compile/win32/build-poc-win32.ts`
 * (win32, CB-1). Gộp 2 bản POC thành 1 script tham số hoá `--target`.
 *
 * VỊ TRÍ TRONG CI (chốt thiết kế, xem w3-stage-binary.md §2.3):
 *   - Bản canonical sống trong repo c2t-ide tại `build/engine/build-engine.ts`
 *     (parent áp từ compile-ci/build-engine.ts).
 *   - Workflow KHÔNG sửa repo engine: bước Stage engine gọi
 *     `build/engine/stage-engine-binary.sh`, script này CHÉP build-engine.ts
 *     vào cây engine checkout tại `packages/cli/script/build-engine.ts`
 *     (file MỚI trong checkout thải hồi của CI) rồi chạy nó từ đó — vì script
 *     resolve `../package.json`, `./opencode-pty`, `../src/app-archive`,
 *     `@opencode/plugin/runtime-modules` theo vị trí packages/cli/script/.
 *   - `buildScriptSha` trong ENGINE-MANIFEST.json = sha256 của ĐÚNG file này.
 *
 * Khác biệt CÓ CHỦ ĐÍCH so với `script/build.ts` của fork (kế thừa POC-1 §5):
 *  1. Standalone: KHÔNG import `@opencode/script` (devDependency của cli,
 *     VẮNG trong cây production-pruned kiểu w28 — finding S1, POC-1 §1.1).
 *     Version lấy từ `../package.json`; channel mặc định "poc-compile"
 *     (khác "local" để `src/app-assets.ts` trả archive rỗng thay vì đòi
 *     `packages/app/dist`; ĐỔI channel = đổi byte binary — xem hồ sơ §5.2).
 *  2. Web UI: đường `--skip-web-ui` của fork — archive rỗng
 *     (`AppArchive.encode([])`) ghi ra BUILD_ENGINE_OUT/.cache.
 *  3. `allowUnresolved` = danh sách R5 đã bóc tách của POC-1 (nhúng sẵn dưới
 *     đây, nguyên văn `poc-compile/allow-r5.txt`), KHÔNG phải mặc định ["*"]
 *     cho-qua-lặng của fork. `--allow=<file>` nạp thêm nếu cần debug.
 *  4. Entrypoints = [./src/index.ts, node_modules/@opentui/core/parser.worker.js]
 *     NHƯ BẢN POC ĐÃ PASS POC-2R (serve/chat/tool/streaming). Fork không liệt
 *     kê entrypoint worker (+184.320 byte, POC-1 §7) — bỏ nó là quyết định
 *     RIÊNG cần tái kiểm chứng, không gộp vào cổng alpha.40.
 *  5. Bỏ simulation-graph verify + NativeArch.verify của fork (hậu kiểm,
 *     không ảnh hưởng graph); giữ 5 plugin: app-assets, solid,
 *     parcel-watcher, opencode-pty, plugin-runtime.
 *  6. Target: chỉ linux-x64 + win32-x64 (nhu cầu alpha). Per-target bám
 *     build.ts của fork: win32 KHÔNG define OPENCODE_LIBC/FFF_LIBC/
 *     process.env.OPENTUI_LIBC; parcel-watcher codegen không hậu tố libc
 *     cho win32; opencode-pty trả undefined cho win32 theo thiết kế fork.
 *
 * Chạy (từ packages/cli của cây engine, bằng bun pin 1.4.2):
 *   BUILD_ENGINE_OUT=<out> bun run script/build-engine.ts --target=linux-x64 --mode=compile
 *   BUILD_ENGINE_OUT=<out> bun run script/build-engine.ts --target=win32-x64 --mode=compile
 * Mã thoát: 0 = build success; 3 = build fail.
 */

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { BunPlugin } from "bun"
import pkg from "../package.json"
import { AppArchive } from "../src/app-archive"
import { discoverPluginRuntimeSpecifiers, pluginRuntimeLoaderCode } from "@opencode/plugin/runtime-modules"
import { resolveOpencodePty } from "./opencode-pty"

const dir = path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "compile"
if (mode !== "bundle" && mode !== "compile") throw new Error(`--mode phải là bundle|compile, nhận: ${mode}`)
const target = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ?? ""
if (target !== "linux-x64" && target !== "win32-x64")
  throw new Error(`--target phải là linux-x64|win32-x64, nhận: ${target || "<trống>"}`)
const channel =
  process.argv.find((arg) => arg.startsWith("--channel="))?.slice("--channel=".length) ?? "poc-compile"
const allowFile = process.argv.find((arg) => arg.startsWith("--allow="))?.slice("--allow=".length)
const buildOut = process.env.BUILD_ENGINE_OUT
  ? path.resolve(process.env.BUILD_ENGINE_OUT)
  : process.env.POC_OUT
    ? path.resolve(process.env.POC_OUT)
    : path.resolve(import.meta.dirname, "../../../../out")

const isWin = target === "win32-x64"
const outBinName = isWin ? "opencode.exe" : "opencode"
const compileTarget = isWin ? "bun-windows-x64" : "bun-linux-x64"
const watcherPackage = isWin ? "@parcel/watcher-win32-x64" : "@parcel/watcher-linux-x64-glibc"

// Allowlist R5 của POC-1 (poc-compile/allow-r5.txt) — nguyên văn, đã qua
// 5 lượt bóc tách reject-unresolved (POC-1 §6). `<empty>` = specifier opaque.
const ALLOW_R5 = [
  "<empty>",
  "../rust-pty/target/release/*",
  "@ff-labs/fff-bin-darwin-*/libfff_c.dylib",
  "@ff-labs/fff-bin-win32-*/fff_c.dll",
  "@ff-labs/fff-bin-linux-*-",
  "@ff-labs/fff-bin-linux-*-*/libfff_c.so",
]
const extraAllow: string[] = [
  ...ALLOW_R5,
  ...(allowFile
    ? (await Bun.file(path.resolve(allowFile)).text())
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : []),
].map((line) => (line === "<empty>" ? "" : line))

const VERSION = pkg.version // "2.0.32" tại ENGINE_REF 95381c4a…

// --- Web UI archive rỗng (đường --skip-web-ui của fork) ---
const cacheDir = path.join(buildOut, ".cache")
await mkdir(cacheDir, { recursive: true })
const appArchive = path.join(cacheDir, "bun-app-archive.bin")
await Bun.write(appArchive, AppArchive.encode([]))

const appAssetsPlugin: BunPlugin = {
  name: "opencode-app-assets",
  setup(build) {
    build.onResolve({ filter: /^virtual:opencode-app-assets$/ }, () => ({
      path: "opencode-app-assets",
      namespace: "opencode",
    }))
    build.onLoad({ filter: /^opencode-app-assets$/, namespace: "opencode" }, () => ({
      loader: "js",
      contents: `import { readFileSync } from "node:fs"
import archive from ${JSON.stringify(appArchive.replaceAll("\\", "/"))} with { type: "file" }
export default () => readFileSync(archive)`,
    }))
  },
}

// --- Plugin runtime: static registry như fork (codegen lúc build) ---
let pluginRuntimeCount = -1
let pluginRuntimeError = ""
let pluginRuntimeEntries: ReadonlyMap<string, string> = new Map()
try {
  pluginRuntimeEntries = discoverPluginRuntimeSpecifiers()
  pluginRuntimeCount = pluginRuntimeEntries.size
} catch (error) {
  pluginRuntimeError = error instanceof Error ? error.message : String(error)
}
const pluginRuntimeModulesSource = [
  "export const resolveHostPackageRoots = () => []",
  "const modules = {",
  ...[...pluginRuntimeEntries.keys()].map(
    (specifier) => `  ${JSON.stringify(specifier)}: ${pluginRuntimeLoaderCode(specifier, pluginRuntimeEntries)},`,
  ),
  "}",
  "export const loadRuntimeModules = () => modules",
].join("\n")
const pluginRuntimePlugin: BunPlugin = {
  name: "opencode-plugin-runtime",
  setup(build) {
    build.onLoad({ filter: /plugin[/\\]src[/\\]runtime-modules\.ts$/ }, () => ({
      contents: pluginRuntimeModulesSource,
      loader: "ts",
    }))
    // LƯU Ý byte-exact (bài học CB-3 rehearsal r1): đuôi filter này là
    // backslash + ".js" (MỘT backslash). Gõ thừa thành hai backslash thì
    // stub không bao giờ khớp, Scalar/Swagger THẬT (~5,2 MB) bị bundle vào
    // và binary phình +15.138.816 byte so với bản POC đã PASS.
    build.onLoad({ filter: /[/\\]internal[/\\]httpApi(?:Scalar|Swagger)\.js$/ }, () => ({
      contents:
        'export const css = ""; export const javascript = \'document.body.textContent = "Scalar/Swagger UI assets are not bundled in OpenCode"\'',
      loader: "js",
    }))
  },
}

// --- @parcel/watcher: binding theo target (fork sinh theo từng target) ---
const parcelWatcherPlugin: BunPlugin = {
  name: "parcel-watcher-binding",
  setup(build) {
    build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
      contents: `export default () => require(${JSON.stringify(watcherPackage)})`,
      loader: "js",
    }))
  },
}

// --- opencode-pty: nhúng binary helper dạng file như fork (win32: undefined) ---
const ptyTarget = isWin
  ? { platform: "win32", arch: "x64" }
  : { platform: "linux", arch: "x64", libc: "glibc" as const }
let ptyNote = "not-resolved"
try {
  const probe = await resolveOpencodePty(ptyTarget)
  ptyNote = probe ? `${probe.source} sha256=${probe.sha256}` : "undefined-for-target"
} catch (error) {
  ptyNote = `error: ${error instanceof Error ? error.message : String(error)}`
}
const opencodePty = await resolveOpencodePty(ptyTarget).catch(() => undefined)
const opencodePtyPlugin: BunPlugin = {
  name: "opencode-pty-binary",
  setup(build) {
    build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
      loader: "js",
      contents: opencodePty
        ? `import file from ${JSON.stringify(opencodePty.source)} with { type: "file" }
export default { path: file, version: ${JSON.stringify(opencodePty.version)}, sha256: ${JSON.stringify(opencodePty.sha256)} }`
        : "export default undefined",
    }))
  },
}

const solidPlugin = createSolidTransformPlugin()
const workerEntrypoint = path.join(dir, "node_modules/@opentui/core/parser.worker.js")
const entrypoints = ["./src/index.ts", workerEntrypoint]

console.log(
  JSON.stringify(
    {
      build: "CB-3 build-engine (standalone hoá build.ts của fork, theo POC-1/CB-1)",
      mode,
      target,
      channel,
      entrypoints,
      allowUnresolved: extraAllow,
      pluginRuntimeSpecifiers: pluginRuntimeCount,
      pluginRuntimeError: pluginRuntimeError || undefined,
      opencodePty: ptyNote,
      buildOut,
      cliDir: dir,
    },
    null,
    2,
  ),
)

const result = await Bun.build({
  entrypoints,
  tsconfig: "./tsconfig.json",
  plugins: [appAssetsPlugin, solidPlugin, parcelWatcherPlugin, opencodePtyPlugin, pluginRuntimePlugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  splitting: true,
  sourcemap: "none",
  allowUnresolved: extraAllow,
  define: {
    OPENCODE_VERSION: `'${VERSION}'`,
    OPENCODE_CLI_NAME: "'opencode'",
    OPENCODE_CHANNEL: `'${channel}'`,
    OPENCODE_ARTIFACT: "'cli'",
    ...(isWin
      ? {
          // Fork cho win32: 2 define này = undefined, KHÔNG đặt OPENTUI_LIBC.
          OPENCODE_LIBC: "undefined",
          FFF_LIBC: "undefined",
        }
      : {
          OPENCODE_LIBC: "'glibc'",
          FFF_LIBC: "'gnu'",
          "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
        }),
  },
  ...(mode === "bundle"
    ? { outdir: path.join(buildOut, "bundle"), target: "bun" as const }
    : {
        bytecode: true,
        compile: {
          autoloadBunfig: false,
          autoloadDotenv: false,
          autoloadTsconfig: true,
          autoloadPackageJson: true,
          target: compileTarget as "bun-linux-x64" | "bun-windows-x64",
          outfile: path.join(buildOut, "compile", outBinName),
          execArgv: ["--smol", `--user-agent=opencode/${channel}/${VERSION}/cli`, "--use-system-ca", "--no-warnings", "--"],
          windows: {},
        },
      }),
})

console.log(`BUILD_SUCCESS=${result.success}`)
for (const log of result.logs) {
  const position = (log as { position?: { file?: string; line?: number; column?: number } }).position
  console.log(
    `LOG ${log.level}: ${log.message}${position?.file ? ` @ ${position.file}:${position.line}:${position.column}` : ""}`,
  )
}
for (const output of result.outputs) {
  console.log(`OUTPUT ${output.kind} ${output.path} ${output.size} byte`)
}
process.exit(result.success ? 0 : 3)
