#!/usr/bin/env node
/**
 * lx-telemetry 压测套件 · T5 追加吞吐（STRESS_PLAN §1）
 *
 * 判据：1,000 / 10,000 行，每千行 < 200ms；落盘行数 = 投递去重后条数；无半行。
 * 纪律：DIGEST_DIR 必须指向 mkdtemp，不污染仓库 digests/。
 * 说明：T5 是长测计量项，不在日常 39 例套件里；本文件单独跑。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { ingest } = require('../scripts/ingest-digest.js')

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-ingest-t5-'))
  process.env.DIGEST_DIR = dir
  return dir
}

function digestAt(i, baseMs) {
  return {
    schema: 'lx-health-digest/1',
    device: { id: 'a1b2c3d4e5f6', model: 'K80 Pro', android: '15' },
    app: { version: '1.9.2', build: 305 },
    generated_at: new Date(baseMs + i * 1000).toISOString(),
    window_hours: 24,
    probe: { total: 38, ok: 15 },
    play: { total: 24, ok: 0 },
  }
}

function runBatch(n) {
  const dir = freshDir()
  // 基线取 29 天前，确保 generated_at 落在 validate 允许的过去 30 天窗口内。
  const baseMs = Date.now() - 29 * 864e5
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) {
    const r = ingest({ body: JSON.stringify(digestAt(i, baseMs)), issue: i + 1 })
    assert.equal(r.result, 'ingested', `第 ${i} 条未入库: ${r.result} ${r.reason || ''}`)
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6

  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  const lines = files.flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
  let parsed = 0
  for (const line of lines) {
    JSON.parse(line) // 半行/坏行会直接抛
    parsed++
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { n, elapsedMs, per1000Ms: elapsedMs / (n / 1000), lines: lines.length, parsed, files: files.length }
}

test('T5.1 1,000 行追加，每千行 <200ms，落盘 1000 行无半行', () => {
  const r = runBatch(1000)
  assert.equal(r.files, 1)
  assert.equal(r.lines, 1000)
  assert.equal(r.parsed, 1000)
  assert.ok(r.per1000Ms < 200, `1000 行耗时 ${r.elapsedMs.toFixed(1)}ms，每千行 ${r.per1000Ms.toFixed(1)}ms，超过 200ms`)
})

test('T5.2 10,000 行追加，每千行 <200ms，落盘 10000 行无半行', () => {
  const r = runBatch(10000)
  assert.equal(r.files, 1)
  assert.equal(r.lines, 10000)
  assert.equal(r.parsed, 10000)
  assert.ok(r.per1000Ms < 200, `10000 行耗时 ${r.elapsedMs.toFixed(1)}ms，每千行 ${r.per1000Ms.toFixed(1)}ms，超过 200ms`)
})
