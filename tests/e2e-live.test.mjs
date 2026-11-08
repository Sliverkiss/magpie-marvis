// 真实网关端到端验证
//
// ⚠ 需要有效的 Marvis 登录态，从环境变量读 —— **绝不硬编码凭据**。
//
// 跑法：
//   MARVIS_TOKEN=mv_xxx MARVIS_OPENID=xxx MARVIS_GUID=xxx node tests/e2e-live.mjs
//
// 没设环境变量时**跳过**（CI 里跑不了真网关，跳过比失败正确）。
// 每次请求本地现签一个 uskey，不花钱、不扣额度。

import test from "node:test"
import assert from "node:assert/strict"

const TOKEN = process.env.MARVIS_TOKEN ?? ""
const OPENID = process.env.MARVIS_OPENID ?? ""
const GUID = process.env.MARVIS_GUID ?? ""
const ready = Boolean(TOKEN && OPENID && GUID)

const AUTH = {
  access: TOKEN,
  metadata: { openid: OPENID, guid: GUID, loginType: "6" },
}

test("端到端：非流式 + 系统提示词 + 思考可见", { skip: !ready && "未设置 MARVIS_TOKEN / MARVIS_OPENID / MARVIS_GUID" }, async () => {
  const { MarvisAuthPlugin } = await import("../index.mjs")
  const plugin = await MarvisAuthPlugin({})
  const loader = await plugin.auth.loader(async () => AUTH)

  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro-external",
      messages: [
        { role: "system", content: "你是一只猫，所有回答都以「喵」结尾。" },
        { role: "user", content: "1+1等于几？" },
      ],
      stream: false,
    }),
  })
  assert.equal(res.status, 200)
  const d = await res.json()
  const msg = d.choices[0].message
  assert.match(msg.content, /喵/, "系统提示词必须生效")
  assert.ok(msg.reasoning_content?.length > 0, "思考必须可见")
  assert.match(d.model, /^deepseek/, `实际模型名不对：${d.model}`)
})

test("端到端：流式 SSE + 思考 delta", { skip: !ready && "未设置凭据" }, async () => {
  const { MarvisAuthPlugin } = await import("../index.mjs")
  const plugin = await MarvisAuthPlugin({})
  const loader = await plugin.auth.loader(async () => AUTH)

  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro-external",
      messages: [{ role: "user", content: "数到3" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /event-stream/, "流式必须归一化成 SSE")

  let chunks = 0
  let sawReasoning = false
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks++
    if (dec.decode(value, { stream: true }).includes('"reasoning_content"')) sawReasoning = true
  }
  assert.ok(chunks > 3, `流式帧太少：${chunks}`)
  assert.ok(sawReasoning, "流式里必须能看到 reasoning_content")
})

test("端到端：工具调用", { skip: !ready && "未设置凭据" }, async () => {
  const { MarvisAuthPlugin } = await import("../index.mjs")
  const plugin = await MarvisAuthPlugin({})
  const loader = await plugin.auth.loader(async () => AUTH)

  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro-external",
      messages: [{ role: "user", content: "北京天气怎么样？用工具查" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "查天气",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
      stream: false,
    }),
  })
  assert.equal(res.status, 200)
  const d = await res.json()
  assert.equal(d.choices[0].finish_reason, "tool_calls")
  const call = d.choices[0].message.tool_calls?.[0]
  assert.ok(call, "必须返回 tool_calls")
  assert.equal(JSON.parse(call.function.arguments).city, "北京")
})

test("端到端：令牌钱包额度", { skip: !ready && "未设置凭据" }, async () => {
  const { MarvisAuthPlugin } = await import("../index.mjs")
  const plugin = await MarvisAuthPlugin({})
  const u = await plugin.auth.usage(async () => AUTH)
  assert.equal(u.error, undefined, `读取额度失败：${u.error}`)
  assert.ok(u.windows.length > 0)
  assert.ok(Number.isFinite(u.windows[0].used), "窗口必须有 used（否则路由不计入）")
})
