import { useEffect, useRef, useState } from 'react'
import type { DiaryMeta } from '../api'
import { formatCN, weekdayCN, formatNumber } from '../utils'

interface Props {
  diaries: DiaryMeta[]
  onSelect: (date: string) => void
}

function randomFrom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null
  return arr[Math.floor(Math.random() * arr.length)]
}

function scrambleDate(): string {
  const y = 2018 + Math.floor(Math.random() * 10)
  const m = 1 + Math.floor(Math.random() * 12)
  const d = 1 + Math.floor(Math.random() * 28)
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

/** 拾光：从过往日记里随机抽出一天 */
export function Shiguang({ diaries, onSelect }: Props) {
  const pool = diaries.filter(d => !d.empty)
  const [rolling, setRolling] = useState(false)
  const [pick, setPick] = useState<DiaryMeta | null>(null)
  const [slot, setSlot] = useState(pool[0]?.date ?? '????-??-??')
  const [fadeKey, setFadeKey] = useState(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
  }, [])

  const draw = () => {
    if (rolling || pool.length === 0) return
    const target = randomFrom(pool)
    if (!target) return

    setRolling(true)
    setPick(null)

    let ticks = 0
    const total = 22
    timerRef.current = window.setInterval(() => {
      ticks += 1
      if (ticks >= total) {
        if (timerRef.current) window.clearInterval(timerRef.current)
        timerRef.current = null
        setSlot(target.date)
        setPick(target)
        setRolling(false)
        setFadeKey(k => k + 1)
        return
      }
      // 后段逐渐靠近真实日期，避免硬切
      const nearEnd = ticks > total - 5
      setSlot(nearEnd && Math.random() > 0.35 ? target.date : scrambleDate())
    }, 55)
  }

  const digits = (slot ?? '').split('')

  return (
    <div className="card overflow-hidden" style={{ borderRadius: 10 }}>
      {/* 头部 */}
      <div className="px-6 pt-6 pb-2 text-center">
        <div
          style={{
            fontFamily: '"KaiTi", "楷体", "STKaiti", serif',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: 'var(--fg)',
          }}
        >
          拾光
        </div>
        <div className="label-xs mt-1.5" style={{ letterSpacing: '0.08em' }}>
          从旧日记里，随机拾回一天
        </div>
      </div>

      {/* 抽签转轮 */}
      <div className="px-6 py-4">
        <div
          className="shiguang-slot mx-auto"
          style={{ maxWidth: 320 }}
          aria-label="抽到的日期"
        >
          <div className={'shiguang-digits' + (rolling ? ' is-rolling' : '')}>
            {digits.map((ch, i) => (
              <span key={i} className={'shiguang-d' + (rolling && ch !== '-' && ch !== '?' ? ' spin' : '')}>
                {ch}
              </span>
            ))}
          </div>
          <div className="shiguang-gloss" aria-hidden="true" />
        </div>

        <div className="mt-5 flex items-center justify-center gap-2.5">
          <button
            type="button"
            className="btn btn-primary"
            onClick={draw}
            disabled={rolling || pool.length === 0}
            style={{ minWidth: 112, opacity: rolling ? 0.65 : 1 }}
          >
            {rolling ? '拾取中…' : pick ? '再拾一次' : '拾取一天'}
          </button>
          {pool.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onSelect(pick!.date)}
              disabled={!pick}
              style={{ opacity: pick ? 1 : 0.45 }}
            >
              读这一天
            </button>
          )}
        </div>
      </div>

      {/* 结果卡片 */}
      {pool.length === 0 ? (
        <div className="label-xs text-center pb-8 pt-2">还没有可以拾取的日记，先去写一篇吧</div>
      ) : (
        <div className="px-6 pb-6">
          {pick ? (
            <div key={fadeKey} className="shiguang-reveal card" style={{ borderRadius: 10, background: 'var(--bg-2)' }}>
              <div className="px-5 py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div
                    style={{
                      fontFamily: '"KaiTi", "楷体", "STKaiti", serif',
                      fontSize: 15,
                      fontWeight: 700,
                      color: 'var(--fg)',
                    }}
                  >
                    {formatCN(pick.date)} · {weekdayCN(pick.date)}
                  </div>
                  <div className="label-xs shrink-0">{formatNumber(pick.words)} 字</div>
                </div>
                <p
                  className="text-sm c-fg2 mt-3 leading-relaxed"
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {pick.preview || pick.title || '（这天没有写下内容）'}
                </p>
                <button
                  type="button"
                  className="label-xs hover:c-fg transition-colors mt-3 inline-flex items-center gap-1"
                  onClick={() => onSelect(pick.date)}
                >
                  翻开这一天
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          ) : (
            <div
              className="shiguang-placeholder text-center label-xs"
              style={{ padding: '18px 12px', border: '1px dashed var(--line)', borderRadius: 10 }}
            >
              {rolling ? '日历正在翻动…' : '点击「拾取一天」，看看命运给你哪一页'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
