import { useMemo, useRef, useEffect, useState } from 'react'
import { api, type DiaryMeta } from '../api'
import { todayStr, WEEK_CN, weekdayCN } from '../utils'

interface HeatmapProps {
  diaries: DiaryMeta[]
  onSelect: (date: string) => void
  selected?: string
  year?: number  // 指定展示年份，默认今年
}

const GAP = 3
const MIN_CELL = 8
const FALLBACK_CELL = 11
const DAY_MS = 86400000
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

interface Cell {
  date: string
  level: number
  meta?: DiaryMeta
  inFuture: boolean
  outOfYear: boolean // 不属于展示年份（首尾周溢出到邻年）
  holiday?: { name: string; type: 'holiday' | 'work' } // 中国法定节假日/调休
}

function levelOf(m?: DiaryMeta): number {
  if (!m) return 0
  const c = m.words
  if (c === 0) return 0
  if (c < 50) return 1
  if (c < 200) return 2
  if (c < 600) return 3
  return 4
}

function fmt(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/**
 * GitHub 风格日记热力图
 * 一年一图，展示完整 12 个月（1月1日 → 12月31日），当天截止
 */
export function Heatmap({ diaries, onSelect, selected, year }: HeatmapProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [availWidth, setAvailWidth] = useState(0)
  // 每次渲染取当日，避免长开页面跨年后 today 卡住
  const today = todayStr()

  // 先确定展示年份，再拉对应节假日
  const displayYear0 = useMemo(() => {
    const ty = new Date(today + 'T00:00:00').getFullYear()
    return year ?? ty
  }, [today, year])

  const [holidays, setHolidays] = useState<Record<string, { name: string; type: 'holiday' | 'work' }>>({})
  useEffect(() => {
    let alive = true
    api.holiday(displayYear0).then(r => { if (alive) setHolidays(r.data || {}) }).catch(() => {})
    return () => { alive = false }
  }, [displayYear0])

  const { weeks, monthLabels, displayCount, displayYear, todayCol } = useMemo(() => {
    const map = new Map<string, DiaryMeta>()
    for (const d of diaries) map.set(d.date, d)

    const todayDate = new Date(today + 'T00:00:00')
    const todayMs = todayDate.getTime()
    const displayYear = displayYear0

    // 起点：1 月 1 日，对齐到周日
    const jan1 = new Date(displayYear, 0, 1)
    const start = new Date(jan1)
    start.setDate(start.getDate() - start.getDay())
    start.setHours(0, 0, 0, 0)

    // 终点：12 月 31 日；未来日期渲染为透明占位，保证整年 12 个月布局完整
    const dec31 = new Date(displayYear, 11, 31, 23, 59, 59, 999)
    const endMs = dec31.getTime()

    const weeks: Cell[][] = []
    const monthLabels: { col: number; label: string }[] = []
    let lastMonth = -1
    let col = 0
    let todayCol = -1

    for (let t = start.getTime(); t <= endMs; t += DAY_MS * 7, col++) {
      const weekCells: Cell[] = []
      for (let d = 0; d < 7; d++) {
        const cellMs = t + d * DAY_MS
        const dt = new Date(cellMs)
        const key = fmt(dt)
        const meta = map.get(key)
        weekCells.push({
          date: key,
          level: levelOf(meta),
          meta,
          inFuture: cellMs > todayMs,
          outOfYear: dt.getFullYear() !== displayYear,
          holiday: holidays[key],
        })
        if (key === today) todayCol = col
      }
      weeks.push(weekCells)

      const wed = new Date(t + 3 * DAY_MS)
      // 只标注属于展示年份的月份，避免首周（可能落在上一年 12 月）标出错误月份
      if (wed.getFullYear() === displayYear && wed.getMonth() !== lastMonth) {
        lastMonth = wed.getMonth()
        monthLabels.push({ col, label: MONTH_CN[lastMonth] })
      }
    }

    // 本年内已写篇数
    const yearStart = fmt(jan1)
    const yearEnd = fmt(new Date(Math.min(dec31.getTime(), todayMs)))
    const displayCount = diaries.filter(d => d.date >= yearStart && d.date <= yearEnd && !d.empty).length

    return { weeks, monthLabels, displayCount, displayYear, todayCol }
  }, [diaries, today, year, holidays])

  // 测量滚动区宽度，让整年网格铺满（消除右侧空白）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w != null && w > 0) setAvailWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { cellSize, weekPx, gridWidth } = useMemo(() => {
    const n = Math.max(weeks.length, 1)
    if (availWidth <= 0) {
      return { cellSize: FALLBACK_CELL, weekPx: FALLBACK_CELL + GAP, gridWidth: n * (FALLBACK_CELL + GAP) }
    }
    // n 列 + (n-1) 间距 = 可用宽度；过窄时保底 MIN_CELL 并允许横向滚动
    const fitted = (availWidth - (n - 1) * GAP) / n
    const cellSize = Math.max(MIN_CELL, fitted)
    return {
      cellSize,
      weekPx: cellSize + GAP,
      gridWidth: n * cellSize + (n - 1) * GAP,
    }
  }, [availWidth, weeks.length])

  // 当前年：滚动到今天所在列；往年：回到最左
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = todayCol < 0 ? 0 : todayCol * weekPx - el.clientWidth / 2
  }, [todayCol, weekPx, availWidth])

  const spacedMonths = useMemo(() => {
    const out: { col: number; label: string }[] = []
    let last = -Infinity
    for (const m of monthLabels) {
      if (m.col - last >= 3) {
        out.push(m)
        last = m.col
      }
    }
    return out
  }, [monthLabels])

  // 展示模式：default=日记绿阶+节假日蓝 / diary=只看日记 / holiday=只看节假日
  const [mode, setMode] = useState<'default' | 'diary' | 'holiday'>('default')

  const levelColor = (level: number): string => {
    switch (level) {
      case 4: return 'var(--lv4)'
      case 3: return 'var(--lv3)'
      case 2: return 'var(--lv2)'
      case 1: return 'var(--lv1)'
      default: return 'var(--empty)'
    }
  }

  // 节假日蓝（放假日）
  const HOLIDAY_BLUE = 'color-mix(in srgb, var(--accent) 45%, var(--empty))'
  // 半绿半蓝（节假日 + 有日记）：对角分割
  const halfColor = (level: number): string =>
    `linear-gradient(135deg, ${levelColor(level)} 0%, ${levelColor(level)} 49%, ${HOLIDAY_BLUE} 51%, ${HOLIDAY_BLUE} 100%)`

  const colorOf = (cell: Cell): string => {
    // 邻年溢出格：不染色、不交互
    if (cell.outOfYear) return 'transparent'

    const isHol = cell.holiday?.type === 'holiday'
    const wrote = (cell.level ?? 0) > 0
    // 未来无节日：淡占位；未来有节日仍染色（方便预知长假）
    const futureDim = 'color-mix(in srgb, var(--empty) 55%, transparent)'

    if (mode === 'diary') {
      // 日记模式：节假日不参与染色，纯日记绿阶
      return levelColor(cell.level)
    }

    if (mode === 'holiday') {
      // 节假日模式：只看节假日，日记信息完全不参与染色
      if (isHol) return HOLIDAY_BLUE
      return wrote && !cell.inFuture ? 'color-mix(in srgb, var(--empty) 80%, var(--bg))' : futureDim
    }

    // 默认模式：日记绿阶为主；放假日染蓝（含未来）；节假日+有日记 = 半绿半蓝
    if (isHol) return wrote && !cell.inFuture ? halfColor(cell.level) : HOLIDAY_BLUE
    if (cell.inFuture) return futureDim
    return levelColor(cell.level)
  }

  /** 调休上班日：橙黄虚线框（各模式通用；日记模式不显示） */
  const holidayBorder = (cell: Cell): string => {
    if (cell.outOfYear) return 'transparent'
    if (mode !== 'default' && mode !== 'holiday') return 'transparent'
    if (cell.holiday?.type !== 'work') return 'transparent'
    return '1px dashed color-mix(in srgb, #e8a33d 75%, transparent)'
  }

  /** 放假日标「休」，调休上班标「班」；日记模式不显示 */
  const markOf = (cell: Cell): string | null => {
    if (cell.outOfYear || mode === 'diary') return null
    if (cell.holiday?.type === 'holiday') return '休'
    if (cell.holiday?.type === 'work') return '班'
    return null
  }

  return (
    <div className="card overflow-hidden" style={{ borderRadius: 10 }}>
      <div className="flex">
        {/* 星期标签：与格子行同一套行高/间距，保证纵向对齐 */}
        <div className="shrink-0" style={{ width: 28, paddingTop: 12, paddingBottom: 12 }}>
          {/* 与月份行等高占位 */}
          <div className="h-4 mb-1" />
          <div className="flex flex-col" style={{ gap: GAP }}>
            {WEEK_CN.map((d) => (
              <div
                key={d}
                className="label-xs text-right pr-1.5"
                style={{ height: cellSize, lineHeight: `${cellSize}px`, fontSize: Math.min(11, Math.max(8, cellSize - 1)) }}
              >
                {d}
              </div>
            ))}
          </div>
        </div>

        {/* 滚动区 */}
        <div ref={scrollRef} className="overflow-x-auto hide-scrollbar flex-1 py-3 px-1.5">
          <div style={{ width: gridWidth }}>
            {/* 月份 */}
            <div className="relative h-4 mb-1">
              {spacedMonths.map((m, i) => (
                <div
                  key={i}
                  className="absolute label-xs whitespace-nowrap pointer-events-none"
                  style={{ left: m.col * weekPx }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* 格子 */}
            <div className="flex" style={{ gap: GAP }}>
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col shrink-0" style={{ gap: GAP }}>
                  {week.map((cell, di) => {
                    const isSelected = selected === cell.date
                    const isToday = cell.date === today
                    const mark = markOf(cell)
                    return (
                      <button
                        key={di}
                        type="button"
                        className={isToday ? 'heat-cell heat-today' : 'heat-cell'}
                        disabled={cell.outOfYear || cell.inFuture}
                        onClick={() => onSelect(cell.date)}
                        title={cell.outOfYear ? undefined : (() => {
                          let s = cell.date + ' ' + weekdayCN(cell.date)
                          if (cell.holiday) {
                            s += ' · ' + cell.holiday.name + (cell.holiday.type === 'work' ? '（调休上班）' : '（放假日）')
                          }
                          if (cell.meta) s += ' · ' + cell.meta.words + ' 字'
                          return s
                        })()}
                        style={{
                          width: cellSize,
                          height: cellSize,
                          background: colorOf(cell),
                          borderRadius: 'var(--block-radius)',
                          border: cell.outOfYear
                            ? 'none'
                            : isSelected
                            ? '1.5px solid var(--fg)'
                            : isToday
                            ? '1px solid var(--fg-3)'
                            : holidayBorder(cell),
                          cursor: cell.outOfYear || cell.inFuture ? 'default' : 'pointer',
                          padding: 0,
                          fontSize: Math.max(8, Math.floor(cellSize * 0.72)),
                        }}
                      >
                        {mark ? (
                          <span
                            className="heat-mark"
                            style={{ color: 'color-mix(in srgb, var(--fg) 72%, transparent)' }}
                          >
                            {mark}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div
        className="flex items-center justify-between gap-4 px-3 py-2.5 border-t c-line"
        style={{ background: 'var(--bg)' }}
      >
        <span className="label-xs">{displayYear} 年 · 已写 {displayCount} 篇</span>
        <div className="flex items-center gap-1.5">
          <span className="label-xs">少</span>
          {[0, 1, 2, 3, 4].map(l => (
            <div
              key={l}
              style={{
                width: cellSize,
                height: cellSize,
                borderRadius: 'var(--block-radius)',
                background:
                  l === 0 ? 'var(--empty)'
                    : `var(--lv${l})`,
              }}
            />
          ))}
          <span className="label-xs">多</span>
          {/* 模式切换：日记 / 节假日 / 默认 */}
          <div
            className="flex items-center p-0.5 ml-4"
            style={{ background: 'var(--empty)', borderRadius: 7 }}
          >
            {([
              ['diary', '日记'],
              ['holiday', '节假日'],
              ['default', '默认'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                className="label-xs transition-colors"
                style={{
                  padding: '3px 8px',
                  borderRadius: 5,
                  background: mode === k ? 'var(--bg)' : 'transparent',
                  color: mode === k ? 'var(--fg)' : 'var(--fg-3)',
                  boxShadow: mode === k ? '0 1px 0 var(--line)' : 'none',
                }}
                onClick={() => setMode(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-3">
            <span className="label-xs">节假日</span>
            <div
              title="放假日"
              style={{
                width: cellSize, height: cellSize, borderRadius: 'var(--block-radius)',
                background: HOLIDAY_BLUE,
              }}
            />
            <div
              title="节假日 + 已写日记（默认/日记模式下绿蓝各半）"
              style={{
                width: cellSize, height: cellSize, borderRadius: 'var(--block-radius)',
                background: halfColor(2),
                opacity: mode === 'holiday' ? 0.35 : 1,
              }}
            />
            <div
              title="调休上班日"
              style={{
                width: cellSize, height: cellSize, borderRadius: 'var(--block-radius)',
                background: 'var(--empty)',
                border: '1px dashed color-mix(in srgb, #e8a33d 75%, transparent)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}