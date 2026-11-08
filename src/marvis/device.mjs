// 虚拟设备 —— 给每个账号一个独立的设备标识
//
// ⚠ 实测结论：Marvis 上游把 token 绑定在 `guid` 上，不是 qimei36 / nonce：
//   · 同一 token + 原 guid → 200
//   · 同一 token + 随机 guid → 401
//   · 同一 token + 随机 qimei36 / nonce（guid 不变）→ 200
//
// 客户端默认所有账号共用本机 `svid`，所以**新号登录会把旧号顶掉**
// （同一 guid 只保留一个有效登录态）。给每个账号分配独立 guid，
// 相当于给每个号一台“虚拟设备”，多个号就能并存。
//
// 这里只负责**生成 guid**和**登录过程中的临时映射**：
//   · `authorize()` 生成 guid，按 OAuth state 暂存；
//   · `callback()` 用 state 取回同一个 guid，再交给换取请求；
//   · 成功后 guid 由 `authOf()` 写进账号 metadata，后续请求一直用它。

import { randomBytes } from "node:crypto"

/** 生成一个 32 位小写 hex 的设备 guid（与 Marvis 的 svid 同形状） */
export function newDeviceGuid() {
  return randomBytes(16).toString("hex")
}

/**
 * 登录过程中的 state → guid 暂存表。
 *
 * 为什么需要它：QQ 的 `state` 原本是随机小数，不能把 guid 塞进去改变官方参数形状；
 * 而 `authorize()` 与 `callback()` 是两次独立调用，中间不能靠模块级“当前账号”变量
 * （宿主同进程跑所有账号，会串号）。用 state 做 key 是唯一不改变请求格式的关联方式。
 *
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 */
export function createDeviceRegistry({ ttlMs = 10 * 60_000, now = Date.now } = {}) {
  /** @type {Map<string, { guid: string, at: number }>} */
  const map = new Map()

  const prune = () => {
    const t = now()
    for (const [k, v] of map) {
      if (t - v.at > ttlMs) map.delete(k)
    }
  }

  return {
    /**
     * @param {string} state
     * @param {string} guid
     */
    remember(state, guid) {
      if (!state || !guid) return
      prune()
      map.set(String(state), { guid: String(guid), at: now() })
    },

    /**
     * 取出并删除（一次性）。
     * @param {string} state
     * @returns {string} 没有就返回空串
     */
    take(state) {
      if (!state) return ""
      prune()
      const hit = map.get(String(state))
      if (!hit) return ""
      map.delete(String(state))
      return hit.guid
    },

    /** 当前暂存数量（测试/诊断用） */
    get size() {
      prune()
      return map.size
    },
  }
}

/**
 * 从 URL 里取 OAuth state。
 * @param {string} url
 * @returns {string}
 */
export function stateOfUrl(url) {
  try {
    return new URL(String(url)).searchParams.get("state") ?? ""
  } catch {
    return ""
  }
}
