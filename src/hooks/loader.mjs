// ④ auth.loader —— 接管所有出站请求
//
// 这里只做四件事：
//   1. 每次请求**现签一个 uskey**（同一 uskey 只给 2 次，第 3 次 403）
//   2. 换成这个账号的 Ual-Access-* 头（模型网关不认 Bearer，只认这套）
//   3. 把「模型不可用」翻成 404、「登录失效」翻成 401 + X-Magpie-Sign-In: expired
//   4. **把 Response 原样交回去** —— 绝不在 fetch 里读流（读了就是「只有第一段就结束」）
//
// ⚠ 实测：把 UAL 签名头（md5 body+ts+accessKey+nonce）加到模型网关上是**错的** ——
//   会从 403 风控变成 401 登录态过期。那套只用于 /v3/*。

import { BASE_V1, DEFAULT_MODEL, canonicalModelId } from "../context.mjs"
import { llmHeaders } from "../marvis/protocol.mjs"
import { normalizeTools } from "../marvis/tool-schema.mjs"
import { beaconStatus } from "../native.mjs"

/** 上游说「模型不行」的措辞 */
const MODEL_ISSUE =
  /model.*not (found|exist|allowed|available)|no such model|不支持.*模型|模型.*(不存在|未开通|不可用)|4100402/i

/** 风控（uskey 配额用完 / 缺 MarvisExt）—— 可重试，但要换新 uskey */
const RISK_BLOCK = /4100404|风控拦截/

/** 登录态过期 */
const AUTH_EXPIRED = /4100403|登录态过期|未登录/

/**
 * 构造一个错误 Response。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { type: "upstream_error", code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** 从账号凭据里取模型网关要的四件套 */
function credsOf(auth) {
  const meta = auth?.metadata ?? {}
  return {
    openid: String(meta.openid ?? auth?.uid ?? ""),
    accessToken: String(auth?.access ?? auth?.key ?? ""),
    guid: String(meta.guid ?? ""),
    loginType: String(meta.loginType ?? "1"),
  }
}

export function loaderHook() {
  return async (getAuth) => {
    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds.accessToken || !creds.openid) {
      return {}
    }

    return {
      baseURL: BASE_V1,
      apiKey: "placeholder",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

        // 非补全请求（/models 之类）原样放行 —— 上游没有这个端点，交给上层兜底
        if (!/\/chat\/completions\b/.test(url)) {
          return fetch(input, init)
        }

        // ⚠ 每次都要重新算头：uskey 是一次性的
        //
        // 0.2.16 以前这里 catch 住就回 503 `native_unavailable` —— 于是
        // 「native/ 是 Windows 二进制」被误报成「上游连不上」，macOS / Linux
        // 上所有账号全挂。现在 `llmHeaders()` 保证不抛（uskey 取不到就发空串），
        // catch 只留作最后一道防线，并且不再短路整个请求。
        let headers
        try {
          headers = llmHeaders(creds, {
            scene: "preload_summary",
            agentTag: "auto_discovery",
          })
        } catch (err) {
          return errorResponse(
            503,
            "header_build_failed",
            `构造 Marvis 请求头失败：${/** @type {any} */ (err)?.message ?? err}`,
          )
        }

        // 保留调用方传的 stream / 业务体，只换鉴权头
        const merged = { ...(init?.headers ?? {}) }
        for (const [k, v] of Object.entries(headers)) merged[k] = v

        // ⚠ 旧路由里模型 ID 是数组下标 `"0"…"7"`，上游只认槽位名。
        //   在这里做一次归一，旧路由不改配置也能继续用。
        let body = init?.body
        /** 请求是不是要流式。`undefined` = body 不是 JSON，判不出来 */
        let wantStream
        if (typeof body === "string") {
          try {
            const json = JSON.parse(body)
            wantStream = json.stream === true
            let changed = false
            const canonical = canonicalModelId(json.model)
            if (canonical !== json.model) {
              json.model = canonical
              changed = true
            }
            // Marvis 要求每个工具 parameters 显式 type:"object"；
            // DSH 的部分工具省略了它，缺一个就 400 invalid parameter。
            const tools = normalizeTools(json.tools)
            if (tools !== json.tools) {
              json.tools = tools
              changed = true
            }
            if (changed) {
              body = JSON.stringify(json)
              // body 变了，长度头必须去掉，让 fetch 重新算
              delete merged["content-length"]
              delete merged["Content-Length"]
              delete merged["content-encoding"]
              delete merged["Content-Encoding"]
            }
          } catch {
            /* 不是 JSON 就原样转发 */
          }
        }

        let response
        try {
          response = await fetch(url, { ...init, ...(body === init?.body ? {} : { body }), headers: merged })
        } catch (err) {
          return errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${err?.message ?? err}`)
        }

        if (response.ok) {
          // 上游给流式响应时带的是 `text/plain` —— 但 body 是标准 SSE。
          // 部分 OpenAI SDK 版本按 content-type 决定走不走 SSE 解析器，所以这里归一化。
          // ⚠ 只在请求明确要流式（wantStream === true）时才标 SSE：
          //   非流式响应是整体 JSON，标成 event-stream 会让客户端拿 JSON 喂 SSE 解析器。
          //   body 判不出（undefined）时保守归一化，维持旧行为。
          const ct = response.headers.get("content-type") ?? ""
          if (response.body && wantStream !== false && !/event-stream/i.test(ct)) {
            const headers = new Headers(response.headers)
            headers.set("content-type", "text/event-stream; charset=utf-8")
            return new Response(response.body, { status: response.status, headers })
          }
          return response
        }

        // —— 错误分流：只读 **错误** 的 body（成功响应绝不读，见文件头 ⚠）——
        let text = ""
        try {
          text = await response.clone().text()
        } catch {
          /* 读不出来就按状态码判 */
        }

        if (AUTH_EXPIRED.test(text) || response.status === 401) {
          return errorResponse(401, "sign_in_expired", "Marvis 登录态已过期，请重新登录。", {
            "X-Magpie-Sign-In": "expired",
          })
        }
        if (RISK_BLOCK.test(text)) {
          // 风控可重试：换新 uskey 就能过，交给宿主重试
          //
          // ⚠ 0.2.16 起本机签不出 uskey 时 newUskey() 每次返回**新随机值**，
          //   每个新值一个新的风控配额桶 —— 非 Windows 上重试是有效的，会换新桶。
          const beacon = beaconStatus()
          const why = beacon.ok ? "" : `（本机用降级 uskey，重试会自动换新值，通常直接重试即可：${beacon.reason}）`
          return errorResponse(
            503,
            "risk_blocked",
            `上游风控拦截（通常是一次性 uskey 用完了，重试即可）${why}：${text.slice(0, 300)}`,
          )
        }
        if (MODEL_ISSUE.test(text) || response.status === 404) {
          // 模型级错误 → 404，只搁置这个模型，不打死账号（AGENTS 坑 6）
          return errorResponse(404, "model_unavailable", `该模型在当前账号不可用：${text.slice(0, 300)}`)
        }
        // 其余原样透出
        return new Response(text || null, {
          status: response.status,
          headers: response.headers,
        })
      },
    }
  }
}

export { DEFAULT_MODEL, credsOf }
