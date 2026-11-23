#!/usr/bin/env node
/**
 * 证据完整性（STRESS_PLAN T7）：逐行 JSON.parse 仓库 digests/*.jsonl
 * 只读，不修改任何数据文件；坏行 = 0 才算通过。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const DIR = path.resolve(__dirname, '../digests')

test('T7 全部 digests/*.jsonl 逐行可解析，坏行=0', () => {
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  assert.ok(files.length > 0, 'digests/ 应至少有一个按天文件')

  let lines = 0
  const bad = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8')
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue
      lines++
      try {
        const row = JSON.parse(line)
        assert.ok(row && typeof row === 'object', `${f}:${i + 1} 不是对象`)
        assert.ok(row.digest && typeof row.digest === 'object', `${f}:${i + 1} 缺 digest`)
      } catch (e) {
        bad.push(`${f}:${i + 1} ${e.message}`)
      }
    }
  }
  assert.deepEqual(bad, [], '坏行必须为 0')
  assert.ok(lines > 0, '至少应有一条真机摘要')
})
