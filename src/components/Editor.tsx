import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { api } from '../api'
import { formatCN, weekdayCN, renderMarkdown, todayStr } from '../utils'

interface Props {
  date: string
  onClose: () => void
  onChanged: () => void
  editorName: string // 配置的编辑器名（如 Typora / VS Code），用于按钮文案
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * 内置网页编辑器：Write/Preview 双 Tab、Markdown 工具栏、
 * 自动保存 + Ctrl+S、粘贴/拖拽图片上传
 */
export function Editor({ date, onClose, onChanged, editorName }: Props) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [uploading, setUploading] = useState(false)
  const [opening, setOpening] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const dirtyRef = useRef(false)
  // 保存时以当前值为快照，回调里再对比 state，避免闭包拿到旧内容或误清脏标记
  const contentRef = useRef('')
  const isToday = date === todayStr()

  // 加载内容
  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError(null)
    api.diary(date).then(r => {
      if (!alive) return
      // 统一规整尾部空白为单个换行：
      // 1) 全新日记得到 "# 日期\n"，光标落在标题紧邻的下一行行首
      // 2) 旧模板文件（"# 日期\n\n"）同样被规整
      // 3) 已有内容的日记，光标落在最后一行文字的下一行行首
      let c = r.exists ? r.content : `# ${date}`
      c = c.replace(/\s+$/, '')
      if (c.length === 0) c = `# ${date}`
      c += '\n'
      contentRef.current = c
      setContent(c)
      setLoading(false)
      // 光标定位到文末，并聚焦编辑区
      requestAnimationFrame(() => {
        const ta = taRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(c.length, c.length)
      })
    }).catch((e: unknown) => {
      if (!alive) return
      setLoadError(e instanceof Error ? e.message : '无法读取这篇日记')
      setLoading(false)
    })
    return () => { alive = false }
  }, [date])

  const update = useCallback((v: string) => {
    contentRef.current = v
    setContent(v)
    dirtyRef.current = true
    setSaveState('dirty')
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    const snapshot = contentRef.current
    setSaveState('saving')
    try {
      await api.save(date, snapshot)
      // 保存期间又改过内容：保持脏标记，继续等下一轮自动保存
      if (contentRef.current === snapshot) {
        dirtyRef.current = false
        setSaveState('saved')
      } else {
        setSaveState('dirty')
      }
      return true
    } catch {
      setSaveState('error')
      return false
    }
  }, [date])

  // 输入停 1.2 秒自动保存
  useEffect(() => {
    if (saveState !== 'dirty') return
    const t = setTimeout(() => { void save() }, 1200)
    return () => clearTimeout(t)
  }, [saveState, save])

  const close = useCallback(async () => {
    if (dirtyRef.current) {
      const ok = await save()
      if (!ok && !window.confirm('日记保存失败，确定放弃本次修改并关闭吗？')) return
    }
    onChanged()
    onClose()
  }, [save, onChanged, onClose])

  // Ctrl+S 保存 / Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape') {
        void close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, close])

  // ---------- 光标编辑工具 ----------

  const surround = (before: string, after: string, placeholder: string) => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const e = ta.selectionEnd
    const sel = ta.value.slice(s, e) || placeholder
    update(ta.value.slice(0, s) + before + sel + after + ta.value.slice(e))
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(s + before.length, s + before.length + sel.length)
    })
  }

  const prefixLines = (prefix: string) => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e, value } = ta
    const start = value.lastIndexOf('\n', s - 1) + 1
    let end = value.indexOf('\n', e)
    if (end === -1) end = value.length
    const toggled = value
      .slice(start, end)
      .split('\n')
      .map(l => (l.startsWith(prefix) ? l.slice(prefix.length) : prefix + l))
      .join('\n')
    update(value.slice(0, start) + toggled + value.slice(end))
  }

  const insertAtCursor = (text: string) => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart
    update(ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd))
    requestAnimationFrame(() => {
      ta.focus()
      const pos = s + text.length
      ta.setSelectionRange(pos, pos)
    })
  }

  // ---------- 图片上传 ----------

  const uploadImage = async (file: File) => {
    try {
      setUploading(true)
      const dataURL: string = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = reject
        r.readAsDataURL(file)
      })
      const r = await api.uploadImage(dataURL, date)
      insertAtCursor(`\n![图片](images/${r.name})\n`)
    } catch {
      alert('图片上传失败')
    } finally {
      setUploading(false)
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) void uploadImage(file)
        return
      }
    }
  }

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.dataTransfer?.files || []).find(f => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      void uploadImage(file)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      insertAtCursor('  ')
    }
  }

  // 外部编辑器只拿到磁盘上的明文快照，先把当前改动落盘再交给它打开
  const openExternal = async () => {
    if (opening) return
    setOpening(true)
    try {
      if (dirtyRef.current) {
        const ok = await save()
        if (!ok) {
          window.alert('日记保存失败，未打开外部编辑器')
          return
        }
      }
      await api.open(date)
      onChanged()
      onClose()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : `打开${editorName}失败`)
    } finally {
      setOpening(false)
    }
  }

  // ---------- 派生 ----------

  const wordCount = useMemo(() => {
    const body = content.replace(/^#\s+.*\n+/, '').trim()
    const cjk = (body.match(/[\u4e00-\u9fa5]/g) || []).length
    const en = (body.match(/[a-zA-Z0-9]+/g) || []).length
    return cjk + en
  }, [content])

  const saveInfo: Record<SaveState, { text: string; color: string }> = {
    idle: { text: '', color: 'var(--fg-3)' },
    dirty: { text: '未保存', color: 'var(--fg-3)' },
    saving: { text: '正在保存…', color: 'var(--fg-2)' },
    saved: { text: '已保存', color: 'var(--success)' },
    error: { text: '保存失败', color: 'var(--danger)' },
  }
  const si = saveInfo[saveState]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in"
      style={{ background: 'rgba(31,35,40,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={() => void close()}
    >
      <div
        className="c-bg w-full max-w-3xl max-h-[88vh] flex flex-col modal-in border c-line"
        style={{ borderRadius: 12, boxShadow: '0 24px 70px rgba(31,35,40,0.25)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b c-line shrink-0">
          <div className="flex items-baseline gap-3 min-w-0">
            <h2 className="text-[15px] c-fg font-semibold truncate">{formatCN(date)}</h2>
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
          <button className="label-xs hover:c-fg p-1" onClick={() => void close()} aria-label="关闭">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex items-end gap-1 px-4 pt-2 shrink-0 border-b c-line">
          {([['write', '编辑'], ['preview', '预览']] as const).map(([k, label]) => {
            const active = mode === k
            return (
              <button
                key={k}
                onClick={() => setMode(k)}
                className="text-[13px] transition-colors"
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px 6px 0 0',
                  background: active ? 'var(--bg)' : 'transparent',
                  border: '1px solid transparent',
                  borderTop: active ? '1px solid var(--line)' : 'none',
                  borderLeft: active ? '1px solid var(--line)' : 'none',
                  borderRight: active ? '1px solid var(--line)' : 'none',
                  color: active ? 'var(--fg)' : 'var(--fg-2)',
                  fontWeight: active ? 600 : 400,
                  marginBottom: -1,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {loading ? (
          <div className="label-xs py-16 text-center">读取中…</div>
        ) : loadError ? (
          <div className="py-16 text-center">
            <div className="label-xs" style={{ color: 'var(--danger)' }}>{loadError}</div>
            <div className="label-xs mt-3">为避免覆盖内容，已停止编辑。</div>
            <button className="btn btn-ghost mt-4" onClick={() => void close()}>关闭</button>
          </div>
        ) : mode === 'write' ? (
          <>
            {/* 工具栏 */}
            <div
              className="flex items-center gap-0.5 px-3 py-1.5 border-b c-line shrink-0 flex-wrap"
              style={{ background: 'var(--bg-2)' }}
            >
              <ToolBtn title="粗体" onClick={() => surround('**', '**', '粗体')}><b>B</b></ToolBtn>
              <ToolBtn title="斜体" onClick={() => surround('*', '*', '斜体')}><i>I</i></ToolBtn>
              <ToolBtn title="删除线" onClick={() => surround('~~', '~~', '删除')}><s>S</s></ToolBtn>
              <Sep />
              <ToolBtn title="标题" onClick={() => prefixLines('## ')}>H</ToolBtn>
              <ToolBtn title="无序列表" onClick={() => prefixLines('- ')}>•≡</ToolBtn>
              <ToolBtn title="任务列表" onClick={() => prefixLines('- [ ] ')}>☑</ToolBtn>
              <ToolBtn title="引用" onClick={() => prefixLines('> ')}>❝</ToolBtn>
              <ToolBtn title="行内代码" onClick={() => surround('`', '`', '代码')}>{'{ }'}</ToolBtn>
              <ToolBtn title="代码块" onClick={() => surround('\n```\n', '\n```\n', '代码')}>```</ToolBtn>
              <Sep />
              <ToolBtn title="链接" onClick={() => surround('[', '](https://)', '链接文字')}>🔗</ToolBtn>
              <ToolBtn title="图片（可直接粘贴或拖入）" onClick={() => insertAtCursor('\n![](images/)\n')}>🖼</ToolBtn>
              {uploading && <span className="label-xs ml-2">图片上传中…</span>}
            </div>

            {/* 编辑区 */}
            <textarea
              ref={taRef}
              value={content}
              onChange={e => update(e.target.value)}
              onPaste={onPaste}
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              onKeyDown={onKeyDown}
              spellCheck={false}
              placeholder="写下今天…"
              autoFocus
              className="flex-1 w-full resize-none outline-none mono"
              style={{ padding: '16px 18px', fontSize: 14, lineHeight: 1.75, background: 'var(--bg)', color: 'var(--fg)', minHeight: 260 }}
            />
          </>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5" style={{ minHeight: 260 }}>
            <article
              className="diary-content text-[15px] leading-[1.8] c-fg"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          </div>
        )}

        {/* 底部 */}
        <div
          className="flex items-center justify-between gap-3 px-4 py-3 border-t c-line shrink-0"
          style={{ background: 'var(--bg-2)' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="label-xs shrink-0">{wordCount} 字</span>
            {si.text && (
              <span className="label-xs truncate" style={{ color: si.color }}>{si.text}</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="btn btn-ghost"
              disabled={opening}
              onClick={() => void openExternal()}
              title={`用 ${editorName} 打开这一天的明文临时文件`}
            >
              {opening ? '打开中…' : editorName}
            </button>
            <button className="btn btn-primary" onClick={() => void close()}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="mono text-xs"
      style={{
        minWidth: 28,
        height: 26,
        padding: '0 6px',
        borderRadius: 4,
        color: 'var(--fg-2)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <div style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 4px' }} />
}
