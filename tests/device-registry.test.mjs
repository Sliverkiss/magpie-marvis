// tests/device-registry.test.mjs —— 每账号虚拟设备 guid 的形状锁
//
// 上游实测：token 绑定 guid；同一 token 换 guid → 401；换 qimei36/nonce → 200。
// 所以「多账号并行」= 每个账号登录时生成独立 guid，并且不能在并发登录间串号。

import test from "node:test"
import assert from "node:assert/strict"

import { createDeviceRegistry, newDeviceGuid, stateOfUrl } from "../src/marvis/device.mjs"

test("newDeviceGuid 是 32 位小写 hex，且每次不同", () => {
  const a = newDeviceGuid()
  const b = newDeviceGuid()
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.match(b, /^[0-9a-f]{32}$/)
  assert.notEqual(a, b)
})

test("registry：state 一次性取出，take 后不再返回", () => {
  const r = createDeviceRegistry()
  r.remember("s1", "g1")
  assert.equal(r.take("s1"), "g1")
  assert.equal(r.take("s1"), "", "同一个 state 不能被取两次")
})

test("registry：并发两个 state 互不覆盖", () => {
  const r = createDeviceRegistry()
  r.remember("s1", "g1")
  r.remember("s2", "g2")
  assert.equal(r.size, 2)
  assert.equal(r.take("s2"), "g2")
  assert.equal(r.take("s1"), "g1")
})

test("registry：超过 TTL 的条目会被清掉", () => {
  let now = 1000
  const r = createDeviceRegistry({ ttlMs: 100, now: () => now })
  r.remember("s1", "g1")
  now = 1101
  assert.equal(r.take("s1"), "")
  assert.equal(r.size, 0)
})

test("stateOfUrl：能取 state，坏 URL 返回空串", () => {
  assert.equal(stateOfUrl("https://x/cb?code=1&state=31.117"), "31.117")
  assert.equal(stateOfUrl("https://x/cb?code=1"), "")
  assert.equal(stateOfUrl("not a url"), "")
})
