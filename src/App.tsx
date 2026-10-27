import { useEffect, useState, useMemo, useCallback, useRef, type ReactNode } from 'react'
import { api, type DiaryMeta, type Stats, type Status } from './api'
import { Heatmap } from './components/Heatmap'
import { DiaryModal } from './components/DiaryModal'
import { Editor } from './components/Editor'
import { Shiguang } from './components/Shiguang'
import { Gate, gatePassed, getUnlockToken } from './components/Gate'
import { BootSplash, BOOT_MS } from './components/BootSplash'
import { formatCN, weekdayCN, formatNumber, relativeTime, todayStr, formatShort } from './utils'
import { holidayNameOf } from './festive'

type View = 'list' | 'heatmap'

const GATE_ENABLED_KEY = 'md-gate-enabled'

/** 读缓存的隐私门开关：null = 未知（避免启动/刷新时误闪整蛊门） */
function readGateEnabled(): boolean | null {
  try {
    const v = localStorage.getItem(GATE_ENABLED_KEY)
    return v === null ? null : v === '1'
  } catch {
    return null
  }
}

function writeGateEnabled(on: boolean) {
  try {
    localStorage.setItem(GATE_ENABLED_KEY, on ? '1' : '0')
  } catch {}
}

function readPasswordReminder(): number | null {
  try {
    const value = localStorage.getItem('md-password-reminder')
    if (value === null) return null
    const clicks = Number(value)
    return Number.isInteger(clicks) && clicks >= 0 && clicks < 3 ? clicks : null
  } catch {
    return null
  }
}

export default function App() {
  const [diaries, setDiaries] = useState<DiaryMeta[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [view, setView] = useState<View>('heatmap')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [year, setYear] = useState(() => new Date().getFullYear())
  const [now, setNow] = useState(() => new Date())
  const [gate, setGate] = useState(() => gatePassed())
  const [gateEnabled, setGateEnabled] = useState<boolean | null>(readGateEnabled)
  const [passwordReminderClicks, setPasswordReminderClicks] = useState<number | null>(readPasswordReminder)
  // 开屏 Logo：必须播在整蛊门之前
  const [bootDone, setBootDone] = useState(false)
  const [showTrend, setShowTrend] = useState(false)
  const [showList, setShowList] = useState(false)
  const [holidayName, setHolidayName] = useState<string | null>(null)
  const [solarTerm, setSolarTerm] = useState<string | null>(null)
  const [solarDay, setSolarDay] = useState<number | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // 开屏动画：CSS 淡出在 BOOT_MS 时完成，这里多加 200ms 缓冲确保动画结束后再卸载
  useEffect(() => {
    const t = setTimeout(() => setBootDone(true), BOOT_MS + 200)
    return () => clearTimeout(t)
  }, [])

  const today = todayStr()

  const refresh = useCallback(async () => {
    try {
      const [d, s, st] = await Promise.all([api.diaries(), api.stats(), api.status()])
      setDiaries(d.diaries ?? [])
      setStats(s)
      setStatus(st)
      const on = st.privacyGateEnabled !== false
      setGateEnabled(on)
      writeGateEnabled(on)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '无法读取本地数据')
    } finally {
      setLoading(false)
    }
  }, [])

  const retry = () => {
    setLoadError(null)
    setLoading(true)
    void refresh()
  }

  // 节日提示：完全按节假日 API 当天数据（依赖 today，跨天自动刷新）
  useEffect(() => {
    let alive = true
    const y = Number(today.slice(0, 4))
    api.holiday(y)
      .then(r => {
        if (alive) setHolidayName(holidayNameOf(today, r.data || {}))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [today])

  // 节气：本地推算（依赖 today，跨天自动刷新）
  useEffect(() => {
    let alive = true
    api
      .solarTerm(today)
      .then(r => {
        if (alive) {
          setSolarTerm(r.term || null)
          setSolarDay(r.day ?? null)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [today])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const writeToday = () => {
    setSelected(null)
    setEditing(today)
  }

  const map = useMemo(() => {
    const m = new Map<string, DiaryMeta>()
    for (const d of diaries) m.set(d.date, d)
    return m
  }, [diaries])

  const wroteToday = map.has(today) && !map.get(today)!.empty

  const confirmPasswordReminder = () => {
    if (passwordReminderClicks === null) return
    if (passwordReminderClicks >= 2) {
      try { localStorage.removeItem('md-password-reminder') } catch {}
      setPasswordReminderClicks(null)
      return
    }
    const next = passwordReminderClicks + 1
    try { localStorage.setItem('md-password-reminder', String(next)) } catch {}
    setPasswordReminderClicks(next)
  }

  // 编辑器名：取配置路径的文件名去扩展名，如 D:\...\Obsidian.exe → Obsidian
  const editorName = useMemo(() => {
    if (!status?.editorPath) return '外部编辑器'
    const base = status.editorPath.split(/[\\/]/).pop() || status.editorPath
    const stem = base.replace(/\.[^.]+$/, '').trim()
    return stem || '外部编辑器'
  }, [status])

  // 可选年份范围：最早日记年份 → 今年（至少回溯 4 年，保证滑杆始终可用）
  // 依赖 today：跨年午夜后 max 跟着变新
  const years = useMemo(() => {
    const max = Number(today.slice(0, 4))
    let earliest = max
    for (const d of diaries) {
      const y = Number(d.date.slice(0, 4))
      if (y < earliest) earliest = y
    }
    const min = Math.min(earliest, max - 4)
    return { min, max }
  }, [diaries, today])

  // 跨年：若原先停在「今年」，自动跟到新年；手动翻旧年则不动
  useEffect(() => {
    const y = Number(today.slice(0, 4))
    setYear(prev => (prev === y - 1 ? y : Math.min(prev, y)))
  }, [today])

  // 在年份控制区滚动滚轮即可切换年份
  const yearBoxRef = useRef<HTMLDivElement>(null)
  const yearsRef = useRef(years)
  yearsRef.current = years

  useEffect(() => {
    const el = yearBoxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { min, max } = yearsRef.current
      setYear(y => Math.min(max, Math.max(min, e.deltaY < 0 ? y + 1 : y - 1)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 开屏 Logo → 整蛊门 → 主界面（顺序不能反）
  if (!bootDone) {
    return <BootSplash durationMs={BOOT_MS} />
  }

  // 隐私门：确认开启且未解锁时才拦截；未知/关闭时绝不闪现
  if (gateEnabled === true && !gate) {
    return <Gate onUnlock={() => setGate(true)} />
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="sticky top-0 z-30 c-bg border-b c-line">
        <div className="max-w-4xl mx-auto px-5 md:px-8 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-bold tracking-wide" style={{ fontFamily: '"Orbitron", sans-serif', fontSize: 22 }}>MyDiary</span>
            <div className="hidden md:flex flex-col min-w-0">
              <span className="label-xs">本地日记</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div
              className="hidden md:flex items-center p-0.5 border c-line"
              style={{ background: 'var(--bg-2)', borderRadius: 7 }}
            >
              {([['heatmap', '热力图'], ['list', '列表']] as [View, string][]).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setView(k)}
                  className="px-3 py-1.5 text-xs transition-colors"
                  style={{
                    borderRadius: 5,
                    background: view === k ? 'var(--bg)' : 'transparent',
                    color: view === k ? 'var(--fg)' : 'var(--fg-2)',
                    boxShadow: view === k ? '0 1px 0 var(--line)' : 'none',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              className="label-xs hover:c-fg transition-colors p-1.5"
              onClick={() => setShowSettings(true)}
              title="设置"
              //变大
              style={{ fontSize: 18 }}
            >
              ⚙
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 md:px-8 pt-4 md:pt-5 pb-24">
        {/* 今日入口 */}
        <section className="mb-8 fade-up">
          <div className="text-center mb-5">
            <div
              className="label-xs mb-2"
              style={{
                fontFamily: '"KaiTi", "楷体", "STKaiti", serif',
                fontSize: 13,
                letterSpacing: '0.04em',
                fontWeight: 700,
              }}
            >
              {formatCN(today)} · {weekdayCN(today)}
            </div>
            {/* 时钟永远与日期同轴居中；节气框固定偏移，不随秒数漂移 */}
            <div className="relative flex justify-center" style={{ minHeight: 72 }}>
              <div
                className="clock-time"
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                  lineHeight: 1,
                  width: 'fit-content',
                }}
              >
                {String(now.getHours()).padStart(2, '0')}
                <span className="clock-colon">:</span>
                {String(now.getMinutes()).padStart(2, '0')}
                <span
                  style={{
                    fontSize: '0.55em',
                    verticalAlign: '0.12em',
                    marginLeft: '0.06em',
                    color: 'var(--accent)',
                    WebkitTextFillColor: 'var(--accent)',
                    lineHeight: 1,
                  }}
                >
                  :{String(now.getSeconds()).padStart(2, '0')}
                </span>
              </div>
              {holidayName && (
                <div
                  title="今天是节日"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(calc(-50% - 240px), -50%)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: '"Songti SC", "STSong", "SimSun", "Noto Serif SC", serif',
                    fontSize: 15,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    color: 'var(--fg-2)',
                    border: '1px solid var(--line)',
                    background: 'var(--bg-2)',
                    borderRadius: 10,
                    padding: '8px 12px',
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  今天是{holidayName}
                </div>
              )}
              {solarTerm && (
                <div
                  title="当前节气"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(calc(-50% + 240px), -50%)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: '"Songti SC", "STSong", "SimSun", "Noto Serif SC", serif',
                    fontSize: 15,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    color: 'var(--fg-2)',
                    border: '1px solid var(--line)',
                    background: 'var(--bg-2)',
                    borderRadius: 10,
                    padding: '8px 12px',
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>今天是{solarTerm}第</span>
                  {solarDay != null && (
                    <span
                      style={{
                        fontFamily: '"JetBrains Mono", monospace',
                        fontWeight: 700,
                        fontSize: '1.15em',
                        color: 'var(--fg)',
                        margin: '0 2px',
                        lineHeight: 1,
                      }}
                    >
                      {solarDay}
                    </span>
                  )}
                  <span>天</span>
                </div>
              )}
            </div>
          </div>
          {/* 今日状态：列表页隐藏 */}
          {view !== 'list' && (
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div>
                <h1 className="text-2xl md:text-3xl c-fg leading-tight tracking-tight font-semibold">
                  {wroteToday ? '今天已经写过了。' : '今天还没有写。'}
                </h1>
                {wroteToday && map.get(today) && (
                  <p className="text-sm c-fg2 mt-2">
                    {formatNumber(map.get(today)!.words)} 字 · 更新于 {relativeTime(map.get(today)!.mtime)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2.5">
                <button className="btn btn-primary" onClick={writeToday}>
                  {wroteToday ? '继续写' : '写今天的日记'}
                </button>
                {wroteToday && (
                  <button className="btn btn-ghost" onClick={() => setSelected(today)}>
                    阅读
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* 统计：数字块 + 可展开的趋势（同一张卡片）；列表页隐藏 */}
        {stats && view !== 'list' && (
          <section className="mb-10 fade-up" style={{ animationDelay: '60ms' }}>
            <div className="card overflow-hidden" style={{ borderRadius: 10 }}>
              <div className="relative">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-px overflow-hidden">
                  <StatBlock label="已写" value={formatNumber(stats.writtenDays)} unit="天" />
                  <StatBlock label="当前连续" value={formatNumber(stats.currentStreak)} unit="天" accent />
                  <StatBlock label="最长连续" value={formatNumber(stats.longestStreak)} unit="天" />
                  <StatBlock label="累计字数" value={formatNumber(stats.totalWords)} unit="字" />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = !showTrend
                    setShowTrend(next)
                    if (next) void refresh() // 每次展开都拉取最新数据
                  }}
                  aria-expanded={showTrend}
                  title={showTrend ? '收起字数趋势' : '展开字数趋势'}
                  className="trend-toggle absolute top-2 right-2 flex items-center justify-center transition-colors"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    color: showTrend ? 'var(--accent)' : 'var(--fg-2)',
                    background: showTrend
                      ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
                      : 'var(--bg-2)',
                    border: '1px solid var(--line)',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <polyline
                      points="2,12 5,8 8,10 11,4 14,7"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              {showTrend && (
                <div className="border-t c-line" style={{ background: 'var(--bg)' }}>
                  <MonthlyTrend diaries={diaries} />
                </div>
              )}
            </div>
          </section>
        )}

        {/* 热力图 */}
        {view === 'heatmap' && (
          <section className="fade-up" style={{ animationDelay: '100ms' }}>
            <div className="flex items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-3" ref={yearBoxRef} title="滚轮或拖动滑块切换年份">
                <span className="label-xs" style={{ minWidth: 48 }}>{year} 年</span>
                <input
                  type="range"
                  min={years.min}
                  max={years.max}
                  step={1}
                  value={year}
                  onChange={e => setYear(Number(e.target.value))}
                  aria-label="选择年份"
                  style={{ width: 150, accentColor: 'var(--accent)' }}
                />
                {year !== years.max && (
                  <button className="label-xs hover:c-fg transition-colors" onClick={() => setYear(years.max)}>
                    回到今年
                  </button>
                )}
              </div>
              <div className="label-xs">点格子查看当天</div>
            </div>
            {loadError ? (
              <LoadErrorCard message={loadError} onRetry={retry} />
            ) : loading ? (
              <div className="label-xs py-16 text-center">读取中…</div>
            ) : (
              <Heatmap diaries={diaries} onSelect={setSelected} selected={selected ?? undefined} year={year} />
            )}
          </section>
        )}

        {/* 列表：默认「拾光」抽日子，日记列表点按钮再展开 */}
        {view === 'list' && (
          <section className="fade-up">
            {loadError ? (
              <LoadErrorCard message={loadError} onRetry={retry} />
            ) : loading ? (
              <div className="label-xs py-16 text-center">读取中…</div>
            ) : (
              <>
                <Shiguang diaries={diaries} onSelect={setSelected} />

                <div className="mt-4">
                  <button
                    type="button"
                    className="btn btn-ghost w-full justify-center"
                    onClick={() => setShowList(v => !v)}
                    aria-expanded={showList}
                  >
                    {showList
                      ? '收起日记列表'
                      : `显示日记列表${diaries.length ? `（${diaries.length}）` : ''}`}
                  </button>
                </div>

                {showList && diaries.length > 0 && (
                  <div className="card overflow-hidden mt-3" style={{ borderRadius: 10 }}>
                    {diaries.map((d, i) => (
                      <button
                        key={d.date}
                        onClick={() => setSelected(d.date)}
                        className="list-row w-full text-left px-5 py-4 flex items-center gap-4 group"
                        style={{ borderTop: i === 0 ? 'none' : '1px solid var(--line)' }}
                      >
                        <div className="shrink-0 w-[4.5rem]">
                          <div className="mono text-sm c-fg whitespace-nowrap">{formatShort(d.date)}</div>
                          <div className="label-xs mt-0.5">{weekdayCN(d.date).replace('周', '')}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm c-fg truncate">
                            {d.broken ? (
                              <span style={{ color: 'var(--danger)' }}>（无法解密）</span>
                            ) : d.empty ? (
                              <span className="c-fg3">（空）</span>
                            ) : (
                              d.preview || d.title
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 label-xs">{d.words > 0 ? `${formatNumber(d.words)} 字` : '—'}</div>
                        <div className="shrink-0 c-fg3 group-hover:c-fg transition-all text-sm group-hover:translate-x-0.5">→</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* 手机端视图切换 */}
        <div
          className="md:hidden fixed bottom-0 left-0 right-0 c-bg z-30 border-t c-line"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="grid grid-cols-2">
            {([['heatmap', '热力图'], ['list', '列表']] as [View, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                className="py-3.5 text-xs transition-colors"
                style={{ color: view === k ? 'var(--fg)' : 'var(--fg-2)', fontWeight: view === k ? 600 : 400 }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </main>

      {/* 弹窗 */}
      {selected && (
        <DiaryModal
          date={selected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onEdit={d => {
            setSelected(null)
            setEditing(d)
          }}
        />
      )}
      {editing && (
        <Editor
          date={editing}
          onClose={() => setEditing(null)}
          onChanged={refresh}
          editorName={editorName}
        />
      )}
      {showSettings && status && (
        <SettingsModal
          status={status}
          onClose={() => setShowSettings(false)}
          onSaved={refresh}
          onFirstPasswordSet={() => {
            try { localStorage.setItem('md-password-reminder', '0') } catch {}
            setPasswordReminderClicks(0)
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-20 md:bottom-8 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 fade-in text-xs c-fg border c-line"
          style={{ borderRadius: 6, background: 'var(--bg)', boxShadow: '0 8px 24px rgba(31,35,40,0.12)' }}
        >
          {toast}
        </div>
      )}
      {passwordReminderClicks !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.68)', backdropFilter: 'blur(5px)' }}
          onClick={e => e.stopPropagation()}
        >
          <div
            className="c-bg border c-line p-6"
            style={{ width: 360, maxWidth: '100%', borderRadius: 6, boxShadow: '0 24px 80px rgba(0,0,0,0.38)' }}
          >
            <div className="label-xs mb-3" style={{ color: 'var(--warning, #d6a84f)' }}>首次设置完成 · 必读提醒</div>
            <h3 className="text-[15px] c-fg font-semibold">请妥善保存密码和验证答案</h3>
            <p className="label-xs mt-3 leading-6">
              请记住刚设置的 6 位隐私门密码，以及忘记密码时使用的辅助验证答案。遗忘后只能通过该答案重置密码。
            </p>
            <div className="mt-5">
              <button className="btn btn-primary w-full justify-center" onClick={confirmPasswordReminder}>
                {passwordReminderClicks === 0 ? '我已记录密码（确认 1/3）' : passwordReminderClicks === 1 ? '我已记录验证答案（确认 2/3）' : '我确认已妥善保存（确认 3/3）'}
              </button>
              <div className="label-xs text-center mt-3">需要完成三次确认才能关闭</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
function LoadErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card px-6 py-10 text-center" style={{ borderRadius: 10 }}>
      <div className="text-sm c-fg">无法读取本地数据</div>
      <div className="label-xs mt-2 break-words" style={{ color: 'var(--danger)' }}>{message}</div>
      <button className="btn btn-primary mt-4" onClick={onRetry}>重试</button>
    </div>
  )
}

function StatBlock({ label, value, unit, accent }: { label: string; value: string; unit: string; accent?: boolean }) {
  return (
    <div className="px-5 py-4" style={{ background: 'var(--bg)' }}>
      <div className="label-xs mb-2">{label}</div>
      <div className="flex items-baseline gap-1">
        <span
          className="mono text-2xl md:text-3xl font-medium count-up"
          style={{ color: accent ? 'var(--success)' : 'var(--fg)' }}
        >
          {value}
        </span>
        <span className="label-xs">{unit}</span>
      </div>
    </div>
  )
}

/** 近 12 个月字数趋势折线 */
function MonthlyTrend({ diaries }: { diaries: DiaryMeta[] }) {
  const data = useMemo(() => {
    const now = new Date()
    const months: { key: string; label: string; words: number }[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      months.push({
        key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
        label: d.getMonth() + 1 + '月',
        words: 0,
      })
    }
    const idx = new Map(months.map((m, i) => [m.key, i]))
    for (const d of diaries) {
      if (d.empty) continue
      const i = idx.get(d.date.slice(0, 7))
      if (i != null) months[i].words += d.words
    }
    return months
  }, [diaries])

  const max = Math.max(...data.map(d => d.words), 1)
  const total = data.reduce((s, d) => s + d.words, 0)
  const peak = data.reduce((a, b) => (b.words > a.words ? b : a), data[0])
  const cur = data[data.length - 1] // 当月（最后一根）

  // SVG 坐标（拉宽画布让月与月之间更疏朗）
  const W = 1000
  const H = 250
  const padL = 64
  const padR = 34
  const padT = 46
  const padB = 46
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const xOf = (i: number) => padL + (i / Math.max(1, data.length - 1)) * innerW
  const yOf = (v: number) => padT + (1 - v / max) * innerH

  const pts = data.map((d, i) => ({ x: xOf(i), y: yOf(d.words), ...d }))

  // Catmull-Rom → 贝塞尔平滑曲线
  const smoothPath = useMemo(() => {
    const P = pts.map(p => [p.x, p.y] as const)
    if (P.length < 2) return `M${P[0][0]},${P[0][1]}`
    let path = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)]
      const p1 = P[i]
      const p2 = P[i + 1]
      const p3 = P[Math.min(P.length - 1, i + 2)]
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = p2[1] - (p3[1] - p1[1]) / 6
      path += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
    }
    return path
  }, [data, max])
  const areaPath =
    smoothPath +
    ` L${pts[pts.length - 1].x.toFixed(1)},${(padT + innerH).toFixed(1)}` +
    ` L${pts[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} Z`

  // 悬停：导轨 + 数据点 + 浮层
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((mx - padL) / innerW) * (data.length - 1))
    setHover(Math.max(0, Math.min(data.length - 1, i)))
  }
  const hp = hover != null ? pts[hover] : null
  // 浮层坐标（防溢出）
  let tipX = 0
  let tipY = 0
  if (hp) {
    tipX = hp.x + 18
    tipY = Math.max(padT + 2, hp.y - 66)
    if (tipX + 132 > W - padR) tipX = hp.x - 150
  }

  return (
    <div className="px-5 pt-4 pb-3">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <div className="label-xs">月度字数趋势 · 近 12 个月</div>
        <div className="label-xs">
          本月 {formatNumber(cur.words)} 字 · 合计 {formatNumber(total)} 字 · 峰值 {peak.label} {formatNumber(peak.words)} 字
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="近 12 个月字数趋势"
        style={{ display: 'block' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="mt-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.22 }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.01 }} />
          </linearGradient>
        </defs>

        {/* 横向参考线 */}
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
          const y = padT + t * innerH
          return (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 10} y={y + 4.5} textAnchor="end" fontSize="13" fill="var(--fg-3)">
                {formatNumber(Math.round(max * (1 - t)))}
              </text>
            </g>
          )
        })}

        {/* 渐变面积 + 平滑曲线 */}
        <path d={areaPath} fill="url(#mt-grad)" />
        <path
          d={smoothPath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="3"
          strokeLinecap="round"
        />

        {/* 月份刻度 */}
        {pts.map(p => (
          <text key={p.key} x={p.x} y={H - 12} textAnchor="middle" fontSize="13" fill="var(--fg-3)">
            {p.label}
          </text>
        ))}

        {/* 当月高亮点 + 数值标注 */}
        {cur.words > 0 && (
          <g pointerEvents="none">
            <circle cx={pts[pts.length - 1].x} cy={yOf(cur.words)} r="6" fill="var(--bg)" stroke="var(--accent)" strokeWidth="3" />
            <text
              x={pts[pts.length - 1].x}
              y={yOf(cur.words) - 16}
              textAnchor={pts[pts.length - 1].x > W - padR - 90 ? 'end' : 'middle'}
              fontSize="14"
              fontWeight="700"
              fill="var(--accent)"
            >
              本月 {formatNumber(cur.words)} 字
            </text>
          </g>
        )}

        {/* 悬停：导轨 + 数据点 + 浮层 */}
        {hp && (
          <g pointerEvents="none">
            <line
              x1={hp.x} x2={hp.x} y1={padT} y2={padT + innerH}
              stroke="var(--accent)" strokeWidth="1" opacity="0.35"
            />
            <circle cx={hp.x} cy={hp.y} r="6" fill="var(--bg)" stroke="var(--accent)" strokeWidth="2.8" />
            <g>
              <rect x={tipX} y={tipY} rx="9" width="132" height="56" fill="#1F2A2C" />
              <text x={tipX + 15} y={tipY + 22} fontSize="12.5" fill="#9FB3B5">
                {hp.key.slice(0, 4)} 年 {hp.label}
              </text>
              <text x={tipX + 15} y={tipY + 45} fontSize="16" fontWeight="700" fill="#FFFFFF">
                {hp.words.toLocaleString()} 字
              </text>
            </g>
          </g>
        )}

        {/* 悬停热区 */}
        <rect
          x={padL} y={padT} width={innerW} height={innerH}
          fill="transparent"
        />
      </svg>
    </div>
  )
}

function PaneHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-3">
      <div className="text-[13px] c-fg font-semibold">{title}</div>
      <div className="label-xs mt-1 leading-relaxed">{desc}</div>
    </div>
  )
}

function SettingsSection({ children }: { children: ReactNode }) {
  return (
    <div className="border c-line" style={{ borderRadius: 6, background: 'var(--bg)' }}>
      {children}
    </div>
  )
}

function SettingRow({ title, desc, control }: { title: string; desc: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <div className="min-w-0">
        <div className="text-[13px] c-fg">{title}</div>
        <div className="label-xs mt-1 leading-relaxed">{desc}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      style={{
        width: 38, height: 22, borderRadius: 11, border: 'none', padding: 0,
        background: on ? 'var(--success)' : 'var(--line)',
        position: 'relative', cursor: 'pointer', transition: 'background 200ms ease',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute', top: 2, left: on ? 18 : 2,
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          transition: 'left 200ms cubic-bezier(0.16,1,0.3,1)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  )
}

function SettingsModal({ status, onClose, onSaved, onFirstPasswordSet }: { status: Status; onClose: () => void; onSaved: () => void; onFirstPasswordSet: () => void }) {
  const [editor, setEditor] = useState(status.editorPath)
  const [gateOn, setGateOn] = useState(status.privacyGateEnabled !== false)
  const [idleLock, setIdleLock] = useState(status.idleLockMinutes ?? 0)
  const [reminderOn, setReminderOn] = useState(status.reminderEnabled === true)
  const [reminderTime, setReminderTime] = useState(status.reminderTime || '21:00')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [tab, setTab] = useState<'editor' | 'privacy' | 'auto' | 'data'>('privacy')
  const editorDirty = editor.trim() !== status.editorPath.trim()
  // 密码弹窗：set=开启时设置密码 / off=关闭时验证 / change=修改密码 / answer=设置辅助验证答案
  // a=当前密码 b=新密码 c=确认新密码 d=辅助验证答案
  const [pwDialog, setPwDialog] = useState<null | { mode: 'set' | 'off' | 'change' | 'answer'; a: string; b: string; c: string; d: string }>(null)
  const [pwErr, setPwErr] = useState<string | null>(null)
  const [exitAsk, setExitAsk] = useState(false)
  const [migrationBusy, setMigrationBusy] = useState<null | 'export' | 'import-picker' | 'import'>(null)
  const [exportPassword, setExportPassword] = useState('')
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null)

  // 操作结果提示
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }

  const pick = async () => {
    setPicking(true)
    try {
      const r = await api.pickPath({ mode: 'exe', initial: editor })
      if (r.path) setEditor(r.path)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      window.alert(msg.includes('404')
        ? '本地服务未启动，请重新打开 MyDiary'
        : msg || '打开系统对话框失败')
    } finally {
      setPicking(false)
    }
  }

  const cleanTemp = async () => {
    if (!window.confirm('删除外部编辑器留下的明文临时文件？尚未保存到编辑器的内容会丢失。')) return
    setCleaning(true)
    try {
      const r = await api.cleanEditTemp()
      showToast(r.removed > 0 ? `已清理 ${r.removed} 个临时文件` : '没有可清理的临时文件', true)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '清理失败', false)
    } finally {
      setCleaning(false)
    }
  }

  const exportData = async () => {
    if (exportPassword.length < 8) {
      setMigrationNotice('迁移文件密码至少需要 8 个字符。')
      return
    }
    if (exportPassword !== exportPasswordConfirm) {
      setMigrationNotice('两次输入的迁移文件密码不一致。')
      return
    }
    setMigrationBusy('export')
    setMigrationNotice(null)
    try {
      const choice = await api.pickPath({ mode: 'archive-save' })
      if (!choice.path) return
      const result = await api.exportData(choice.path, exportPassword)
      setMigrationNotice(`已导出 ${result.diaryCount} 篇日记和 ${result.imageCount} 张图片。请在新设备使用此迁移文件及该密码导入。`)
      setExportPassword('')
      setExportPasswordConfirm('')
    } catch (e) {
      setMigrationNotice(e instanceof Error ? e.message : '导出失败，请重试。')
    } finally {
      setMigrationBusy(null)
    }
  }

  const importData = async () => {
    if (!importPassword) {
      setMigrationNotice('请输入迁移文件密码。')
      return
    }
    setMigrationBusy('import-picker')
    setMigrationNotice(null)
    try {
      const choice = await api.pickPath({ mode: 'archive-open' })
      if (!choice.path) return
      const confirmed = window.confirm('导入会替换本机现有的全部日记和图片，当前配置与隐私门密码会保留。建议先导出备份。确定继续吗？')
      if (!confirmed) return
      setMigrationBusy('import')
      const result = await api.importData(choice.path, importPassword)
      showToast(`已导入 ${result.diaryCount} 篇日记和 ${result.imageCount} 张图片。`, true)
      setImportPassword('')
      await onSaved()
    } catch (e) {
      const message = e instanceof Error ? e.message : '请检查迁移文件和密码后重试。'
      showToast(`导入失败：${message}`, false)
    } finally {
      setMigrationBusy(null)
    }
  }

  /** 用当前密码换解锁 token（改密码 / 开关隐私门前都要验一次）。
   *  注意：Electron 不支持 window.prompt()，验证一律走表单字段 */
  const verifyCurrent = async (cur: string): Promise<string | null> => {
    try {
      const r = await api.unlock(cur)
      if (!r.token) return null
      try { sessionStorage.setItem('md-gate-token', r.token) } catch {}
      return r.token
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const er = e as { locked?: boolean }
      if (er.locked || msg.includes('423')) {
        window.alert('密码错误次数过多，请稍后再试')
      } else if (msg.includes('404')) {
        window.alert('本地服务未启动，请重新打开 MyDiary')
      } else {
        window.alert(msg.includes('401') ? '当前密码错误' : msg || '验证失败')
      }
      return null
    }
  }

  const save = async () => {
    if (reminderOn && !/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
      window.alert('请选择有效的提醒时间')
      return
    }
    setBusy(true)
    try {
      await api.saveConfig({
        editorPath: editor,
        idleLockMinutes: idleLock,
        reminderEnabled: reminderOn,
        reminderTime,
      })
      onSaved()
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      window.alert(
        msg.includes('404') ? '本地服务未启动，请重新打开 MyDiary' : msg || '保存失败',
      )
    } finally {
      setBusy(false)
    }
  }

  /** 开关隐私门：开→弹窗设密码；关→弹窗验当前密码 */
  const onToggleGate = () => {
    setPwErr(null)
    setPwDialog(gateOn ? { mode: 'off', a: '', b: '', c: '', d: '' } : { mode: 'set', a: '', b: '', c: '', d: '' })
  }

  /** 密码弹窗确认 */
  const submitPwDialog = async () => {
    if (!pwDialog) return
    const a = pwDialog.a.trim()
    const b = pwDialog.b.trim()
    const c = pwDialog.c.trim()
    const d = pwDialog.d.trim()
    setBusy(true)
    setPwErr(null)
    let remindAfterSet = false
    try {
      let token = getUnlockToken()
      if (pwDialog.mode === 'answer') {
        // 仅设置/修改辅助验证答案；门开着时需先验证当前密码
        if (!d) { setPwErr('请输入辅助验证答案'); return }
        if (gateOn) {
          if (!a) { setPwErr('请输入当前密码'); return }
          const t = await verifyCurrent(a)
          if (!t) return
          token = t
        }
        await api.saveConfig({ editorPath: editor, securityAnswer: d, unlockToken: token })
        showToast('辅助验证答案已保存', true)
      } else if (pwDialog.mode === 'set') {
        // 开启密码：新密码 + 确认 + 辅助验证答案
        if (!/^\d{6}$/.test(b)) { setPwErr('新密码须为 6 位数字'); return }
        if (b !== c) { setPwErr('两次输入的密码不一致'); return }
        if (!d) { setPwErr('请输入辅助验证答案（用于忘记密码时找回）'); return }
        const saved = await api.saveConfig({
          editorPath: editor,
          privacyGateEnabled: true,
          privacyPassword: b,
          securityAnswer: d,
          unlockToken: token,
        })
        remindAfterSet = saved.firstPasswordSet === true
        writeGateEnabled(true)
        setGateOn(true)
        showToast('已开启密码保护', true)
      } else if (pwDialog.mode === 'off') {
        if (!a) { setPwErr('请输入当前密码'); return }
        const t = await verifyCurrent(a)
        if (!t) return
        token = t
        await api.saveConfig({ editorPath: editor, privacyGateEnabled: false, unlockToken: token })
        writeGateEnabled(false)
        setGateOn(false)
        showToast('已关闭密码保护', true)
      } else {
        if (!a) { setPwErr('请输入当前密码'); return }
        if (!/^\d{6}$/.test(b)) { setPwErr('新密码须为 6 位数字'); return }
        if (b !== c) { setPwErr('两次输入的密码不一致'); return }
        const t = await verifyCurrent(a)
        if (!t) return
        token = t
        const saved = await api.saveConfig({
          editorPath: editor,
          privacyPassword: b,
          ...(d ? { securityAnswer: d } : {}),
          unlockToken: token,
        })
        remindAfterSet = saved.firstPasswordSet === true
        showToast('密码已修改', true)
      }
      setPwDialog(null)
      onSaved()
      if (remindAfterSet) onFirstPasswordSet()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const label =
        pwDialog.mode === 'set'
          ? '开启密码保护失败'
          : pwDialog.mode === 'off'
          ? '关闭密码保护失败'
          : pwDialog.mode === 'answer'
          ? '保存辅助验证答案失败'
          : '修改密码失败'
      setPwErr(
        msg.includes('404')
          ? `${label}：本地服务未启动，请重新打开 MyDiary`
          : msg.includes('401')
          ? `${label}：当前密码错误`
          : `${label}：${msg || '请重试'}`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in"
      style={{ background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <div
        className="c-bg modal-in border c-line"
        style={{
          width: 680,
          maxWidth: '100%',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: '0 24px 70px rgba(31,35,40,0.2)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b c-line shrink-0">
          <h2 className="text-[15px] c-fg font-semibold">设置</h2>
          <button onClick={onClose} className="label-xs hover:c-fg p-1" aria-label="关闭设置">✕</button>
        </div>

        <div className="flex" style={{ height: 344 }}>
          <nav
            className="flex flex-col shrink-0 px-2 py-2.5 border-r c-line"
            style={{ width: 156, background: 'var(--bg-2)' }}
            aria-label="设置分区"
          >
            {([
              ['editor', '外部编辑器'],
              ['privacy', '隐私与密码'],
              ['auto', '锁定与提醒'],
              ['data', '数据迁移'],
            ] as const).map(([key, label]) => {
              const active = tab === key
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className="text-left text-xs"
                  style={{
                    padding: '7px 10px',
                    marginBottom: 2,
                    borderRadius: 4,
                    color: active ? 'var(--fg)' : 'var(--fg-2)',
                    background: active ? 'var(--bg)' : 'transparent',
                    boxShadow: active ? 'inset 0 0 0 1px var(--line)' : 'none',
                    fontWeight: active ? 600 : 400,
                    transition: 'background 120ms ease, color 120ms ease',
                  }}
                >
                  {label}
                </button>
              )
            })}
            <div className="mt-auto px-2 pt-3 label-xs leading-relaxed">
              来自 dafen
              <a className="block underline hover:c-fg" href="https://github.com/hhhjjddss/MyDiary" target="_blank" rel="noreferrer">给项目打分</a>
            </div>
          </nav>

          <div className="flex-1 min-w-0 px-5 py-4" style={{ overflow: 'hidden' }}>
          {tab === 'editor' && (
            <div>
              <PaneHeader
                title="外部编辑器"
                desc="写作时可把当天内容交给本地编辑器继续写；阅读始终在应用内完成。"
              />
              <SettingsSection>
                <div className="px-3 py-3">
                  <label className="label-xs block mb-2" htmlFor="editor-path">编辑器路径</label>
                  <div className="flex items-center gap-2">
                    <input
                      id="editor-path"
                      value={editor}
                      onChange={e => setEditor(e.target.value)}
                      placeholder="尚未选择编辑器（可留空）"
                      className="mono text-xs c-fg bg-transparent border c-line px-3 py-2.5 outline-none focus:border-current transition-colors flex-1 min-w-0"
                      style={{ borderRadius: 4, caretColor: 'var(--fg)', pointerEvents: 'auto' }}
                    />
                    <button
                      className="btn btn-ghost shrink-0"
                      style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4 }}
                      disabled={picking}
                      onClick={() => void pick()}
                    >
                      浏览
                    </button>
                  </div>
                  <div
                    className="label-xs mt-2"
                    style={{
                      color: !editor.trim()
                        ? 'var(--fg-2)'
                        : editorDirty
                          ? 'var(--fg-2)'
                          : status.editorExists ? 'var(--success)' : 'var(--danger)',
                    }}
                  >
                    {!editor.trim()
                      ? '可选；仅用于写作时在外部程序里打开'
                      : editorDirty
                        ? '保存后检查该路径'
                        : status.editorExists ? '✓ 已找到' : '✕ 路径不存在'}
                  </div>
                </div>
                <div className="border-t c-line px-3 py-3 flex items-start justify-between gap-4">
                  <span className="label-xs leading-relaxed">外部编辑器会收到明文临时文件，请仅在可信环境使用</span>
                  <button
                    className="btn btn-ghost shrink-0"
                    style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4 }}
                    disabled={cleaning}
                    onClick={() => void cleanTemp()}
                    aria-label="清理临时文件"
                  >
                    {cleaning ? '清理中…' : '清理临时文件'}
                  </button>
                </div>
              </SettingsSection>
            </div>
          )}

          {tab === 'privacy' && (
            <div>
              <PaneHeader
                title="隐私与密码"
                desc="最小化或关闭窗口后，再次打开需要输入密码。"
              />
              <SettingsSection>
                <SettingRow
                  title="打开应用需输入密码"
                  desc="开启后，最小化或关闭窗口再打开时需重新输入密码"
                  control={<Toggle on={gateOn} onClick={onToggleGate} label="隐私门开关" />}
                />
                <div className="border-t c-line" />
                <SettingRow
                  title="修改密码"
                  desc="弹窗内完成，需验证当前密码"
                  control={
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4 }}
                      onClick={() => {
                        setPwErr(null)
                        setPwDialog({ mode: 'change', a: '', b: '', c: '', d: '' })
                      }}
                    >
                      修改密码
                    </button>
                  }
                />
                <div className="border-t c-line" />
                <SettingRow
                  title="辅助验证"
                  desc={
                    status.hasSecurityAnswer === false
                      ? '未设置；忘记密码时将无法自助找回'
                      : '已设置；忘记密码时回答问题后可重置'
                  }
                  control={
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4 }}
                      onClick={() => {
                        setPwErr(null)
                        setPwDialog({ mode: 'answer', a: '', b: '', c: '', d: '' })
                      }}
                    >
                      {status.hasSecurityAnswer === false ? '设置答案' : '修改答案'}
                    </button>
                  }
                />
              </SettingsSection>
              {status.hasSecurityAnswer === false && (
                <div className="label-xs mt-3" style={{ color: 'var(--danger)' }}>
                  ⚠ 尚未设置辅助验证答案，忘记密码将无法自助找回
                </div>
              )}
            </div>
          )}

          {tab === 'auto' && (
            <div>
              <PaneHeader
                title="锁定与提醒"
                desc="基于系统空闲时间和本机时间；仅在应用运行时生效。"
              />
              <SettingsSection>
                <SettingRow
                  title="空闲自动锁定"
                  desc="无操作达到设定时长后自动锁定并收起窗口（需开启隐私门）"
                  control={
                    <select
                      value={idleLock}
                      onChange={e => setIdleLock(Number(e.target.value))}
                      className="text-xs c-fg border c-line px-2 py-1.5 outline-none focus:border-current transition-colors shrink-0"
                      style={{ borderRadius: 4, background: 'var(--bg)' }}
                      aria-label="空闲自动锁定时间"
                    >
                      <option value={0}>关闭</option>
                      <option value={5}>5 分钟</option>
                      <option value={10}>10 分钟</option>
                      <option value={15}>15 分钟</option>
                      <option value={30}>30 分钟</option>
                      <option value={60}>1 小时</option>
                    </select>
                  }
                />
                <div className="border-t c-line" />
                <SettingRow
                  title="每日写作提醒"
                  desc="到点发送系统通知；当天已经写过则跳过"
                  control={
                    <Toggle
                      on={reminderOn}
                      onClick={() => setReminderOn(v => !v)}
                      label="每日写作提醒开关"
                    />
                  }
                />
                {reminderOn && (
                  <>
                    <div className="border-t c-line" />
                    <SettingRow
                      title="提醒时间"
                      desc="使用本机时区"
                      control={
                        <input
                          id="reminder-time"
                          type="time"
                          value={reminderTime}
                          onChange={e => setReminderTime(e.target.value)}
                          className="mono text-xs c-fg bg-transparent border c-line px-2 py-1.5 outline-none focus:border-current transition-colors"
                          style={{ borderRadius: 4 }}
                        />
                      }
                    />
                  </>
                )}
              </SettingsSection>
            </div>
          )}

          {tab === 'data' && (
            <div>
              <PaneHeader
                title="数据迁移"
                desc="打包为口令加密的 .mydiary 文件，可在另一台设备导入。"
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="border c-line p-3 flex flex-col gap-2" style={{ borderRadius: 6, background: 'var(--bg)' }}>
                  <div>
                    <div className="text-[13px] c-fg">导出</div>
                    <div className="label-xs mt-1">密码至少 8 个字符，导入时需要</div>
                  </div>
                  <input
                    value={exportPassword}
                    onChange={e => setExportPassword(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="设置迁移文件密码"
                    className="w-full text-xs c-fg bg-transparent border c-line px-3 py-2 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4, caretColor: 'var(--fg)', pointerEvents: 'auto' }}
                  />
                  <input
                    value={exportPasswordConfirm}
                    onChange={e => setExportPasswordConfirm(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="再次输入密码"
                    className="w-full text-xs c-fg bg-transparent border c-line px-3 py-2 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4, caretColor: 'var(--fg)', pointerEvents: 'auto' }}
                  />
                  <button className="btn btn-ghost w-full justify-center mt-auto" onClick={() => void exportData()} disabled={migrationBusy !== null}>
                    {migrationBusy === 'export' ? '正在导出…' : '导出全部日记与图片'}
                  </button>
                </div>

                <div className="border c-line p-3 flex flex-col gap-2" style={{ borderRadius: 6, background: 'var(--bg)' }}>
                  <div>
                    <div className="text-[13px] c-fg">导入</div>
                    <div className="label-xs mt-1">会替换本机全部日记和图片</div>
                  </div>
                  <input
                    value={importPassword}
                    onChange={e => setImportPassword(e.target.value)}
                    type="password"
                    autoComplete="current-password"
                    placeholder="输入导出时设置的密码"
                    className="w-full text-xs c-fg bg-transparent border c-line px-3 py-2 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4, caretColor: 'var(--fg)', pointerEvents: 'auto' }}
                  />
                  <button className="btn btn-ghost w-full justify-center" onClick={() => void importData()} disabled={migrationBusy !== null}>
                    {migrationBusy === 'import' && <span aria-hidden="true" className="migration-spinner" />}
                    {migrationBusy === 'import' ? '正在导入…' : '选择文件并导入'}
                  </button>
                  {migrationBusy === 'import' ? (
                    <div className="migration-progress-wrap" role="status" aria-live="polite">
                      <div className="migration-progress-track"><div className="migration-progress-indicator" /></div>
                      <div className="label-xs">正在解密并写入，请稍候…</div>
                    </div>
                  ) : (
                    <div className="label-xs leading-relaxed mt-auto">应用设置与隐私门密码保留；建议先导出备份。</div>
                  )}
                </div>
              </div>
              {migrationNotice && <div className="label-xs mt-3 break-words leading-relaxed" role="status">{migrationNotice}</div>}
            </div>
          )}
          </div>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t c-line shrink-0" style={{ background: 'var(--bg-2)' }}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>保存</button>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <span className="label-xs ml-1">{tab === 'data' ? '迁移操作立即生效' : '修改后需保存'}</span>
          <button
            className="btn btn-danger ml-auto"
            onClick={() => setExitAsk(true)}
          >
            退出
          </button>
        </div>
      </div>

      {/* 密码弹窗：开启设置密码 / 关闭验证 / 修改密码 */}
      {pwDialog && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 fade-in"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }}
          onClick={() => setPwDialog(null)}
        >
          <div
            className="c-bg modal-in border c-line"
            style={{ width: 300, maxWidth: '100%', borderRadius: 6, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b c-line">
              <h3 className="text-[14px] c-fg font-semibold">
                {pwDialog.mode === 'set'
                  ? '设置进入密码'
                  : pwDialog.mode === 'off'
                  ? '关闭密码门'
                  : pwDialog.mode === 'answer'
                  ? '辅助验证答案'
                  : '修改密码'}
              </h3>
              <button className="label-xs hover:c-fg p-1" onClick={() => setPwDialog(null)}>✕</button>
            </div>
            <div className="px-4 py-4 space-y-3">
              {(pwDialog.mode !== 'set' && !(pwDialog.mode === 'answer' && !gateOn)) && (
                <div>
                  <label className="label-xs block mb-2">当前密码</label>
                  <input
                    autoFocus
                    value={pwDialog.a}
                    onChange={e => setPwDialog({ ...pwDialog, a: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') void submitPwDialog() }}
                    type="password"
                    autoComplete="current-password"
                    name="mydiary-privacy-cur"
                    data-1p-ignore=""
                    data-lpignore="true"
                    data-bwignore="true"
                    className="w-full mono text-xs c-fg bg-transparent border c-line px-3 py-2.5 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4 }}
                  />
                </div>
              )}
              {(pwDialog.mode === 'set' || pwDialog.mode === 'change') && (
                <div>
                  <label className="label-xs block mb-2">新密码（6 位数字）</label>
                  <input
                    autoFocus={pwDialog.mode === 'set'}
                    value={pwDialog.b}
                    onChange={e => setPwDialog({ ...pwDialog, b: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') void submitPwDialog() }}
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="new-password"
                    name="mydiary-privacy-new"
                    data-1p-ignore=""
                    data-lpignore="true"
                    data-bwignore="true"
                    className="w-full mono text-xs c-fg bg-transparent border c-line px-3 py-2.5 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4 }}
                  />
                </div>
              )}
              {(pwDialog.mode === 'set' || pwDialog.mode === 'change') && (
                <div>
                  <label className="label-xs block mb-2">确认新密码</label>
                  <input
                    value={pwDialog.c}
                    onChange={e => setPwDialog({ ...pwDialog, c: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') void submitPwDialog() }}
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="new-password"
                    name="mydiary-privacy-new2"
                    data-1p-ignore=""
                    data-lpignore="true"
                    data-bwignore="true"
                    className="w-full mono text-xs c-fg bg-transparent border c-line px-3 py-2.5 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4 }}
                  />
                </div>
              )}
              {pwDialog.mode !== 'off' && (
                <div>
                  <label className="label-xs block mb-2">
                    {pwDialog.mode === 'answer'
                      ? '你最喜爱的人物是？'
                      : '辅助验证答案（忘记密码时回答的问题：你最喜爱的人物是？）'}
                    {pwDialog.mode === 'change' && '，留空则不修改'}
                  </label>
                  <input
                    autoFocus={pwDialog.mode === 'answer' && !gateOn}
                    value={pwDialog.d}
                    onChange={e => setPwDialog({ ...pwDialog, d: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') void submitPwDialog() }}
                    type="text"
                    name="mydiary-privacy-answer"
                    data-1p-ignore=""
                    data-lpignore="true"
                    data-bwignore="true"
                    className="w-full text-xs c-fg bg-transparent border c-line px-3 py-2.5 outline-none focus:border-current transition-colors"
                    style={{ borderRadius: 4 }}
                  />
                </div>
              )}
              {pwErr && (
                <div className="label-xs" style={{ color: 'var(--danger)' }}>{pwErr}</div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t c-line" style={{ background: 'var(--bg-2)' }}>
              <button className="btn btn-ghost" onClick={() => setPwDialog(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void submitPwDialog()} disabled={busy}>
                {busy ? '保存中…' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 退出方式选择：完全退出 / 仅关窗驻留托盘 */}
      {exitAsk && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 fade-in"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }}
          onClick={() => setExitAsk(false)}
        >
          <div
            className="c-bg modal-in border c-line"
            style={{ width: 320, maxWidth: '100%', borderRadius: 6, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4">
              <h3 className="text-[14px] c-fg font-semibold">退出 MyDiary</h3>
              <p className="label-xs mt-2">关闭窗口只是隐藏到托盘，服务继续运行。</p>
              <div className="mt-4 space-y-2">
                <button
                  className="btn btn-danger w-full justify-center"
                  onClick={async () => {
                    setExitAsk(false)
                    try { await api.shutdown() } catch {}
                  }}
                >
                  完全退出应用
                </button>
                <button
                  className="btn btn-ghost w-full justify-center"
                  onClick={() => {
                    setExitAsk(false)
                    window.close()
                  }}
                >
                  仅关闭窗口（驻留托盘）
                </button>
                <button className="btn btn-ghost w-full justify-center" onClick={() => setExitAsk(false)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 操作结果提示 */}
      {toast && (
        <div
          className="fixed left-1/2 label-xs border c-line fade-in"
          style={{
            bottom: 28,
            transform: 'translateX(-50%)',
            zIndex: 90,
            background: 'var(--bg-2)',
            borderRadius: 6,
            padding: '8px 16px',
            maxWidth: '90vw',
            pointerEvents: 'none',
            boxShadow: '0 8px 28px rgba(0,0,0,0.25)',
            color: toast.ok ? 'var(--success)' : 'var(--danger)',
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
