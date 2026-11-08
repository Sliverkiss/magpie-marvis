// tool schema 兼容 —— Marvis 的严格校验
//
// 实测（DSH 真实请求，57 个工具）：只要有一个 `function.parameters` 缺少顶层
// `type: "object"`，`/v1/chat/completions` 就返回
//   `{"code":3000101,"msg":"invalid parameter"}`
// 而 OpenAI 兼容端通常容忍省略 type。补上 type 后，`additionalProperties:false`、
// 57 个工具、reasoning_effort、流式全部通过（实测 200）。
//
// 只补缺失的 `type`，不动 `properties` / `required` / `additionalProperties`。

/**
 * 递归补齐对象 schema 的 `type: "object"`。
 *
 * @param {any} schema
 * @returns {any} 原对象（没有改动时）或新对象
 */
export function withObjectType(schema) {
  if (!schema || typeof schema !== "object") return schema
  if (Array.isArray(schema)) {
    let changed = false
    const out = schema.map((x) => {
      const y = withObjectType(x)
      if (y !== x) changed = true
      return y
    })
    return changed ? out : schema
  }

  let changed = false
  /** @type {Record<string, any>} */
  const out = { ...schema }
  if (out.properties && typeof out.properties === "object" && !out.type) {
    out.type = "object"
    changed = true
  }

  for (const key of ["properties", "patternProperties"]) {
    const map = out[key]
    if (!map || typeof map !== "object" || Array.isArray(map)) continue
    /** @type {Record<string, any>} */
    const next = {}
    let mapChanged = false
    for (const [name, child] of Object.entries(map)) {
      const y = withObjectType(child)
      next[name] = y
      if (y !== child) mapChanged = true
    }
    if (mapChanged) {
      out[key] = next
      changed = true
    }
  }

  for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) {
    if (out[key] && typeof out[key] === "object") {
      const y = withObjectType(out[key])
      if (y !== out[key]) {
        out[key] = y
        changed = true
      }
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(out[key])) {
      const y = withObjectType(out[key])
      if (y !== out[key]) {
        out[key] = y
        changed = true
      }
    }
  }

  return changed ? out : schema
}

/**
 * 补齐 tools 数组里每个 function.parameters 的 type。
 * 没有改动时返回原数组，方便调用方判断要不要重写 body。
 *
 * @param {any} tools
 * @returns {any}
 */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return tools
  let changed = false
  const out = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool
    const fn = tool.function
    if (!fn || typeof fn !== "object" || !fn.parameters) return tool
    const params = withObjectType(fn.parameters)
    if (params === fn.parameters) return tool
    changed = true
    return { ...tool, function: { ...fn, parameters: params } }
  })
  return changed ? out : tools
}
