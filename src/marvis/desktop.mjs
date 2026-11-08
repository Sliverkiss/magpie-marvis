// 从本机 Marvis 客户端导入登录态
//
// 为什么需要它：Marvis 的 token 落在 `marvis-login-state.json` 里，是
// **AES-256-CBC + 运行期派生密钥**（conf v15 的 `IV[0:16] + ':' + CT`），
// 密钥攻不出来。但客户端跑着的时候，明文就在进程内存里 —— 直接读。
//
// ⚠ 只读，不写、不注入、不 hook。用 `ReadProcessMemory` 扫可读区段。
// ⚠ 只在 Windows 上有；其它平台抛「不可用」，让用户走浏览器登录。
// ⚠ **不需要管理员权限**（同用户进程即可）；跨用户会失败并给出明确错误。
//
// ⚠⚠ 四个已经踩过的坑，改这里之前先读：
//   1. C# 不能经 `powershell -Command <长脚本>` 传 —— 引号会被 Windows 命令行
//      参数解析吃掉（`return "";` 必然炸成 MissingEndParenthesisInMethodCall）。
//      → 落成临时 .cs + .ps1，走 `-File`。
//   2. `Add-Type -Path` **不能**再给 `-Language` —— 两者属于不同参数集，
//      同时给报 `AmbiguousParameterSet`。`-Path` 自己会按扩展名推断。
//   3. .ps1 里**不要写中文** —— PowerShell 5.1 按 ANSI 读脚本，UTF-8 中文会变乱码，
//      还可能把后面的语法带崩。注释一律英文。
//   4. 输出走 **base64** —— 内存里什么字节都有，直接 `Write-Output` 会被编码/换行搞坏。

import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deviceGuid } from "./login.mjs"
import { WX_TTL_MS, ttlFor } from "./expiry.mjs"

/** 探查本机是否有 Marvis 客户端在跑 */
export async function desktopAvailable() {
  try {
    return findPids().length > 0
  } catch {
    return false
  }
}

/**
 * 列出所有可能持有登录态的进程 PID。
 *
 * ⚠ 两个进程都要扫：
 *   · `Marvis.exe`（Electron 主进程）持有 **Chromium cookie**（`accesstoken=` 那串）
 *   · `MarvisAgent.exe`（Python agent）持有 `Ual-Access-Access-Token` 请求头
 * 只扫一个会漏 —— 实测 `Marvis.exe` 有 3 个实例，cookie 只在其中一个里。
 */
function findPids() {
  const pids = []
  for (const name of ["Marvis.exe", "MarvisAgent.exe"]) {
    try {
      const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      })
      for (const m of out.matchAll(/"[^"]+","(\d+)"/g)) pids.push(Number(m[1]))
    } catch {
      /* 没装 / 没跑 */
    }
  }
  return pids
}

/** C# 扫描器 —— 写成独立 .cs，由 Add-Type -Path 编译。**全 ASCII**。 */
const CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public class MarvisMemScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, ref MBI mbi, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public uint Pad1;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
        public uint Pad2;
    }

    private static bool Readable(uint p)
    {
        switch (p)
        {
            case 0x02: case 0x04: case 0x06: case 0x08:
            case 0x20: case 0x40: case 0x80:
            case 0x42: case 0x44: case 0x60: case 0x62: case 0x64:
                return true;
            default:
                return false;
        }
    }

    // Scan committed readable regions for needle, append every hit region.
    public static string Scan(int pid, string needle)
    {
        IntPtr h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) return string.Empty;

        StringBuilder sb = new StringBuilder();
        long addr = 0;
        MBI mbi = new MBI();
        const long MAX_REGION = 64L * 1024 * 1024;

        while (VirtualQueryEx(h, new IntPtr(addr), ref mbi, Marshal.SizeOf(typeof(MBI))) != 0)
        {
            long size = (long)mbi.RegionSize;
            if (mbi.State == 0x1000 && size > 0 && size < MAX_REGION && Readable(mbi.Protect))
            {
                byte[] buf = new byte[size];
                IntPtr read;
                if (ReadProcessMemory(h, new IntPtr(addr), buf, (int)size, out read))
                {
                    string s = Encoding.UTF8.GetString(buf, 0, (int)read);
                    if (s.IndexOf(needle, StringComparison.Ordinal) >= 0) sb.Append(s);
                }
            }
            addr += size;
            if (addr > 0x7FFFFFFFFFFFL) break;
        }
        CloseHandle(h);
        return sb.ToString();
    }
}
`

/** run.ps1 的内容 —— **全 ASCII**，见文件头第 3 条 */
function ps1(pid) {
  return [
    "$ErrorActionPreference = 'Stop'",
    // -Path implies the language from the extension; do NOT also pass -Language
    // (different parameter sets -> AmbiguousParameterSet).
    "Add-Type -Path (Join-Path $PSScriptRoot 'Scan.cs')",
    `$text = [MarvisMemScan]::Scan(${pid}, 'accesstoken=')`,
    `if ([string]::IsNullOrEmpty($text)) { $text = [MarvisMemScan]::Scan(${pid}, 'accessToken') }`,
    "$b = [System.Text.Encoding]::UTF8.GetBytes($text)",
    "[Console]::Out.Write([Convert]::ToBase64String($b))",
    "",
  ].join("\r\n")
}

/**
 * 从进程内存里读出登录态。
 *
 * 内存里有两处：
 *   1. `openid=...; accesstoken=...; refreshtoken=...; logintype=QC; ...`（cookie 形态）
 *   2. 结构化对象 `{"openid":"...","accessToken":"..."}`
 * 优先用 1（字段最全，带 logintype 和到期时刻）。
 */
export async function importFromDesktop() {
  if (process.platform !== "win32") {
    throw new Error("「从本机导入」只支持 Windows。请改用 QQ / 微信 登录。")
  }
  const pids = findPids()
  if (!pids.length) {
    throw new Error("没找到运行中的 Marvis 客户端。请先打开 Marvis 并登录，或改用 QQ / 微信 登录。")
  }

  const dir = mkdtempSync(join(tmpdir(), "magpie-marvis-scan-"))
  try {
    writeFileSync(join(dir, "Scan.cs"), CS, "utf8")

    let lastErr = ""
    for (const pid of pids) {
      writeFileSync(join(dir, "run.ps1"), ps1(pid), "utf8")
      let b64 = ""
      try {
        b64 = execFileSync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "run.ps1")],
          { encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
        ).trim()
      } catch (err) {
        lastErr = String(err?.stderr ?? "").trim() || String(err?.message ?? err)
        continue
      }
      const text = b64 ? Buffer.from(b64, "base64").toString("utf8") : ""
      const acct = parseLoginState(text)
      if (acct) return acct
    }

    throw new Error(
      "读到了 Marvis 进程，但里面没有登录态。请在 Marvis 客户端里登录一次再试，或改用 QQ / 微信 登录。" +
        (lastErr ? `（最后一次错误：${lastErr.slice(0, 200)}）` : ""),
    )
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响主流程 */
    }
  }
}

/**
 * 从内存文本里抠登录态。
 * @param {string} text
 */
export function parseLoginState(text) {
  if (!text) return null
  const guid = deviceGuid()

  // 形态 1：cookie 串
  // ⚠ guid 优先从**同一段内存**里取 —— 服务端按 (openid, guid, token) 三元组校验，
  //   注册表里的值理论上一致，但内存里的这份才是这个 token 真正绑定的那个。
  const cookie = /openid=([0-9A-Fa-f]{16,64});\s*accesstoken=([^;\s]+);\s*(?:refreshtoken=([^;\s]+);\s*)?(?:logintype=([A-Za-z]+))?/
  let m = cookie.exec(text)
  if (m) {
    const expire = /access_token_expire_time=(\d{10})/.exec(text)
    const memGuid = /guid=([0-9a-fA-F]{32})/.exec(text)
    return {
      openid: m[1],
      accessToken: m[2],
      refreshToken: m[3] || undefined,
      loginType: /^WX/i.test(m[4] ?? "") ? "2" : "1",
      guid: memGuid ? memGuid[1].toLowerCase() : guid,
      // cookie 里带 logintype，拿不到真实 expires_in 时按登录方式兜底
      // （微信只有 2 小时，共用 30 天会让微信账号 2 小时后 401）
      expiresAt: expire
        ? Number(expire[1]) * 1000
        : Date.now() + ttlFor(/^WX/i.test(m[4] ?? "") ? "2" : "1"),
    }
  }

  // 形态 2：`"openid":"...","accessToken":"..."` 结构化串
  const json = /"openid"\s*:\s*"([0-9A-Fa-f]{16,64})"[\s\S]{0,600}?"accessToken"\s*:\s*"([^"]+)"/
  m = json.exec(text)
  if (m) {
    const rt = /"refreshToken"\s*:\s*"([^"]+)"/.exec(text)
    return {
      openid: m[1],
      accessToken: m[2],
      refreshToken: rt?.[1],
      // ⚠ 只认 1（QQ）/ 2（微信）—— 渲染层 yct={QC:"1",WX:"2",WXAPP:"2"}。
      //   JSON 形态拿不到类型，按 QQ 算；写 6 会让后续请求 401
      loginType: "1",
      guid,
      // 形态 2 读不到 logintype —— 保守按最短 TTL（微信 2 小时），
      // 第一次续期就会用上游真实的 expires_in 修正
      expiresAt: Date.now() + WX_TTL_MS,
    }
  }
  return null
}
