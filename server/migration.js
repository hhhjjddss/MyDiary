import crypto from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const MAGIC = Buffer.from('MYD-MIG1')
const SALT_SIZE = 16
const IV_SIZE = 12
const TAG_SIZE = 16
const HEADER_SIZE = MAGIC.length + SALT_SIZE + IV_SIZE + TAG_SIZE
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024
const MAX_CONTENT_SIZE = 512 * 1024 * 1024

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  })
}

export function createMigrationArchive(data, password) {
  const salt = crypto.randomBytes(SALT_SIZE)
  const iv = crypto.randomBytes(IV_SIZE)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  const plain = deflateRawSync(Buffer.from(JSON.stringify({ version: 1, ...data })))
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted])
}

export function readMigrationArchive(archive, password) {
  if (!Buffer.isBuffer(archive) || archive.length <= HEADER_SIZE || archive.length > MAX_ARCHIVE_SIZE) {
    throw new Error('迁移文件大小无效')
  }
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('文件不是 MyDiary 数据迁移包')
  }

  const saltStart = MAGIC.length
  const ivStart = saltStart + SALT_SIZE
  const tagStart = ivStart + IV_SIZE
  const dataStart = tagStart + TAG_SIZE
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(password, archive.subarray(saltStart, ivStart)),
    archive.subarray(ivStart, tagStart),
  )
  decipher.setAuthTag(archive.subarray(tagStart, dataStart))
  const compressed = Buffer.concat([
    decipher.update(archive.subarray(dataStart)),
    decipher.final(),
  ])
  const plain = inflateRawSync(compressed, { maxOutputLength: MAX_CONTENT_SIZE })
  const data = JSON.parse(plain.toString('utf8'))

  if (data.version !== 1 || !Array.isArray(data.diaries) || !Array.isArray(data.images)) {
    throw new Error('迁移文件内容格式无效')
  }
  const dates = new Set()
  for (const diary of data.diaries) {
    if (!diary || !/^\d{4}-\d{2}-\d{2}$/.test(diary.date) || typeof diary.content !== 'string') {
      throw new Error('迁移文件中的日记数据无效')
    }
    if (dates.has(diary.date)) throw new Error('迁移文件包含重复日期')
    dates.add(diary.date)
  }
  const names = new Set()
  for (const image of data.images) {
    if (
      !image || typeof image.name !== 'string' || image.name === '.' || !/^[\w.-]+$/.test(image.name) || image.name.includes('..') ||
      typeof image.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
    ) {
      throw new Error('迁移文件中的图片数据无效')
    }
    if (names.has(image.name)) throw new Error('迁移文件包含重复图片')
    names.add(image.name)
  }
  return data
}
