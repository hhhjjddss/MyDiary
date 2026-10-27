import fsp from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  loadMasterKey,
  encryptBuffer,
  decryptBuffer,
  writeEncryptedFile,
  readEncryptedFile,
  readEncryptedText,
} from './vault.js'

/**
 * 加密数据仓：日记/图片/配置均以密文落盘，资源管理器里看不到明文。
 * 目录结构（在数据根目录下）：
 *   key.bin          主密钥（Electron 里由 safeStorage 再包一层时可不落盘明文）
 *   config.enc       应用配置
 *   diaries/*.enc    按日一篇
 *   images/*.enc     图片
 */
export function createStore({ dataDir, key }) {
  if (!dataDir) throw new Error('store: dataDir required')
  const diariesDir = path.join(dataDir, 'diaries')
  const imagesDir = path.join(dataDir, 'images')
  const configFile = path.join(dataDir, 'config.enc')
  const keyFile = path.join(dataDir, 'key.bin')

  const masterKey = key || loadMasterKey(keyFile)

  mkdirSync(diariesDir, { recursive: true })
  mkdirSync(imagesDir, { recursive: true })

  const diaryPath = date => path.join(diariesDir, `${date}.enc`)
  const imagePath = name => path.join(imagesDir, name)

  // 同一路径的写入串行化，避免自动保存/关闭保存/外部回写并发时旧内容覆盖新内容
  const writeChains = new Map()
  function serialize(key, task) {
    const prev = writeChains.get(key) || Promise.resolve()
    const run = prev.then(task, task)
    const guard = run.then(() => {}, () => {})
    writeChains.set(key, guard)
    guard.then(() => {
      if (writeChains.get(key) === guard) writeChains.delete(key)
    })
    return run
  }

  return {
    dataDir,
    diariesDir,
    imagesDir,
    configFile,

    /** 是否已存在某天日记 */
    async diaryExists(date) {
      return existsSync(diaryPath(date))
    },

    /** 读日记明文；不存在返回 null */
    async readDiary(date) {
      const p = diaryPath(date)
      if (!existsSync(p)) return null
      return await readEncryptedText(masterKey, p)
    },

    /** 写日记（明文入，密文落盘） */
    async writeDiary(date, content) {
      await serialize(`diary:${date}`, () =>
        writeEncryptedFile(masterKey, diaryPath(date), String(content ?? '')),
      )
    },

    async deleteDiary(date) {
      try {
        await fsp.unlink(diaryPath(date))
      } catch {}
    },

    /** 列出所有日记日期（从密文文件名） */
    async listDates() {
      let names
      try {
        names = await fsp.readdir(diariesDir)
      } catch {
        return []
      }
      return names
        .filter(n => n.endsWith('.enc'))
        .map(n => n.slice(0, -4))
        .sort()
    },

    async diaryMtime(date) {
      try {
        const st = await fsp.stat(diaryPath(date))
        return st.mtimeMs
      } catch {
        return 0
      }
    },

    /** 图片：密文落盘，返回解密后的 Buffer */
    async writeImage(name, buf) {
      await serialize(`image:${name}`, () =>
        writeEncryptedFile(masterKey, imagePath(name), buf),
      )
    },

    async readImage(name) {
      const p = imagePath(name)
      if (!existsSync(p)) return null
      // 文件名做路径穿越防护
      if (name.includes('..') || name.includes('/') || name.includes('\\')) return null
      return await readEncryptedFile(masterKey, p)
    },

    async listImages() {
      try {
        const names = await fsp.readdir(imagesDir)
        return names.filter(n => n.endsWith('.enc'))
      } catch {
        return []
      }
    },

    /** 原子替换日记和图片；配置、密钥仍留在当前设备 */
    async replaceDiariesAndImages(diaries, images) {
      const id = randomUUID()
      const stagedDiaries = path.join(dataDir, `.diaries-${id}`)
      const stagedImages = path.join(dataDir, `.images-${id}`)
      const backupDiaries = path.join(dataDir, `.diaries-backup-${id}`)
      const backupImages = path.join(dataDir, `.images-backup-${id}`)
      mkdirSync(stagedDiaries, { recursive: true })
      mkdirSync(stagedImages, { recursive: true })
      let oldDiariesMoved = false
      let oldImagesMoved = false
      let newDiariesMoved = false
      let newImagesMoved = false

      try {
        for (const diary of diaries) {
          await writeEncryptedFile(masterKey, path.join(stagedDiaries, `${diary.date}.enc`), diary.content)
        }
        for (const image of images) {
          await writeEncryptedFile(masterKey, path.join(stagedImages, image.name), image.data)
        }
        await fsp.rename(diariesDir, backupDiaries)
        oldDiariesMoved = true
        await fsp.rename(imagesDir, backupImages)
        oldImagesMoved = true
        await fsp.rename(stagedDiaries, diariesDir)
        newDiariesMoved = true
        await fsp.rename(stagedImages, imagesDir)
        newImagesMoved = true
      } catch (err) {
        if (newDiariesMoved) await fsp.rm(diariesDir, { recursive: true, force: true })
        if (newImagesMoved) await fsp.rm(imagesDir, { recursive: true, force: true })
        if (oldDiariesMoved) await fsp.rename(backupDiaries, diariesDir)
        if (oldImagesMoved) await fsp.rename(backupImages, imagesDir)
        throw err
      } finally {
        await fsp.rm(stagedDiaries, { recursive: true, force: true })
        await fsp.rm(stagedImages, { recursive: true, force: true })
      }

      await fsp.rm(backupDiaries, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(backupImages, { recursive: true, force: true }).catch(() => {})
    },

    /** 配置（JSON）：文件存在却读不出来时明确报错，绝不静默回退默认密码 */
    async readConfig(fallback) {
      if (!existsSync(configFile)) return { ...fallback }
      let raw
      try {
        raw = await readEncryptedText(masterKey, configFile)
      } catch (err) {
        throw new Error(`配置文件 config.enc 无法解密（${err.message}）`)
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('配置文件 config.enc 格式损坏')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('配置文件 config.enc 格式无效')
      }
      return { ...fallback, ...parsed }
    },

    async writeConfig(cfg) {
      await serialize('config', () =>
        writeEncryptedFile(masterKey, configFile, JSON.stringify(cfg, null, 2)),
      )
    },

    /** 供外部编辑器：解密到临时明文文件，返回路径；写回用 commitExternal */
    async exportPlain(date, tmpDir) {
      const content = (await this.readDiary(date)) ?? ''
      mkdirSync(tmpDir, { recursive: true })
      const tmp = path.join(tmpDir, `MyDiary-${date}-${randomUUID().slice(0, 8)}.md`)
      await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
      return tmp
    },

    async commitExternal(tmpPath, date) {
      const content = await fsp.readFile(tmpPath, 'utf8')
      await this.writeDiary(date, content)
    },
  }
}

export { encryptBuffer, decryptBuffer }
