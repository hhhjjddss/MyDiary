import { app, BrowserWindow, Tray, Menu, nativeImage, safeStorage, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 打包后资源在 resources/app（asar:false）或 resources/app.asar(.unpacked)；开发时是项目根 */
function resolveAppRoot() {
  if (!app.isPackaged) return path.resolve(__dirname, '..')
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked'),
    path.join(process.resourcesPath, 'app'),
    path.join(process.resourcesPath, 'app.asar'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'server', 'server.js'))) return dir
  }
  return path.resolve(__dirname, '..')
}

const ROOT = resolveAppRoot()

// 数据目录：安装后在用户应用数据区，首次启动自动创建
const DATA_DIR = process.env.MYDIARY_DATA_DIR || path.join(app.getPath('userData'), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

/** 主密钥：用系统凭据库（DPAPI/Keychain）包一层 */
function ensureMasterKeyHex() {
  const keyPath = path.join(DATA_DIR, 'key.oscrypt')
  try {
    if (fs.existsSync(keyPath)) {
      const wrapped = fs.readFileSync(keyPath)
      if (safeStorage.isEncryptionAvailable()) {
        const hex = safeStorage.decryptString(wrapped)
        if (/^[0-9a-fA-F]{64}$/.test(hex)) return hex
      } else {
        const hex = wrapped.toString('utf8').trim()
        if (/^[0-9a-fA-F]{64}$/.test(hex)) return hex
      }
    }
  } catch (err) {
    console.error('[key] read fail:', err.message)
  }
  const hex = crypto.randomBytes(32).toString('hex')
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(keyPath, safeStorage.encryptString(hex))
    } else {
      fs.writeFileSync(keyPath, hex, { mode: 0o600 })
    }
  } catch (err) {
    console.error('[key] write fail:', err.message)
  }
  return hex
}

const API_PORT = process.env.MYDIARY_API_PORT || '4399'
let serverProc = null
let mainWindow = null
let tray = null
let quitting = false

function iconPath(...parts) {
  return path.join(__dirname, ...parts)
}

function waitPort(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const ping = () => {
      const s = net.connect(Number(port), '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve()
      })
      s.once('error', () => {
        s.destroy()
        if (Date.now() - started > timeoutMs) return reject(new Error('server start timeout'))
        setTimeout(ping, 200)
      })
    }
    ping()
  })
}

/**
 * 用 ELECTRON_RUN_AS_NODE 启动本地服务（exe 当 Node 用）。
 * 打包后不要直接 spawn(process.execPath) 开第二个 Electron，也不要主进程 import ESM 服务，
 * 都会踩「Cannot use import statement outside a module」或白屏。
 */
async function startServer() {
  process.env.PORT = API_PORT
  process.env.MYDIARY_DATA_DIR = DATA_DIR
  process.env.MYDIARY_MASTER_KEY = ensureMasterKeyHex()

  const script = path.join(ROOT, 'server', 'server.js')
  if (!fs.existsSync(script)) {
    throw new Error('missing ' + script)
  }

  serverProc = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: API_PORT,
      MYDIARY_DATA_DIR: DATA_DIR,
      MYDIARY_MASTER_KEY: process.env.MYDIARY_MASTER_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => process.stdout.write(d))
  serverProc.stderr.on('data', d => process.stderr.write(d))
  serverProc.on('error', err => {
    console.error('[electron] server spawn error:', err)
  })
  // 服务退出（如网页里的「退出」按钮触发 /api/shutdown）时，应用必须跟随退出，
  // 否则会留下「界面活着、后端已死」的僵尸窗口，什么都点不动
  serverProc.on('exit', code => {
    console.log('[electron] server exited:', code)
    if (!quitting) app.quit()
  })

  await waitPort(API_PORT)
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath('tray-32.png'))
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    tray.setToolTip('MyDiary 本地日记')
    const menu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return createWindow()
          mainWindow.show()
          mainWindow.focus()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])
    tray.setContextMenu(menu)
    tray.on('double-click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return createWindow()
      mainWindow.show()
      mainWindow.focus()
    })
  } catch (err) {
    console.error('[tray] fail:', err.message)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    autoHideMenuBar: true,
    show: false,
    // 窗口底色必须跟页面一致：缩放非整数倍时 WebContents 可能比窗口窄几像素，
    // 右下角会漏出这块底色（原来是 #f7f7f5，看着像一块白块）
    useContentSize: true,
    backgroundColor: '#0d1117',
    icon: iconPath('icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 关闭时驻留系统托盘，不退出进程
  mainWindow.on('close', e => {
    if (!quitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 打包版 / electron 启动：一律走内置服务托管的 dist
  const url = `http://127.0.0.1:${API_PORT}`
  mainWindow.loadURL(url).catch(err => {
    console.error('[electron] loadURL fail:', err)
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<!doctype html><meta charset="utf-8"><title>MyDiary</title>
           <body style="font-family:system-ui;padding:40px;line-height:1.7">
           <h2>页面加载失败</h2>
           <p>${desc} (${code})</p>
           <p>本地服务地址：<code>${url}</code></p>
           </body>`,
        ),
    )
  })

  return mainWindow
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed())
    if (w) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
  })

  app.whenReady().then(async () => {
    // 开屏 Logo 在网页内播（整蛊门之前）；Electron 不再另开闪屏窗
    createTray()

    try {
      await startServer()
    } catch (err) {
      console.error('[electron] local server failed:', err)
      const win = new BrowserWindow({ width: 720, height: 420 })
      win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<!doctype html><meta charset="utf-8"><title>MyDiary</title>
             <body style="font-family:system-ui;padding:40px;line-height:1.7">
             <h2>本地服务启动失败</h2>
             <pre>${String(err && err.message ? err.message : err)}</pre>
             </body>`,
          ),
      )
      return
    }

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    if (serverProc) {
      try { serverProc.kill() } catch {}
    }
  })

  app.on('window-all-closed', () => {
    // 有托盘驻留时，关窗不退出；仅 macOS 保持惯例
    if (process.platform === 'darwin' && !tray) {
      app.quit()
    }
  })
}
