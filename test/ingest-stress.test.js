#!/usr/bin/env node
/**
 * lx-telemetry 压测套件（STRESS_PLAN §1 T1~T4/T6，29 例）
 *
 * 纪律：
 * - 所有写盘用例都走 DIGEST_DIR=<mkdtemp>，不污染仓库 digests/
 * - 只断言 ingest/validate/extractJson 的公开行为，不断言内部实现
 * - T5（1000/10000 行追加吞吐）是计量项，需单独跑长测；本文件不伪造其结论
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_BYTES = 48 * 1024
const { ingest, validate, extractJson } = require('../scripts/ingest-digest.js')

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-ingest-stress-'))
  process.env.DIGEST_DIR = dir
  return dir
}

function base() {
  return {
    schema: 'lx-health-digest/1',
    device: { id: 'a1b2c3d4e5f6', model: 'K80 Pro', android: '15' },
    app: { version: '1.9.2', build: 305 },
    generated_at: new Date().toISOString(),
    window_hours: 24,
    probe: { total: 38, ok: 15 },
    play: { total: 24, ok: 0 },
  }
}

function paddedBody(d, bytes) {
  const s = JSON.stringify(d)
  const used = Buffer.byteLength(s, 'utf8')
  if (used > bytes) throw new Error(`base ${used}B > target ${bytes}B`)
  return s + ' '.repeat(bytes - used)
}

// ---- T1 体积边界（5 例） ----
test('T1.1 47.9KB 合法摘要可收', () => {
  freshDir()
  assert.equal(ingest({ body: paddedBody(base(), Math.floor(47.9 * 1024)), issue: 1 }).result, 'ingested')
})

test('T1.2 48KB 边界可收', () => {
  freshDir()
  assert.equal(ingest({ body: paddedBody(base(), MAX_BYTES), issue: 2 }).result, 'ingested')
})

test('T1.3 48KB+1B 拒收', () => {
  freshDir()
  const r = ingest({ body: paddedBody(base(), MAX_BYTES + 1), issue: 3 })
  assert.equal(r.result, 'invalid')
  assert.match(r.reason, /49152|48KB|超过/)
})

test('T1.4 600KB 拒收且不抛', () => {
  freshDir()
  assert.equal(ingest({ body: 'x'.repeat(600 * 1024), issue: 4 }).result, 'invalid')
})

test('T1.5 2048KB 拒收且不抛', () => {
  freshDir()
  assert.equal(ingest({ body: 'x'.repeat(2048 * 1024), issue: 5 }).result, 'invalid')
})

// ---- T2 结构畸形（8 例） ----
test('T2.1 非 JSON 拒收', () => {
  freshDir()
  assert.equal(ingest({ body: 'not json', issue: 6 }).result, 'invalid')
})

test('T2.2 顶层数组拒收', () => {
  freshDir()
  assert.equal(ingest({ body: JSON.stringify([base()]), issue: 7 }).result, 'invalid')
})

test('T2.3 多段 JSON 拒收', () => {
  freshDir()
  assert.equal(ingest({ body: JSON.stringify(base()) + JSON.stringify(base()), issue: 8 }).result, 'invalid')
})

test('T2.4 深嵌套 100 层不崩', () => {
  freshDir()
  let root = {}
  let cur = root
  for (let i = 0; i < 100; i++) { cur.a = {}; cur = cur.a }
  assert.equal(ingest({ body: JSON.stringify(root), issue: 9 }).result, 'invalid')
})

test('T2.5 10^5 长数组不崩', () => {
  freshDir()
  assert.equal(ingest({ body: '[' + '0,'.repeat(99999) + '0]', issue: 10 }).result, 'invalid')
})

test('T2.6 控制字符/NUL 不误收', () => {
  freshDir()
  assert.equal(ingest({ body: JSON.stringify({ x: '\u0000' }), issue: 11 }).result, 'invalid')
})

test('T2.7 BOM 前缀不误收', () => {
  freshDir()
  assert.equal(ingest({ body: '\uFEFF' + JSON.stringify(base()), issue: 12 }).result, 'invalid')
})

test('T2.8 空 body 拒收', () => {
  freshDir()
  assert.equal(ingest({ body: '', issue: 13 }).result, 'invalid')
})

// ---- T3 契约漂移（7 例） ----
test('T3.1 未知顶层键拒收', () => {
  freshDir()
  assert.ok(validate({ ...base(), extra: true }).length > 0)
})

test('T3.2 未知嵌套键拒收', () => {
  freshDir()
  const d = base()
  d.device.imei = 'x'
  assert.ok(validate(d).length > 0)
})

test('T3.3 schema 版本错误拒收', () => {
  freshDir()
  const d = base()
  d.schema = 'lx-health-digest/2'
  assert.ok(validate(d).length > 0)
})

test('T3.4 device.id 长度 7 拒收', () => {
  freshDir()
  const d = base()
  d.device.id = 'a1b2c3d'
  assert.ok(validate(d).some(e => e.includes('device.id')))
})

test('T3.5 device.id 长度 33 拒收', () => {
  freshDir()
  const d = base()
  d.device.id = 'a'.repeat(33)
  assert.ok(validate(d).some(e => e.includes('device.id')))
})

test('T3.6 device.id 大写 hex 拒收', () => {
  freshDir()
  const d = base()
  d.device.id = 'A1B2C3D4E5F6'
  assert.ok(validate(d).some(e => e.includes('device.id')))
})

test('T3.7 ok>total 与负数均拒收', () => {
  freshDir()
  const over = base()
  over.probe = { total: 5, ok: 9 }
  assert.ok(validate(over).some(e => e.includes('ok > total')))
  const neg = base()
  neg.probe = { total: 5, ok: -1 }
  assert.ok(validate(neg).length > 0)
})

// ---- T4 去重语义（4 例） ----
test('T4.1 同 device+时间+同 issue 判 duplicate', () => {
  freshDir()
  const d = base()
  d.generated_at = '2026-11-23T01:00:00.000Z'
  assert.equal(ingest({ body: JSON.stringify(d), issue: 20 }).result, 'ingested')
  assert.equal(ingest({ body: JSON.stringify(d), issue: 20 }).result, 'duplicate')
})

test('T4.2 同 device+时间+异 issue 仍判 duplicate', () => {
  freshDir()
  const d = base()
  d.generated_at = '2026-11-23T02:00:00.000Z'
  assert.equal(ingest({ body: JSON.stringify(d), issue: 21 }).result, 'ingested')
  assert.equal(ingest({ body: JSON.stringify(d), issue: 22 }).result, 'duplicate')
})

test('T4.3 同 device 异时间全部入库', () => {
  freshDir()
  const a = base(); a.generated_at = '2026-11-23T03:00:00.000Z'
  const b = base(); b.generated_at = '2026-11-23T04:00:00.000Z'
  assert.equal(ingest({ body: JSON.stringify(a), issue: 23 }).result, 'ingested')
  assert.equal(ingest({ body: JSON.stringify(b), issue: 24 }).result, 'ingested')
})

test('T4.4 异 device 同时间全部入库', () => {
  freshDir()
  const a = base(); a.generated_at = '2026-11-23T05:00:00.000Z'; a.device.id = 'a1b2c3d4e5f6'
  const b = base(); b.generated_at = a.generated_at; b.device.id = 'b1c2d3e4f5a6'
  assert.equal(ingest({ body: JSON.stringify(a), issue: 25 }).result, 'ingested')
  assert.equal(ingest({ body: JSON.stringify(b), issue: 26 }).result, 'ingested')
})

// ---- T6 围栏提取（5 例） ----
test('T6.1 单 json 围栏可提取', () => {
  const d = base()
  const r = extractJson('```json\n' + JSON.stringify(d) + '\n```')
  assert.equal(r.digest.device.id, d.device.id)
})

test('T6.2 首个围栏无效时取后续有效围栏', () => {
  const d = base()
  const r = extractJson('```\nnot json\n```\n```json\n' + JSON.stringify(d) + '\n```')
  assert.equal(r.digest.device.id, d.device.id)
})

test('T6.3 text 围栏不误取', () => {
  const r = extractJson('```text\n' + JSON.stringify(base()) + '\n```')
  assert.ok(r.error)
})

test('T6.4 围栏内前后空行可提取', () => {
  const d = base()
  const r = extractJson('```json\n\n' + JSON.stringify(d) + '\n\n```')
  assert.equal(r.digest.device.id, d.device.id)
})

test('T6.5 未闭合围栏明确 invalid', () => {
  const r = extractJson('```json\n' + JSON.stringify(base()))
  assert.ok(r.error)
})
