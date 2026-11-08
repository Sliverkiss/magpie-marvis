// ② auth.methods —— 两条登录路
//
//   A. QQ / 微信 授权：自己起一个**隔离浏览器**（一次性 profile、伪装客户端 UA、
//      抹掉 navigator.webdriver），用户在窗口里授权，插件在 CDP 的**请求阶段**拦下回调，
//      再带本机 guid 把 code 换一次。
//      → `{ url, opened: true, method: "auto", callback }`
//        `opened: true` 让 magpie **不要**再开系统默认浏览器（否则弹两个窗口）。
//
//   B. 从本机 Marvis 导入：装了客户端且登录过的人，直接读进程内存里的登录态。
//      → 同样 `opened: true` + `method: "auto"`，整个登录就是「点一下 → 读内存 → 成功」。
//
// ⚠ `authorize()` 必须**立刻**返回 —— 真正等用户的是 `callback()`。
//   在这里 await 登录会和 magpie 双向死锁（HOOKS §四·陷阱1）。
//   `findBrowser()` 要查十几次注册表（实测 1.4 秒），必须放在 callback 里。
//
// ⚠⚠ `-109 RC_PARAMS_INVALID` 的根因（已修）：`marvis_oauth` 是**参数检查**失败，
//   最常见的是**缺设备 guid**。实测：缺 guid → 恒定 -109；带 `Ual-Access-Guid`
//   （或 `.qq.com` 的 `guid` cookie）后，假 code / 已消费 code 变成 `-107 RC_NO_AUTH_ERR`。
//   官方成功路径是「回调 → 302 + Set-Cookie 写入登录态」，不是 JSON 响应体。
//
//   所以现在：`browser.mjs` 用 CDP `Fetch.requestPaused` 在 **Request 阶段**拦下回调
//   （请求不出网，code 保持未使用），再 `Fetch.fulfillRequest` 一张静态完成页，
//   把回调地址交回来；这里只调 `parseCallback(callbackUrl, body, { loginType, guid })`，
//   由 Node 带 guid 换**唯一那一次**。`body` 恒为空 —— 没有「回调页正文」这回事。

import { PROVIDER, LOGIN_TYPE } from "../context.mjs"
import { authorizeUrl, parseCallback, deviceGuid } from "../marvis/login.mjs"
import { createDeviceRegistry, newDeviceGuid, stateOfUrl } from "../marvis/device.mjs"
import { openIsolatedLogin, findBrowser } from "../marvis/browser.mjs"
import { resolveAccount } from "../account-name.mjs"
import { importFromDesktop, desktopAvailable } from "../marvis/desktop.mjs"
import { fetchUserProfile, accountLabel } from "../marvis/profile.mjs"

/**
 * 登录过程中的 state → 虚拟设备 guid。
 *
 * ⚠ 不能用一个模块级 `currentGuid`：宿主在同一进程里同时服务多个账号，
 *   两个登录窗口并行时就会串号。按 OAuth state 分开存，天然隔离。
 */
const pendingDevices = createDeviceRegistry()

/** 回调地址判据：跳到 marvis_oauth 且带 code= */
const CALLBACK = /marvis_client_login\/marvis_oauth\?[^#]*\bcode=/i

/**
 * CDP `Fetch.enable` 的拦截模式（`*` = 任意长度）。
 * ⚠ 故意放松到「路径里含 marvis_oauth」：判据漏一个只会让 code 被浏览器消费（之后换成 `-107`），
 *   而授权页自己的地址里虽然也带这个字样，路径却是百分号编码的 —— 由 `isCallbackUrl` 再筛一次。
 */
const CALLBACK_PATTERN = "*marvis_oauth*"

/** `-109` 的可执行提示：参数检查没通过，最常见是缺 guid */
const PARAM_HINT =
  "  [提示] 服务端参数检查未通过（最常见是缺设备 guid）。这不是 code 过期，" +
  "请把这条提示反馈给插件作者；也可以改用「从本机 Marvis 导入」——装了客户端并在里面登录过就能一键导入。"

/** 拦截没生效（浏览器自己把回调请求发了出去）时的追加提示 */
const NOT_INTERCEPTED_HINT =
  "（本次未能在请求发出前拦下回调，code 很可能已被浏览器消费 —— 换个 Chromium 内核浏览器再试）"

/**
 * 登录成功时给宿主的字段。
 * `accountId` 是**名字**（卡片上显示），`uid` 是身份（HOOKS §八）。
 * ⚠ `refresh` 必须有 —— 缺了它 magpie 不会把账号写进 plugin-auth.json，
 *   表现是「登录显示成功，但界面说无法列出账号」。
 */
export function authOf(acct) {  const { accountId, uid } = resolveAccount({
    name: acct.nickname ?? "",
    phone: "",
    urn: acct.openid,
  })
  // 卡片名带登录方式：QQ·昵称 / 微信·昵称
  const label = accountLabel(acct.nickname, acct.loginType) || accountId
  return {
    type: "success",
    access: acct.accessToken,
    // token 30 天有效，refresh 会成对轮换 —— 这里存自己，refresh 钩子负责换新
    refresh: acct.refreshToken ?? acct.accessToken,
    expires: acct.expiresAt ?? 0,
    ...(label ? { accountId: label } : {}),
    ...(uid ? { uid } : {}),
    // 落盘的额外字段：模型请求随时要用
    metadata: {
      openid: acct.openid,
      guid: acct.guid ?? deviceGuid(),
      loginType: acct.loginType ?? "1",
      nickname: acct.nickname ?? "",
    },
  }
}

/**
 * 补昵称/头像：拿不到就用原值，**绝不阻塞登录**。
 * QQ 号拿不到（Marvis 只给 openid），这里只取 `nick_name`。
 *
 * @param {any} acct
 * @param {"QC" | "WX"} loginType
 */
async function withProfile(acct, loginType) {
  try {
    const profile = await fetchUserProfile(acct, { loginType })
    if (!profile) return acct
    return {
      ...acct,
      nickname: profile.nickname || acct.nickname,
      avatar: profile.avatar || acct.avatar,
    }
  } catch {
    return acct
  }
}

/** 授权页登录（QQ / 微信），走隔离浏览器 */
function oauthLogin(loginType, label, instructions) {  return {
    type: "oauth",
    label,
    async authorize() {
      // ⚠ 每个账号一个独立 guid，而不是共用本机 svid —— 否则新号登录会把旧号顶掉
      const guid = newDeviceGuid()
      const url = authorizeUrl(loginType, guid)
      // 用 QQ/微信 回传的 state 关联这次登录与 guid（WX 的 state 本身就是 guid）
      const state = stateOfUrl(url) || guid
      pendingDevices.remember(state, guid)

      return {
        url,
        // 我们自己开隔离浏览器，magpie 不要再开系统默认浏览器
        opened: true,
        method: "auto",
        instructions,
        async callback(_url, _input, signal) {
          const browser = findBrowser()
          if (!browser) {
            throw new Error(
              "没有找到可用的 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 浏览器都行）。" +
                "请装一个，或改用「从本机 Marvis 导入」。",
            )
          }

          // 起隔离浏览器 → 在**请求阶段**拦下回调（请求不出网，code 不会被消费）
          const { url: callbackUrl, body, intercepted } = await openIsolatedLogin({
            browser,
            url,
            match: CALLBACK,
            pattern: CALLBACK_PATTERN,
            timeoutMs: 5 * 60_000,
            signal,
          })

          // 取回这次登录专属的虚拟设备 guid
          const callbackState = stateOfUrl(callbackUrl)
          const virtualGuid = pendingDevices.take(callbackState) || (loginType === "WX" ? callbackState : "")
          if (!virtualGuid) {
            throw new Error(
              "登录流程已失效（找不到这次登录的设备标识）。请重新点一次登录，" +
                "或改用「从本机 Marvis 导入」。",
            )
          }

          /** @type {any} */
          let acct
          try {
            // ⚠ guid 必须是**这次登录生成的那个**：token 会绑定到它
            acct = await parseCallback(callbackUrl, body, { loginType, guid: virtualGuid })
            acct = await withProfile({ ...acct, guid: virtualGuid }, loginType)
          } catch (err) {
            const msg = String(err?.message ?? err)
            // -109 = 参数检查没过（不该再出现；出现就是真 bug，别让用户误以为是 code 过期）
            const paramHint = /-109|RC_PARAMS_INVALID/.test(msg) ? PARAM_HINT : ""
            throw new Error(msg + paramHint + (intercepted ? "" : NOT_INTERCEPTED_HINT))
          }
          return authOf({ ...acct, guid: virtualGuid, loginType: acct.loginType ?? LOGIN_TYPE[loginType] ?? "1" })
        },
      }
    },
  }
}

export function methods() {
  return [
    oauthLogin(
      "QC",
      "QQ 登录",
      "1) 会打开一个**独立的**浏览器窗口（不碰你日常浏览器）\n" +
        "2) 用你的 QQ 登录并确认授权\n" +
        "3) 授权完成后窗口会自己关掉，回到 magpie 即可",
    ),
    oauthLogin(
      "WX",
      "微信登录",
      "1) 会打开一个**独立的**浏览器窗口（不碰你日常浏览器）\n" +
        "2) 用微信扫码并确认\n" +
        "3) 授权完成后窗口会自己关掉，回到 magpie 即可",
    ),
    {
      type: "oauth",
      label: "从本机 Marvis 导入（需已安装并登录）",
      async authorize() {
        const ok = await desktopAvailable()
        return {
          // ⚠ 必须 opened: true + method: "auto"，否则 magpie 会去开这个 url
          //   （之前给 about:blank 弹了一次「没有可打开此链接的应用」）
          url: "",
          opened: true,
          method: "auto",
          instructions: ok
            ? "已检测到本机 Marvis 客户端，正在读取登录态…"
            : "本机没找到运行中的 Marvis 客户端。请先打开 Marvis 并登录，或改用 QQ / 微信 登录。",
          async callback() {
            const acct = await importFromDesktop()
            const loginType = acct.loginType === "2" ? "WX" : "QC"
            return authOf(await withProfile(acct, loginType))
          },
        }
      },
    },
  ]
}

export { PROVIDER, CALLBACK }
