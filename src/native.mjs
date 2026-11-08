// Beacon SDK 封装 —— uskey 的本地签发（**best-effort**）
//
// ⚠ 这一层曾经是整个插件的**硬门槛**：模型网关要请求头 `Ual-Access-MarvisExt`
//   里带一个 uskey，而 uskey 由 Beacon SDK 本地生成。拿不到就 503 ——
//   这是 0.2.16 以前**所有非 Windows 机器**（macOS / Linux）的 503 根因。
//
// ═══ 为什么现在不再硬依赖 ═══════════════════════════════════════════
//   `native/` 里的 4 个文件是 **Windows PE**（`beacon_napi.node` 是 PE32+ dll，
//   靠同目录的 `qimei.dll` / `beacon_sdk.dll` / `beacon_wrapper.dll` 动态加载）。
//   在 macOS 上 `dlopen` 报 `slice is not valid mach-o file`，M 系列 arm64 更是
//   架构都不对。于是 `newUskey()` 抛错 → `marvisExt()` 抛错 → loader 回 503，
//   **一个能用的账号在能用的系统上永远连不上上游**。
//
//   实测（macOS arm64，2026-11-08）：`uskey: ""` 的请求 **200 且正常出内容**，
//   非流式 / 流式 / 8 个模型槽位 / 带 tools 全部通过。uskey 不是准入条件，
//   至少对 `/v1/chat/completions` 不是。
//
//   所以这里改成：**能签就签，签不出来就发空串**，绝不因为平台不对就打死账号。
//   如果上游某天真的开始要 uskey，风控错误（4100404）会照原样透出来，
//   `beaconStatus()` 会告诉用户是哪一侧的问题。
//
// ⚠ 为什么必须 vendor 二进制（Windows 上仍然走这条路）：`beacon_napi.node` 的
//   PE 导入表里**看不到**它依赖谁 —— 它运行时按**自己所在目录**去 LoadLibrary
//   兄弟 DLL。少一个（尤其 `qimei.dll`）不报错，只是 `getQimei()` / `getUskey()`
//   静默返回 null。这就是为什么「只复制 .node 文件」在别的机器上必然失败。
//
// ⚠ 同一个 uskey 只能成功 **2 次**，第 3 次起 403（等 75 秒仍 403 = 配额不是频率）。
//   所以每次请求都必须现签一个，不能缓存。

import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件根目录下的 native/ —— 4 个文件一起才工作 */
export const NATIVE_DIR = join(HERE, "..", "native")

/** 缺哪个文件就报哪个，别让用户猜 */
const REQUIRED = ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]

/** 上游 appKey —— 来自 Marvis 的 resources/.env 的 MARVIS_QIMEI_APPKEY */
const APP_KEY = "0WIN06Y06DKV1IUQ"
const APP_VERSION = "1.60.3300.408"

/**
 * 这个平台的 Beacon SDK 能不能用。
 *
 * `vendor` 是**打包进来的二进制**的目标平台。`native/` 里只有 Windows 版，
 * 所以在别的系统上不是「文件缺了」而是「本来就没打算跑」—— 两种要分开报，
 * 否则用户会去重装插件，而重装解决不了。
 *
 * @typedef {"windows" | "unsupported-platform" | "missing-files" | "init-failed" | "ready"} BeaconState
 */

/** @type {{ init: Function, getUskey: Function, getQimei: Function } | null} */
let beacon = null
/** @type {{ state: BeaconState, reason: string } | null} */
let probe = null

/** 打包的二进制只支持 Windows —— 靠扩展名和平台双重判断 */
function platformVerdict() {
  if (process.platform === "win32") return null
  return {
    state: /** @type {BeaconState} */ ("unsupported-platform"),
    reason:
      `native/ 里只有 Windows 版 Beacon SDK（.node + .dll），当前是 ${process.platform}/${process.arch}。` +
      `插件会自动降级成「每请求随机 uskey」，模型请求照常可用（实测上游照样 200）。`,
  }
}

/**
 * 加载并初始化 Beacon SDK。**只做一次**，重复调用返回同一个结果。
 *
 * ⚠ 不再抛错 —— 失败也要能问「为什么失败」。
 *
 * @returns {{ ok: true, beacon: any } | { ok: false, state: BeaconState, reason: string }}
 */
export function loadBeacon() {
  if (beacon) return { ok: true, beacon }
  if (probe) return { ok: false, ...probe }

  const wrongPlatform = platformVerdict()
  if (wrongPlatform) {
    probe = wrongPlatform
    return { ok: false, ...probe }
  }

  const missing = REQUIRED.filter((f) => !existsSync(join(NATIVE_DIR, f)))
  if (missing.length) {
    probe = {
      state: "missing-files",
      reason:
        `native/ 目录缺少 ${missing.join("、")}。` +
        `这 4 个文件必须一起打包（beacon_napi.node 靠同目录的 DLL 动态加载，缺一个就静默返回 null）`,
    }
    return { ok: false, ...probe }
  }

  try {
    const mod = require(join(NATIVE_DIR, "beacon_napi.node"))
    // init 返回 0 = 成功。返回非 0 时 getUskey 也会给 null，所以这里就拦住。
    const rc = mod.init({ appKey: APP_KEY, appVersion: APP_VERSION })
    if (rc !== 0) throw new Error(`beacon init 返回 ${rc}`)
    beacon = mod
    probe = { state: "ready", reason: "" }
    return { ok: true, beacon }
  } catch (err) {
    probe = {
      state: "init-failed",
      reason: `Beacon SDK 加载失败：${/** @type {any} */ (err)?.message ?? err}`,
    }
    return { ok: false, ...probe }
  }
}

/**
 * 诊断用：当前 uskey 能力。
 *
 * @returns {{ state: BeaconState, ok: boolean, reason: string, platform: string }}
 */
export function beaconStatus() {
  const r = loadBeacon()
  return {
    state: r.ok ? "ready" : r.state,
    ok: r.ok,
    reason: r.ok ? "" : r.reason,
    platform: `${process.platform}/${process.arch}`,
  }
}

/**
 * 现签一个 uskey。**每次请求都要调**（同一 uskey 只给 2 次）。
 *
 * ⚠ **不抛错**。签不出来返回**随机值**，不是空串：
 *   风控配额按 uskey **值**记账 —— 空串是全机共享同一个桶，
 *   2 次之后**永久** 403 风控（实测 5 分钟内不恢复，等 75 秒也没用）；
 *   而每次现造一个随机值 = 每次一个新桶，macOS / Linux 上与官方客户端
 *   「每请求现签」行为等价（实测连续 5 发全 200）。
 *   服务端只要求非空且 ≥2 字符、ASCII（非 ASCII 连 HTTP 头都发不出去）。
 *
 * @param {string} [businessId] 业务 id，模型网关固定 `marvis_client`
 * @returns {string} uskey；本机签不出时是 32 位随机 hex
 */
export function newUskey(businessId = "marvis_client") {
  const r = loadBeacon()
  if (!r.ok) return randomBytes(16).toString("hex")
  try {
    const uskey = String(r.beacon.getUskey(businessId, { reqScene: 1, taskType: "user" }) ?? "")
    return uskey === "null" ? randomBytes(16).toString("hex") : uskey
  } catch {
    return randomBytes(16).toString("hex")
  }
}

/**
 * 设备 qimei36。MarvisExt 里要用。
 * @returns {string} 取不到时返回空串（服务端接受空串，不会因此 403）
 */
export function qimei36() {
  const r = loadBeacon()
  if (!r.ok) return ""
  try {
    return String(r.beacon.getQimei() ?? "")
  } catch {
    return ""
  }
}

/** 拿不到 uskey 时给用户看的说明（登录页 / 错误提示用） */
export function nativeHint() {
  const s = beaconStatus()
  return s.ok ? "" : s.reason
}
