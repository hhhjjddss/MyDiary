/**
 * 等待网页服务(5399)就绪后，用浏览器 --start-fullscreen 模式打开 ——
 * 启动即 F11 式全屏（无 UI），解锁后按 F11 可退出恢复浏览器。
 * 优先 Edge（Windows 自带）→ Chrome → 退回默认浏览器普通窗口。
 */
import net from 'node:net'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'

const PAGE_URL = 'http://localhost:5399'

function waitForPort(port, timeout = 30000) {
  const started = Date.now()
  // Vite 在 Windows 上可能只监听 IPv6 (::1)，所以两个栈都探测
  const hosts = ['127.0.0.1', '::1']
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      let pending = hosts.length
      let settled = false
      const fail = () => {
        if (settled) return
        if (--pending > 0) return
        if (Date.now() - started > timeout) { settled = true; return reject(new Error('timeout')) }
        setTimeout(tryOnce, 400)
      }
      for (const host of hosts) {
        const s = net.connect(port, host)
        s.once('connect', () => {
          s.destroy()
          if (settled) return
          settled = true
          resolve()
        })
        s.once('error', () => { s.destroy(); fail() })
      }
    }
    tryOnce()
  })
}

function open(cmd) {
  return new Promise(resolve => {
    exec(cmd, { shell: 'cmd.exe' }, () => resolve())
  })
}

/** 在候选路径中找到实际存在的浏览器可执行文件 */
function findBrowser(candidates) {
  for (const p of candidates) {
    try { if (p && existsSync(p)) return p } catch {}
  }
  return null
}

try {
  await waitForPort(5399)
  await new Promise(r => setTimeout(r, 800)) // 缓一拍，等 vite 首页可响应

  const edge = findBrowser([
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ])
  const chrome = findBrowser([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ])

  const exe = edge || chrome
  if (exe) {
    await open(`start "" "${exe}" --start-fullscreen ${PAGE_URL} --no-first-run --no-default-browser-check`)
    console.log('[gate] 全屏浏览器已启动:', exe)
  } else {
    // 找不到 Edge/Chrome，退回默认浏览器普通窗口
    await open(`start "" "${PAGE_URL}"`)
    console.log('[gate] 未找到 Edge/Chrome，已用默认浏览器打开')
  }
} catch {
  // 服务迟迟未起或启动失败，退回默认浏览器
  await open(`start "" "${PAGE_URL}"`)
}
