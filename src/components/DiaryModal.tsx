import { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { formatCN, weekdayCN, renderMarkdown, todayStr } from '../utils'

interface Props {
  date: string
  onClose: () => void
  onChanged: () => void
  onEdit: (date: string) => void
}

export function DiaryModal({ date, onClose, onChanged, onEdit }: Props) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exists, setExists] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const load = useCallback(() => {
    let alive = true
    setLoading(true)
    setError(null)
    api.diary(date)
      .then(r => {
        if (!alive) return
        setContent(r.content)
        setExists(r.exists)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!alive) return
        setError(e.message || '读取失败')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [date])

  useEffect(() => load(), [load])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async () => {
    setBusy(true)
    try {
      await api.remove(date)
      onChanged()
      onClose()
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const isToday = date === todayStr()
  const body = content.replace(/^#\s+.*\n+/, '').trim()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in"
      style={{ background: 'rgba(31,35,40,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="c-bg w-full max-w-2xl max-h-[86vh] flex flex-col modal-in border c-line"
        style={{ borderRadius: 12, boxShadow: '0 24px 70px rgba(31,35,40,0.25)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-4 px-6 py-5 border-b c-line shrink-0">
          <div className="min-w-0">
            <div className="flex items-baseline gap-3">
              <h2 className="text-lg c-fg font-semibold truncate">{formatCN(date)}</h2>
              <span className="label-xs shrink-0">{weekdayCN(date)}</span>
              {isToday && (
                <span
                  className="shrink-0 px-1.5 py-0.5 text-xs font-medium"
                  style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success)', borderRadius: 10 }}
                >
                  今天
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="label-xs hover:c-fg transition-colors p-1 shrink-0"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-6 min-h-[120px]">
          {localError && (
            <div
              className="mb-4 px-3 py-2.5 text-xs border"
              style={{ color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 7%, transparent)', borderColor: 'color-mix(in srgb, var(--danger) 30%, transparent)', borderRadius: 6 }}
            >
              {localError}
              <button className="ml-3 underline" onClick={() => setLocalError(null)}>关闭</button>
            </div>
          )}
          {loading ? (
            <div className="label-xs py-8 text-center">读取中…</div>
          ) : error ? (
            <div className="py-10 text-center">
              <div className="text-sm" style={{ color: 'var(--danger)' }}>{error}</div>
              <p className="label-xs mt-2">为避免覆盖，这篇日记不会被自动改写；建议先备份数据目录。</p>
              <button className="btn btn-ghost mt-4" onClick={() => load()}>重试</button>
            </div>
          ) : !exists || body.length === 0 ? (
            <div className="py-10 text-center">
              <div className="text-3xl c-fg3 mb-3" style={{ opacity: 0.4 }}>—</div>
              <p className="text-sm c-fg3">这一天还没有写下什么</p>
            </div>
          ) : (
            <article
              className="diary-content text-[15px] leading-[1.85] c-fg"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2.5 px-6 py-4 border-t c-line shrink-0" style={{ background: 'var(--bg-2)' }}>
          <button className="btn btn-primary" onClick={() => onEdit(date)}>
            {exists && body.length > 0 ? '编辑' : '写这一天的日记'}
          </button>
          {exists && (
            <button
              className="btn btn-ghost"
              onClick={() => void api.reveal(date).catch(() => {})}
              title="在文件夹中显示"
            >
              定位文件
            </button>
          )}
          <div className="flex-1" />
          {exists && (
            confirmDel ? (
              <div className="flex items-center gap-1.5">
                <button
                  className="btn"
                  style={{ color: 'var(--danger)' }}
                  onClick={remove}
                  disabled={busy}
                >
                  确认删除
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                className="label-xs hover:c-fg transition-colors px-2"
                onClick={() => setConfirmDel(true)}
              >
                删除
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}