// ③ auth.refresh —— 续期
//
// ⚠⚠ 上游有**两个**长得像续期的端点，只有一个能用（2026-11-07 实测）：
//
//   ✅ `POST /marvis_client_login/marvis_refresh_token`
//      body  `{"userInfo":{"openId","refreshToken","accessToken","loginType":"Marvis"}}`
//      resp  `{"code":0,"msg":"RC_SUCCESS","user_info":{"access_token","expires_in",…}}`
//      —— 官方客户端自己走的就是它，实测 `code:0`，**access_token 不变、只重置有效期**。
//
//   ❌ `GET /v3/marvis_refresh_token?refresh_token=…`
//      恒定回 `{"code":-109,"msg":"RefreshToken missing required param (openid, guid, token)"}`。
//      0.2.13 及以前调的是这个 —— **续期从来没成功过**。
//
//   后果不对称：QQ 的 token 30 天，没人发现；微信的只有 2 小时，
//   登录完几小时就 401「登录态过期/未登录」→ 账号被标「需要重新登录」。
//
// ⚠ 续期必须**串行**（同账号同时只允许一次）：一次性的 refresh_token 并发两次，
//   后拿到的那份会把先拿到的打掉（AGENTS 坑 7）。
//
// ⚠ 返回是**合并**语义：只给新字段会覆盖掉 metadata 里的 openid/guid（AGENTS 坑 4）。

import { createRefreshLock } from "../refresh-lock.mjs"
import { BASE, REFRESH_PATH } from "../context.mjs"
import { businessHeaders } from "../marvis/protocol.mjs"
import { fetchUserProfile, accountLabel } from "../marvis/profile.mjs"
import { expiresAtOf } from "../marvis/expiry.mjs"

const lock = createRefreshLock()

/**
 * 这些业务码代表「登录态真的不能用了」，其余（-109 参数、-7 签名、-5 缺头）
 * 都是**插件自身**的问题 —— 标 `signIn: "expired"` 会让 magpie 把好账号
 * 标成「需要重新登录」，比不刷新更糟（AGENTS 坑 6 的同类）。
 */
const FATAL_CODES = new Set([-107, -101])

/**
 * ⚠⚠ 签名是 `(auth, provider)` —— **第一个参数是账号对象，不是 getter**。
 *
 *   HOOKS 第五节的对照表（magpie 官方契约）：
 *     `async refresh(auth, provider)`        ← 本钩子
 *     `async loader(getAuth, provider)`      ← 只有这三个收函数
 *     `async usage(getAuth, provider)`
 *     `async checkin(getAuth, provider)`
 *
 *   0.2.13 及以前写成 `async (getAuth) => { const auth = await getAuth() }`，
 *   magpie 实测报 `auth.refresh: getAuth is not a function.
 *   (In 'getAuth()', 'getAuth' is an instance of Object)` ——
 *   **续期一次都没跑起来过**（错误被 magpie 记成 plugin [error] 后 30 秒重试，无限循环）。
 *   这是「微信被踢」的第 5 个根因，也是最致命的一个：前面四个改了也没用。
 *
 *   兼容写法保留：万一某个 magpie 版本传的是函数，这里一样认。
 *
 * @param {any} authOrGetter 账号对象（或 getter，兼容）
 * @param {any} [_provider]
 * @returns {Promise<Record<string, unknown>>}
 */
export function refreshHook() {
  return async (authOrGetter, _provider) => {
    const auth = typeof authOrGetter === "function" ? await authOrGetter() : authOrGetter
    const meta = auth?.metadata ?? {}
    const refreshToken = String(auth?.refresh ?? "")
    if (!refreshToken) return {}

    // ⚠ 锁键必须是**凭据身份**（refresh-lock 文档同款要求）：用 refreshToken 本身。
    //   以 openid 为键时，成功结果回放 60s 是合并语义的完整旧结果 —— 用户刚重新
    //   登录拿到新 token，一次旧回放就能把新 token 盖掉（旧 token 已被服务端作废）。
    //   键 = refreshToken，token 一换键就换，回放天然失效。
    const key = refreshToken

    return lock.run(key, async () => {
      const acct = {
        openid: String(meta.openid ?? ""),
        accessToken: String(auth?.access ?? auth?.key ?? ""),
        guid: String(meta.guid ?? ""),
        loginType: String(meta.loginType ?? "1"),
      }

      const body = JSON.stringify({
        userInfo: {
          openId: acct.openid,
          refreshToken,
          accessToken: acct.accessToken,
          // ⚠ 恒为 "Marvis"：这不是 `Ual-Access-Login-Type`（那个是 QC→1 / WX→2）
          loginType: "Marvis",
        },
      })
      const url = `${BASE}${REFRESH_PATH}`

      /** @type {Response} */
      let res
      try {
        res = await fetch(url, {
          method: "POST",
          headers: businessHeaders(acct, { query: body, method: "POST" }),
          body,
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        throw new Error(`续期请求发不出去：${err?.message ?? err}`)
      }

      const text = await res.text()

      /** @type {any} */
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`续期接口返回的不是 JSON（${res.status}）：${text.slice(0, 200)}`)
      }

      const info = json?.user_info ?? json?.data ?? null
      const biz = Number(json?.code ?? 0)
      const access = String(info?.access_token ?? info?.accessToken ?? "")

      if (!access || biz !== 0) {
        const err = new Error(
          `续期失败（code=${json?.code ?? "?"}）：${json?.msg ?? text.slice(0, 200)}`,
        )
        // ⚠ 只有「参数过了、会话/token 校验失败」才算登录失效
        if (FATAL_CODES.has(biz)) err.signIn = "expired"
        throw err
      }

      // ⚠ `refresh_token` 可能回**空串**（实测微信就回 `""`）。
      //   空串是「这次没给新值」，不是「清空」—— 必须回退到旧的，
      //   否则下次 `if (!refreshToken) return {}` 直接短路，永不续期。
      const nextRefresh = String(info?.refresh_token || info?.refreshToken || "") || refreshToken

      // 顺手补一次昵称：老账号升级后卡片上还是一串 key，点刷新就能变成 QQ/微信昵称
      let profile = null
      try {
        profile = await fetchUserProfile(
          { ...acct, accessToken: access, refreshToken: nextRefresh },
          { loginType: acct.loginType },
        )
      } catch {
        /* 昵称拿不到不影响续期 */
      }
      const nickname = profile?.nickname ?? meta.nickname
      const label = accountLabel(nickname, meta.loginType)
      return {
        access,
        refresh: nextRefresh,
        expires: expiresAtOf(info),
        ...(label ? { accountId: label } : {}),
        ...(profile?.avatar ? { avatar: profile.avatar } : {}),
        metadata: { ...meta, ...(nickname ? { nickname: String(nickname) } : {}) },
      }
    })
  }
}
