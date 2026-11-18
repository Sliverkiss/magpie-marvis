// 上游错误的识别与分流 —— loader 和「200 里藏着的错误」共用这一份
//
// ⚠ 为什么单独成文件：0.2.18 及以前的 loader 只在 `response.ok === false` 时才看 body。
//   实测（2026-11-17 / 18 的 app.log）：风控 `4100404` 是 **200** 回来的，
//   于是那块错误 body 被当成正常响应交给宿主 → 宿主读不到 `choices` →
//   变成「200 之后 2~3 分钟 EOF」，用户只看到超时，看不到「风控」两个字。
//
//   所以识别逻辑必须是**纯函数**，能对 200 的 body 也跑一遍；
//   loader 负责读（可回放地读），这里只负责「这段文字是什么意思」。

/** 上游说「模型不行」的措辞 */
export const MODEL_ISSUE =
  /model.*not (found|exist|allowed|available)|no such model|不支持.*模型|模型.*(不存在|未开通|不可用)|4100402/i

/** 风控（uskey 配额用完 / 缺 MarvisExt）—— 可重试，但要换新 uskey */
export const RISK_BLOCK = /4100404|风控拦截/

/** 登录态过期 */
export const AUTH_EXPIRED = /4100403|登录态过期|未登录/

/** 流式响应最多先读这么多字节再决定「是答案还是错误」 */
export const PEEK_LIMIT = 16 * 1024

/** 上游在 200 里回错误时用的码 */
const ERROR_CODES = /"(?:code|error_code|ret)"\s*:\s*(-?\d{5,}|4100\d{3})/

/** 一段 JSON 里有没有真的答案（`choices` 是数组） */
function looksLikeAnswer(json) {
  return Array.isArray(json?.choices)
}

/**
 * 200 的 body 是「答案」还是「错误」。
 *
 * @param {string} text 已读到的字节（UTF-8 解出来的）
 * @param {boolean} done 流是否已经结束
 * @returns {"answer" | "risk" | "auth" | "model" | "error" | "pending"}
 *   `pending` = 还看不出来，要继续读
 */
export function classifyBody(text, done) {
  if (!text) {
    if (done) return "error"
    return "pending"
  }

  // 流式：任何一帧里已经有答案开头（delta 非空）就算答案，错误不会跟在答案后面
  if (/^data:\s*\{/m.test(text) && /"delta"\s*:\s*\{\s*"(?:content|reasoning_content|tool_calls|role)"/.test(text)) {
    return "answer"
  }

  // 非流式：整段读完了才判
  if (done) {
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return "error"
    }
    if (looksLikeAnswer(json)) return "answer"
    if (RISK_BLOCK.test(text)) return "risk"
    if (AUTH_EXPIRED.test(text)) return "auth"
    if (MODEL_ISSUE.test(text)) return "model"
    if (json?.error || json?.code !== undefined) return "error"
    return "error"
  }

  // 没读完：只认**已经完整**的错误对象。
  // 光有 `"code":4100404` 还不够 —— 可能在后面的 `msg` 里更具体，也可能这个
  // 200 后面跟的是 SSE 帧。等到行尾或流结束再下结论。
  if (RISK_BLOCK.test(text) && /\n/.test(text.slice(text.search(RISK_BLOCK)))) return "risk"
  if (/^data:\s*\[DONE\]\s*$/m.test(text)) return "error"
  return "pending"
}

/**
 * 状态码 + body → 该回给宿主的错误。
 *
 * 状态码错和「200 里藏错误」走同一套判断，避免两处措辞漂移。
 *
 * @param {number} status
 * @param {string} text
 * @returns {"auth" | "risk" | "model" | "error" | null} null = 不是错误
 */
export function errorKind(status, text = "") {
  if (status === 401 || AUTH_EXPIRED.test(text)) return "auth"
  if (RISK_BLOCK.test(text)) return "risk"
  if (MODEL_ISSUE.test(text) || status === 404) return "model"
  if (status >= 400) return "error"
  if (ERROR_CODES.test(text) && !/"code"\s*:\s*0\b/.test(text)) return "error"
  return null
}
