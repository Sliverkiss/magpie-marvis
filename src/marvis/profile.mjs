// QQ / 微信 昵称与头像
//
// ⚠ 实测（2026-11-06）：
//   · GET `/marvis_client/marvis_get_user_info` + 三个 Ual-Access-* 头 → WAF **403**
//   · GET + Cookie / MarvisExt → 仍 403
//   · **签名 POST**（`Ual-Access-Businessid` + timestamp/nonce/signature，body 带 userInfo）
//     → `200 {"ret":0,"nick_name":"示例昵称","head_img_url":"..."}`
//
// 所以走 Marvis 渲染层的 `fetchWxappUserInfoApi` 同款形状：businessHeaders 的签名，
// 但**不带** `Ual-Access-Access-Token` 那套（带了反而 500），身份只放在 body 的 userInfo 里。
//
// 拿不到就返回 null —— 绝不编造账号名。QQ 号是拿不到的：Marvis 只用 openid，
// QQ 号不在任何返回字段里。

import { ualSignature } from "./protocol.mjs"
import { BASE, BUSINESS_ID } from "../context.mjs"

const USER_INFO_URL = `${BASE}/marvis_client/marvis_get_user_info`

/** `1` / `2` / `QC` / `WX` → 接口 body 里的 `loginType` */
function rawLoginType(v) {
  const s = String(v ?? "").toUpperCase()
  if (s === "2" || s === "WX" || s === "WXAPP") return "WX"
  return "QC"
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s))
  } catch {
    return String(s)
  }
}

/** `1` / `QC` → QQ；`2` / `WX` → 微信 */
export function platformLabel(loginType) {
  const s = String(loginType ?? "").toUpperCase()
  return s === "2" || s === "WX" || s === "WXAPP" ? "微信" : "QQ"
}

/**
 * 卡片上显示的账号名：`QQ·昵称` / `微信·昵称`。
 * 没有昵称就返回空串 —— 宿主会回退显示供应商名，不编造。
 *
 * @param {unknown} nickname
 * @param {unknown} loginType
 * @returns {string}
 */
export function accountLabel(nickname, loginType) {
  const name = String(nickname ?? "").trim()
  return name ? `${platformLabel(loginType)}·${name}` : ""
}

/**
 * 取当前账号的昵称和头像。
 *
 * @param {{ openid?: string, accessToken?: string, refreshToken?: string, guid?: string, loginType?: string }} acct
 * @param {{ loginType?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ nickname?: string, avatar?: string } | null>}
 */
export async function fetchUserProfile(acct, opts = {}) {
  const openid = String(acct?.openid ?? "")
  const accessToken = String(acct?.accessToken ?? "")
  const guid = String(acct?.guid ?? "")
  if (!openid || !accessToken || !guid) return null

  const body = JSON.stringify({
    userInfo: {
      openId: openid,
      accessToken,
      refreshToken: String(acct?.refreshToken ?? ""),
      loginType: rawLoginType(opts.loginType ?? acct?.loginType),
      guid,
    },
  })
  const timestamp = String(Date.now())
  const nonce = String(1000 + Math.floor(Math.random() * 9000))
  const signature = ualSignature(body, timestamp, nonce)

  /** @type {Response} */
  let res
  try {
    res = await fetch(USER_INFO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
        "Ual-Access-Businessid": BUSINESS_ID,
        "Ual-Access-Timestamp": timestamp,
        "Ual-Access-Nonce": nonce,
        "Ual-Access-Signature": signature,
      },
      body,
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    })
  } catch {
    return null
  }

  /** @type {any} */
  let json
  try {
    json = await res.json()
  } catch {
    return null
  }
  if (json?.ret !== 0 || !json?.nick_name) return null

  const nickname = safeDecode(json.nick_name).trim()
  if (!nickname) return null
  const avatar = json.head_img_url ? safeDecode(json.head_img_url) : ""
  return { nickname, ...(avatar ? { avatar } : {}) }
}
