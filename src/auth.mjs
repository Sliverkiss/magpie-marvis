// auth 对象装配 —— 各钩子摆到一起
//
// 数据字段（不是钩子，但决定 UI）：
//   icon           两处必须一致：这里 + package.json 的 magpie.icon
//   maxConcurrency 上游对 uskey 是按次扣的，并发 2 就够（多了只会互相抢配额）
//   refreshLead    距到期多久开始调 refresh（token 30 天，提前 1 天）

import { PROVIDER, ICON, REFRESH_LEAD_MS } from "./context.mjs"
import { methods } from "./hooks/methods.mjs"
import { refreshHook } from "./hooks/refresh.mjs"
import { loaderHook } from "./hooks/loader.mjs"
import { usageHook } from "./hooks/usage.mjs"

export function authHooks() {
  return {
    provider: PROVIDER,
    icon: ICON,
    maxConcurrency: 2,
    refreshLead: REFRESH_LEAD_MS,
    methods: methods(),
    refresh: refreshHook(),
    loader: loaderHook(),
    usage: usageHook(),
  }
}
