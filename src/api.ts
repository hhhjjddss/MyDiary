export interface DiaryMeta {
  date: string
  title: string
  chars: number
  words: number
  preview: string
  mtime: number
  empty: boolean
  broken?: boolean
}

export interface Stats {
  totalDiaries: number
  writtenDays: number
  totalChars: number
  totalWords: number
  currentStreak: number
  longestStreak: number
  firstDate: string | null
  lastDate: string | null
}

export interface Status {
  ok: boolean
  editorPath: string
  editorExists: boolean
  diaryDir: string
  diaryDirExists: boolean
  privacyGateEnabled: boolean
  hasSecurityAnswer?: boolean
  idleLockMinutes?: number
  reminderEnabled?: boolean
  reminderTime?: string
}

declare global {
  interface Window {
    myDiary?: {
      token?: string
      pickPath: (params: { mode: 'folder' | 'exe' | 'archive-save' | 'archive-open'; initial?: string }) =>
        Promise<{ ok: boolean; path: string | null }>
    }
  }
}

const FETCH_TIMEOUT = 12000

async function req<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const timeout = timeoutMs ?? FETCH_TIMEOUT
  const ctrl = new AbortController()
  // timeoutMs 传 0 表示不设超时（如等待系统对话框的请求）
  const timer = timeout > 0 ? setTimeout(() => ctrl.abort(), timeout) : null

  let res: Response
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = window.myDiary?.token
    // Electron 下服务只认本次启动的一次性令牌；纯浏览器开发时为空
    if (token) headers['x-mydiary-token'] = token
    res = await fetch(url, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: ctrl.signal,
    })
  } catch (e: unknown) {
    if (timer) clearTimeout(timer)
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('请求超时，请检查本地服务是否正常运行')
    }
    throw new Error('无法连接本地服务，请重新打开 MyDiary')
  }
  if (timer) clearTimeout(timer)

  if (res.status === 423) {
    const j = await res.json().catch(() => ({}))
    const err = new Error(j.message || '操作过于频繁，已临时锁定')
    ;(err as Error & { locked?: boolean; retryAfterMs?: number }).locked = true
    ;(err as Error & { locked?: boolean; retryAfterMs?: number }).retryAfterMs = j.retryAfterMs ?? 30000
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `请求失败 (${res.status})`)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new Error('服务响应异常')
  }
}

export const api = {
  status: () => req<Status>('/api/status'),
  diaries: () => req<{ ok: boolean; diaries: DiaryMeta[] }>('/api/diaries'),
  stats: () => req<Stats & { ok: boolean }>('/api/stats'),
  diary: (date: string) =>
    req<{ ok: boolean; exists: boolean; date: string; content: string }>(`/api/diary/${date}`),
  save: (date: string, content: string) =>
    req<{ ok: boolean }>(`/api/diary/${date}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  uploadImage: (dataURL: string, date: string) =>
    req<{ ok: boolean; name: string }>('/api/image', { method: 'POST', body: JSON.stringify({ dataURL, date }) }),
  open: (date?: string) =>
    req<{ ok: boolean; created?: boolean; error?: string; message?: string; path?: string }>(
      '/api/open',
      { method: 'POST', body: JSON.stringify({ date }) }
    ),
  reveal: (date: string) =>
    req<{ ok: boolean }>('/api/reveal', { method: 'POST', body: JSON.stringify({ date }) }),
  remove: (date: string) =>
    req<{ ok: boolean }>(`/api/diary/${date}`, { method: 'DELETE' }),
  saveConfig: (cfg: {
    editorPath?: string
    diaryDir?: string
    privacyPassword?: string
    privacyGateEnabled?: boolean
    securityAnswer?: string
    idleLockMinutes?: number
    reminderEnabled?: boolean
    reminderTime?: string
    unlockToken?: string
  }) => req<{ ok: boolean } & Record<string, unknown>>('/api/config', { method: 'POST', body: JSON.stringify(cfg) }),
  pickPath: (params: { mode: 'folder' | 'exe' | 'archive-save' | 'archive-open'; initial?: string }) => {
    if (window.myDiary?.pickPath) return window.myDiary.pickPath(params)
    const q = new URLSearchParams({ mode: params.mode })
    if (params.initial) q.set('initial', params.initial)
    // 不设超时：原生对话框会一直等到用户选完/取消
    return req<{ ok: boolean; path: string | null }>(`/api/pick-path?${q.toString()}`, undefined, 0)
  },
  holiday: (year: number) =>
    req<{ ok: boolean; data: Record<string, { name: string; type: 'holiday' | 'work' }> }>(`/api/holiday?year=${year}`),
  solarTerm: (date: string) =>
    req<{ ok: boolean; date: string; term: string | null; day?: number | null; label?: string | null }>(
      `/api/solar-term?date=${date}`,
    ),
  unlock: (password: string) =>
    req<{ ok: boolean; token?: string; locked?: boolean; retryAfterMs?: number; message?: string; fails?: number }>(
      '/api/unlock',
      { method: 'POST', body: JSON.stringify({ password }) },
    ),
  securityQuestion: () =>
    req<{ ok: boolean; question: string; hasAnswer: boolean }>('/api/security-question'),
  verifySecurityAnswer: (answer: string) =>
    req<{ ok: boolean; resetToken?: string; locked?: boolean; retryAfterMs?: number; message?: string }>(
      '/api/verify-security-answer',
      { method: 'POST', body: JSON.stringify({ answer }) },
    ),
  resetPassword: (resetToken: string, newPassword: string) =>
    req<{ ok: boolean; message?: string }>(
      '/api/reset-password',
      { method: 'POST', body: JSON.stringify({ resetToken, newPassword }) },
    ),
  exportData: (destination: string, password: string) =>
    req<{ ok: boolean; diaryCount: number; imageCount: number }>('/api/data-export', {
      method: 'POST',
      body: JSON.stringify({ destination, password }),
    }, 0),
  cleanEditTemp: () =>
    req<{ ok: boolean; removed: number }>('/api/edit-temp/clean', { method: 'POST' }),
  importData: (source: string, password: string) =>
    req<{ ok: boolean; diaryCount: number; imageCount: number }>('/api/data-import', {
      method: 'POST',
      body: JSON.stringify({ source, password }),
    }, 0),
  shutdown: () => req<{ ok: boolean }>('/api/shutdown', { method: 'POST' }),
}
