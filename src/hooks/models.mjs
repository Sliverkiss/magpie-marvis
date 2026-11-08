// ⑦ provider.models —— 模型目录
//
// Marvis 没有「列模型」的开放接口：模型注册表在客户端自己的
// `_internal/CONFIG`（Fernet 加密的 config_defaults.yaml）里，是**静态**的 25 条。
// 所以这里不做网络请求 —— 静态表就是权威，登录后也不变。
//
// 三态降级里只有一条适用：
//   ③ 登录失效 → 抛带 signIn: "expired" 的错（由 loader 已经分流的 401 触发，这里兜底）
// 「接口失败」「缺字段」两条不适用：没有接口可失败。
//
// ⚠ 返回的是 OpenCode `Model` 形状（`capabilities.input` 是**对象**、`toolcall` 无下划线），
//   跟 `config` 钩子里的静态表（`modalities` 是**数组**、`tool_call` 有下划线）**不是一套**。
//   写混不会报错，只会让能力静默为假（HOOKS 十一之三）。
//
// ⚠ 想加模型？先确认它在 config_defaults.yaml 的注册表里 ——
//   槽位名写错不会报错，只会 4100402 模型不存在。

import { providerModels } from "../context.mjs"

export function modelsHook() {
  return async (_getAuth) => {
    // 登录前后完全一致：目录来自客户端配置，与账号无关
    return providerModels()
  }
}
