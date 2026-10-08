import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const MAGIC = Buffer.from('MDV1') // MyDiary Vault v1
const VERSION = 1

/** 从环境变量或密钥文件取得 32 字节主密钥 */
export function loadMasterKey(keyFile) {
  const env = process.env.MYDIARY_MASTER_KEY
  if (env && /^[0-9a-fA-F]{64}$/.test(env.trim())) {
    return Buffer.from(env.trim(), 'hex')
  }
  if (keyFile && fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile)
    if (raw.length === 32) return raw
    const hex = raw.toString('utf8').trim()
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
  }
  const key = crypto.randomBytes(32)
  if (keyFile) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, key, { mode: 0o600 })
  }
  return key
}

/** 加密为二进制封装：magic + ver + iv(12) + tag(16) + ciphertext */
export function encryptBuffer(key, plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, ct])
}

export function decryptBuffer(key, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4 + 1 + 12 + 16 + 1) {
    throw new Error('vault: bad blob')
  }
  if (!blob.subarray(0, 4).equals(MAGIC)) {
    throw new Error('vault: bad magic')
  }
  const iv = blob.subarray(5, 17)
  const tag = blob.subarray(17, 33)
  const ct = blob.subarray(33)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

export function encryptText(key, text) {
  return encryptBuffer(key, Buffer.from(text, 'utf8'))
}

export function decryptText(key, blob) {
  return decryptBuffer(key, blob).toString('utf8')
}

export async function writeEncryptedFile(key, filePath, data) {
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const blob = encryptBuffer(key, plain)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  await fsp.writeFile(tmp, blob)
  await fsp.rename(tmp, filePath)
}

export async function readEncryptedFile(key, filePath) {
  const blob = await fsp.readFile(filePath)
  return decryptBuffer(key, blob)
}

export async function readEncryptedText(key, filePath) {
  return (await readEncryptedFile(key, filePath)).toString('utf8')
}
