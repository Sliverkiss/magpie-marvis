// tests/profile.test.mjs —— 昵称/头像请求的形状锁
//
// 实测：GET /marvis_client/marvis_get_user_info → 403；
// 签名 POST + body {userInfo} → 200 {ret:0, nick_name}。
// 昵称拿不到必须返回 null，绝不能阻塞登录或编造名字。

import test from "node:test"
import assert from "node:assert/strict"

import { fetchUserProfile } from "../src/marvis/profile.mjs"
import { authOf } from "../src/hooks/methods.mjs"

const ACCT = {
  openid: "0123456789abcdef0123456789abcdef",
  accessToken: "mv_test",
  refreshToken: "rt_test",
  guid: "0123456789abcdef0123456789abcdef",
  loginType: "1",
}

function stubFetch(handler) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {})
  }
  return { calls, restore: () => (globalThis.fetch = real) }
}

test("签名 POST 成功：返回昵称与头像", async () => {
  const s = stubFetch(
    () =>
      new Response(JSON.stringify({ ret: 0, nick_name: "测试昵称", head_img_url: "https://example.test/a.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  try {
    const p = await fetchUserProfile(ACCT)
    assert.deepEqual(p, { nickname: "测试昵称", avatar: "https://example.test/a.png" })
    const { init } = s.calls[0]
    assert.equal(init.method, "POST")
    assert.ok(init.headers["Ual-Access-Businessid"])
    assert.ok(init.headers["Ual-Access-Signature"])
    assert.equal(init.headers["Ual-Access-Access-Token"], undefined, "签名 POST 不能带 token 头")
    const body = JSON.parse(init.body)
    assert.equal(body.userInfo.openId, ACCT.openid)
    assert.equal(body.userInfo.guid, ACCT.guid)
  } finally {
    s.restore()
  }
})

test("ret 非 0 或没有昵称：返回 null，不编造", async () => {
  for (const payload of [{ ret: -107, nick_name: "" }, { ret: 0, nick_name: "" }, { ret: 0 }]) {
    const s = stubFetch(() => new Response(JSON.stringify(payload), { status: 200 }))
    try {
      assert.equal(await fetchUserProfile(ACCT), null)
    } finally {
      s.restore()
    }
  }
})

test("网络错误：返回 null，不抛", async () => {
  const s = stubFetch(() => Promise.reject(new Error("boom")))
  try {
    assert.equal(await fetchUserProfile(ACCT), null)
  } finally {
    s.restore()
  }
})

test("缺 openid / token / guid：直接 null，不发请求", async () => {
  const s = stubFetch(() => new Response("{}"))
  try {
    assert.equal(await fetchUserProfile({}), null)
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

test("authOf：昵称进 accountId，openid 只进 uid", () => {
  const a = authOf({
    openid: "0123456789abcdef0123456789abcdef",
    accessToken: "mv_test",
    refreshToken: "rt_test",
    guid: "0123456789abcdef0123456789abcdef",
    nickname: "测试昵称",
    loginType: "1",
  })
  assert.equal(a.accountId, "QQ·测试昵称")
  assert.equal(a.uid, "0123456789abcdef0123456789abcdef")
})
