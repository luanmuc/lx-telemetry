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
