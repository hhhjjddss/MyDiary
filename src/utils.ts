export const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

export function todayStr(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00')
}

export function formatCN(date: string): string {
  const d = parseDate(date)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

export function formatShort(date: string): string {
  const d = parseDate(date)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function weekdayCN(date: string): string {
  return '周' + WEEK_CN[parseDate(date).getDay()]
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/**
 * 给图片地址补上本地服务的一次性令牌。
 * <img>/新窗口无法带自定义请求头，而服务端只认令牌，因此走 ?t=。
 */
export function withApiToken(url: string): string {
  if (!/^\/?images\//.test(url)) return url
  const token = typeof window !== 'undefined' ? window.myDiary?.token : ''
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token)
}

/** 极简 Markdown → HTML（支持标题/列表/代码/引用/图片/任务列表） */
export function renderMarkdown(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const escUrl = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  let inList = false
  let listType = ''

  const closeList = () => {
    if (inList) {
      out.push(listType === 'ol' ? '</ol>' : '</ul>')
      inList = false
    }
  }

  const inline = (t: string) =>
    esc(t)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => `<img src="${escUrl(withApiToken(url))}" alt="${alt}" loading="lazy" />`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => {
        // 拦截 javascript: 等危险协议
        const safe = /^(https?:|mailto:|\/|images\/|\.\/|\.\.\/)/.test(url)
        return safe ? `<a href="${escUrl(withApiToken(url))}" target="_blank" rel="noreferrer">${txt}</a>` : txt
      })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()

    if (/^```/.test(line)) {
      if (inCode) {
        out.push('</code></pre>')
        inCode = false
      } else {
        closeList()
        out.push('<pre><code>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(esc(raw) + '\n')
      continue
    }

    if (line.trim() === '') {
      closeList()
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const lv = h[1].length
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      continue
    }

    if (/^>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList()
      out.push('<hr />')
      continue
    }

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      if (!inList || listType !== 'ul') {
        closeList()
        out.push('<ul class="task-list">')
        inList = true
        listType = 'ul'
      }
      const checked = task[1] !== ' '
      out.push(
        `<li class="task-item">` +
        `<input type="checkbox" disabled ${checked ? 'checked' : ''} />` +
        `${inline(task[2])}</li>`
      )
      continue
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) {
      if (!inList || listType !== 'ul') {
        closeList()
        out.push('<ul>')
        inList = true
        listType = 'ul'
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      continue
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) {
      if (!inList || listType !== 'ol') {
        closeList()
        out.push('<ol>')
        inList = true
        listType = 'ol'
      }
      out.push(`<li>${inline(ol[1])}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }

  closeList()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')
}