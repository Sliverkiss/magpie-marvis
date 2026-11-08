// tests/tool-schema.test.mjs —— Marvis 工具 schema 兼容
//
// 实测：DSH 的 bash 工具 parameters 省略了 type:"object"，Marvis 直接 400
// invalid parameter；补上后 57 个工具 + reasoning_effort + 流式全部 200。

import test from "node:test"
import assert from "node:assert/strict"

import { withObjectType, normalizeTools } from "../src/marvis/tool-schema.mjs"

const BASH = {
  type: "function",
  function: {
    name: "bash",
    description: "run",
    parameters: {
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        description: { type: "string" },
        idle_seconds: { maximum: 900, minimum: 1, type: "integer" },
      },
      required: ["command", "description"],
    },
  },
}

test("缺少 type 的 parameters 补成 object，且不动 additionalProperties", () => {
  const out = withObjectType(BASH.function.parameters)
  assert.equal(out.type, "object")
  assert.equal(out.additionalProperties, false)
  assert.deepEqual(out.required, ["command", "description"])
  assert.equal(out.properties.command.type, "string")
})

test("递归补嵌套 object", () => {
  const schema = {
    properties: {
      opts: { properties: { level: { type: "integer" } } },
      list: { type: "array", items: { properties: { x: { type: "string" } } } },
    },
  }
  const out = withObjectType(schema)
  assert.equal(out.type, "object")
  assert.equal(out.properties.opts.type, "object")
  assert.equal(out.properties.list.items.type, "object")
})

test("已经有 type 时原样返回（同一引用）", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } }
  assert.equal(withObjectType(schema), schema)
})

test("normalizeTools：只改需要改的工具，返回新数组", () => {
  const typed = { type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }
  const out = normalizeTools([BASH, typed])
  assert.notEqual(out, undefined)
  assert.equal(out[0].function.parameters.type, "object")
  assert.equal(out[1], typed, "已合规的工具保持原对象")
})

test("normalizeTools：全部合规时返回原数组", () => {
  const tools = [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }]
  assert.equal(normalizeTools(tools), tools)
  assert.equal(normalizeTools(undefined), undefined)
})
