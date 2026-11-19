#!/usr/bin/env node
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-ingest-'))
process.env.DIGEST_DIR = tmp
const { ingest, validate, extractJson } = require('../scripts/ingest-digest.js')

const base = () => ({
  schema: 'lx-health-digest/1',
  device: { id: 'a1b2c3d4e5f6', model: 'K80 Pro', android: '15' },
  app: { version: '1.9.2', build: 305 },
  generated_at: new Date().toISOString(),
  window_hours: 24,
  probe: { total: 38, ok: 15 },
  play: { total: 24, ok: 0 },
})

test('合法摘要入库并生成当日文件', () => {
  const d = base()
  const r = ingest({ body: JSON.stringify(d), issue: 1 })
  assert.equal(r.result, 'ingested')
  assert.ok(fs.existsSync(path.join(tmp, d.generated_at.slice(0, 10) + '.jsonl')))
})

test('同一 device+generated_at 重复投递判 duplicate', () => {
  const d = base()
  assert.equal(ingest({ body: JSON.stringify(d), issue: 2 }).result, 'ingested')
  assert.equal(ingest({ body: JSON.stringify(d), issue: 3 }).result, 'duplicate')
})

test('code fence 包裹的 JSON 也能提取', () => {
  const d = base()
  const body = '巡检摘要如下\n```json\n' + JSON.stringify(d) + '\n```\n'
  assert.equal(extractJson(body).digest.device.id, d.device.id)
})

test('计数非法/未知字段一律拒收', () => {
  const bad = base()
  bad.probe = { total: 5, ok: 9 }
  assert.ok(validate(bad).length > 0)
  const extra = base()
  extra.device.imei = 'x'
  assert.ok(validate(extra).length > 0)
})

test('超 48KB body 直接拒收', () => {
  assert.equal(ingest({ body: 'x'.repeat(600 * 1024), issue: 4 }).result, 'invalid')
})

// ---- 2026-11-19 通读补修：LT-03 / LT-04 / LT-06 的回归用例 ----

test('LT-03：device.android 超长/非字符串拒收（与 schema maxLength 40 对齐）', () => {
  const long = base()
  long.device.android = 'x'.repeat(41)
  assert.ok(validate(long).some(e => e.includes('device.android')))
  const wrongType = base()
  wrongType.device.android = 15
  assert.ok(validate(wrongType).some(e => e.includes('device.android')))
  const ok = base()
  ok.device.android = 'Android 15 / HyperOS 2'
  assert.equal(validate(ok).length, 0)
})

test('LT-03：breaker 子结构按 schema 校验（state 长度 / fail 范围 / 未知字段）', () => {
  const longState = base()
  longState.breaker = { kw: { state: 'x'.repeat(21) } }
  assert.ok(validate(longState).some(e => e.includes('breaker.kw.state')))

  const badFail = base()
  badFail.breaker = { kw: { state: 'open', fail: 10000 } }
  assert.ok(validate(badFail).some(e => e.includes('breaker.kw.fail')))

  const extraKey = base()
  extraKey.breaker = { kw: { state: 'open', fail: 2, extra: true } }
  assert.ok(validate(extraKey).some(e => e.includes('breaker.kw 含未知字段')))

  const ok = base()
  ok.breaker = { kw: { state: 'open', fail: 2 }, tx: { state: 'closed' } }
  assert.equal(validate(ok).length, 0)
})

test('LT-04：generated_at 未来时间超过 5 分钟拒收（原来绝对值容差会放行）', () => {
  const future = base()
  future.generated_at = new Date(Date.now() + 29 * 864e5).toISOString()
  assert.ok(validate(future).some(e => e.includes('晚于当前时间')))

  const slightSkew = base()
  slightSkew.generated_at = new Date(Date.now() + 60 * 1000).toISOString()
  assert.equal(validate(slightSkew).length, 0, '5 分钟内时钟漂移应放行')

  const tooOld = base()
  tooOld.generated_at = new Date(Date.now() - 31 * 864e5).toISOString()
  assert.ok(validate(tooOld).some(e => e.includes('早于当前时间超过 30 天')))
})

test('LT-06：前面有说明性 fence 时取第一个能解析成对象的 JSON', () => {
  const d = base()
  const body = '示例（不是数据）：\n```\nnot a json\n```\n真正的摘要：\n```json\n' + JSON.stringify(d) + '\n```\n'
  const r = extractJson(body)
  assert.ok(r.digest, '应能从第二个 fence 取到 JSON：' + (r.error || ''))
  assert.equal(r.digest.device.id, d.device.id)
})
