import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const GATE_KEY = 'md-gate-ok'
const TOKEN_KEY = 'md-gate-token'
const PW_PATTERN = /^\d{6}$/

/** 每次打开都需解锁；仅用于当前会话标记 */
export function gatePassed(): boolean {
  try {
    return sessionStorage.getItem(GATE_KEY) === '1'
  } catch {
    return false
  }
}

/** 解锁 token（改密码 / 开关隐私门时带上） */
export function getUnlockToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function lockDiary() {
  try {
    sessionStorage.removeItem(GATE_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {}
}

type GateView = 'pw' | 'forgot' | 'reset'

/**
 * 隐私门：开启密码后必须输入密码才能进入。
 * 错误次数过多时服务端会临时锁定（423 + retryAfterMs），本地做倒计时。
 * 忘记密码：走辅助验证问题（「你最喜爱的人物是?」），答对后重置为 6 位数字新密码。
 */
export function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [view, setView] = useState<GateView>('pw')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lockMs, setLockMs] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const errTimer = useRef<number | null>(null)

  // 忘记密码流程
  const [secQuestion, setSecQuestion] = useState('')
  const [secAnswer, setSecAnswer] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [npw1, setNpw1] = useState('')
  const [npw2, setNpw2] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      if (errTimer.current) clearTimeout(errTimer.current)
    }
  }, [view])

  // 锁定倒计时
  useEffect(() => {
    if (lockMs <= 0) return
    const t = window.setInterval(() => {
      setLockMs(v => (v - 200 <= 0 ? 0 : v - 200))
    }, 200)
    return () => window.clearInterval(t)
  }, [lockMs > 0])

  const flashErr = (msg: string) => {
    setErr(msg)
    if (errTimer.current) clearTimeout(errTimer.current)
    errTimer.current = window.setTimeout(() => setErr(null), 4000)
  }

  const handleFail = (e: unknown, fallback: string) => {
    const msg = e instanceof Error ? e.message : ''
    const er = e as Error & { locked?: boolean; retryAfterMs?: number }
    if (er.locked) {
      setLockMs(er.retryAfterMs ?? 30000)
    } else if (msg.includes('404')) {
      flashErr('本地服务未启动，请重新打开 MyDiary')
    } else {
      flashErr(msg || fallback)
    }
  }

  const backToPw = () => {
    setView('pw')
    setErr(null)
    setSecAnswer('')
    setResetToken('')
    setNpw1('')
    setNpw2('')
  }

  const submit = async () => {
    const v = pw.trim()
    if (!v || busy || lockMs > 0) return
    setBusy(true)
    try {
      const r = await api.unlock(v)
      if (r.token) {
        try { sessionStorage.setItem(TOKEN_KEY, r.token) } catch {}
      }
      try { sessionStorage.setItem(GATE_KEY, '1') } catch {}
      onUnlock()
    } catch (e) {
      setPw('')
      const msg = e instanceof Error ? e.message : ''
      const er = e as Error & { locked?: boolean; retryAfterMs?: number }
      if (er.locked) {
        setLockMs(er.retryAfterMs ?? 30000)
      } else if (msg.includes('401')) {
        flashErr('密码错误，请重试')
      } else {
        flashErr(msg.includes('404') ? '本地服务未启动，请重新打开 MyDiary' : msg || '解锁失败')
      }
    } finally {
      setBusy(false)
    }
  }

  /** 打开「忘记密码」：取辅助验证问题 */
  const openForgot = async () => {
    setErr(null)
    setBusy(true)
    try {
      const r = await api.securityQuestion()
      setSecQuestion(r.question)
      if (!r.hasAnswer) {
        flashErr('尚未设置辅助验证答案，无法自助找回')
        return
      }
      setView('forgot')
    } catch (e) {
      handleFail(e, '获取辅助验证问题失败')
    } finally {
      setBusy(false)
    }
  }

  /** 校验辅助验证答案 */
  const submitAnswer = async () => {
    const a = secAnswer.trim()
    if (!a || busy || lockMs > 0) return
    setBusy(true)
    try {
      const r = await api.verifySecurityAnswer(a)
      if (r.resetToken) {
        setResetToken(r.resetToken)
        setView('reset')
        setErr(null)
      } else {
        flashErr('答案不正确')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const er = e as Error & { locked?: boolean; retryAfterMs?: number }
      if (er.locked) {
        setLockMs(er.retryAfterMs ?? 30000)
      } else if (msg.includes('401')) {
        flashErr('答案不正确')
      } else {
        handleFail(e, '验证失败')
      }
    } finally {
      setBusy(false)
    }
  }

  /** 重置密码并直接进入 */
  const submitReset = async () => {
    const a = npw1.trim()
    const b = npw2.trim()
    if (busy || lockMs > 0) return
    if (!PW_PATTERN.test(a)) { flashErr('新密码须为 6 位数字'); return }
    if (a !== b) { flashErr('两次输入的密码不一致'); return }
    setBusy(true)
    try {
      await api.resetPassword(resetToken, a)
      const r = await api.unlock(a)
      if (r.token) {
        try { sessionStorage.setItem(TOKEN_KEY, r.token) } catch {}
      }
      try { sessionStorage.setItem(GATE_KEY, '1') } catch {}
      onUnlock()
    } catch (e) {
      handleFail(e, '重置失败')
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'mono w-full text-sm c-fg bg-transparent border c-line px-3 py-2.5 outline-none focus:border-current transition-colors'
  const inputStyle = { borderRadius: 6, marginTop: 26, textAlign: 'center', letterSpacing: '0.3em' } as const

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        userSelect: 'none',
      }}
    >
      <div style={{ width: 280, maxWidth: '86vw', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span
          className="gate-mark"
          style={{
            WebkitMaskImage: 'url(./logo-mark.png)',
            maskImage: 'url(./logo-mark.png)',
          }}
          aria-hidden
        />
        <div
          style={{
            fontFamily: '"Orbitron", sans-serif',
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '0.24em',
            textIndent: '0.12em',
            color: 'var(--fg)',
            lineHeight: 1,
            marginTop: 18,
          }}
        >
          MyDiary
        </div>
        <div className="label-xs" style={{ marginTop: 10 }}>
          {lockMs > 0
            ? '已临时锁定'
            : view === 'pw'
            ? '输入密码进入'
            : view === 'forgot'
            ? '辅助验证'
            : '设置新密码'}
        </div>

        {lockMs > 0 ? (
          <div
            style={{
              marginTop: 22,
              textAlign: 'center',
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            }}
          >
            <div style={{ fontSize: 44, fontWeight: 700, color: 'var(--danger)', lineHeight: 1.1 }}>
              {Math.ceil(lockMs / 1000)}
            </div>
            <div className="label-xs" style={{ marginTop: 8 }}>
              秒后可再次尝试
            </div>
          </div>
        ) : view === 'pw' ? (
          <>
            <input
              ref={inputRef}
              type="password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void submit()
              }}
              disabled={busy}
              autoComplete="current-password"
              name="mydiary-gate"
              aria-label="日记密码"
              placeholder="密码"
              className={inputCls}
              style={inputStyle}
            />
            <button
              className="btn btn-primary w-full justify-center"
              style={{ marginTop: 12 }}
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? '解锁中…' : '解锁'}
            </button>
            <button
              className="label-xs hover:c-fg"
              style={{ marginTop: 10, background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => void openForgot()}
              disabled={busy}
            >
              忘记密码？
            </button>
          </>
        ) : view === 'forgot' ? (
          <>
            <div className="label-xs" style={{ marginTop: 26, textAlign: 'center' }}>
              {secQuestion}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={secAnswer}
              onChange={e => setSecAnswer(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void submitAnswer()
              }}
              disabled={busy}
              name="mydiary-gate-answer"
              aria-label="辅助验证答案"
              placeholder="你的答案"
              className={inputCls}
              style={inputStyle}
            />
            <button
              className="btn btn-primary w-full justify-center"
              style={{ marginTop: 12 }}
              onClick={() => void submitAnswer()}
              disabled={busy}
            >
              {busy ? '验证中…' : '验证'}
            </button>
            <button
              className="label-xs hover:c-fg"
              style={{ marginTop: 10, background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={backToPw}
              disabled={busy}
            >
              返回输入密码
            </button>
          </>
        ) : (
          <>
            <input
              ref={inputRef}
              type="password"
              value={npw1}
              onChange={e => setNpw1(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void submitReset()
              }}
              disabled={busy}
              inputMode="numeric"
              maxLength={6}
              autoComplete="new-password"
              name="mydiary-gate-newpw"
              aria-label="新密码"
              placeholder="新密码（6 位数字）"
              className={inputCls}
              style={inputStyle}
            />
            <input
              type="password"
              value={npw2}
              onChange={e => setNpw2(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void submitReset()
              }}
              disabled={busy}
              inputMode="numeric"
              maxLength={6}
              autoComplete="new-password"
              name="mydiary-gate-newpw2"
              aria-label="确认新密码"
              placeholder="再次输入新密码"
              className={inputCls}
              style={{ ...inputStyle, marginTop: 12 }}
            />
            <button
              className="btn btn-primary w-full justify-center"
              style={{ marginTop: 12 }}
              onClick={() => void submitReset()}
              disabled={busy}
            >
              {busy ? '重置中…' : '重置并进入'}
            </button>
            <button
              className="label-xs hover:c-fg"
              style={{ marginTop: 10, background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={backToPw}
              disabled={busy}
            >
              返回输入密码
            </button>
          </>
        )}

        <div
          className="label-xs"
          style={{ marginTop: 14, minHeight: 18, color: err ? 'var(--danger)' : 'var(--fg-3)' }}
        >
          {err ?? (lockMs > 0 ? '错误次数过多，请稍后再试' : '')}
        </div>
      </div>
    </div>
  )
}
