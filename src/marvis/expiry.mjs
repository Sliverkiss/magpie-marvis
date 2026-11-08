// 上游「有效期」的归一 —— 只做一件事：把响应里的时间字段算成**绝对毫秒时间戳**
//
// ⚠ 为什么要单独一个文件（2026-11-07 的真实事故）：
//   上游两条链路给的字段**语义不同**，以前被混在同一个 `> 1e9` 判断里：
//
//   | 字段 | 语义 | 实测值 |
//   |---|---|---|
//   | `access_token_expire_time` | **绝对**时间（秒 10 位 / 毫秒 13 位） | `1796545945` |
//   | `expires_in` | **相对**秒数 | QQ `2591962`（≈30 天）/ 微信 `7200`（**2 小时**） |
//
//   旧写法 `expire > 1e9 ? expire * 1000 : Date.now() + 30 天`：
//   · QQ 的 `2591962` 不满足 `> 1e9` → 回退「30 天后」→ **碰巧对**
//   · 微信的 `7200` 也不满足 → 回退「30 天后」→ **错 60 倍**：
//     token 2 小时就过期，而插件以为还有 30 天，于是**从不主动续期**，
//     到期后上游 401「登录态过期/未登录」。
//
//   这就是「微信账号被踢下线、QQ 却正常」的直接原因之一。
//   （QQ 不是没问题，只是 30 天还没走完 —— 走完一样会挂。）

/** 上游一个都不给时的兜底：30 天 */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000

/** 微信侧的 `expires_in` 只有 2 小时（实测 7200）；导入型登录态拿不到真实值时按它兜底 */
export const WX_TTL_MS = 2 * 60 * 60_000

/**
 * 把上游返回的登录态算成**绝对毫秒时间戳**。
 *
 * 优先顺序：`access_token_expire_time`（绝对）→ `expires_in`（相对）→ `fallbackMs`。
 *
 * @param {any} info 上游 `user_info`（或等价对象）
 * @param {{ fallbackMs?: number, now?: number }} [opts]
 *   `fallbackMs`：两个字段都没有时的兜底 TTL；`now`：可注入的当前时间（测试用）
 * @returns {number} 绝对毫秒时间戳
 */
export function expiresAtOf(info, { fallbackMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  // ① 绝对时间戳：13 位毫秒原样用，10 位秒乘 1000
  const abs = Number(info?.access_token_expire_time ?? 0)
  if (Number.isFinite(abs) && abs > 0) return abs > 1e12 ? abs : abs * 1000

  // ② 相对秒数
  const rel = Number(info?.expires_in ?? 0)
  if (Number.isFinite(rel) && rel > 0) return now + rel * 1000

  // ③ 都没给
  return now + fallbackMs
}

/**
 * 按登录方式给兜底 TTL —— 只用于拿不到 `expires_in` 的导入路径。
 *
 * ⚠ 微信是 2 小时、QQ 是 30 天，差 360 倍；用同一个兜底必然错一边。
 *
 * @param {unknown} loginType `"1"`/`"2"`/`"QC"`/`"WX"`
 * @returns {number} 毫秒
 */
export function ttlFor(loginType) {
  const s = String(loginType ?? "").toUpperCase()
  return s === "2" || s === "WX" || s === "WXAPP" ? WX_TTL_MS : DEFAULT_TTL_MS
}
