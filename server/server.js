import express from 'express'
import fs from 'node:fs/promises'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { createStore } from './storage.js'
import { createMigrationArchive, readMigrationArchive } from './migration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// 加密数据根目录：Electron 传入 userData 下的 data/；纯 Node 开发时用项目 data/
const DATA_DIR = process.env.MYDIARY_DATA_DIR || path.join(ROOT, 'data')
// 旧版明文目录（仅用于一次性迁移）
const LEGACY_DIR = path.join(ROOT, 'diaries')
const CONFIG_FILE = path.join(DATA_DIR, 'config.enc')

const PORT = process.env.PORT || 4399

// ---------- 加密数据仓 ----------
const store = createStore({
  dataDir: DATA_DIR,
  key: process.env.MYDIARY_MASTER_KEY
    ? Buffer.from(process.env.MYDIARY_MASTER_KEY, 'hex')
    : null,
})

// ---------- 配置 ----------

const SECURITY_QUESTION = '你最喜爱的人物是?'

const DEFAULT_CONFIG = {
  editorPath: '',
  diaryDir: DATA_DIR,
  privacyPassword: '1234',
  privacyPasswordSet: null,
  privacyGateEnabled: true,
  securityAnswer: '',
}

/** 密码格式：6 位数字 */
const PW_PATTERN = /^\d{6}$/
/** 答案比较：去空格、忽略大小写 */
const normAnswer = s => String(s || '').trim().toLowerCase()

async function loadConfig() {
  const cfg = await store.readConfig(DEFAULT_CONFIG)
  if (typeof cfg.privacyPasswordSet !== 'boolean') {
    cfg.privacyPasswordSet = String(cfg.privacyPassword || '1234') !== '1234'
  }
  // 数据目录固定为加密仓，避免再指到明文文件夹
  cfg.diaryDir = DATA_DIR
  return cfg
}

async function saveConfig(cfg) {
  try {
    await store.writeConfig({ ...cfg, diaryDir: DATA_DIR })
  } catch (err) {
    console.error('[config] 写入配置失败:', err.message)
  }
}

/** 首次启动：把旧版明文 *.md 迁入加密仓 */
async function migrateLegacyDiaries() {
  if (!existsSync(LEGACY_DIR)) return
  let names
  try {
    names = await fs.readdir(LEGACY_DIR)
  } catch {
    return
  }
  const existing = new Set(await store.listDates())
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    const date = f.slice(0, -3)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (existing.has(date)) continue
    try {
      const raw = await fs.readFile(path.join(LEGACY_DIR, f), 'utf8')
      await store.writeDiary(date, raw)
      console.log('[migrate] 已加密导入', date)
    } catch (err) {
      console.error('[migrate] 失败', f, err.message)
    }
  }
}

/** 首次启动：把旧版明文 config.json 迁入加密配置 */
async function migrateLegacyConfig() {
  const legacy = path.join(ROOT, 'config.json')
  if (!existsSync(legacy)) return
  if (existsSync(store.configFile)) return
  try {
    const raw = await fs.readFile(legacy, 'utf8')
    const obj = JSON.parse(raw)
    await store.writeConfig({ ...DEFAULT_CONFIG, ...obj, diaryDir: DATA_DIR })
    console.log('[migrate] 已加密导入配置')
  } catch (err) {
    console.error('[migrate] 配置失败:', err.message)
  }
}

/** 自动探测编辑器安装位置（支持 Windows / macOS / Linux） */
function detectEditor() {
  const platform = process.platform
  let candidates = []

  if (platform === 'win32') {
    candidates = [
      // 用户常用的本地编辑器；配置里已有路径时不会走这里
      'D:\\Soft\\obsidian\\Obsidian.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Obsidian', 'Obsidian.exe'),
      'D:\\Typora\\Typora.exe',
      'C:\\Program Files\\Typora\\Typora.exe',
      'C:\\Program Files (x86)\\Typora\\Typora.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Typora', 'Typora.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    ]
  } else if (platform === 'darwin') {
    candidates = [
      '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
      '/Applications/Obsidian.app',
      '/Applications/Typora.app/Contents/MacOS/Typora',
      '/Applications/Typora.app',
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    ]
  } else {
    candidates = [
      '/usr/bin/obsidian',
      '/usr/bin/typora',
      '/usr/local/bin/typora',
      '/usr/bin/code',
      path.join(os.homedir(), '.local', 'bin', 'typora'),
    ]
  }

  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch (err) {
      console.error('[detect] 探测路径异常:', p, err.message)
    }
  }
  return null
}

/** 确保日记目录存在（启动时同步创建，运行时调用已存在则跳过） */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ---------- 工具 ----------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isValidDate(s) {
  return DATE_RE.test(s)
}

function filePathFor(date, dir) {
  return path.join(dir, `${date}.md`)
}

/** 加密仓里的日记路径（密文） */
function vaultDiaryPath(date) {
  return path.join(DATA_DIR, 'diaries', `${date}.enc`)
}

function formatDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function template(date) {
  return `# ${date}\n\n`
}

// ---------- 应用 ----------

const app = express()
app.use(express.json())

// 打包后由本服务直接托管前端（Electron 窗口打开 http://127.0.0.1:PORT）
const DIST_DIR = path.join(ROOT, 'dist')
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5399')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

/** 包装异步路由处理器，自动捕获异常 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

/** 二十四节气：本地推算（1900 起经典公式，1900–2100 足够用） */
const SOLAR_TERMS = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分',
  '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分',
  '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
]
const S_TERM_INFO = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921,
  173149, 195551, 218072, 240693, 263343, 285989, 308563,
  331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
]

/** 第 n 个节气落在 year 的哪一天（n: 0=小寒 … 23=冬至） */
function solarTermDay(year, n) {
  const ms = 31556925974.7 * (year - 1900) + S_TERM_INFO[n] * 60000
  const d = new Date(ms + Date.UTC(1900, 0, 6, 2, 5))
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 当天是否恰好是节气日 */
function solarTermExact(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const day = Number(m[3])
  for (let n = 0; n < 24; n++) {
    const t = solarTermDay(y, n)
    if (t.month === mo && t.day === day) return SOLAR_TERMS[n]
  }
  return null
}

/** 第几天 → 数字字符串（如 6） */
function toDayNum(n) {
  return String(n)
}

/** 当前节气 + 已过第几天（含节气日为第 1 天） */
function solarTermInfo(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const day = Number(m[3])
  const t0 = new Date(y, mo - 1, day).getTime()

  // 找到今天之前（含今天）最近一次节气
  let lastN = -1
  let lastMs = 0
  for (let n = 0; n < 24; n++) {
    const t = solarTermDay(y, n)
    const ms = new Date(y, t.month - 1, t.day).getTime()
    if (ms <= t0) {
      lastN = n
      lastMs = ms
    }
  }
  if (lastN < 0) {
    // 1 月小寒之前：上一年冬至
    const t = solarTermDay(y - 1, 23)
    lastMs = new Date(y - 1, t.month - 1, t.day).getTime()
    const diff = Math.round((t0 - lastMs) / 86400000) + 1
    return { term: '冬至', day: diff, label: `今天是冬至第${toDayNum(diff)}天` }
  }
  const diff = Math.round((t0 - lastMs) / 86400000) + 1
  const term = SOLAR_TERMS[lastN]
  return {
    term,
    day: diff,
    label: `今天是${term}第${toDayNum(diff)}天`,
    exact: solarTermExact(dateStr) === term,
  }
}

/** 节气缓存：本地推算，短缓存即可 */
const solarTermCache = new Map() // date -> { ts, payload }
const SOLAR_TERM_TTL = 6 * 3600 * 1000

async function fetchSolarTerm(dateStr) {
  const cached = solarTermCache.get(dateStr)
  if (cached && Date.now() - cached.ts < SOLAR_TERM_TTL) return cached.payload

  const info = solarTermInfo(dateStr)
  const payload = {
    ok: true,
    date: dateStr,
    term: info?.term ?? null,
    day: info?.day ?? null,
    label: info?.label ?? null,
    exact: info?.exact ?? null,
    source: 'local',
  }
  solarTermCache.set(dateStr, { ts: Date.now(), payload })
  return payload
}

app.get('/api/solar-term', asyncHandler(async (req, res) => {
  const date = req.query.date
  const d = date || formatDate(new Date())
  if (!isValidDate(d)) return res.status(400).json({ ok: false, error: 'invalid date' })
  res.json(await fetchSolarTerm(d))
}))

/** 节假日数据：按年拉取 timor.tech API，进程内缓存 12 小时 */
const holidayCache = new Map() // year -> { ts, data }
const HOLIDAY_TTL = 12 * 3600 * 1000

app.get('/api/holiday', asyncHandler(async (req, res) => {
  const y = Number(req.query.year) || new Date().getFullYear()
  const cached = holidayCache.get(y)
  if (cached && Date.now() - cached.ts < HOLIDAY_TTL) return res.json({ ok: true, data: cached.data })

  // 中国法定节假日 + 调休：从 timor.tech 拉取全年数据
  // 返回结构: { '2026-01-01': { name: '元旦', type: 'holiday' | 'work' }, ... }
  const url = `http://timor.tech/api/holiday/year/${y}`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    const out = {}
    if (j && j.holiday) {
      for (const k of Object.keys(j.holiday)) {
        const it = j.holiday[k]
        if (it && it.date) {
          out[it.date] = { name: it.name || '', type: it.holiday ? 'holiday' : 'work' }
        }
      }
    }
    holidayCache.set(y, { ts: Date.now(), data: out })
    res.json({ ok: true, data: out })
  } catch (e) {
    // 拉取失败：返回缓存（哪怕过期）或空对象，不让前端崩
    const fallback = cached?.data || {}
    res.json({ ok: true, data: fallback, stale: !cached })
  }
}))

/** 健康检查 + 配置信息 */
app.get('/api/status', asyncHandler(async (req, res) => {
  const cfg = await loadConfig()
  const detected = detectEditor()
  res.json({
    ok: true,
    editorPath: cfg.editorPath,
    editorExists: existsSync(cfg.editorPath),
    detected: detected,
    diaryDir: cfg.diaryDir,
    diaryDirExists: existsSync(cfg.diaryDir),
    privacyGateEnabled: cfg.privacyGateEnabled !== false,
    // 只告知「已设置密码」，不回传明文；明文走 /api/privacy-password
    hasPassword: true,
    hasSecurityAnswer: !!String(cfg.securityAnswer || '').trim(),
  })
}))

/** 隐私门会话：解锁后发 token；改密码/开关门必须带上 token */
const unlockSession = {
  token: /** @type {string|null} */ (null),
  failCount: 0,
  lockedUntil: 0,
}
const UNLOCK_MAX_FAILS = 5
const UNLOCK_LOCK_MS = 30 * 1000

/** 查看当前隐私门密码（明文）；门开启时需 unlock token */
app.get('/api/privacy-password', asyncHandler(async (req, res) => {
  const cfg = await loadConfig()
  const gateIsOn = cfg.privacyGateEnabled !== false
  const token = req.get('x-unlock-token') || String(req.query.token || '')
  if (gateIsOn && (!token || token !== unlockSession.token)) {
    return res.status(401).json({ ok: false, error: 'privacy-auth-required' })
  }
  res.json({ ok: true, password: String(cfg.privacyPassword || '1234') })
}))

/** 隐私门重新锁定：作废解锁 token */
app.post('/api/lock', (req, res) => {
  unlockSession.token = null
  unlockSession.failCount = 0
  securityReset.token = null
  res.json({ ok: true })
})

/** 辅助验证：答对后发一次性 reset token（10 分钟有效，用一次即作废） */
const securityReset = {
  token: /** @type {string|null} */ (null),
  failCount: 0,
  expires: 0,
}

/** 辅助验证问题（问题本身固定，不敏感） */
app.get('/api/security-question', asyncHandler(async (req, res) => {
  const cfg = await loadConfig()
  res.json({
    ok: true,
    question: SECURITY_QUESTION,
    hasAnswer: !!String(cfg.securityAnswer || '').trim(),
  })
}))

/** 校验辅助验证答案 */
app.post('/api/verify-security-answer', asyncHandler(async (req, res) => {
  const now = Date.now()
  if (unlockSession.lockedUntil > now) {
    return res.status(423).json({
      ok: false,
      locked: true,
      retryAfterMs: unlockSession.lockedUntil - now,
      message: '尝试次数过多，已临时锁定',
    })
  }
  const cfg = await loadConfig()
  const stored = normAnswer(cfg.securityAnswer)
  if (!stored) {
    return res.status(404).json({ ok: false, error: 'security-answer-not-set', message: '尚未设置辅助验证答案' })
  }
  const answer = normAnswer(req.body?.answer)
  if (answer && answer === stored) {
    securityReset.failCount = 0
    securityReset.token = randomUUID()
    securityReset.expires = now + 10 * 60 * 1000
    return res.json({ ok: true, resetToken: securityReset.token })
  }
  securityReset.failCount += 1
  if (securityReset.failCount >= UNLOCK_MAX_FAILS) {
    securityReset.failCount = 0
    unlockSession.lockedUntil = now + UNLOCK_LOCK_MS
    return res.status(423).json({
      ok: false,
      locked: true,
      retryAfterMs: UNLOCK_LOCK_MS,
      message: '连续输入错误次数过多，已临时锁定',
    })
  }
  res.status(401).json({ ok: false, message: '答案不正确' })
}))

/** 通过辅助验证后重置密码（6 位数字） */
app.post('/api/reset-password', asyncHandler(async (req, res) => {
  const now = Date.now()
  const resetToken = String(req.body?.resetToken || '')
  const newPassword = String(req.body?.newPassword || '').trim()
  if (!securityReset.token || resetToken !== securityReset.token || securityReset.expires <= now) {
    securityReset.token = null
    return res.status(401).json({ ok: false, message: '重置凭证无效，请重新验证' })
  }
  if (!PW_PATTERN.test(newPassword)) {
    return res.status(400).json({ ok: false, message: '新密码须为 6 位数字' })
  }
  const cfg = await loadConfig()
  cfg.privacyPassword = newPassword
  await saveConfig(cfg)
  // 一次性：用掉 reset token
  securityReset.token = null
  unlockSession.failCount = 0
  unlockSession.lockedUntil = 0
  res.json({ ok: true })
}))

/** 保存配置 */
app.post('/api/config', asyncHandler(async (req, res) => {
  const cfg = await loadConfig()
  const firstPasswordSet = !cfg.privacyPasswordSet
  const gateIsOn = cfg.privacyGateEnabled !== false

  const wantsPassword = typeof req.body.privacyPassword === 'string' && !!req.body.privacyPassword.trim()
  const hasGate = typeof req.body.privacyGateEnabled === 'boolean'
  // 只有「真正要改门开关」才算敏感操作；值没变时不鉴权，避免每次保存都弹解锁
  const wantsGate = hasGate && req.body.privacyGateEnabled !== (cfg.privacyGateEnabled !== false)
  const wantsAnswer = typeof req.body.securityAnswer === 'string' && !!req.body.securityAnswer.trim()

  // 新密码统一要求 6 位数字
  if (wantsPassword && !PW_PATTERN.test(req.body.privacyPassword.trim())) {
    return res.status(400).json({ ok: false, message: '密码须为 6 位数字' })
  }

  // 仅当隐私门「已开启」时，改密码/开关门/改辅助验证答案才需要先解锁。
  // 门关着时直接配置，避免「关着门却要先过门」死锁。
  if (gateIsOn && (wantsPassword || wantsGate || wantsAnswer)) {
    const token = req.body.unlockToken || req.get('x-unlock-token') || ''
    if (!token || token !== unlockSession.token) {
      return res.status(401).json({ ok: false, error: 'privacy-auth-required' })
    }
  }

  if (typeof req.body.editorPath === 'string' && req.body.editorPath.trim()) {
    cfg.editorPath = req.body.editorPath.trim()
  }
  if (typeof req.body.diaryDir === 'string' && req.body.diaryDir.trim()) {
    cfg.diaryDir = req.body.diaryDir.trim()
    ensureDir(cfg.diaryDir)
  }
  if (wantsPassword) {
    cfg.privacyPassword = req.body.privacyPassword.trim()
    cfg.privacyPasswordSet = true
  }
  if (wantsAnswer) {
    cfg.securityAnswer = req.body.securityAnswer.trim()
  }
  // 设置/开启密码时必须同时有辅助验证答案，否则忘记密码将无法找回
  const effectiveGateOn = hasGate ? req.body.privacyGateEnabled : (cfg.privacyGateEnabled !== false)
  if ((wantsPassword || wantsGate) && effectiveGateOn) {
    if (!String(cfg.securityAnswer || '').trim()) {
      return res.status(400).json({ ok: false, message: '请先设置辅助验证答案' })
    }
  }
  if (hasGate) {
    cfg.privacyGateEnabled = req.body.privacyGateEnabled
  }
  await saveConfig(cfg)
  // 不回传密码明文
  res.json({
    ok: true,
    editorPath: cfg.editorPath,
    diaryDir: cfg.diaryDir,
    privacyGateEnabled: cfg.privacyGateEnabled !== false,
    passwordChanged: wantsPassword,
    firstPasswordSet: wantsPassword && firstPasswordSet,
  })
}))

/** 列出所有日记（只返回元数据，不返回全文） */
app.get('/api/diaries', asyncHandler(async (req, res) => {
  const dates = await store.listDates()
  const list = []
  for (const date of dates) {
    if (!isValidDate(date)) continue
    const content = (await store.readDiary(date)) ?? ''
    const body = content.replace(/^#\s+.*\n+/, '').trim()
    list.push({
      date,
      title: extractTitle(content, date),
      chars: body.length,
      words: countWords(body),
      preview: body.replace(/[#*`>\-\[\]]/g, '').slice(0, 80),
      mtime: await store.diaryMtime(date),
      empty: body.length === 0,
    })
  }
  list.sort((a, b) => b.date.localeCompare(a.date))
  res.json({ ok: true, diaries: list })
}))

/** 读取单篇日记 */
app.get('/api/diary/:date', asyncHandler(async (req, res) => {
  const { date } = req.params
  if (!isValidDate(date)) return res.status(400).json({ ok: false, error: 'invalid date' })
  const content = await store.readDiary(date)
  if (content == null) {
    return res.json({ ok: true, exists: false, date, content: '' })
  }
  res.json({ ok: true, exists: true, date, content })
}))

/** 保存日记（网页编辑器）——密文落盘 */
app.put('/api/diary/:date', asyncHandler(async (req, res) => {
  const { date } = req.params
  if (!isValidDate(date)) return res.status(400).json({ ok: false, error: 'invalid date' })
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  await store.writeDiary(date, content)
  res.json({ ok: true })
}))

/** 图片上传（dataURL），加密落盘 */
app.post('/api/image', asyncHandler(async (req, res) => {
  const { dataURL, date } = req.body || {}
  const m = typeof dataURL === 'string' && dataURL.match(/^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.+)$/)
  if (!m) return res.status(400).json({ ok: false, error: 'invalid image' })
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  const safeDate = isValidDate(date) ? date : formatDate(new Date())
  const name = `${safeDate}-${Date.now()}.${ext}`
  await store.writeImage(name, Buffer.from(m[2], 'base64'))
  res.json({ ok: true, name })
}))

/** 图片访问：解密后输出，浏览器侧仍是 /images/<name> */
app.get('/images/:name', asyncHandler(async (req, res) => {
  const name = req.params.name
  const buf = await store.readImage(name)
  if (!buf) return res.status(404).end()
  const ext = path.extname(name).toLowerCase()
  const type = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  }[ext] || 'application/octet-stream'
  res.set('Content-Type', type)
  res.send(buf)
}))

/** 创建/打开日记并用系统关联程序编辑（解密到临时明文，不落盘明文副本） */
app.post('/api/open', asyncHandler(async (req, res) => {
  const date = req.body?.date || formatDate(new Date())
  if (!isValidDate(date)) return res.status(400).json({ ok: false, error: 'invalid date' })

  let created = false
  let content = await store.readDiary(date)
  if (content == null) {
    await store.writeDiary(date, template(date))
    content = template(date)
    created = true
  } else if (content.trim() === '') {
    await store.writeDiary(date, template(date))
    content = template(date)
  }

  const cfg = await loadConfig()
  const editor = cfg.editorPath
  // 解密到系统临时目录，供外部编辑器使用；程序本身不保存明文
  const tmpDir = path.join(os.tmpdir(), 'MyDiary-edit')
  const tmpFile = await store.exportPlain(date, tmpDir)

  // 轻量回写：监视临时文件，保存后写回加密仓
  try {
    const { watch } = await import('node:fs')
    let timer = null
    const w = watch(tmpFile, { persistent: false }, async () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        try {
          await store.commitExternal(tmpFile, date)
        } catch (err) {
          console.error('[open] 回写失败:', err.message)
        }
      }, 800)
    })
    w.unref?.()
    // 5 分钟后停止监视
    setTimeout(() => w.close(), 5 * 60 * 1000).unref?.()
  } catch (err) {
    console.error('[open] 监视临时文件失败:', err.message)
  }

  try {
    launchEditor(tmpFile, editor)
    res.json({ ok: true, created, path: tmpFile, editor })
  } catch (e) {
    console.error('[open] 异常:', e)
    res.status(500).json({ ok: false, error: String(e), path: tmpFile })
  }
}))

/**
 * 优先用配置的编辑器打开；未配置/不存在时回退系统关联（explorer）。
 *
 * 回退 explorer 的原因（保留历史行为）：
 *   1. 老版本 Electron 应用（如 Typora 0.9.x）脱离桌面会话启动时，
 *      会因拿不到窗口焦点而自动退出。explorer 打开可携带完整桌面会话。
 *   2. 绝不在请求路径上使用 execSync（注册表查询等同步调用会阻塞
 *      事件循环，导致所有接口无响应——曾因此出现"读取中…"卡死）。
 */
function launchEditor(filePath, editorPath) {
  const useConfigured = Boolean(editorPath && existsSync(editorPath))

  if (process.platform === 'win32') {
    let child
    if (useConfigured) {
      // 指定编辑器（Typora / Obsidian / VS Code…），直接带上文件路径启动
      child = spawn(editorPath, [filePath], { detached: true, stdio: 'ignore' })
      child.on('error', err => {
        console.error('[open] 编辑器启动失败，回退 explorer:', editorPath, err.message)
        const fb = spawn('explorer', [filePath], { detached: true, stdio: 'ignore' })
        fb.on('error', e2 => console.error('[open] explorer 启动失败:', e2.message))
        fb.unref()
      })
    } else {
      child = spawn('explorer', [filePath], { detached: true, stdio: 'ignore' })
      child.on('error', err => console.error('[open] explorer 启动失败:', err.message))
    }
    child.unref()
  } else if (process.platform === 'darwin') {
    const child = useConfigured
      ? spawn(editorPath, [filePath], { detached: true, stdio: 'ignore' })
      : spawn('open', [filePath], { detached: true, stdio: 'ignore' })
    child.on('error', err => console.error('[open] 启动失败:', err.message))
    child.unref()
  } else {
    const child = useConfigured
      ? spawn(editorPath, [filePath], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' })
    child.on('error', err => console.error('[open] 启动失败:', err.message))
    child.unref()
  }
}

/** 在文件管理器中定位加密数据目录（不暴露明文） */
app.post('/api/reveal', asyncHandler(async (req, res) => {
  const dir = path.join(DATA_DIR, 'diaries')
  ensureDir(dir)
  if (process.platform === 'win32') {
    const child = spawn('explorer', [dir], { detached: true, stdio: 'ignore' })
    child.on('error', err => console.error('[reveal] explorer 启动失败:', err.message))
    child.unref()
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [dir], { detached: true, stdio: 'ignore' })
    child.on('error', err => console.error('[reveal] open 启动失败:', err.message))
    child.unref()
  } else {
    const child = spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' })
    child.on('error', err => console.error('[reveal] xdg-open 启动失败:', err.message))
    child.unref()
  }
  res.json({ ok: true })
}))

/** 删除日记 */
app.delete('/api/diary/:date', asyncHandler(async (req, res) => {
  const { date } = req.params
  if (!isValidDate(date)) return res.status(400).json({ ok: false, error: 'invalid date' })
  await store.deleteDiary(date)
  res.json({ ok: true })
}))

/** 原生系统对话框选择路径（folder=选文件夹 / exe=选程序），对话框强制置顶避免被全屏浏览器遮挡 */
app.get('/api/pick-path', (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(400).json({ ok: false, error: '仅支持 Windows 原生对话框' })
  }
  const requestedMode = String(req.query.mode || 'folder')
  const mode = ['exe', 'folder', 'archive-save', 'archive-open'].includes(requestedMode)
    ? requestedMode
    : 'folder'
  const title = mode === 'exe'
    ? '选择编辑器程序'
    : mode === 'archive-save'
    ? '导出 MyDiary 迁移包'
    : mode === 'archive-open'
    ? '选择 MyDiary 迁移包'
    : '选择日记文件夹'
  const initial = typeof req.query.initial === 'string' ? req.query.initial : ''
  const initialDir = mode === 'exe' && initial ? path.dirname(initial) : initial

  const ps = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
# 1) 自带前台权的隐形父窗：TopMost + 显示一帧 + Activate
$owner = New-Object System.Windows.Forms.Form
$owner.Text = '${title}'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Opacity = 0
$owner.Width = 0; $owner.Height = 0
$owner.Show() | Out-Null
$owner.Activate() | Out-Null
# 2) 把自己前台权让给即将弹出的对话框（AllowSetForegroundWindow 等价做法）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AF {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int p);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
# 模拟用户操作以"解锁"前台权限制（标准技巧：发送一次输入触发前台权）
$null = [AF]::AllowSetForegroundWindow(-1)
[AF]::BringWindowToTop($owner.Handle) | Out-Null
[AF]::SetForegroundWindow($owner.Handle) | Out-Null
${mode === 'exe'
  ? `$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = '${title}'
$f.Filter = '程序 (*.exe)|*.exe|所有文件 (*.*)|*.*'
${initialDir && existsSync(initialDir) ? `$f.InitialDirectory = '${initialDir.replace(/'/g, "''")}'` : ''}`
  : mode === 'archive-save'
  ? `$f = New-Object System.Windows.Forms.SaveFileDialog
$f.Title = '${title}'
$f.Filter = 'MyDiary 迁移包 (*.mydiary)|*.mydiary'
$f.DefaultExt = 'mydiary'
$f.AddExtension = $true`
  : mode === 'archive-open'
  ? `$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = '${title}'
$f.Filter = 'MyDiary 迁移包 (*.mydiary)|*.mydiary'
$f.CheckFileExists = $true`
  : `$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = '${title}'
$f.ShowNewFolderButton = $true
${initial && existsSync(initial) ? `$f.SelectedPath = '${initial.replace(/'/g, "''")}'` : ''}`}
try {
  $r = $f.ShowDialog($owner)
} finally {
  $owner.Close()
}
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
  if ($f -is [System.Windows.Forms.OpenFileDialog] -or $f -is [System.Windows.Forms.SaveFileDialog]) { Write-Output $f.FileName }
  else { Write-Output $f.SelectedPath }
}`
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')

  // spawn 直连 powershell（绕过 cmd 引号问题）；stdout 只认"盘符:\"行，其余噪音忽略；
  // 任何异常（含崩溃/超时）一律按"用户取消"处理，绝不报错打断界面
  let out = ''
  let replied = false
  const reply = path => { if (!replied) { replied = true; res.json({ ok: true, path }) } }
  try {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', b64],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', () => {})
    child.on('error', () => reply(null))
    child.on('exit', () => {
      const lines = out.split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Za-z]:\\/.test(s))
      reply(lines.length ? lines[lines.length - 1] : null)
    })
  } catch {
    reply(null)
  }
  req.on('close', () => { replied = true }) // 客户端断开也不再写响应
})

/** 导出所有日记和照片为可跨设备导入的口令加密文件 */
app.post('/api/data-export', asyncHandler(async (req, res) => {
  const password = String(req.body?.password || '')
  const destination = String(req.body?.destination || '')
  if (password.length < 8) {
    return res.status(400).json({ ok: false, message: '迁移文件密码至少需要 8 个字符' })
  }
  if (!path.isAbsolute(destination) || !destination.toLowerCase().endsWith('.mydiary')) {
    return res.status(400).json({ ok: false, message: '请选择 .mydiary 文件保存位置' })
  }

  const dates = await store.listDates()
  const diaries = []
  for (const date of dates) {
    diaries.push({ date, content: (await store.readDiary(date)) ?? '' })
  }
  const imageEntries = await fs.readdir(store.imagesDir, { withFileTypes: true })
  const images = []
  for (const entry of imageEntries) {
    if (!entry.isFile() || entry.name.endsWith('.tmp') || entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) continue
    const data = await store.readImage(entry.name)
    if (data) images.push({ name: entry.name, data: data.toString('base64') })
  }

  const archive = createMigrationArchive({ diaries, images }, password)
  if (archive.length > 1024 * 1024 * 1024) {
    return res.status(400).json({ ok: false, message: '迁移文件超过 1 GB，无法导出' })
  }
  await fs.writeFile(destination, archive)
  res.json({ ok: true, diaryCount: diaries.length, imageCount: images.length })
}))

/** 导入前完整校验迁移包，校验成功后替换当前日记与图片 */
app.post('/api/data-import', asyncHandler(async (req, res) => {
  const password = String(req.body?.password || '')
  const source = String(req.body?.source || '')
  if (!password) return res.status(400).json({ ok: false, message: '请输入迁移文件密码' })
  if (!path.isAbsolute(source) || !source.toLowerCase().endsWith('.mydiary')) {
    return res.status(400).json({ ok: false, message: '请选择 .mydiary 迁移文件' })
  }

  let data
  try {
    const fileInfo = await fs.stat(source)
    if (fileInfo.size > 1024 * 1024 * 1024) {
      return res.status(400).json({ ok: false, message: '迁移文件超过 1 GB，无法导入' })
    }
    const archive = await fs.readFile(source)
    data = readMigrationArchive(archive, password)
    if (data.diaries.some(diary => !isValidDate(diary.date))) {
      return res.status(400).json({ ok: false, message: '迁移文件中包含无效日期' })
    }
  } catch (err) {
    const message = err instanceof Error && err.message.startsWith('迁移文件')
      ? err.message
      : '无法解密迁移文件，请检查密码或文件是否完整'
    return res.status(400).json({ ok: false, message })
  }

  const images = data.images.map(image => ({ name: image.name, data: Buffer.from(image.data, 'base64') }))
  try {
    await store.replaceDiariesAndImages(data.diaries, images)
  } catch (err) {
    console.error('[migration] 数据导入失败:', err)
    return res.status(500).json({ ok: false, message: '导入失败，原有日记数据已恢复' })
  }
  res.json({ ok: true, diaryCount: data.diaries.length, imageCount: images.length })
}))

/** 隐私门密码验证：5 次错误锁定 30 秒；成功返回 unlock token */
app.post('/api/unlock', asyncHandler(async (req, res) => {
  const now = Date.now()
  if (unlockSession.lockedUntil > now) {
    return res.status(423).json({
      ok: false,
      locked: true,
      retryAfterMs: unlockSession.lockedUntil - now,
      message: '连续输入错误次数过多，已临时锁定',
    })
  }

  const cfg = await loadConfig()
  const pw = String(req.body?.password ?? '')
  if (pw && pw === String(cfg.privacyPassword || '1234')) {
    unlockSession.failCount = 0
    unlockSession.lockedUntil = 0
    unlockSession.token = randomUUID()
    return res.json({ ok: true, token: unlockSession.token })
  }

  unlockSession.failCount += 1
  if (unlockSession.failCount >= UNLOCK_MAX_FAILS) {
    unlockSession.failCount = 0
    unlockSession.lockedUntil = now + UNLOCK_LOCK_MS
    unlockSession.token = null
    return res.status(423).json({
      ok: false,
      locked: true,
      retryAfterMs: UNLOCK_LOCK_MS,
      message: '连续输入错误次数过多，已临时锁定',
    })
  }
  res.status(401).json({ ok: false, fails: unlockSession.failCount })
}))

/** 关闭服务 */
app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true, message: 'shutting down' })
  setTimeout(() => {
    console.log('收到关闭指令，正在停止服务...')
    process.exit(0)
  }, 150)
})

/** 统计：总篇数、总字数、连续天数、最长连续 */
app.get('/api/stats', asyncHandler(async (req, res) => {
  const dates = await store.listDates()
  let totalChars = 0
  let totalWords = 0
  let writtenDays = 0

  for (const date of dates) {
    if (!isValidDate(date)) continue
    const content = (await store.readDiary(date)) ?? ''
    const body = content.replace(/^#\s+.*\n+/, '').trim()
    const chars = body.length
    const words = countWords(body)
    totalChars += chars
    totalWords += words
    if (chars > 0) writtenDays++
  }

  const validDates = dates.filter(isValidDate).sort()
  const { current, longest } = computeStreaks(validDates)

  res.json({
    ok: true,
    totalDiaries: validDates.length,
    writtenDays,
    totalChars,
    totalWords,
    currentStreak: current,
    longestStreak: longest,
    firstDate: validDates[0] || null,
    lastDate: validDates[validDates.length - 1] || null,
  })
}))

/** 全局错误处理 */
app.use((err, req, res, _next) => {
  console.error('[server] 未捕获异常:', err)
  res.status(500).json({ ok: false, error: '服务器内部错误' })
})

// ---------- 辅助 ----------

function extractTitle(content, date) {
  const m = content.match(/^#\s+(.+)$/m)
  if (m && m[1].trim() && m[1].trim() !== date) return m[1].trim()
  return date
}

/** 中英混排字数统计：中文按字算，英文按词算，emoji 不计入字数 */
function countWords(text) {
  const clean = text
    .replace(/[#*`>\-\[\]()]/g, ' ')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
  const cjk = (clean.match(/[\u4e00-\u9fa5\u3400-\u4DBF]/g) || []).length
  const words = (clean.match(/[a-zA-Z0-9]+/g) || []).length
  return cjk + words
}

function computeStreaks(sortedDates) {
  if (sortedDates.length === 0) return { current: 0, longest: 0 }

  const dayMs = 86400000
  const set = new Set(sortedDates)
  const toNum = d => new Date(d + 'T00:00:00').getTime()

  let longest = 1
  let run = 1
  for (let i = 1; i < sortedDates.length; i++) {
    if (toNum(sortedDates[i]) - toNum(sortedDates[i - 1]) === dayMs) {
      run++
      longest = Math.max(longest, run)
    } else {
      run = 1
    }
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  let cursor = today.getTime()
  if (!set.has(formatDate(new Date(cursor)))) cursor -= dayMs
  let current = 0
  while (set.has(formatDate(new Date(cursor)))) {
    current++
    cursor -= dayMs
  }

  return { current, longest }
}

// ---------- 启动 ----------

await migrateLegacyConfig()
await migrateLegacyDiaries()
const cfg = await loadConfig()
ensureDir(DATA_DIR)

app.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  MyDiary 本地服务已启动')
  console.log(`  接口地址  http://127.0.0.1:${PORT}`)
  console.log(`  加密数据  ${DATA_DIR}`)
  console.log(`  编辑器    ${cfg.editorPath}`)
  console.log('')
})
