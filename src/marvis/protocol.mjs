// Marvis 上游协议 —— 请求头与签名
//
// 两个上游，两套鉴权，**不能混**：
//   /v1/chat/completions  模型网关 → 只要 Ual-Access-Openid/Access-Token/Login-Type/Guid
//                                       + Ual-Access-MarvisExt（uskey 指纹）。**不要**签名。
//   /v3/*                 业务接口 → 要 md5(query + timestamp + accessKey + nonce) 签名。
//
// 把签名头加到模型网关上是**错**的：会从 403 风控变成 401 登录态过期（实测）。
//
// ⚠ 模型网关的 UA 必须是 `AsyncOpenAI/Python 2.32.0`（Marvis agent 自己的）。
//   换成浏览器 UA 或 magpie 自己的 UA 都会被风控拦（4100404）。

import { createHash, randomUUID } from "node:crypto"
import { ACCESS_KEY, BUSINESS_ID, CLIENT, BROWSER_UA, BASE } from "../context.mjs"
import { newUskey, qimei36 } from "../native.mjs"

/**
 * 模型网关要求的 `Ual-Access-MarvisExt` 值。
 *
 * 字段来源（照抄 Marvis agent 的 `build_llm_auth_headers`）：
 *   qimei36 / osVersion / guid / uskey（现签）/ nonce / reqScene / taskType / clientVersion / isIoa
 *
 * ⚠ **这个函数绝不抛错。** `uskey` / `qimei36` 都来自 `native/` 里的 Windows
 *   二进制，在 macOS / Linux 上必然取不到 —— 0.2.16 以前这里一抛，loader 就回 503，
 *   把「平台降级」误报成「上游不可用」。现在降级是：uskey 每请求一个新随机值
 *   （新风控配额桶，实测上游照样 200）、qimei36 空串，所以降级是安全的。
 *
 * @param {{ guid: string, clientVersion?: string }} acct
 * @returns {string} 紧凑 JSON（不能有空格，服务端按原文字符串校验）
 */
export function marvisExt(acct) {
  return JSON.stringify({
    qimei36: qimei36(),
    osVersion: "Windows-10-10.0.26200",
    guid: acct.guid ?? "",
    uskey: newUskey(BUSINESS_ID),
    nonce: randomUUID(),
    reqScene: 1,
    taskType: "user",
    clientVersion: acct.clientVersion ?? "1.60.3300.765",
    isIoa: false,
  })
}

/**
 * 模型网关的完整请求头。
 *
 * @param {{ openid: string, accessToken: string, guid: string, loginType?: string }} acct
 * @param {{ scene?: string, agentTag?: string, conversationId?: string, responseId?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function llmHeaders(acct, opts = {}) {
  const ext = marvisExt(acct)
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": CLIENT,
    "X-Stainless-Lang": "python",
    "X-Stainless-Package-Version": "2.32.0",
    "X-Stainless-OS": "Windows",
    "X-Stainless-Arch": "other:amd64",
    "X-Stainless-Runtime": "CPython",
    "X-Stainless-Runtime-Version": "3.11.9",
    "X-Stainless-Async": "async:asyncio",
    "X-Stainless-Raw-Response": "true",
    Authorization: "Bearer placeholder",
    "Ual-Access-Openid": acct.openid,
    "Ual-Access-Access-Token": acct.accessToken,
    "Ual-Access-Login-Type": acct.loginType ?? "1",
    "Ual-Access-Guid": acct.guid ?? "",
    "Marvis-AgentTag": opts.agentTag ?? "auto_discovery",
    "Marvis-Conversation-ID": opts.conversationId ?? "",
    "Marvis-Response-ID": opts.responseId ?? "",
    "Marvis-Scene": opts.scene ?? "preload_summary",
    "Marvis-Protocol-Version": "1000",
    "X-Device-GUID": acct.guid ?? "",
    "Ual-Access-MarvisExt": ext,
  }
}

/**
 * `/v3/*` 业务接口的签名。
 *
 * 逆向自 Marvis 主进程：`md5(query + timestamp + accessKey + nonce)`，
 * accessKey 硬编码在渲染层（`fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi`）。
 * 实测重放真实请求返回 200。
 *
 * @param {string} query 签名原文 —— GET 是查询串（不含 `?`），POST 是 JSON body
 * @param {string} timestamp 毫秒时间戳
 * @param {string} nonce 4 位随机数
 * @returns {string} 32 位小写 hex
 */
export function ualSignature(query, timestamp, nonce) {
  return createHash("md5").update(query + timestamp + ACCESS_KEY + nonce).digest("hex")
}

/**
 * `/v3/*` 业务接口的完整请求头。
 *
 * @param {{ openid: string, accessToken: string, guid: string, loginType?: string }} acct
 * @param {{ query: string, method?: string }} opts
 * @returns {Record<string, string>}
 */
export function businessHeaders(acct, { query, method = "GET" }) {
  const timestamp = String(Date.now())
  const nonce = String(1000 + Math.floor(Math.random() * 9000))
  return {
    Accept: "*/*",
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": BROWSER_UA,
    "Ual-Access-Businessid": BUSINESS_ID,
    "Ual-Access-Timestamp": timestamp,
    "Ual-Access-Nonce": nonce,
    "Ual-Access-Signature": ualSignature(query, timestamp, nonce),
    "Ual-Access-Guid": acct.guid ?? "",
    "Ual-Access-Access-Token": acct.accessToken,
    "Ual-Access-Login-Type": acct.loginType ?? "1",
    "Ual-Access-Openid": acct.openid,
    ...(method === "POST" ? {} : {}),
  }
}

/** 模型网关地址 */
export const CHAT_URL = `${BASE}/v1/chat/completions`
