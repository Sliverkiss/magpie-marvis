// ① config —— 声明 provider 与静态模型表
//
// ⚠ `config.models` 必须有内容：它是**没人登录时**模型列表的唯一来源，
//   空了就是「插件装上了但显示 0 models」。
//
// ⚠⚠ **模型表是对象，键是槽位名**（`cfg.models[<id>]`）。写成数组会被 magpie
//   存成数组下标 `"0"…"7"`，路由里显示 `0`、请求发 `model:"0"`，上游 400。
//
// ⚠⚠ **用户在 magpie 设置里改过的值优先，插件不许覆盖。**
//   宿主把用户改过的 provider 配置原样传进来（`cfg.provider[PROVIDER]`），
//   我们要做的是「**补齐缺失**」，不是「重置成默认」。
//
// 合并规则（逐模型、逐字段）：
//   · 用户有的字段 → 保留用户的（`limit.context` / `limit.output` / `modalities` / `name` …）
//   · 用户没有的字段 → 用默认值补
//   · 默认表里有、用户配置里没有的模型 → 追加（新版本新增模型能自动出现）
//   · 旧版数组形态（下标 `"0"…"7"`）→ 按 TABLE 顺序认回槽位名

import { PROVIDER, PROVIDER_NAME, SDK, BASE_V1, staticModels, canonicalModelId, displayModelId } from "../context.mjs"

/** 合并一个模型：用户字段优先，缺的用默认值补；id 一律用槽位名 */
function mergeModel(userModel, defaultModel, id) {
  const merged = { ...(defaultModel ?? {}), ...(userModel ?? {}) }
  merged.id = id
  merged.apiId = canonicalModelId(userModel?.apiId ?? defaultModel?.apiId ?? id)

  // limit 逐字段合并 —— 只改 context 的用户不该把 output 也吃掉
  merged.limit = { ...(defaultModel?.limit ?? {}), ...(userModel?.limit ?? {}) }

  // config 形状用 modalities 数组 + tool_call 下划线；用户可能只改了其中一个
  if (userModel?.modalities || defaultModel?.modalities) {
    merged.modalities = {
      ...(defaultModel?.modalities ?? {}),
      ...(userModel?.modalities ?? {}),
    }
  }
  return merged
}

/**
 * 合并模型表。
 *
 * @param {Record<string, any>} defaults 插件内置的默认表（对象）
 * @param {Record<string, any> | any[] | undefined} user 宿主里用户改过的表（对象；旧版可能是数组）
 * @returns {Record<string, any>}
 */
export function mergeModels(defaults, user) {
  const defaultIds = Object.keys(defaults)
  /** @type {Record<string, any>} */
  const out = {}
  const seen = new Set()

  if (Array.isArray(user)) {
    // 旧版：数组下标就是 TABLE 顺序。按位置认回槽位名，字段仍用用户的。
    user.forEach((um, index) => {
      if (!um) return
      const id = defaultIds[index] ?? displayModelId(um?.id ?? index)
      const dm = defaults[id]
      out[id] = mergeModel(um, dm, id)
      seen.add(id)
    })
  } else if (user && typeof user === "object") {
    for (const [key, um] of Object.entries(user)) {
      if (!um || typeof um !== "object") continue
      // 兼容 `id` 缺失或 旧数字 id 的对象键
      // 键可能是显示名、旧槽位名（main-auto）、旧数字下标；都归一成显示名
      const candidates = [key, um.id].filter(Boolean)
      const id =
        candidates.map((x) => displayModelId(x)).find((x) => defaults[x]) ??
        displayModelId(um.id ?? key)
      out[id] = mergeModel(um, defaults[id], id)
      seen.add(id)
    }
  }

  // 默认表里有、用户没有的 → 追加（新版本新增的模型）
  for (const id of defaultIds) {
    if (!seen.has(id)) out[id] = mergeModel(undefined, defaults[id], id)
  }
  return out
}

export function configHook() {
  return async (cfg) => {
    cfg.provider ??= {}
    const existing = cfg.provider[PROVIDER]

    if (!existing) {
      cfg.provider[PROVIDER] = {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE_V1,
        models: staticModels(),
      }
      return
    }

    // 已有配置：只补缺，用户改过的优先
    existing.name ??= PROVIDER_NAME
    existing.npm ??= SDK
    existing.api ??= BASE_V1
    existing.models = mergeModels(staticModels(), existing.models)
  }
}
