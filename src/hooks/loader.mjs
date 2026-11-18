// ④ auth.loader —— 接管所有出站请求
//
// 这里只做五件事：
//   1. 每次请求**现签一个 uskey**（同一 uskey 只给 2 次，第 3 次 403）
//   2. 换成这个账号的 Ual-Access-* 头（模型网关不认 Bearer，只认这套）
//   3. 把「模型不可用」翻成 404、「登录失效」翻成 401 + X-Magpie-Sign-In: expired
//   4. **200 也要先看一眼 body**：上游会把风控 `4100404` 放在 **200** 里返回
//   5. **把 Response 原样交回去** —— 绝不在 fetch 里读流再重放整条
//
// ⚠ 实测：把 UAL 签名头（md5 body+ts+accessKey+nonce）加到模型网关上是**错**的 ——
//   会从 403 风控变成 401 登录态过期。那套只用于 /v3/*。
//
// ⚠ 200 里藏错误（0.2.19 修复）：风控 4100404 是 `200 {"code":4100404,...}` 回来的。
//   0.2.18 及以前只在 `!response.ok` 时才读 body，错误 body 被原样交给宿主 →
//   宿主解析不出 choices → 表现为「200 之后 2~3 分钟 EOF」，用户看不到真正的原因。
//   现在成功响应先 **peek**（读到头就停，边读边判），
//   判成答案就把已经读出来的字节 + 剩下的流拼回去，一个字节不丢。
//   判成错误就按错误分流，风控再换新 uskey 重试一次。

import { BASE_V1, DEFAULT_MODEL, canonicalModelId } from "../context.mjs"
import { llmHeaders } from "../marvis/protocol.mjs"
import { normalizeTools } from "../marvis/tool-schema.mjs"
import { beaconStatus } from "../native.mjs"
import { PEEK_LIMIT, classifyBody, errorKind } from "../marvis/error-branch.mjs"

/** 被风控时最多再试几次（每次都会换新签的 uskey） */
const RISK_RETRIES = 1

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

/**
 * 上游错误 body → 给宿主的 Response。
 *
 * ⚠ 只读**错误**的 body（成功响应绝不整段读，见文件头）。
 *
 * @param {string} kind `errorKind()` 的返回值（非 null）
 * @param {string} text
 */
function branchError(kind, text) {
  const tail = text.slice(0, 300)
  if (kind === "auth") {
    return errorResponse(401, "sign_in_expired", "Marvis 登录态已过期，请重新登录。", {
      "X-Magpie-Sign-In": "expired",
    })
  }
  if (kind === "risk") {
    // 风控可重试：换新 uskey 就能过，交给宿主重试
    //
    // ⚠ 0.2.16 起本机签不出 uskey 时 newUskey() 每次返回**新随机值**，
    //   每个新值一个新的风控配额桶 —— 非 Windows 上重试是有效的，会换新桶。
    const beacon = beaconStatus()
    const why = beacon.ok ? "" : `（本机用降级 uskey，重试会自动换新值，通常直接重试即可：${beacon.reason}）`
    return errorResponse(
      503,
      "risk_blocked",
      `上游风控拦截（一次性 uskey 用完或被拒）${why}：${tail}`,
    )
  }
  if (kind === "model") {
    // 模型级错误 → 404，只搁置这个模型，不打死账号（AGENTS 坑 6）
    return errorResponse(404, "model_unavailable", `该模型在当前账号不可用：${tail}`)
  }
  return errorResponse(502, "upstream_error", `Marvis 上游返回错误：${tail}`)
}

/**
 * 边读边判：读到「是答案」或「是错误」就停，返回已经读出来的部分。
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 */
async function peek(reader) {
  const decoder = new TextDecoder()
  /** @type {Uint8Array[]} */
  const chunks = []
  let text = ""
  let done = false

  for (;;) {
    const verdict = classifyBody(text, done)
    if (verdict !== "pending") return { verdict, chunks, text, reader }
    if (text.length >= PEEK_LIMIT) {
      // 读满上限还没有答案也没有错误：交给调用方按「不是错误」处理
      return { verdict: "unknown", chunks, text, reader }
    }
    const r = await reader.read()
    if (r.done) {
      done = true
      continue
    }
    chunks.push(r.value)
    text += decoder.decode(r.value, { stream: true })
  }
}

/**
 * 把 peek 读掉的字节接回剩下的流。
 *
 * @param {Uint8Array[]} chunks
 * @param {ReadableStreamDefaultReader<Uint8Array> | null} reader
 * @param {Headers} headers
 * @param {number} status
 */
function replay(chunks, reader, headers, status) {
  const out = new Headers(headers)
  // body 是重新拼的，长度和编码头都不再成立
  out.delete("content-length")
  out.delete("Content-Length")
  out.delete("content-encoding")
  out.delete("Content-Encoding")

  let i = 0
  const stream = new ReadableStream({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
        return
      }
      try {
        const r = reader ? await reader.read() : { done: true }
        if (r.done) {
          controller.close()
          return
        }
        controller.enqueue(r.value)
      } catch (err) {
        controller.error(err)
      }
    },
    cancel(reason) {
      // Node 上对仍活跃的 body 调 cancel 可能挂住，不 await
      void reader?.cancel(reason).catch(() => {})
    },
  })
  return new Response(stream, { status, headers: out })
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
            if (changed) body = JSON.stringify(json)
          } catch {
            /* 不是 JSON 就原样转发 */
          }
        }

        for (let attempt = 0; ; attempt++) {
          // ⚠ 每次都要重新算头：uskey 是一次性的
          //
          // 0.2.16 以前这里 catch 住就回 503 `native_unavailable` —— 于是
          // 「native/ 是 Windows 二进制」被误报成「上游连不上」，macOS / Linux
          // 上所有账号全挂。现在 `llmHeaders()` 保证不抛，
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
          if (body !== init?.body) {
            // body 可能变过长度，让 fetch 自己算
            for (const k of ["content-length", "Content-Length", "content-encoding", "Content-Encoding"]) {
              delete merged[k]
            }
          }

          let response
          try {
            response = await fetch(url, { ...init, ...(body === init?.body ? {} : { body }), headers: merged })
          } catch (err) {
            return errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${err?.message ?? err}`)
          }

          // —— 成功响应：先 peek，可能是答案，也可能是 200 里的错误 ——
          if (response.ok) {
            if (!response.body) return response

            const reader = response.body.getReader()
            let head
            try {
              head = await peek(reader)
            } catch (err) {
              void reader.cancel().catch(() => {})
              return errorResponse(503, "upstream_broken", `读 Marvis 响应失败：${err?.message ?? err}`)
            }

            // 答案（或读满上限仍判不出）：把读掉的字节接回去，原样交还
            if (head.verdict === "answer" || head.verdict === "unknown") {
              // 上游给流式响应时带的是 `text/plain` —— 但 body 是标准 SSE。
              // 部分 OpenAI SDK 版本按 content-type 决定走不走 SSE 解析器，所以这里归一化。
              // ⚠ 只在请求明确要流式（wantStream === true）时才标 SSE：
              //   非流式响应是整体 JSON，标成 event-stream 会让客户端拿 JSON 喂 SSE 解析器。
              //   body 判不出（undefined）时保守归一化，维持旧行为。
              const ct = response.headers.get("content-type") ?? ""
              const headers = new Headers(response.headers)
              if (wantStream !== false && !/event-stream/i.test(ct)) {
                headers.set("content-type", "text/event-stream; charset=utf-8")
              }
              return replay(head.chunks, head.reader, headers, response.status)
            }

            // 200 里是错误：丢掉这条 body，按错误分流
            void head.reader.cancel().catch(() => {})
            if (head.verdict === "risk" && attempt < RISK_RETRIES) continue
            return branchError(head.verdict, head.text)
          }

          // —— 非 2xx：只读**错误**的 body ——
          let text = ""
          try {
            text = await response.clone().text()
          } catch {
            /* 读不出来就按状态码判 */
          }

          const kind = errorKind(response.status, text)
          if (!kind) {
            // 状态码是非 2xx 却没有错误特征：原样透出
            return new Response(text || null, { status: response.status, headers: response.headers })
          }
          if (kind === "risk" && attempt < RISK_RETRIES) continue
          return branchError(kind, text)
        }
      },
    }
  }
}

export { DEFAULT_MODEL, credsOf }
