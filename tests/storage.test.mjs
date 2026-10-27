import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../server/storage.js'
import { encryptBuffer, decryptBuffer } from '../server/vault.js'

const tempDirs = []

async function makeStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mydiary-test-'))
  tempDirs.push(dataDir)
  return createStore({ dataDir, key: crypto.randomBytes(32) })
}

after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })))
})

test('日记加密往返，磁盘上不出现明文', async () => {
  const store = await makeStore()
  const text = '# 2026-10-27\n\n今天写了一次测试。'
  await store.writeDiary('2026-10-27', text)

  assert.equal(await store.readDiary('2026-10-27'), text)
  assert.deepEqual(await store.listDates(), ['2026-10-27'])

  const blob = await fs.readFile(path.join(store.diariesDir, '2026-10-27.enc'))
  assert.equal(blob.subarray(0, 4).toString(), 'MDV1')
  assert.ok(!blob.includes(Buffer.from('今天写了一次测试')), '密文里不应包含明文')
})

test('并发写同一天：串行化后最后一次写入生效', async () => {
  const store = await makeStore()
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.writeDiary('2026-01-01', `第 ${i} 版`)),
  )
  assert.equal(await store.readDiary('2026-01-01'), '第 19 版')
})

test('配置能加密保存并读回', async () => {
  const store = await makeStore()
  await store.writeConfig({ privacyGateEnabled: true, editorPath: '' })
  const cfg = await store.readConfig({ privacyGateEnabled: false, editorPath: 'fallback' })
  assert.equal(cfg.privacyGateEnabled, true)
  assert.equal(cfg.editorPath, '')
})

test('配置损坏时明确抛错，绝不回退默认密码', async () => {
  const store = await makeStore()
  await fs.writeFile(store.configFile, 'not-a-vault-blob')
  await assert.rejects(() => store.readConfig({ privacyPasswordSet: false }), /config\.enc 无法解密/)
})

test('外部编辑器：导出明文后能回写加密仓', async () => {
  const store = await makeStore()
  await store.writeDiary('2026-02-02', '# 2026-02-02\n\n原始内容\n')
  const tmpDir = path.join(store.dataDir, 'tmp-edit')
  const tmpFile = await store.exportPlain('2026-02-02', tmpDir)

  await fs.writeFile(tmpFile, '# 2026-02-02\n\n编辑器改过的内容\n')
  await store.commitExternal(tmpFile, '2026-02-02')

  assert.equal(await store.readDiary('2026-02-02'), '# 2026-02-02\n\n编辑器改过的内容\n')
})

test('错误密钥无法解密', () => {
  const blob = encryptBuffer(crypto.randomBytes(32), Buffer.from('秘密'))
  assert.throws(() => decryptBuffer(crypto.randomBytes(32), blob))
})

test('图片读写往返，路径穿越被拒绝', async () => {
  const store = await makeStore()
  const data = crypto.randomBytes(128)
  await store.writeImage('2026-10-27-1.png', data)
  assert.deepEqual(await store.readImage('2026-10-27-1.png'), data)
  assert.equal(await store.readImage('../config.enc'), null)
})
