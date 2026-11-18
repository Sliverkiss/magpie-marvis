// 错误分流 —— 纯函数，全部离线
//
// 跑法：node --test tests/error-branch.test.mjs
//
// 这一组守的是 0.2.19 的回归：风控 4100404 是 **200** 回来的，
// 以前 loader 只看 `response.ok`，于是错误 body 被当成正常答案交给宿主。

import test from "node:test"
import assert from "node:assert/strict"

import { classifyBody, errorKind, PEEK_LIMIT } from "../src/marvis/error-branch.mjs"

const RISK = JSON.stringify({ code: 4100404, msg: "客户端通用错误:请求被风控拦截" })
const ANSWER = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "喵" } }] })
const SSE_FIRST = 'data: {"id":"x","model":"deepseek-v4-pro-202606","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n'

test("200 + 风控 body（已读完）→ risk，不能当答案", () => {
  assert.equal(classifyBody(RISK, true), "risk")
})

test("200 + 风控 body（还没读完，但已有一整行）→ 也是 risk", () => {
  assert.equal(classifyBody(`${RISK}\n`, false), "risk")
})

test("200 + 正常非流式 JSON → answer", () => {
  assert.equal(classifyBody(ANSWER, true), "answer")
})

test("200 + 正常非流式 JSON 但还没读完 → pending（等读完）", () => {
  assert.equal(classifyBody(ANSWER, false), "pending")
})

test("流式第一帧有 delta 就立刻判 answer，绝不先吃满 16KiB", () => {
  assert.equal(classifyBody(SSE_FIRST, false), "answer")
})

test("流式思考块（reasoning_content delta）也算答案开头", () => {
  const t = 'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n'
  assert.equal(classifyBody(t, false), "answer")
})

test("流式尾帧只有 [DONE] 没有答案 → error（空回答）", () => {
  assert.equal(classifyBody("data: [DONE]\n\n", false), "error")
})

test("只读到半个 code、没有换行 → pending（别抢跑，msg 还没到）", () => {
  assert.equal(classifyBody('{"code":4100404,"msg":"客户端', false), "pending")
})

test("空的 200 body 读完了 → error", () => {
  assert.equal(classifyBody("", true), "error")
})

test("截断的 JSON（读满了 PEEK_LIMIT）→ error，不是 answer", () => {
  const truncated = ANSWER.slice(0, 20)
  assert.equal(classifyBody(truncated, true), "error")
  assert.ok(PEEK_LIMIT > 0)
})

test("200 里的登录态过期 / 模型不可用分别归类", () => {
  assert.equal(classifyBody(JSON.stringify({ code: 4100403, msg: "登录态过期" }), true), "auth")
  assert.equal(classifyBody(JSON.stringify({ code: 4100402, msg: "模型不存在" }), true), "model")
})

test("errorKind：401 和 body 里的登录态过期都算 auth", () => {
  assert.equal(errorKind(401, ""), "auth")
  assert.equal(errorKind(400, '{"code":4100403}'), "auth")
})

test("errorKind：状态码 200 且 body 是答案 → null（不是错误）", () => {
  assert.equal(errorKind(200, ANSWER), null)
  assert.equal(errorKind(200, SSE_FIRST), null)
})

test("errorKind：404 → model（只搁置这个模型，不打死账号）", () => {
  assert.equal(errorKind(404, "not found"), "model")
})

test("errorKind：其它 4xx/5xx → error", () => {
  assert.equal(errorKind(500, "boom"), "error")
  assert.equal(errorKind(400, '{"error":{"message":"bad"}}'), "error")
})
