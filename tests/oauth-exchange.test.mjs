// tests/oauth-exchange.test.mjs —— OAuth code 换取的形状锁
//
// 把已实测的事实写死成测试，改代码时会被拦住：
//   ① 换取成功 = **302 + Set-Cookie**（openid/accesstoken/refreshtoken/logintype/
//      nickname/head_img_url/access_token_expire_time/appid/scope/is_locked），不是 JSON
//   ② 必须带 `Ual-Access-Guid`，且必须 `redirect: "manual"`（跟随重定向会丢登录态）
//   ③ 回调的 `state` 必须原样回传；guid 不能是 undefined
//   ④ -109 = 参数检查未通过（最常见是缺 guid）；-107 = 参数已过但 code/会话校验失败
//      —— 都不是「账号或密码错」
//
// 全部离线：fetch 换成假实现，不联网、不需要 magpie 进程、不需要任何凭据。
// 跑法：node --test tests/oauth-exchange.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import {
  exchangeCode,
  parseCallback,
  parseSetCookies,
  accountFromCookies,
  stateOf,
} from "../src/marvis/login.mjs"

/** 32 位小写 hex，形状与 deviceGuid() 一致 */
const GUID = "0123456789abcdef0123456789abcdef"
const CODE = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4"
const OAUTH_PATH = "/marvis_client_login/marvis_oauth"

/**
 * 替身 fetch：记下每次 url / init，回固定响应。
 * @param {(url: string, init: any) => Response | Promise<Response>} makeResponse
 */
function stubFetch(makeResponse) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return makeResponse(String(url), init ?? {})
  }
  return {
    calls,
    restore() {
      globalThis.fetch = real
    },
  }
}

/** 官方 302 成功响应：10 个 Set-Cookie，无 body */
function ok302() {
  const setCookies = [
    "openid=0A1B2C3D4E5F60718293A4B5C6D7E8F9; Path=/; Domain=.qq.com; HttpOnly",
    "accesstoken=TOKEN_abc123; Path=/; Domain=.qq.com; HttpOnly",
    "refreshtoken=REFRESH_def456; Path=/; Domain=.qq.com; HttpOnly",
    "logintype=QC; Path=/; Domain=.qq.com",
    `nickname=${encodeURIComponent("阿明")}; Path=/; Domain=.qq.com`,
    "head_img_url=https%3A%2F%2Fthirdqq.qlogo.cn%2Fabc%2F100; Path=/; Domain=.qq.com",
    "access_token_expire_time=1793000000; Path=/; Domain=.qq.com",
    "appid=1903794758; Path=/; Domain=.qq.com",
    "scope=all; Path=/; Domain=.qq.com",
    "is_locked=0; Path=/; Domain=.qq.com",
  ]
  const headers = new Headers()
  for (const c of setCookies) headers.append("set-cookie", c)
  headers.set("location", "https://yybadaccess.3g.qq.com/marvis_client_login/oauth_done")
  return new Response(null, { status: 302, headers })
}

/** 上游 JSON 失败响应 */
function jsonError(code, msg) {
  return new Response(JSON.stringify({ code, msg }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("302 + Set-Cookie：解析成账号（官方成功形态）", async () => {
  const s = stubFetch(() => ok302())
  try {
    const acct = await exchangeCode(CODE, "QC", GUID, "31.1177412")
    assert.equal(s.calls.length, 1)

    assert.equal(acct.openid, "0A1B2C3D4E5F60718293A4B5C6D7E8F9")
    assert.equal(acct.accessToken, "TOKEN_abc123")
    assert.equal(acct.refreshToken, "REFRESH_def456")
    assert.equal(acct.nickname, "阿明", "nickname 要百分号解码")
    assert.equal(acct.avatar, "https://thirdqq.qlogo.cn/abc/100", "head_img_url → avatar，且要解码")
    assert.equal(acct.loginType, "1", "logintype=QC → Ual-Access-Login-Type 1")
    assert.equal(acct.expiresAt, 1793000000 * 1000, "10 位秒级时间戳要 ×1000")
    assert.equal(acct.appid, "1903794758")
    assert.equal(acct.scope, "all")
    assert.equal(acct.guid, GUID, "换取用的 guid 要跟着账号一起回去落盘")
    assert.equal(acct.isLocked, undefined, "is_locked=0 不是锁定")
  } finally {
    s.restore()
  }
})

test("换取请求：带 Ual-Access-Guid、redirect=manual、只带 login_type/code/state", async () => {
  const s = stubFetch(() => ok302())
  try {
    await exchangeCode(CODE, "QC", GUID, "31.1177412")
    const { url, init } = s.calls[0]
    const u = new URL(url)

    assert.equal(`${u.origin}${u.pathname}`, `https://yybadaccess.3g.qq.com${OAUTH_PATH}`)
    assert.equal(u.searchParams.get("login_type"), "QC")
    assert.equal(u.searchParams.get("code"), CODE)
    assert.equal(u.searchParams.get("state"), "31.1177412", "state 必须原样回传")
    assert.deepEqual(
      [...u.searchParams.keys()].sort(),
      ["code", "login_type", "state"],
      "多带一个参数服务端就 -109",
    )

    assert.equal(init.method, "GET")
    assert.equal(init.redirect, "manual", "必须 manual：跟随 302 就是把 Set-Cookie 丢掉")
    const h = new Headers(init.headers)
    assert.equal(h.get("ual-access-guid"), GUID, "不带它服务端一律 -109")
    assert.ok(!h.get("ual-access-signature"), "签名头会让 WAF 直接 400")
    assert.match(h.get("user-agent"), /Marvis\//, "UA 必须是客户端自己的 Electron UA")
  } finally {
    s.restore()
  }
})

test("兼容 200 + JSON user_info（旧形态仍然认）", async () => {
  const payload = {
    code: 0,
    user_info: {
      openid: "FEDCBA9876543210FEDCBA9876543210",
      access_token: "JSON_TOKEN",
      refresh_token: "JSON_REFRESH",
      nick_name: "小明",
      head_img_url: "https://thirdqq.qlogo.cn/json/100",
      access_token_expire_time: 1793000000,
      login_type: "WX",
    },
  }
  const s = stubFetch(
    () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  try {
    const acct = await exchangeCode(CODE, "WX", GUID)
    assert.equal(acct.openid, "FEDCBA9876543210FEDCBA9876543210")
    assert.equal(acct.accessToken, "JSON_TOKEN")
    assert.equal(acct.refreshToken, "JSON_REFRESH")
    assert.equal(acct.nickname, "小明")
    assert.equal(acct.loginType, "2", "login_type=WX → Ual-Access-Login-Type 2")
    assert.equal(acct.expiresAt, 1793000000 * 1000)
    assert.equal(acct.guid, GUID)
  } finally {
    s.restore()
  }
})

test("兼容 200 + 扁平 JSON（没有 user_info 包一层）", async () => {
  const s = stubFetch(
    () =>
      new Response(JSON.stringify({ openid: "AAAABBBBCCCCDDDD", access_token: "FLAT_TOKEN" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  try {
    const acct = await exchangeCode(CODE, "QC", GUID)
    assert.equal(acct.openid, "AAAABBBBCCCCDDDD")
    assert.equal(acct.accessToken, "FLAT_TOKEN")
    assert.equal(acct.loginType, "1")
  } finally {
    s.restore()
  }
})

test("-109：含义是「参数检查未通过」，不是「授权码过期 / 账号错」", async () => {
  const s = stubFetch(() => jsonError(-109, "params invalid"))
  try {
    await assert.rejects(
      () => exchangeCode(CODE, "QC", GUID),
      (err) => {
        assert.match(err.message, /code=-109/)
        assert.match(err.message, /RC_PARAMS_INVALID/, "要带上游的符号名")
        assert.match(err.message, /参数检查未通过/)
        assert.match(err.message, /Ual-Access-Guid/, "要指出最常见的缺项")
        assert.doesNotMatch(err.message, /授权码无效|密码|账号错/)
        return true
      },
    )
  } finally {
    s.restore()
  }
})

test("-107：含义是「参数已过、code/会话校验失败」，且不与 -109 混说", async () => {
  const s = stubFetch(() => jsonError(-107, "auth failed"))
  try {
    await assert.rejects(
      () => exchangeCode(CODE, "QC", GUID),
      (err) => {
        assert.match(err.message, /code=-107/)
        assert.match(err.message, /参数已通过/)
        assert.match(err.message, /code 无效|已过期|已被消费/)
        assert.doesNotMatch(err.message, /RC_PARAMS_INVALID/, "-107 不是参数无效")
        assert.doesNotMatch(err.message, /密码错误|账号错/)
        return true
      },
    )
  } finally {
    s.restore()
  }
})

test("302 却没下发登录 Cookie：报清楚，不假装成功", async () => {
  const headers = new Headers()
  headers.append("set-cookie", "waf_check=1; Path=/")
  headers.set("location", "https://yybadaccess.3g.qq.com/risk")
  const s = stubFetch(() => new Response(null, { status: 302, headers }))
  try {
    await assert.rejects(
      () => exchangeCode(CODE, "QC", GUID),
      (err) => {
        assert.match(err.message, /302/)
        assert.match(err.message, /没有下发登录 Cookie/)
        assert.match(err.message, /\/risk/, "要把 Location 带出来，方便定位")
        return true
      },
    )
  } finally {
    s.restore()
  }
})

test("缺 guid：本地就报错，不发那趟注定 -109 的请求", async () => {
  const s = stubFetch(() => ok302())
  try {
    await assert.rejects(
      () => exchangeCode(CODE, "QC", undefined),
      (err) => {
        assert.match(err.message, /Ual-Access-Guid/)
        assert.match(err.message, /-109/)
        return true
      },
    )
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

test("parseCallback：从回调 URL 保留 state，并把 guid 带进 Ual-Access-Guid", async () => {
  const s = stubFetch(() => ok302())
  try {
    const cb = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?code=${CODE}&state=31.1177412`
    const acct = await parseCallback(cb, "", { loginType: "QC", guid: GUID })

    assert.equal(s.calls.length, 1)
    const { url, init } = s.calls[0]
    const u = new URL(url)
    assert.equal(u.searchParams.get("state"), "31.1177412", "state 必须是回调里那一个")
    assert.equal(u.searchParams.get("code"), CODE)
    assert.equal(u.searchParams.get("login_type"), "QC")
    assert.equal(new Headers(init.headers).get("ual-access-guid"), GUID, "不能再传 undefined")
    assert.equal(init.redirect, "manual")

    assert.equal(acct.openid, "0A1B2C3D4E5F60718293A4B5C6D7E8F9")
    assert.equal(acct.guid, GUID)
  } finally {
    s.restore()
  }
})

test("parseCallback：微信的 state 就是 guid，没传 opts.guid 也能对上", async () => {
  const s = stubFetch(() => ok302())
  try {
    const cb = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?code=${CODE}&state=${GUID}`
    await parseCallback(cb, "", { loginType: "WX" })
    assert.equal(new Headers(s.calls[0].init.headers).get("ual-access-guid"), GUID)
  } finally {
    s.restore()
  }
})

test("parseCallback：QQ 回调没带 state 时才退回 opts.state；guid 缺省时取设备 guid（不是 undefined）", async () => {
  const s = stubFetch(() => ok302())
  try {
    const cb = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?code=${CODE}`
    await parseCallback(cb, "", { loginType: "QC", state: "7.5" })
    const u = new URL(s.calls[0].url)
    assert.equal(u.searchParams.get("state"), "7.5")

    const guid = new Headers(s.calls[0].init.headers).get("ual-access-guid")
    assert.match(guid, /^[0-9a-f]{32}$/, "缺省要取设备 guid（32 位小写 hex），不能是 undefined")
  } finally {
    s.restore()
  }
})

test("parseCallback：正文是 JSON 时直接认，并把 guid 一起带回去", async () => {
  const s = stubFetch(() => {
    throw new Error("不该发请求")
  })
  try {
    const body = `  {\n  "code": 0,\n  "user_info": { "openid": "0123456789ABCDEF", "access_token": "BODY_TOKEN" }\n}\n`
    const acct = await parseCallback(
      `https://yybadaccess.3g.qq.com${OAUTH_PATH}?code=${CODE}&state=3.5`,
      body,
      { loginType: "QC", guid: GUID },
    )
    assert.equal(s.calls.length, 0, "正文已经是登录态了，不该再换一次")
    assert.equal(acct.accessToken, "BODY_TOKEN")
    assert.equal(acct.guid, GUID)
  } finally {
    s.restore()
  }
})

test("parseSetCookies：Expires 里的逗号劈不开，同名 cookie 取第一个", () => {
  const headers = new Headers()
  headers.append("set-cookie", "openid=ABC; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/")
  headers.append("set-cookie", "accesstoken=T1; Path=/; Domain=.qq.com")
  headers.append("set-cookie", "openid=SECOND; Path=/")

  const jar = parseSetCookies(headers)
  assert.equal(jar.get("openid"), "ABC")
  assert.equal(jar.get("accesstoken"), "T1")

  // 没有 openid / accesstoken 的 cookie 集合不算登录成功
  assert.equal(accountFromCookies(jar, { loginType: "QC" }).openid, "ABC")
  assert.equal(accountFromCookies(new Map([["waf_check", "1"]]), {}), null)
})

test("parseSetCookies：没有 getSetCookie 时也能切（老运行时 / 假 headers）", () => {
  const fake = {
    get: (name) =>
      name.toLowerCase() === "set-cookie"
        ? "openid=X1; Expires=Wed, 01 Jan 2031 00:00:00 GMT, accesstoken=Y1; Path=/"
        : null,
  }
  const jar = parseSetCookies(fake)
  assert.equal(jar.get("openid"), "X1")
  assert.equal(jar.get("accesstoken"), "Y1")
})

test("accountFromCookies：logintype 缺失时退回调用方声明的 loginType", () => {
  const jar = new Map([
    ["openid", "OID"],
    ["accesstoken", "AT"],
  ])
  assert.equal(accountFromCookies(jar, { loginType: "WX" }).loginType, "2")
  assert.equal(accountFromCookies(jar, { loginType: "QC" }).loginType, "1")
})

test("stateOf：取不到 state 时返回空串（不是 null / 'null'）", () => {
  assert.equal(stateOf(`https://x.y${OAUTH_PATH}?code=C&state=31.1177412`), "31.1177412")
  assert.equal(stateOf(`https://x.y${OAUTH_PATH}?code=C`), "")
  assert.equal(stateOf(""), "")
  assert.equal(stateOf(undefined), "")
})
