import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMigrationArchive, readMigrationArchive } from '../server/migration.js'

const PW = 'migrate-pass-123'

function archive(data) {
  return createMigrationArchive(data, PW)
}

test('迁移包往返：中文内容与图片保持原样', () => {
  const data = {
    diaries: [
      { date: '2026-10-27', content: '# 2026-10-27\n\n今天写了中文内容。\n' },
      { date: '2026-10-26', content: '' },
    ],
    images: [{ name: '2026-10-27-123.png', data: Buffer.from([1, 2, 3, 255]).toString('base64') }],
  }
  const parsed = readMigrationArchive(archive(data), PW)
  assert.deepEqual(parsed, { version: 1, ...data })
})

test('错误密码无法解密迁移包', () => {
  const blob = archive({ diaries: [], images: [] })
  assert.throws(() => readMigrationArchive(blob, 'wrong-password'))
})

test('篡改内容会被 GCM 校验发现', () => {
  const blob = archive({ diaries: [{ date: '2026-10-27', content: 'x' }], images: [] })
  blob[blob.length - 1] ^= 0xff
  assert.throws(() => readMigrationArchive(blob, PW))
})

test('非迁移包与过短文件被拒绝', () => {
  assert.throws(() => readMigrationArchive(Buffer.alloc(100, 7), PW), /不是 MyDiary/)
  assert.throws(() => readMigrationArchive(Buffer.alloc(10), PW), /大小无效/)
})

test('重复日期被拒绝', () => {
  const blob = archive({
    diaries: [
      { date: '2026-10-27', content: 'a' },
      { date: '2026-10-27', content: 'b' },
    ],
    images: [],
  })
  assert.throws(() => readMigrationArchive(blob, PW), /重复日期/)
})

test('图片名路径穿越与非法扩展名被拒绝', () => {
  for (const name of ['../evil.png', 'a/b.png', 'a\\b.png', 'evil.png.exe.tmp/x', '']) {
    const blob = archive({ diaries: [], images: [{ name, data: Buffer.from('x').toString('base64') }] })
    assert.throws(() => readMigrationArchive(blob, PW), /图片数据无效/, `应拒绝 ${name}`)
  }
})

test('图片数据必须是合法 base64', () => {
  const blob = archive({ diaries: [], images: [{ name: 'ok.png', data: '!!!not-base64!!!' }] })
  assert.throws(() => readMigrationArchive(blob, PW), /图片数据无效/)
})
