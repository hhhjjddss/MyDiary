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
      await writeEncryptedFile(masterKey, diaryPath(date), String(content ?? ''))
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
      await writeEncryptedFile(masterKey, imagePath(name), buf)
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

    /** 配置（JSON） */
    async readConfig(fallback) {
      if (!existsSync(configFile)) return { ...fallback }
      try {
        const raw = await readEncryptedText(masterKey, configFile)
        return { ...fallback, ...JSON.parse(raw) }
      } catch {
        return { ...fallback }
      }
    },

    async writeConfig(cfg) {
      await writeEncryptedFile(masterKey, configFile, JSON.stringify(cfg, null, 2))
    },

    /** 供外部编辑器：解密到临时明文文件，返回路径；写回用 commitExternal */
    async exportPlain(date, tmpDir) {
      const content = (await this.readDiary(date)) ?? ''
      mkdirSync(tmpDir, { recursive: true })
      const tmp = path.join(tmpDir, `MyDiary-${date}-${randomUUID().slice(0, 8)}.md`)
      await fsp.writeFile(tmp, content, 'utf8')
      return tmp
    },

    async commitExternal(tmpPath, date) {
      const content = await fsp.readFile(tmpPath, 'utf8')
      await this.writeDiary(date, content)
    },
  }
}

export { encryptBuffer, decryptBuffer }
