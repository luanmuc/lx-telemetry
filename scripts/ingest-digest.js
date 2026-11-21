#!/usr/bin/env node
/**
 * 真机健康聚合包入库（lx-telemetry）
 *
 * 设计前提：App 用 fine-grained PAT 开 Issue，body 里放一份 JSON 摘要。
 * 本脚本只做四件事：提取 → 校验 → 去重 → 追加 digests/<日期>.jsonl。
 * 不信任 issue 里的任何字段：全部按白名单校验，超长/多余键/类型不符一律拒收。
 */
const fs = require('fs')
const path = require('path')

const SCHEMA = 'lx-health-digest/1'
const MAX_BYTES = 48 * 1024 // GitHub Issue body 上限 65536 字符，留出余量
const ROOT = path.resolve(__dirname, '..')
const DIR = () => process.env.DIGEST_DIR || path.join(ROOT, 'digests')
const KEEP_DAYS = 60

function extractJson(body) {
  if (typeof body !== 'string' || !body.trim()) return { error: 'body 为空' }
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return { error: `body 超过 ${MAX_BYTES} 字节` }
  // LT-06：原来只取第一个 fence。正文里若先有一段说明性示例片段，真正的 JSON 在后面就会被取错。
  // 改为按出现顺序逐个尝试，返回第一个能解析成对象的；没有 fence 时退回整体解析。
  const fences = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1])
  const candidates = fences.length ? fences : [body]
  let lastErr = null
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { digest: parsed }
    } catch (e) { lastErr = e }
  }
  return { error: 'JSON 解析失败：' + (lastErr ? lastErr.message : '没有解析出对象') }
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const keysOnly = (o, allowed) => Object.keys(o).every(k => allowed.includes(k))

function validateCount(o, name, errs) {
  if (!isObj(o)) { errs.push(`${name} 缺失或不是对象`); return }
  if (!isInt(o.total, 0, 2000)) errs.push(`${name}.total 非 0~2000 整数`)
  if (!isInt(o.ok, 0, 2000)) errs.push(`${name}.ok 非 0~2000 整数`)
  if (isInt(o.total, 0, 2000) && isInt(o.ok, 0, 2000) && o.ok > o.total) errs.push(`${name}.ok > total`)
  // v9.1.4：by_source 与 by_quality 同构，只有键长上限不同（档位名如 flac24bit 更短）
  for (const bucket of ['by_source', 'by_quality']) {
    const sub = o[bucket]
    if (sub === undefined) continue
    if (!isObj(sub)) { errs.push(`${name}.${bucket} 不是对象`); continue }
    const maxKey = bucket === 'by_source' ? 40 : 12
    for (const [k, v] of Object.entries(sub)) {
      if (!keysOnly(v, ['total', 'ok']) || !isInt(v.total, 0, 2000) || !isInt(v.ok, 0, 2000)) errs.push(`${name}.${bucket}.${k} 非法`)
      if (k.length > maxKey) errs.push(`${name}.${bucket} 键过长`)
    }
  }
  if (!keysOnly(o, ['total', 'ok', 'by_source', 'by_quality'])) errs.push(`${name} 含未知字段`)
}

function validate(d) {
  const errs = []
  if (!isObj(d)) return ['顶层不是对象']
  if (d.schema !== SCHEMA) errs.push(`schema 必须为 ${SCHEMA}`)
  if (!isObj(d.device) || !/^[a-f0-9]{8,32}$/.test(String(d.device && d.device.id))) errs.push('device.id 非法（8~32 位小写 hex）')
  else if (d.device.model !== undefined && !isStr(d.device.model, 80)) errs.push('device.model 过长')
  // LT-03：schema 声明 android 是 maxLength 40 的字符串，脚本原来完全不查（类型与长度都没校验），
  // 两份真值不同步。这里补齐，与 schema 对齐。
  if (d.device && d.device.android !== undefined && !isStr(d.device.android, 40)) errs.push('device.android 非法（1~40 字符字符串）')
  if (!keysOnly(d.device || {}, ['id', 'model', 'android'])) errs.push('device 含未知字段')
  if (!isObj(d.app) || !isStr(d.app.version, 32)) errs.push('app.version 非法')
  if (!keysOnly(d.app || {}, ['version', 'build'])) errs.push('app 含未知字段')
  if (d.app && d.app.build !== undefined && !isInt(d.app.build, 0, 999999)) errs.push('app.build 非法')
  const t = Date.parse(d.generated_at)
  if (!isStr(d.generated_at, 40) || Number.isNaN(t)) errs.push('generated_at 不是合法时间')
  // LT-04：原来是绝对值容差，未来 29 天的时间戳同样合法 → 会直接产出未来日期的
  // digests/<未来日>.jsonl，污染按天分文件与「只保留最近 60 个」的裁剪逻辑。
  // 改为单向：只允许过去 30 天，正向仅容忍 5 分钟设备时钟漂移。
  else if (Date.now() - t < -5 * 60e3) errs.push('generated_at 晚于当前时间超过 5 分钟（疑似设备时钟错乱）')
  else if (Date.now() - t > 30 * 864e5) errs.push('generated_at 早于当前时间超过 30 天')
  if (!isInt(d.window_hours, 1, 168)) errs.push('window_hours 非 1~168 整数')
  validateCount(d.probe, 'probe', errs)
  validateCount(d.play, 'play', errs)
  if (d.chain !== undefined) {
    if (!isObj(d.chain)) errs.push('chain 不是对象')
    else {
      if (!isInt(d.chain.total, 0, 2000) || !isInt(d.chain.ok, 0, 2000)) errs.push('chain 计数非法')
      if (d.chain.failures !== undefined) {
        if (!Array.isArray(d.chain.failures) || d.chain.failures.length > 200) errs.push('chain.failures 非数组或超 200 条')
        else for (const f of d.chain.failures) {
          if (!isObj(f) || !isStr(f.source, 40) || !isStr(f.code, 40)) errs.push('chain.failures 条目非法')
          else if (!keysOnly(f, ['source', 'code', 'at'])) errs.push('chain.failures 条目含未知字段')
        }
      }
      if (!keysOnly(d.chain, ['total', 'ok', 'failures'])) errs.push('chain 含未知字段')
    }
  }
  // LT-03：schema 对 breaker 的每个源项声明了 state(maxLength 20) 与 fail(0~9999)，
  // 脚本原来只判「是不是对象」。补齐子结构校验，与 schema 对齐。
  if (d.breaker !== undefined) {
    if (!isObj(d.breaker)) errs.push('breaker 不是对象')
    else for (const [src, v] of Object.entries(d.breaker)) {
      if (!isObj(v)) errs.push(`breaker.${src} 不是对象`)
      else {
        if (v.state !== undefined && !isStr(v.state, 20)) errs.push(`breaker.${src}.state 非法（1~20 字符）`)
        if (v.fail !== undefined && !isInt(v.fail, 0, 9999)) errs.push(`breaker.${src}.fail 非 0~9999 整数`)
        if (!keysOnly(v, ['state', 'fail'])) errs.push(`breaker.${src} 含未知字段`)
      }
      if (src.length > 40) errs.push('breaker 源名过长')
    }
  }
  if (d.recent_events !== undefined) {
    if (!Array.isArray(d.recent_events) || d.recent_events.length > 500) errs.push('recent_events 非数组或超 500 条')
    else for (const e of d.recent_events) {
      if (!isObj(e) || !isStr(e.at, 40) || !isStr(e.kind, 40)) errs.push('recent_events 条目非法')
      else if (!keysOnly(e, ['at', 'kind', 'source', 'code', 'q', 'ms'])) errs.push('recent_events 条目含未知字段')
      else if (e.q !== undefined && !isStr(e.q, 12)) errs.push('recent_events 条目 q 非法')
    }
  }
  if (d.source !== undefined) {
    if (!isObj(d.source)) errs.push('source 不是对象')
    else if (!keysOnly(d.source, ['version'])) errs.push('source 含未知字段')
    else if (d.source.version !== undefined && !isStr(d.source.version, 32)) errs.push('source.version 非法')
  }
  if (!keysOnly(d, ['schema', 'device', 'app', 'source', 'generated_at', 'window_hours', 'probe', 'play', 'chain', 'breaker', 'recent_events'])) errs.push('顶层含未知字段')
  return errs
}

function dayFile(dateStr) {
  const day = dateStr.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期非法：' + dateStr)
  return path.join(DIR(), `${day}.jsonl`)
}

function recentFiles() {
  const dir = DIR()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-KEEP_DAYS)
}

function isDuplicate(d, file) {
  if (!fs.existsSync(file)) return false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.digest && row.digest.device && row.digest.device.id === d.device.id &&
          row.digest.generated_at === d.generated_at) return true
    } catch {}
  }
  // 跨日边界：同一 generated_at 可能落在前一天文件
  for (const f of recentFiles()) {
    if (path.join(DIR(), f) === file) continue
    for (const line of fs.readFileSync(path.join(DIR(), f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row.digest && row.digest.device && row.digest.device.id === d.device.id &&
            row.digest.generated_at === d.generated_at) return true
      } catch {}
    }
  }
  return false
}

function ingest({ body, issue }) {
  const ex = extractJson(body)
  if (ex.error) return { result: 'invalid', reason: ex.error }
  const errs = validate(ex.digest)
  if (errs.length) return { result: 'invalid', reason: errs.slice(0, 8).join('；') }
  const file = dayFile(ex.digest.generated_at)
  if (isDuplicate(ex.digest, file)) return { result: 'duplicate', file: path.relative(ROOT, file) }
  fs.mkdirSync(DIR(), { recursive: true })
  const row = { digest: ex.digest, issue: Number(issue) || null, ingested_at: new Date().toISOString() }
  fs.appendFileSync(file, JSON.stringify(row) + '\n')
  return { result: 'ingested', file: path.relative(ROOT, file) }
}

function main() {
  const out = ingest({ body: process.env.ISSUE_BODY || '', issue: process.env.ISSUE_NUMBER })
  console.log(JSON.stringify(out))
  const ghOut = process.env.GITHUB_OUTPUT
  // LT-07：$GITHUB_OUTPUT 文件形式下 `%` 无特殊语义，真正的破坏者是换行（会把后续 `name=value`
  // 拆成独立的非法行）。原来只替换 \n，补上 \r（Windows 侧拼进来的多行 reason 会带 \r\n）。
  if (ghOut) fs.appendFileSync(ghOut, `result=${out.result}\nfile=${out.file || ''}\nreason=${(out.reason || '').replace(/[\r\n]+/g, ' ')}\n`)
  // invalid/duplicate 不算流程失败：workflow 会根据 result 决定评论与是否关闭
  process.exit(0)
}

if (require.main === module) main()

module.exports = { extractJson, validate, ingest }
