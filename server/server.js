import express from 'express'
import fs from 'node:fs/promises'
import { existsSync, mkdirSync, watch, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { createStore } from './storage.js'
import { createMigrationArchive, readMigrationArchive } from './migration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// 加密数据根目录：Electron 传入 userData 下的 data/；纯 Node 开发时用项目 data/
const DATA_DIR = process.env.MYDIARY_DATA_DIR || path.join(ROOT, 'data')
// 旧版明文目录（仅用于一次性迁移）
const LEGACY_DIR = path.join(ROOT, 'diaries')

// 外部编辑器的临时明文目录：启动时清理过期残留
const EDIT_TMP_DIR = path.join(os.tmpdir(), 'MyDiary-edit')
const EDIT_IDLE_MS = 30 * 60 * 1000
const EDIT_TTL_MS = 24 * 60 * 60 * 1000

const PORT = process.env.PORT || 4399
// Electron 每次启动注入的一次性令牌；纯 Node 开发（无该环境变量）时不校验
const API_TOKEN = String(process.env.MYDIARY_API_TOKEN || '')

// ---------- 加密数据仓 ----------
const store = createStore({
  dataDir: DATA_DIR,
  key: process.env.MYDIARY_MASTER_KEY
    ? Buffer.from(process.env.MYDIARY_MASTER_KEY, 'hex')
    : null,
})

// ---------- 配置 ----------

const SECURITY_QUESTION = '你最喜爱的人物是?'

const DEFAULT_PASSWORD = '1234'
const DEFAULT_CONFIG = {
  editorPath: '',
  diaryDir: DATA_DIR,
  privacyPasswordHash: null,
  privacyPasswordSet: false,
  privacyGateEnabled: true,
  securityAnswerHash: null,
  /** 无操作多少分钟后自动回到密码门；0 表示关闭 */
  idleLockMinutes: 0,
  reminderEnabled: false,
  /** 本地时间 HH:mm */
  reminderTime: '21:00',
}

/** 密码格式：6 位数字 */
const PW_PATTERN = /^\d{6}$/
/** 答案比较：去空格、忽略大小写 */
const normAnswer = s => String(s || '').trim().toLowerCase()

const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** scrypt 哈希，格式 scrypt$saltHex$hashHex */
function hashSecret(secret) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(secret), salt, 32, SCRYPT_OPTS)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifySecret(stored, secret) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    if (!salt.length || !expected.length) return false
    const actual = scryptSync(String(secret), salt, expected.length, SCRYPT_OPTS)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function hasSecurityAnswer(cfg) {
  return Boolean(cfg.securityAnswerHash) || Boolean(normAnswer(cfg.securityAnswer))
}

function verifyPassword(cfg, password) {
  if (cfg.privacyPasswordHash) return verifySecret(cfg.privacyPasswordHash, password)
  // 兼容尚未完成迁移的旧配置
  if (typeof cfg.privacyPassword === 'string') return password === cfg.privacyPassword
  return password === DEFAULT_PASSWORD
}

function verifySecurityAnswer(cfg, answer) {
  if (cfg.securityAnswerHash) return verifySecret(cfg.securityAnswerHash, normAnswer(answer))
  const stored = normAnswer(cfg.securityAnswer)
  return Boolean(stored) && normAnswer(answer) === stored
}

async function loadConfig() {
  const cfg = await store.readConfig(DEFAULT_CONFIG)
  if (typeof cfg.privacyPasswordSet !== 'boolean') {
    cfg.privacyPasswordSet = Boolean(cfg.privacyPasswordHash)
  }
  // 数据目录固定为加密仓，避免再指到明文文件夹
  cfg.diaryDir = DATA_DIR
  return cfg
}

async function saveConfig(cfg) {
  await store.writeConfig({ ...cfg, diaryDir: DATA_DIR })
}

/** 把旧配置里的明文密码/答案转成哈希并删除明文字段 */
async function migrateSecretHashes() {
  const cfg = await store.readConfig(DEFAULT_CONFIG)
  let changed = false
  if (typeof cfg.privacyPassword === 'string') {
    if (cfg.privacyPassword !== DEFAULT_PASSWORD) cfg.privacyPasswordSet = true
    cfg.privacyPasswordHash = hashSecret(cfg.privacyPassword)
    delete cfg.privacyPassword
    changed = true
  }
  if (typeof cfg.securityAnswer === 'string') {
    const normalized = normAnswer(cfg.securityAnswer)
    if (normalized) cfg.securityAnswerHash = hashSecret(normalized)
    delete cfg.securityAnswer
    changed = true
  }
  if (changed) {
    await store.writeConfig({ ...DEFAULT_CONFIG, ...cfg, diaryDir: DATA_DIR })
    console.log('[migrate] 已将明文密码/验证答案转换为哈希')
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

/** 确保日记目录存在（启动时同步创建，运行时调用已存在则跳过） */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ---------- 工具 ----------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isValidDate(s) {
  return DATE_RE.test(s)
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
// 图片以 dataURL 上传、长日记也走 JSON，默认 100KB 不够用
app.use(express.json({ limit: '30mb' }))

// 打包后由本服务直接托管前端（Electron 窗口打开 http://127.0.0.1:PORT）
const DIST_DIR = path.join(ROOT, 'dist')
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5399')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-mydiary-token')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// 本地服务只接受应用内页面发起的请求：同机其它进程/网页拿不到一次性令牌。
// API 只认请求头；图片标签无法带头，因此 /images 额外接受 ?t=<token>。
if (API_TOKEN) {
  app.use('/api', (req, res, next) => {
    if (req.get('x-mydiary-token') === API_TOKEN) return next()
    res.status(401).json({ ok: false, error: 'unauthorized', message: '未授权的本地请求' })
  })
  app.use('/images', (req, res, next) => {
    const provided = req.get('x-mydiary-token') || String(req.query.t || '')
    if (provided === API_TOKEN) return next()
    res.status(401).json({ ok: false, error: 'unauthorized', message: '未授权的本地请求' })
  })
}

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
  res.json({
    ok: true,
    editorPath: cfg.editorPath,
    editorExists: existsSync(cfg.editorPath),
    diaryDir: cfg.diaryDir,
    diaryDirExists: existsSync(cfg.diaryDir),
    privacyGateEnabled: cfg.privacyGateEnabled !== false,
    hasSecurityAnswer: hasSecurityAnswer(cfg),
    idleLockMinutes: Number(cfg.idleLockMinutes) || 0,
    reminderEnabled: cfg.reminderEnabled === true,
    reminderTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.reminderTime)) ? cfg.reminderTime : '21:00',
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

/** 隐私门重新锁定：只作废解锁 token，保留失败计数防止借锁定接口绕过限流 */
app.post('/api/lock', (req, res) => {
  unlockSession.token = null
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
    hasAnswer: hasSecurityAnswer(cfg),
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
  if (!hasSecurityAnswer(cfg)) {
    return res.status(404).json({ ok: false, error: 'security-answer-not-set', message: '尚未设置辅助验证答案' })
  }
  const answer = normAnswer(req.body?.answer)
  if (answer && verifySecurityAnswer(cfg, answer)) {
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
  cfg.privacyPasswordHash = hashSecret(newPassword)
  delete cfg.privacyPassword
  cfg.privacyPasswordSet = true
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

  // 允许传空字符串清空编辑器路径
  if (typeof req.body.editorPath === 'string') {
    const editorPath = req.body.editorPath.trim()
    if (editorPath) {
      let st = null
      try { st = statSync(editorPath) } catch {}
      const needsExe = process.platform === 'win32'
      if (!st || !st.isFile() || (needsExe && !/\.exe$/i.test(editorPath))) {
        return res.status(400).json({
          ok: false,
          message: needsExe ? '请选择有效的 .exe 编辑器程序' : '请选择有效的编辑器程序',
        })
      }
    }
    cfg.editorPath = editorPath
  }
  if (req.body.idleLockMinutes !== undefined) {
    const n = Number(req.body.idleLockMinutes)
    if (!Number.isInteger(n) || n < 0 || n > 120) {
      return res.status(400).json({ ok: false, message: '空闲锁定时间无效' })
    }
    cfg.idleLockMinutes = n
  }
  if (typeof req.body.reminderEnabled === 'boolean') {
    cfg.reminderEnabled = req.body.reminderEnabled
  }
  if (req.body.reminderTime !== undefined) {
    const t = String(req.body.reminderTime)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
      return res.status(400).json({ ok: false, message: '提醒时间格式应为 HH:mm' })
    }
    cfg.reminderTime = t
  }
  if (wantsPassword) {
    cfg.privacyPasswordHash = hashSecret(req.body.privacyPassword.trim())
    delete cfg.privacyPassword
    cfg.privacyPasswordSet = true
  }
  if (wantsAnswer) {
    cfg.securityAnswerHash = hashSecret(normAnswer(req.body.securityAnswer))
    delete cfg.securityAnswer
  }
  // 设置/开启密码时必须同时有辅助验证答案，否则忘记密码将无法找回
  const effectiveGateOn = hasGate ? req.body.privacyGateEnabled : (cfg.privacyGateEnabled !== false)
  if ((wantsPassword || wantsGate) && effectiveGateOn) {
    if (!hasSecurityAnswer(cfg)) {
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
    idleLockMinutes: Number(cfg.idleLockMinutes) || 0,
    reminderEnabled: cfg.reminderEnabled === true,
    reminderTime: cfg.reminderTime,
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
    // 单篇损坏不应让整个列表 500
    let content = ''
    let broken = false
    try {
      content = (await store.readDiary(date)) ?? ''
    } catch (err) {
      broken = true
      console.error('[diaries] 无法解密', date, err.message)
    }
    const body = broken ? '' : content.replace(/^#\s+.*\n+/, '').trim()
    list.push({
      date,
      title: broken ? date : extractTitle(content, date),
      chars: body.length,
      words: countWords(body),
      preview: broken ? '' : body.replace(/[#*`>\-\[\]]/g, '').slice(0, 80),
      mtime: await store.diaryMtime(date),
      empty: !broken && body.length === 0,
      broken,
    })
  }
  list.sort((a, b) => b.date.localeCompare(a.date))
  res.json({ ok: true, diaries: list })
}))

/** 读取单篇日记 */
app.get('/api/diary/:date', asyncHandler(async (req, res) => {
  const { date } = req.params
  if (!isValidDate(date)) return res.status(400).json({ ok: false, error: 'invalid date' })
  let content
  try {
    content = await store.readDiary(date)
  } catch (err) {
    console.error('[diary] 无法解密', date, err.message)
    return res.status(500).json({ ok: false, message: '这篇日记无法解密，文件可能已损坏' })
  }
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
  const tmpFile = await store.exportPlain(date, EDIT_TMP_DIR)

  watchEditFile(tmpFile, date)

  try {
    await launchEditor(tmpFile, editor)
    res.json({ ok: true, created, path: tmpFile, editor })
  } catch (e) {
    console.error('[open] 启动编辑器失败:', e.message)
    // 启动失败就不要把明文留在临时目录：停掉监视并删除快照
    editWatchers.get(date)?.close()
    try { await fs.rm(tmpFile, { force: true }) } catch {}
    res.status(500).json({
      ok: false,
      message: '无法启动外部编辑器，请检查设置中的编辑器路径',
      error: String(e),
    })
  }
}))

// 同一天重复打开时只保留一个监视器
const editWatchers = new Map()

/**
 * 监视临时明文并回写加密仓。
 * 盯目录而不是单文件：编辑器保存常用「写临时文件 + rename」的原子替换，
 * 单文件 watch 会在第一次保存后失效。事件按文件名过滤。
 * 每次改动重置 30 分钟静默计时，静默超时后停止监视。
 */
function watchEditFile(tmpFile, date) {
  const prev = editWatchers.get(date)
  if (prev) prev.close()

  const base = path.basename(tmpFile)
  let debounce = null
  let idle = null
  let watcher = null
  const close = () => {
    if (debounce) clearTimeout(debounce)
    if (idle) clearTimeout(idle)
    try { watcher?.close() } catch {}
    editWatchers.delete(date)
  }

  try {
    watcher = watch(EDIT_TMP_DIR, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== base) return
      if (debounce) clearTimeout(debounce)
      if (idle) clearTimeout(idle)
      debounce = setTimeout(async () => {
        try {
          await store.commitExternal(tmpFile, date)
        } catch (err) {
          console.error('[open] 回写失败:', err.message)
        }
        idle = setTimeout(close, EDIT_IDLE_MS)
        idle.unref?.()
      }, 800)
    })
    watcher.on('error', err => {
      console.error('[open] 监视失败:', err.message)
      close()
    })
    watcher.unref?.()
    // 打开后即使一次都没保存，也要在空闲超时后关闭
    idle = setTimeout(close, EDIT_IDLE_MS)
    idle.unref?.()
    editWatchers.set(date, { close })
  } catch (err) {
    console.error('[open] 监视临时文件失败:', err.message)
  }
}

/** 清理上次异常退出遗留的临时明文，避免长期留在系统临时目录 */
async function cleanStaleEditFiles() {
  let names
  try {
    names = await fs.readdir(EDIT_TMP_DIR)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    const full = path.join(EDIT_TMP_DIR, name)
    try {
      const st = await fs.stat(full)
      if (st.isFile() && now - st.mtimeMs > EDIT_TTL_MS) {
        await fs.rm(full, { force: true })
      }
    } catch {
      // 文件可能已被编辑器/清理进程删除
    }
  }
}

/** 停止外部编辑回写并删除临时明文快照，返回删除的文件数 */
async function clearEditTemp() {
  for (const w of editWatchers.values()) w.close()
  editWatchers.clear()
  let removed = 0
  try {
    const names = await fs.readdir(EDIT_TMP_DIR)
    for (const name of names) {
      const full = path.join(EDIT_TMP_DIR, name)
      try {
        const st = await fs.stat(full)
        if (!st.isFile()) continue
        await fs.rm(full, { force: true })
        removed++
      } catch {}
    }
  } catch {}
  return removed
}

/** 清空外部编辑器遗留的明文临时文件；会停止回写监视，需确认编辑器已关闭 */
app.post('/api/edit-temp/clean', asyncHandler(async (_req, res) => {
  res.json({ ok: true, removed: await clearEditTemp() })
}))

/**
 * 用配置的编辑器打开临时明文；未配置时交给系统关联程序。
 * 配置了却启动失败必须报错——静默回退会让用户以为在用 Typora，实际打开了别的程序。
 * 不在请求路径上使用同步的外部命令（会阻塞事件循环）。
 */
async function launchEditor(filePath, editorPath) {
  const configured = Boolean(editorPath && editorPath.trim())
  if (configured && !existsSync(editorPath)) {
    throw new Error('编辑器路径不存在，请在设置中重新选择')
  }
  const cmd = configured
    ? editorPath
    : process.platform === 'win32'
    ? 'explorer'
    : process.platform === 'darwin'
    ? 'open'
    : 'xdg-open'

  const child = spawn(cmd, [filePath], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
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

  // 单篇损坏不应让整个备份失败，但也不能静默跳过——会导出不完整的数据
  const dates = await store.listDates()
  const diaries = []
  const brokenDiaries = []
  for (const date of dates) {
    try {
      diaries.push({ date, content: (await store.readDiary(date)) ?? '' })
    } catch {
      brokenDiaries.push(date)
    }
  }
  const imageEntries = await fs.readdir(store.imagesDir, { withFileTypes: true })
  const images = []
  const brokenImages = []
  for (const entry of imageEntries) {
    if (!entry.isFile() || entry.name.endsWith('.tmp') || entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) continue
    try {
      const data = await store.readImage(entry.name)
      if (data) images.push({ name: entry.name, data: data.toString('base64') })
    } catch {
      brokenImages.push(entry.name)
    }
  }
  if (brokenDiaries.length || brokenImages.length) {
    const parts = []
    if (brokenDiaries.length) {
      parts.push(`${brokenDiaries.length} 篇日记无法解密（${brokenDiaries.slice(0, 3).join('、')}${brokenDiaries.length > 3 ? ' 等' : ''}）`)
    }
    if (brokenImages.length) parts.push(`${brokenImages.length} 张图片无法解密`)
    return res.status(400).json({
      ok: false,
      message: `导出已取消：${parts.join('，')}。请先在列表中删除损坏的日记后再导出`,
    })
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

  let fileInfo
  try {
    fileInfo = await fs.stat(source)
  } catch {
    return res.status(400).json({ ok: false, message: '找不到迁移文件，请重新选择' })
  }
  if (fileInfo.size > 1024 * 1024 * 1024) {
    return res.status(400).json({ ok: false, message: '迁移文件超过 1 GB，无法导入' })
  }

  let data
  try {
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
  // 先停掉外部编辑回写并清掉旧快照，否则编辑器稍后保存会把导入前的内容写回来
  await clearEditTemp()
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
  if (pw && verifyPassword(cfg, pw)) {
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

  const validDates = dates.filter(isValidDate).sort()
  const writtenDates = []
  for (const date of validDates) {
    let content = ''
    try {
      content = (await store.readDiary(date)) ?? ''
    } catch (err) {
      console.error('[stats] 无法解密', date, err.message)
      continue
    }
    const body = content.replace(/^#\s+.*\n+/, '').trim()
    const chars = body.length
    totalChars += chars
    totalWords += countWords(body)
    if (chars > 0) {
      writtenDays++
      writtenDates.push(date)
    }
  }

  // 连续天数只按真正写了内容的日期计算，与「已写」口径保持一致
  const { current, longest } = computeStreaks(writtenDates)

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
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'payload too large',
      message: '内容过大：单次提交上限 30MB，请压缩图片或分次保存长文',
    })
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid json' })
  }
  const status = Number(err?.status || err?.statusCode)
  if (status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, error: err.message || '请求无效' })
  }
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

async function bootstrap() {
  await migrateLegacyConfig()
  await migrateLegacyDiaries()
  await migrateSecretHashes()
  await cleanStaleEditFiles()
  ensureDir(DATA_DIR)
  return loadConfig()
}

/** Electron 退出后，管道断开即退出，避免残留后台服务 */
function watchParentPipe() {
  if (!process.env.MYDIARY_PARENT_PIPE) return
  process.stdin.resume()
  process.stdin.on('end', () => {
    console.log('父进程已退出，本地服务停止')
    process.exit(0)
  })
  process.stdin.on('error', () => process.exit(0))
}

let cfg
try {
  cfg = await bootstrap()
} catch (err) {
  console.error('')
  console.error('  MyDiary 启动失败：' + (err?.message || err))
  console.error('  为避免覆盖数据，服务已停止；请先备份数据目录再排查。')
  console.error('')
  process.exit(1)
}

watchParentPipe()

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  MyDiary 本地服务已启动')
  console.log(`  接口地址  http://127.0.0.1:${PORT}`)
  console.log(`  加密数据  ${DATA_DIR}`)
  console.log(`  编辑器    ${cfg.editorPath}`)
  console.log('')
})

server.on('error', err => {
  console.error('  MyDiary 本地服务启动失败：' + err.message)
  process.exit(1)
})
