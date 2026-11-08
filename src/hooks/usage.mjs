// ⑤ auth.usage —— 卡片上的额度窗口
//
// Marvis 的额度是**令牌钱包**：总额 10,000,000 tokens，用掉多少、剩多少。
// 上游 `POST /v3/marvis_get_wallet` 返回：
//   { total_tokens, used_tokens, frozen_tokens, avail_tokens, total_cost, status }
//
// ⚠ 窗口一律交给 src/quota.mjs 的构造器生成（这里只给**原始字段**，不要自己先构造一遍）。
//   它会拦下：缺 used、aside 带 amount/limit、时间不是 ISO —— 这五类写法不会抛错，
//   只会让卡片显示「剩余额度未知」，而这个号在智能路由里等于不存在（HOOKS §三）。

import { usage as buildUsage, usageWindow } from "../quota.mjs"
import { businessHeaders } from "../marvis/protocol.mjs"
import { BASE } from "../context.mjs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const WALLET_URL = `${BASE}/v3/marvis_get_wallet`

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "0")

/**
 * 上游失败时留一份现场（不含 token），方便排查「卡片刻度不更新」。
 * @param {string} openid 账号标识 —— 文件名带账号，多账号不互相覆盖（AGENTS 坑 16）
 * @param {unknown} err
 */
function recordFailure(openid, err) {
  try {
    const { mkdirSync, writeFileSync } = require("node:fs")
    const { homedir } = require("node:os")
    const { join } = require("node:path")
    const dir = join(homedir(), ".cache", "magpie")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `marvis-wallet-error__${openid}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), message: String(/** @type {any} */ (err)?.message ?? err) }, null, 2)}\n`,
    )
  } catch {
    /* 写不进去就算了，别因为诊断把主流程搞挂 */
  }
}

/**
 * 钱包结果缓存：magpie 刷新卡片很频繁，不能每次都实打上游
 * （每发一发就是一次新签名的 POST，被 WAF 盯上的概率随刷新频率线性涨）。
 * 成功 60s、失败 5s，同 openid 的并发共享同一个在途请求。
 * @type {Map<string, { at: number, ttl: number, p: Promise<{ error: string, windows: unknown[] }> }>}
 */
const cache = new Map()

/**
 * @param {string} openid
 * @param {() => Promise<{ error: string, windows: unknown[] }>} load
 */
function cachedWallet(openid, load) {
  const hit = cache.get(openid)
  const now = Date.now()
  if (hit && hit.at + hit.ttl > now) return hit.p
  const p = load().then(
    (r) => {
      cache.set(openid, { at: Date.now(), ttl: 60_000, p: Promise.resolve(r) })
      return r
    },
    (r) => {
      cache.set(openid, { at: Date.now(), ttl: 5_000, p: Promise.resolve(r) })
      return r
    },
  )
  cache.set(openid, { at: now, ttl: 60_000, p })
  return p
}

export function usageHook() {
  return async (getAuth) => {
    const auth = await getAuth()
    const meta = auth?.metadata ?? {}
    const acct = {
      openid: String(meta.openid ?? ""),
      accessToken: String(auth?.access ?? auth?.key ?? ""),
      guid: String(meta.guid ?? ""),
      loginType: String(meta.loginType ?? "1"),
    }
    if (!acct.accessToken || !acct.openid) {
      return { error: "尚未登录 Marvis", windows: [] }
    }

    const load = async () => {
      /** @type {any} */
      let wallet
      try {
        const body = "{}"
        const res = await fetch(WALLET_URL, {
          method: "POST",
          headers: businessHeaders(acct, { query: body, method: "POST" }),
          body,
          signal: AbortSignal.timeout(15_000),
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
        wallet = JSON.parse(text)?.data
        if (!wallet) throw new Error(`返回体没有 data：${text.slice(0, 200)}`)
      } catch (err) {
        recordFailure(acct.openid, err)
        // 读取失败不要把整次判死：返回空窗口 + error，magpie 会保留旧值
        return { error: `读取令牌钱包失败：${/** @type {any} */ (err)?.message ?? err}`, windows: [] }
      }

      const total = Number(wallet.total_tokens ?? 0)
      const used = Number(wallet.used_tokens ?? 0)
      const avail = Number(wallet.avail_tokens ?? Math.max(0, total - used))
      const frozen = Number(wallet.frozen_tokens ?? 0)

      // 钱包总额为 0 / 缺失：不能拿 0 当 limit 进构造器（quota.mjs 会抛 QuotaShapeError，
      // 而抛异常会让卡片和路由一起断）。返回 error 让 magpie 保留旧值。
      if (!(total > 0)) {
        return { error: "钱包总额为 0 或缺失，额度窗口不可用", windows: [] }
      }

      return buildUsage({
        plan: "Marvis 令牌",
        windows: [
          // 主窗口：数量型（amount + limit）。路由排序读的就是它。
          usageWindow({
            name: "令牌用量",
            amount: used,
            limit: total,
            unit: "tokens",
            display: `${fmt(avail)} 可用 / 共 ${fmt(total)}`,
          }),
          // 冻结额度单独一条，只上卡片（不影响路由）
          ...(frozen > 0
            ? [usageWindow({ name: "冻结中", textOnly: true, display: `冻结 ${fmt(frozen)}` })]
            : []),
        ],
      })
    }

    return cachedWallet(acct.openid, load)
  }
}
