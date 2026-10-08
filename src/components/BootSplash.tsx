import { useEffect, useState, type CSSProperties } from 'react'

/** 开屏总时长；App 用它同步切到整蛊门/主界面
 *  （改这里即可，index.css 里的 --boot-dur 默认值请保持同步） */
export const BOOT_MS = 3600

/**
 * 开屏（在整蛊门之前播）——「落款」式构图：
 * 单色符号 + 字标 + 一根会自己画完的细线，整个组合作为一个单元
 * 一次进场、匀速收尾，背景与后续界面同为 --bg，交接无跳变。
 * mask 用内联 style 引用，相对文档路径，dev / Electron 打包都成立。
 */
export function BootSplash({ durationMs = BOOT_MS }: { durationMs?: number }) {
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setGone(true), durationMs)
    return () => clearTimeout(t)
  }, [durationMs])

  if (gone) return null

  return (
    <div
      className="boot-splash"
      style={{ '--boot-dur': `${durationMs}ms` } as CSSProperties}
      aria-hidden
    >
      <div className="boot-core">
        <span
          className="boot-mark"
          style={{
            WebkitMaskImage: 'url(./logo-mark.png)',
            maskImage: 'url(./logo-mark.png)',
          }}
        >
          <span className="boot-sheen" />
        </span>
        <div className="boot-word">MyDiary</div>
        <span className="boot-line" />
      </div>
    </div>
  )
}
