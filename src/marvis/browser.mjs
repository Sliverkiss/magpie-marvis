// 隔离浏览器登录 —— 自己起一个一次性 Chromium，用户在里面登录，从 CDP 抓回调 URL
//
// 为什么不用系统默认浏览器：QQ / 微信 的授权页对「刚打开的、没有历史的」窗口更宽容。
// 更重要的是**隔离**：一次性 user-data-dir，不碰用户日常浏览器的 Cookie / 扩展 / 同步，
// 登录态只在本次窗口里，关掉即销毁。
//
// ⚠ 伪装浏览器身份（防风控拦截）：
//   · `--disable-blink-features=AutomationControlled` —— 去掉 `navigator.webdriver`
//   · 不传 `--enable-automation` / `--headless` —— 有头窗口，且不带自动化提示条
//   · `Network.setUserAgentOverride` 换成 Marvis 客户端自己的 Electron UA，
//     并补齐 `Accept-Language` / client hints —— 官方请求就是这套身份
//   · 一次性 profile，每次都是「全新机器」，不会因为历史 Cookie 被判定异常
//
// 设计取舍来自 WPS 灵犀 0.4.11 的实测实现（MIT；见 NOTICE.md）：
//   · 任意 Chromium 内核浏览器都行（Chrome / Edge / 360 / QQ / Brave…），不止 Chrome；
//     国产浏览器在 Windows 上很常见，漏了它们这条登录路对用户就不存在。
//   · Windows 的候选顺序：Chrome → 国产 Chromium → Edge 最后（Edge 策略最多、最容易被组织禁用）。
//   · 退出码不可靠：浏览器可能把调试参数吞掉，所以以「CDP 端口能不能连上」为准。
//
// ═══ 回调怎么抓 ═════════════════════════════════════════════════════
// `marvis_oauth` 的成功形态是 **302 + Set-Cookie**，换取要求带**本机 guid**。
//   · 缺 guid → `-109 RC_PARAMS_INVALID`（实测；参数检查在 code 校验之前）；
//   · 带 guid 但 code 已被消费 → `-107 RC_NO_AUTH_ERR`。
//
// 所以在 **Request 阶段**就把回调停住：不让浏览器把 code 用掉，交给 Node 带 guid
// 换唯一那一次。这也是官方成功路径的等价实现。
//
// 正确做法（也是本模块唯一的正确路径）：
//   1. `Fetch.enable` + `{ urlPattern, requestStage: "Request" }` —— 请求**发出去之前**就停住；
//   2. 拿到暂停事件的 URL（里面带 `code=`），`Fetch.fulfillRequest` 喂一张静态完成页，
//      浏览器永远不发出这个请求，code 保持未使用；
//   3. 把 URL 交给调用方，由 Node **带 guid 换一次**。
//
// ⚠ 所有钩子（`Network.*` / `Page.addScriptToEvaluateOnNewDocument` / `Fetch.enable`）
//   必须在 `Page.navigate` **之前**装好；监听器同理 —— 装晚了首次请求就漏过去，
//   拦截永远不触发（先开 `about:blank` 就是为了这个）。
//
// ⚠ 本模块不依赖任何第三方包；Node 22+ 的全局 WebSocket 足够。
// ⚠ 只读页面 URL，不读 Cookie、不注入脚本；窗口关闭后临时 profile 会被删掉。

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { execFileSync } from "node:child_process"

const WIN_EXES = [
  "chrome.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "Brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
  "msedge.exe",
]

/**
 * 浏览器 UA —— **必须是 Marvis 客户端自己的 Electron UA**。
 *
 * 一开始我用普通 Chrome UA「伪装身份」，结果服务端一律 `-109 RC_PARAMS_INVALID`。
 * 客户端 BrowserWindow 的真实 UA 是带 `Marvis/<version>` 和 `Electron/<ver>` 的 ——
 * 服务端按它识别调用方，缺了就判参数无效。
 */
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Marvis/1.60.3300.408 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36"

/** 回调端点的路径片段 —— 「这是不是回调」的兜底判据（`match` 没命中时用） */
const CALLBACK_PATH = "marvis_client_login/marvis_oauth"

/** 默认拦截模式：CDP 的 `urlPattern`（`*` = 任意长度）。调用方可以另给 */
export const DEFAULT_CALLBACK_PATTERN = "*marvis_oauth*"

/**
 * 静态完成页 —— 回调被拦下后由 CDP 直接**合成**一个响应喂给浏览器。
 *
 * 为什么必须合成：不能 continue 让浏览器真发出去（见文件头）。页面只负责告诉用户
 * 「授权完成了」，真正的换取在 Node 里做。故意不含任何 JSON —— 正文不参与解析。
 */
export const COMPLETE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权完成</title>
<style>
  html,body{margin:0;height:100%;background:#f6f7f9;color:#1a1a1a;
    font:16px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{height:100%;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:36px 44px;
    box-shadow:0 12px 32px rgba(0,0,0,.06);text-align:center;max-width:420px}
  .tick{font-size:44px;line-height:1}
  h1{font-size:20px;margin:14px 0 8px;font-weight:600}
  p{margin:6px 0;color:#4b5563;font-size:14px}
  .muted{color:#9aa2ae;font-size:13px;margin-top:18px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="tick">✓</div>
      <h1>授权完成</h1>
      <p>已拿到授权码，正在换取登录态…</p>
      <p class="muted">这个窗口会自动关闭，请回到 magpie 查看结果。</p>
    </div>
  </div>
</body>
</html>`

/**
 * 这个 URL 是不是登录回调？
 *
 * 先按调用方给的判据（`match`）认；不中再按「路径 + 带 code」兜底 ——
 * 判据漏了只会让 code 被浏览器消费掉（之后 Node 再换会得到 `-107`），所以宁可多认一个。
 *
 * ⚠ 授权页自己的地址里也带 `marvis_oauth` 字样（`redirect_uri` 被百分号编码），
 *   所以**不能用「包含 marvis_oauth」当判据**，必须看未编码的路径片段。
 *
 * @param {string} url
 * @param {RegExp | null} matcher
 * @returns {boolean}
 */
export function isCallbackUrl(url, matcher) {
  const u = String(url ?? "")
  if (!u) return false
  if (matcher && matcher.test(u)) return true
  if (!u.includes(CALLBACK_PATH)) return false
  try {
    const params = new URL(u).searchParams
    return params.has("code") || params.has("error") || params.has("error_description")
  } catch {
    return false
  }
}

/** Windows 注册表 App Paths 查浏览器；查不到返回空串。 */
export function registryAppPath(exe) {
  if (process.platform !== "win32") return ""
  for (const root of ["HKCU", "HKLM"]) {
    for (const tail of [
      `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ]) {
      try {
        const out = execFileSync("reg", ["query", `${root}\\${tail}`, "/ve"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        })
        const line = out.split("\n").find((l) => /REG_SZ/i.test(l))
        const path = line?.split("REG_SZ")[1]?.trim()
        if (path && existsSync(path)) return path
      } catch {
        /* 没有这个键 */
      }
    }
  }
  return ""
}

/**
 * 候选浏览器（按优先级）。不做存在性检查，方便测试与排序。
 * @param {{platform?:string, env?:Record<string,string>, lookup?:(exe:string)=>string}} [o]
 * @returns {{name:string, path:string}[]}
 */
export function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath } = {}) {
  const h = env.HOME || env.USERPROFILE || ""
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || ""
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || ""
  const add = (list, name, path) => {
    if (path) list.push({ name, path })
  }

  if (platform === "win32") {
    const list = []
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      if (fromRegistry) add(list, exe.replace(/\.exe$/i, ""), fromRegistry)
    }
    add(list, "Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(local, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chromium", join(local, "Chromium", "Application", "chrome.exe"))
    add(list, "Chromium", join(pf, "Chromium", "Application", "chrome.exe"))
    add(list, "360极速浏览器X", join(local, "360ChromeX", "Chrome", "Application", "360ChromeX.exe"))
    add(list, "360浏览器", join(local, "360Chrome", "Chrome", "Application", "360chrome.exe"))
    add(list, "360安全浏览器", join(roaming, "secoresdk", "360se6", "Application", "360se.exe"))
    add(list, "QQ浏览器", join(local, "Tencent", "QQBrowser", "Application", "QQBrowser.exe"))
    add(list, "Brave", join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Brave", join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Vivaldi", join(local, "Vivaldi", "Application", "vivaldi.exe"))
    add(list, "Opera", join(local, "Programs", "Opera", "opera.exe"))
    add(list, "Opera", join(roaming, "Opera Software", "Opera Stable", "opera.exe"))
    add(list, "搜狗浏览器", join(local, "SogouExplorer", "SogouExplorer.exe"))
    add(list, "2345浏览器", join(local, "2345Explorer", "2345Explorer.exe"))
    add(list, "猎豹浏览器", join(local, "liebao", "liebao.exe"))
    add(list, "Maxthon", join(roaming, "Maxthon3", "Bin", "Maxthon.exe"))
    add(list, "UC浏览器", join(local, "UCBrowser", "Application", "UCBrowser.exe"))
    add(list, "夸克浏览器", join(local, "Quark", "Quark.exe"))
    add(list, "Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    add(list, "Edge", join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    return dedupe(list)
  }

  if (platform === "darwin") {
    return [
      ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ].map(([name, path]) => ({ name, path }))
  }

  return [
    ["Chrome", join(h, ".config/google-chrome/chrome")],
    ["Chromium", join(h, ".config/chromium/chrome")],
    ["Brave", join(h, ".config/BraveSoftware/Brave-Browser/brave")],
    ["Vivaldi", join(h, ".config/vivaldi/vivaldi")],
    ["Edge", join(h, ".config/microsoft-edge/msedge")],
  ].map(([name, path]) => ({ name, path }))
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    const key = x.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 缓存：注册表查询要跑十几次 `reg query`，不缓存会让 `authorize()` 慢到 1 秒以上 */
let browserCache = null
let browserCached = false

/**
 * 第一个真实存在的候选；没有返回 null。
 *
 * ⚠ 结果**进程内缓存**：`authorize()` 必须立刻返回（HOOKS 四·陷阱 1），
 *   而注册表查询是同步阻塞的 —— 每次登录都重查十几遍会让 UI 卡住。
 */
export function findBrowser({ platform = process.platform, env = process.env, exists = existsSync, lookup = registryAppPath } = {}) {
  if (browserCached) return browserCache
  browserCache = browserCandidates({ platform, env, lookup }).find((b) => exists(b.path)) ?? null
  browserCached = true
  return browserCache
}

/** 测试用：清掉浏览器缓存 */
export function resetBrowserCache() {
  browserCache = null
  browserCached = false
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 打开受控浏览器，在**请求阶段**拦下登录回调，返回那个回调地址。
 *
 * 返回值里的 `body` 恒为空串（除非走了兼容兜底）：回调请求根本没发出去，
 * 没有「回调页正文」这回事 —— 授权码只在 URL 里，换取由调用方自己做。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页
 * @param {RegExp} [o.match] 回调地址的判据（不中时按「路径 + 带 code」兜底）
 * @param {string} [o.pattern] `Fetch.enable` 的 urlPattern，默认 `*marvis_oauth*`
 * @param {Record<string,string>} [o.extraHeaders] 注入到**每个请求**的头（MarvisExt 等）
 * @param {number} [o.timeoutMs] 默认 5 分钟
 * @param {number} [o.settleMs] 拦下后让完成页画一会儿再关窗，默认 700ms
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{url:string, body:string, browser:string, intercepted:boolean}>}
 *   `intercepted: true` = 请求在发出前被拦下（code 还没被消费，正常路径）；
 *   `false` = 拦截没生效、浏览器自己把请求发了出去（code 多半已被消费）。
 */
export async function openIsolatedLogin({
  browser,
  url,
  match,
  pattern = DEFAULT_CALLBACK_PATTERN,
  extraHeaders,
  timeoutMs = 5 * 60_000,
  settleMs = 700,
  signal,
}) {
  if (!browser?.path) throw new Error("没有找到可用的 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 浏览器都行）")

  // 去掉 g/y 标志：带 lastIndex 的正则在循环里 `.test()` 会时真时假
  const matcher = match instanceof RegExp ? new RegExp(match.source, match.flags.replace(/[gy]/g, "")) : null

  const profile = mkdtempSync(join(tmpdir(), "magpie-marvis-login-"))
  const port = await freePort()
  const child = spawn(
    browser.path,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // 一次性全新 profile：没有历史 Cookie / 扩展 / 同步
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      // 去掉自动化痕迹。⚠ 不用 `--disable-blink-features=AutomationControlled` ——
      //   它会在地址栏下面挂一条「你使用的是不受支持的命令行标记」警告条，很扎眼。
      //   `navigator.webdriver` 改用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 抹掉。
      "--exclude-switches=enable-automation",
      `--user-agent=${CHROME_UA}`,
      "--lang=zh-CN",
      // ⚠ 必须先开 about:blank：钩子（Fetch.enable / setExtraHTTPHeaders）要在
      //   导航**之前**装好，否则首次请求漏过去，拦截永远不触发。
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: false },
  )

  const cleanup = () => {
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响主流程 */
    }
  }

  const deadline = Date.now() + timeoutMs
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    let pageWs = ""
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
        pageWs = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
        if (pageWs) break
      } catch {
        /* 浏览器还没起好 */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!pageWs) {
      throw new Error(
        "受控浏览器没有打开调试端口（可能是浏览器吞掉了 --remote-debugging-port，或安全软件拦截）。" +
          "请换一个 Chromium 内核浏览器，或改用「从本机 Marvis 导入」。",
      )
    }

    const ws = new WebSocket(pageWs)
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
    })

    // ── CDP 收发：一个监听器收全部「事件 + 命令回包」────────────────────
    // ⚠ 这个监听器必须在 Page.navigate **之前**挂上：建立拦截全在事件里。
    let nextId = 0
    const pending = new Map()

    /** 发一条 CDP 命令并等结果（带超时，避免连接断了把整条流程吊死） */
    const send = (method, params = {}, cmdTimeout = 10_000) =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时`))
        }, cmdTimeout)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        try {
          ws.send(JSON.stringify({ id, method, params }))
        } catch (err) {
          clearTimeout(timer)
          pending.delete(id)
          reject(err)
        }
      })

    /** @type {{url:string, via:"fetch"|"network", resourceType:string} | null} */
    let hit = null
    /** Fetch 域是否装上 —— 没装上就只能走 responseReceived 兼容路径 */
    let fetchArmed = false
    /** 兼容路径下要读正文的 requestId */
    let fallbackRequestId = ""

    /**
     * 用静态完成页满足被暂停的请求。
     * 注意 `body` 必须 base64 —— CDP 的 `Fetch.fulfillRequest` 只收这个形状。
     */
    const fulfill = (requestId) =>
      send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responsePhrase: "OK",
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: Buffer.from(COMPLETE_PAGE, "utf8").toString("base64"),
      })

    const onMessage = (event) => {
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }

      // 命令回包
      if (msg.id !== undefined) {
        const waiting = pending.get(msg.id)
        if (!waiting) return
        pending.delete(msg.id)
        clearTimeout(waiting.timer)
        if (msg.error) waiting.reject(new Error(msg.error.message || "CDP error"))
        else waiting.resolve(msg.result)
        return
      }

      // ① 主路径：请求**发出去之前**被拦下
      if (msg.method === "Fetch.requestPaused") {
        const params = msg.params ?? {}
        const requestId = String(params.requestId ?? "")
        const u = String(params.request?.url ?? "")
        if (!requestId) return
        if (!isCallbackUrl(u, matcher)) {
          // 不是回调（授权页地址里也带 marvis_oauth 字样，但路径是编码过的）—— 放行
          send("Fetch.continueRequest", { requestId }).catch(() => {})
          return
        }
        // ⚠ 命中后**绝不** continueRequest：请求一旦发出去，服务端就把 code 消费了
        if (hit) {
          // 同一个回调被拦第二次（重载 / self_redirect）：同样喂静态页，但只认第一个
          fulfill(requestId).catch(() => {})
          return
        }
        fulfill(requestId)
          .catch(() => {})
          .finally(() => {
            hit ??= { url: u, via: "fetch", resourceType: String(params.resourceType ?? "") }
          })
        return
      }

      // ② 兼容路径：Fetch 没装上时，只能看响应（此时 code 多半已被消费）
      if (msg.method === "Network.responseReceived" && !hit) {
        const params = msg.params ?? {}
        // ⚠ 资源类型在 `msg.params.type`，**不在** `response.type` —— `response` 上没有这个字段
        const kind = String(params.type ?? "")
        const u = String(params.response?.url ?? "")
        if (u && isCallbackUrl(u, matcher) && (kind === "Document" || kind === "Fetch" || kind === "XHR")) {
          fallbackRequestId = String(params.requestId ?? "")
          hit = { url: u, via: "network", resourceType: kind }
        }
      }
    }

    const failPending = () => {
      for (const [id, waiting] of pending) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error("CDP 连接已关闭"))
        pending.delete(id)
      }
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", failPending)

    try {
      // ── 钩子：全部在 Page.navigate 之前 ─────────────────────────────
      // 补齐 client hints —— 只改 UA 不改 sec-ch-ua 会被指纹比对出来
      await send("Network.enable").catch(() => {})
      await send("Network.setUserAgentOverride", {
        userAgent: CHROME_UA,
        acceptLanguage: "zh-CN,zh;q=0.9",
        platform: "Win32",
      }).catch(() => {})
      // ⚠⚠ 服务端对 `yybadaccess.3g.qq.com` 的**每个**请求都校验
      //   `Ual-Access-MarvisExt`（uskey 设备指纹）。没有它就返回
      //   「请使用 Marvis 客户端」—— 这正是浏览器登录一直失败的原因。
      //   Marvis 的 BrowserWindow 用 `session.webRequest.onBeforeSendHeaders` 注入，
      //   这里用 CDP 的 `Network.setExtraHTTPHeaders` 达到同样效果。
      if (extraHeaders && Object.keys(extraHeaders).length > 0) {
        await send("Network.setExtraHTTPHeaders", { headers: extraHeaders }).catch(() => {})
      }
      // 顺手抹掉 navigator.webdriver（比 --disable-blink-features 更干净，不带警告条）
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})",
      }).catch(() => {})

      // ⚠⚠ 核心：在 **Request 阶段**拦下回调。请求不会被发出去，
      //   code 因此保持未使用 —— 由 Node 带 guid 换**唯一那一次**（见文件头）。
      fetchArmed = await send("Fetch.enable", {
        patterns: [{ urlPattern: pattern, requestStage: "Request" }],
      })
        .then(() => true)
        .catch(() => false)

      // 钩子装完才导航
      await send("Page.navigate", { url }).catch(() => {})

      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("登录已取消")

        if (hit) {
          let body = ""
          if (hit.via === "network" && fallbackRequestId) {
            // 兼容路径：浏览器自己发了请求，正文可能还没落盘；302 的话本来就是空的
            for (let i = 0; i < 10 && !body; i++) {
              try {
                const r = await send("Network.getResponseBody", { requestId: fallbackRequestId }, 5000)
                const raw = String(r?.body ?? "")
                body = r?.base64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw
              } catch {
                /* body 还没就绪 */
              }
              if (!body) await sleep(200)
            }
          }
          // 让合成的完成页有机会画出来，再把一次性窗口关掉
          if (settleMs > 0) await sleep(settleMs)
          return {
            url: hit.url,
            body,
            browser: browser.name,
            intercepted: hit.via === "fetch",
          }
        }

        await sleep(120)
      }

      throw new Error(
        `等了 ${Math.round(timeoutMs / 1000)} 秒还没完成扫码授权。` +
          (fetchArmed
            ? ""
            : "（提示：这个浏览器不接受 CDP 请求拦截，换一个 Chromium 内核浏览器再试）") +
          "可以重新点一次登录，或改用「从本机 Marvis 导入」。",
      )
    } finally {
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", failPending)
      failPending()
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
    }
  } finally {
    cleanup()
  }
}

export const _internal = {
  WIN_EXES,
  CHROME_UA,
  CALLBACK_PATH,
  COMPLETE_PAGE,
  isCallbackUrl,
  freePort,
  dedupe,
  resetBrowserCache,
}
