// loader 对 200 的守望 —— 全部离线（fetch 打桩，绝不联网）
//
// 跑法：node --test tests/loader-200.test.mjs
//
// 守的是 0.2.19 的修复：风控 4100404 是 **200** 回来的。
// 以前 loader 只在 `!response.ok` 时才看 body，于是：
//   · 错误 body 被当正常响应交给宿主 → 「200 之后 EOF」
//   · 风控也不会重试
// 这一组同时守住「正常响应一个字节都不能丢」。

import test from "node:test"
import assert from "node:assert/strict"

import { loaderHook } from "../src/hooks/loader.mjs"

const AUTH = {
  access: "token-xyz",
  metadata: { openid: "openid-xyz", guid: "guid-xyz", loginType: "1" },
}
const URL_CHAT = "https://yybadaccess.3g.qq.com/v1/chat/completions"

/** 用给定的响应序列打桩 globalThis.fetch，返回调用记录 */
function stubFetch(responses) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (typeof next === "function") return next(calls.length)
    return next.clone()
  }
  return { calls, restore: () => (globalThis.fetch = real) }
}

/** 把 body 拆成几小段发出去，模拟真流 */
function streamOf(parts, { failMidway = false } = {}) {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]))
      else if (failMidway) controller.error(new Error("socket hang up"))
      else controller.close()
    },
  })
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "text/plain" } })

const answer = { choices: [{ index: 0, message: { role: "assistant", content: "喵" } }] }
const RISK = { code: 4100404, msg: "客户端通用错误:请求被风控拦截" }

async function callLoader(stream = false) {
  const plugin = await loaderHook()(async () => AUTH)
  return plugin.fetch(URL_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro-external", messages: [{ role: "user", content: "hi" }], stream }),
  })
}

test("200 + 风控 body + 重试也是风控 → 503 risk_blocked，不是把错误当答案", async () => {
  const s = stubFetch([json(RISK), json(RISK)])
  try {
    const res = await callLoader()
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.error.code, "risk_blocked")
    assert.match(body.error.message, /风控/)
    assert.equal(s.calls.length, 2, "风控必须换新 uskey 重试一次")
  } finally {
    s.restore()
  }
})

test("风控重试时 uskey 真的换了（MarvisExt 里的值不同）", async () => {
  const s = stubFetch([json(RISK), json(answer)])
  try {
    const res = await callLoader()
    assert.equal(res.status, 200)
    const ext = (i) => JSON.parse(new Headers(s.calls[i].init.headers).get("Ual-Access-MarvisExt"))
    assert.notEqual(ext(0).uskey, ext(1).uskey)
    assert.notEqual(ext(0).nonce, ext(1).nonce)
  } finally {
    s.restore()
  }
})

test("风控后重试成功 → 把答案交回去", async () => {
  const s = stubFetch([json(RISK), json(answer)])
  try {
    const res = await callLoader()
    assert.equal(res.status, 200)
    assert.equal((await res.json()).choices[0].message.content, "喵")
    assert.equal(s.calls.length, 2)
  } finally {
    s.restore()
  }
})

test("非流式答案被 peek 过后内容不丢（分段到达也一样）", async () => {
  const text = JSON.stringify(answer)
  const parts = [text.slice(0, 10), text.slice(10, 30), text.slice(30)]
  const s = stubFetch([() => new Response(streamOf(parts), { status: 200 })])
  try {
    const res = await callLoader(false)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), text)
    // 非流式不能标成 SSE
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /event-stream/)
  } finally {
    s.restore()
  }
})

test("流式答案：只 peek 到第一帧就放行，后续帧原样保留", async () => {
  const frames = [
    'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"喵"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"喵"}}]}\n\n',
    "data: [DONE]\n\n",
  ]
  let reads = 0
  const underlying = streamOf(frames)
  // 真 Response 会按自己创建的 ReadableStream 走；给不出可数 read 次数，
  // 所以套一个只负责计数的 reader
  const src = underlying.getReader()
  const counting = new ReadableStream({
    async pull(controller) {
      reads++
      const r = await src.read()
      if (r.done) controller.close()
      else controller.enqueue(r.value)
    },
  })
  const s = stubFetch([
    () => new Response(counting, { status: 200, headers: { "content-type": "text/plain" } }),
  ])
  try {
    const res = await callLoader(true)
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /event-stream/)
    const out = await res.text()
    assert.equal(out, frames.join(""))
    assert.equal(reads, 5, "peek 只读到第一帧（1 次空读 + 1 帧），其余 3 帧 + 1 次结束是交还后消费者读的")
  } finally {
    s.restore()
  }
})

test("200 + 非流式空 choices → 502，不再交给宿主去 EOF", async () => {
  const s = stubFetch([json({ code: 5001001, msg: "internal" })])
  try {
    const res = await callLoader()
    assert.equal(res.status, 502)
    assert.equal((await res.json()).error.code, "upstream_error")
  } finally {
    s.restore()
  }
})

test("200 + 登录态过期 → 401 + X-Magpie-Sign-In: expired", async () => {
  const s = stubFetch([json({ code: 4100403, msg: "登录态过期" })])
  try {
    const res = await callLoader()
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
  } finally {
    s.restore()
  }
})

test("非 2xx 的风控也重试一次", async () => {
  const s = stubFetch([json(RISK, 403), json(answer)])
  try {
    const res = await callLoader()
    assert.equal(res.status, 200)
    assert.equal(s.calls.length, 2)
  } finally {
    s.restore()
  }
})

test("非 2xx 非风控错误只发一次（不无脑重试）", async () => {
  const s = stubFetch([json({ error: { message: "bad request" } }, 400)])
  try {
    const res = await callLoader()
    assert.equal(res.status, 502)
    assert.equal(s.calls.length, 1)
  } finally {
    s.restore()
  }
})

test("peek 中途流断了 → 503 upstream_broken，不把半截当答案", async () => {
  const s = stubFetch([() => new Response(streamOf(['{"choices":[{"ind'], { failMidway: true }), { status: 200 })])
  try {
    const res = await callLoader()
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error.code, "upstream_broken")
  } finally {
    s.restore()
  }
})

test("模型 ID 归一与工具 schema 修补仍然生效", async () => {
  const plugin = await loaderHook()(async () => AUTH)
  const s = stubFetch([json(answer)])
  try {
    await plugin.fetch(URL_CHAT, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999" },
      body: JSON.stringify({
        model: "0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: { properties: {} } } }],
      }),
    })
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.model, "main-auto", "下标 0 必须归一成槽位名")
    assert.equal(sent.tools[0].function.parameters.type, "object")
    const h = new Headers(s.calls[0].init.headers)
    assert.equal(h.get("content-length"), null, "body 变长后旧的 content-length 必须去掉")
  } finally {
    s.restore()
  }
})

test("非补全请求原样放行（不换成 Marvis 头）", async () => {
  const plugin = await loaderHook()(async () => AUTH)
  const s = stubFetch([json({ data: [] })])
  try {
    await plugin.fetch("https://yybadaccess.3g.qq.com/v1/models", { headers: { "x-test": "1" } })
    const h = new Headers(s.calls[0].init.headers)
    assert.equal(h.get("x-test"), "1")
    assert.equal(h.get("Ual-Access-Openid"), null)
  } finally {
    s.restore()
  }
})

test("没登录时 loader 不给 fetch（交回 {}）", async () => {
  const plugin = await loaderHook()(async () => ({ access: "", metadata: {} }))
  assert.deepEqual(plugin, {})
})
