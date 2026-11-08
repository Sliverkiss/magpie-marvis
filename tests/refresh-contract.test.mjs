// tests/refresh-contract.test.mjs —— 续期契约（2026-11-07 微信被踢事故的回归锁）
//
// 事故现场（截图）：五个账号里 **两个微信 401「登录态过期」**，三个 QQ 正常。
// 根因是五件事叠在一起，这个文件把每一件都钉死：
//
//   ① **签名错**：`auth.refresh` 收的是**账号对象**（`refresh(auth, provider)`），
//      不是 getter（那是 `loader` / `usage` / `checkin` 的形状）。
//      写成 `getAuth()` → magpie 报 `getAuth is not a function`，**续期一次都没跑起来过**。
//   ② **端点错**：调的是 `GET /v3/marvis_refresh_token?refresh_token=…`，
//      恒定回 `-109 RefreshToken missing required param (openid, guid, token)`。
//      真实续期端点是 `POST /marvis_client_login/marvis_refresh_token`。
//   ③ **-109 被当成登录失效**：参数检查失败 ≠ 会话失效，标 `signIn: "expired"`
//      会让 magpie 把好账号标成「需要重新登录」。
//   ④ **expires 算错**：`expires_in` 是**相对秒数**（微信 7200 = 2 小时），
//      旧代码 `> 1e9` 判成「不是绝对时间戳」→ 回退 30 天 → 从不主动续期。
//   ⑤ **refresh_token 空串覆盖**：响应里 `refresh_token: ""`，`??` 不回退，
//      存成空串后下次 `if (!refreshToken) return {}` 直接短路，永不续期。
//
// 全部离线：mock 掉 globalThis.fetch，不联网、不需要凭据。

import test from "node:test"
import assert from "node:assert/strict"

import { expiresAtOf, ttlFor, DEFAULT_TTL_MS, WX_TTL_MS } from "../src/marvis/expiry.mjs"
import { refreshHook } from "../src/hooks/refresh.mjs"
import { REFRESH_LEAD_MS } from "../src/context.mjs"

/** 替换 globalThis.fetch，返回恢复函数 */
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

/** 造一个上游续期响应 */
function refreshResponse(userInfo) {
  return new Response(JSON.stringify({ code: 0, msg: "RC_SUCCESS", user_info: userInfo }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** 造一个账号对象 */
function account(over = {}) {
  return {
    access: "mv_OLD",
    refresh: "RT_OLD",
    metadata: { openid: "OID", guid: "0".repeat(32), loginType: "2", nickname: "示例昵称" },
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────
// ④ 有效期归一
// ─────────────────────────────────────────────────────────────

test("expiresAtOf：绝对秒 / 绝对毫秒 / 相对秒 / 兜底 四种形状各走各的分支", () => {
  const now = 1_800_000_000_000
  // 10 位秒 → 乘 1000
  assert.equal(expiresAtOf({ access_token_expire_time: "1796545945" }, { now }), 1_796_545_945_000)
  assert.equal(expiresAtOf({ access_token_expire_time: 1_796_545_945 }, { now }), 1_796_545_945_000)
  // 13 位毫秒 → 原样
  assert.equal(expiresAtOf({ access_token_expire_time: 1_796_545_945_000 }, { now }), 1_796_545_945_000)
  // 相对秒（微信只有 7200）
  assert.equal(expiresAtOf({ expires_in: "7200" }, { now }), now + 7_200_000)
  assert.equal(expiresAtOf({ expires_in: 2591962 }, { now }), now + 2_591_962_000)
  // 都没有 → 兜底
  assert.equal(expiresAtOf({}, { now }), now + DEFAULT_TTL_MS)
  assert.equal(expiresAtOf(undefined, { now }), now + DEFAULT_TTL_MS)
  assert.equal(expiresAtOf({}, { now, fallbackMs: 1234 }), now + 1234)
  // 绝对时间戳优先于 expires_in
  assert.equal(
    expiresAtOf({ access_token_expire_time: 1_796_545_945, expires_in: 7200 }, { now }),
    1_796_545_945_000,
  )
})

test("ttlFor：微信 2 小时、QQ 30 天 —— 不能共用一个兜底", () => {
  assert.equal(ttlFor("2"), WX_TTL_MS)
  assert.equal(ttlFor("WX"), WX_TTL_MS)
  assert.equal(ttlFor("WXAPP"), WX_TTL_MS)
  assert.equal(ttlFor("1"), DEFAULT_TTL_MS)
  assert.equal(ttlFor("QC"), DEFAULT_TTL_MS)
  assert.equal(ttlFor(undefined), DEFAULT_TTL_MS)
  // 微信 TTL 必须远小于 QQ —— 共用一个就是 360 倍误差
  assert.ok(WX_TTL_MS * 100 < DEFAULT_TTL_MS)
})

test("REFRESH_LEAD_MS 必须小于微信 token 的有效期（否则微信账号从登录那刻起就「永远该刷新」）", () => {
  assert.ok(REFRESH_LEAD_MS > 0)
  assert.ok(REFRESH_LEAD_MS < WX_TTL_MS, `refreshLead=${REFRESH_LEAD_MS} 应小于 ${WX_TTL_MS}`)
})

// ─────────────────────────────────────────────────────────────
// ① 签名：第一个参数是**账号对象**
// ─────────────────────────────────────────────────────────────

test("refresh：第一个参数按**账号对象**传（不是 getAuth 函数）", async () => {
  let seen = null
  const restore = stubFetch(async () => {
    seen = "called"
    return new Response(JSON.stringify({ code: -107, msg: "x" }), { status: 200 })
  })
  try {
    await assert.rejects(
      () => refreshHook()(account({ refresh: "RT_sig" }), { id: "marvis" }),
      (err) => {
        // 只要没抛 "getAuth is not a function" 就说明签名对了
        assert.ok(!/getAuth is not a function/.test(err.message), err.message)
        assert.match(err.message, /code=-107/)
        return true
      },
    )
    assert.equal(seen, "called")
  } finally {
    restore()
  }
})

test("refresh：也兼容传 getter 的宿主（向后兼容，不能一次写死）", async () => {
  let seen = false
  const restore = stubFetch(async () => {
    seen = true
    return new Response(JSON.stringify({ code: -107, msg: "x" }), { status: 200 })
  })
  try {
    await assert.rejects(
      () => refreshHook()(async () => account({ refresh: "RT_getter" })),
      /code=-107/,
    )
    assert.equal(seen, true)
  } finally {
    restore()
  }
})

// ─────────────────────────────────────────────────────────────
// ② 端点 + 请求形状
// ─────────────────────────────────────────────────────────────

test("refresh：POST 到 /marvis_client_login/marvis_refresh_token，body 是 userInfo 形状", async () => {
  const calls = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    // 昵称接口也走 fetch —— 这里让它失败，不影响续期
    if (String(url).includes("marvis_get_user_info")) {
      return new Response(JSON.stringify({ ret: -1 }), { status: 200 })
    }
    return refreshResponse({
      access_token: "mv_NEW",
      refresh_token: "",
      expires_in: "7200",
      login_type: "WX",
    })
  })

  try {
    const out = await refreshHook()(account())

    assert.equal(calls.length, 2, "一次续期 + 一次昵称（昵称失败不影响）")
    const [refreshCall] = calls
    assert.match(
      refreshCall.url,
      /^https:\/\/yybadaccess\.3g\.qq\.com\/marvis_client_login\/marvis_refresh_token$/,
      "端点必须是 POST /marvis_client_login/marvis_refresh_token（不是 /v3/marvis_refresh_token）",
    )
    assert.equal(refreshCall.init.method, "POST")

    const body = JSON.parse(refreshCall.init.body)
    assert.deepEqual(body, {
      userInfo: {
        openId: "OID",
        refreshToken: "RT_OLD",
        accessToken: "mv_OLD",
        // ⚠ 恒为 "Marvis"，不是 QC/WX
        loginType: "Marvis",
      },
    })

    // 签名头必须带（/v3、/marvis_client_login 业务接口都要）
    assert.ok(refreshCall.init.headers["Ual-Access-Signature"])
    assert.ok(refreshCall.init.headers["Ual-Access-Timestamp"])
    assert.ok(refreshCall.init.headers["Ual-Access-Nonce"])
    assert.equal(refreshCall.init.headers["Ual-Access-Openid"], "OID")
    assert.equal(refreshCall.init.headers["Ual-Access-Guid"], "0".repeat(32))
    // ⚠ 模型网关那套 UAL 头**不能**混进来 —— 加了会从 200 变 400
    assert.equal(refreshCall.init.headers["Ual-Access-MarvisExt"], undefined)

    // ⑤ 空串回退：响应 refresh_token 是 "" 时保留旧的
    assert.equal(out.refresh, "RT_OLD", "空串是「没给新值」，不能覆盖旧 refresh_token")
    assert.equal(out.access, "mv_NEW")
    // ④ expires 按 expires_in=7200 秒算，不是 30 天
    const ttl = out.expires - Date.now()
    assert.ok(ttl > 7_000_000 && ttl < 7_300_000, `expires 应约 2 小时后，实际 ${ttl}ms`)
    // 合并语义：metadata 不能丢
    assert.equal(out.metadata.openid, "OID")
    assert.equal(out.metadata.guid, "0".repeat(32))
    assert.equal(out.metadata.loginType, "2")
  } finally {
    restore()
  }
})

test("refresh：响应给了新 refresh_token 时用新的", async () => {
  const restore = stubFetch(async () => refreshResponse({ access_token: "mv_2", refresh_token: "RT_NEW" }))
  try {
    const out = await refreshHook()(
      account({
        access: "mv_1",
        // ⚠ 锁键 = refreshToken：别和别的测试重名，否则命中上一条的 60s 回放缓存
        refresh: "RT_OLD2",
        metadata: { openid: "OID2", guid: "1".repeat(32), loginType: "1" },
      }),
    )
    assert.equal(out.refresh, "RT_NEW")
    assert.equal(out.access, "mv_2")
  } finally {
    restore()
  }
})

test("refresh：没有 refresh_token 时直接返回 {}（不凭空造，也不发请求）", async () => {
  let called = false
  const restore = stubFetch(async () => {
    called = true
    return refreshResponse({ access_token: "x" })
  })
  try {
    const out = await refreshHook()(account({ access: "a", refresh: "", metadata: {} }))
    assert.deepEqual(out, {})
    assert.equal(called, false, "没有 refresh_token 就不该发请求")
  } finally {
    restore()
  }
})

// ─────────────────────────────────────────────────────────────
// ③ 错误分类：只有会话/ token 校验失败才标 signIn=expired
// ─────────────────────────────────────────────────────────────

test("refresh：-107/-101 标 signIn=expired，-109/-7/-5 不标（参数/签名错不是登录失效）", async () => {
  const cases = [
    [-107, true],
    [-101, true],
    [-109, false],
    [-7, false],
    [-5, false],
  ]
  for (const [code, fatal] of cases) {
    const restore = stubFetch(
      async () => new Response(JSON.stringify({ code, msg: `err${code}` }), { status: 200 }),
    )
    try {
      await assert.rejects(
        () =>
          refreshHook()(
            account({
              access: "a",
              refresh: `RT_${code}`,
              metadata: { openid: `OID_${code}`, guid: "2".repeat(32), loginType: "2" },
            }),
          ),
        (err) => {
          assert.equal(
            err.signIn === "expired",
            fatal,
            `code=${code} 的 signIn 应该是 ${fatal ? "expired" : "不设"}`,
          )
          assert.match(err.message, new RegExp(`code=${code}`))
          return true
        },
      )
    } finally {
      restore()
    }
  }
})

test("refresh：非 JSON 响应报清楚，不假装成功", async () => {
  const restore = stubFetch(async () => new Response("<html>502</html>", { status: 502 }))
  try {
    await assert.rejects(
      () =>
        refreshHook()(
          account({
            access: "a",
            refresh: "RT_html",
            metadata: { openid: "OID_html", guid: "3".repeat(32) },
          }),
        ),
      /不是 JSON（502）/,
    )
  } finally {
    restore()
  }
})

test("refresh：网络异常时抛可读错误（不是 undefined is not a function）", async () => {
  const restore = stubFetch(async () => {
    throw new TypeError("fetch failed")
  })
  try {
    await assert.rejects(
      () =>
        refreshHook()(
          account({
            access: "a",
            refresh: "RT_net",
            metadata: { openid: "OID_net", guid: "4".repeat(32) },
          }),
        ),
      /续期请求发不出去/,
    )
  } finally {
    restore()
  }
})
