/**
 * 生成测试日记（可选工具，正式使用后可删）
 *   node tools/seed.mjs          生成一批随机测试日记
 *   node tools/seed.mjs --keep 30  只保留最近 30 天 + 今天，删除更早的
 *   node tools/seed.mjs --clear  清空全部日记
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(__dirname, '..', 'diaries')
fs.mkdirSync(DIR, { recursive: true })

const args = process.argv.slice(2)
const keepIdx = args.indexOf('--keep')

const fmt = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const SENTENCES = [
  '今天天气不错，心情也还好。',
  '工作上遇到一点小麻烦，不过解决了。',
  '读了几页书，觉得有些道理。',
  '傍晚出去走了走，街道很安静。',
  '和朋友聊了很久，聊到一些以前的事。',
  '今天有点累，早点睡了。',
  '写了一点代码，卡在一个小问题上。',
  '想起一件很久以前的小事。',
  '下午喝了杯咖啡，效率高了一些。',
  '没什么特别的，就是普通的一天。',
]
const TITLES = ['日常', '随笔', '记录', '碎念', '一天', '想法']

function makeBody(date, seed) {
  const n = 2 + (seed % 4)
  const lines = [`# ${date}`, '', TITLES[seed % TITLES.length], '']
  for (let i = 0; i < n; i++) {
    lines.push(SENTENCES[(seed + i * 3) % SENTENCES.length])
    lines.push('')
  }
  lines.push('## 记一下', '')
  lines.push('- 第一件事')
  lines.push('- 第二件事')
  lines.push('')
  lines.push('> 就这样吧。')
  return lines.join('\n')
}

// --clear
if (args.includes('--clear')) {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md'))
  for (const f of files) fs.unlinkSync(path.join(DIR, f))
  console.log(`已清空 ${files.length} 篇日记`)
  process.exit(0)
}

// --keep N
if (keepIdx >= 0) {
  const n = Number(args[keepIdx + 1] || 30)
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md'))
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - n)
  const cutStr = fmt(cutoff)

  let removed = 0
  for (const f of files) {
    const date = f.replace(/\.md$/, '')
    if (date < cutStr) {
      fs.unlinkSync(path.join(DIR, f))
      removed++
    }
  }
  const left = fs.readdirSync(DIR).filter(f => f.endsWith('.md')).length
  console.log(`已删除 ${removed} 篇较早的日记，保留最近 ${n} 天 + 今天，共剩 ${left} 篇`)
  process.exit(0)
}

// 默认：生成测试数据（最近 200 天内随机，约 55% 概率有日记，更早有稀疏记录）
const today = new Date()
let count = 0

// 今天
const todayName = fmt(today)
fs.writeFileSync(
  path.join(DIR, `${todayName}.md`),
  `# ${todayName}

今天把 MyDiary 做出来了。

## 完成的事

- 本地服务能读写 md 文件
- 一键用 Typora 打开
- 热力图和统计都跑通了

> 坚持写下去。
`,
  'utf-8'
)
count++

// 过去 400 天
for (let i = 1; i <= 400; i++) {
  const d = new Date(today)
  d.setDate(d.getDate() - i)
  // 越近的日期写得越勤
  const p = i < 60 ? 0.72 : i < 180 ? 0.5 : 0.28
  if (Math.random() > p) continue
  const name = fmt(d)
  fs.writeFileSync(path.join(DIR, `${name}.md`), makeBody(name, i), 'utf-8')
  count++
}

const total = fs.readdirSync(DIR).filter(f => f.endsWith('.md')).length
console.log(`已生成 ${count} 篇测试日记，目录共 ${total} 篇`)
