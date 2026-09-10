#!/usr/bin/env node
/**
 * 批处理入口：目录 / 多文件 / 压缩包 → 路由 + 执行本地处理器 → 汇总清单。
 *
 * 用法:
 *   node scripts/batch.mjs <路径...> [--out-dir <目录>] [--dry-run] [--max-files 200]
 *                          [--include <正则>] [--json]
 *
 * 行为:
 *   1. 展开输入：目录递归、压缩包先解压再递归、文件直接收；
 *   2. 每个文件跑 route.mjs 的路由逻辑；
 *   3. 执行「本地可自动完成」的处理器（extract.py / transcribe.py / unzip.py）；
 *      vision.js（识图，耗外部额度）与 video-deconstruct（需拆解决策）只给命令，不自动执行；
 *   4. 输出 JSON 汇总：成功/失败/跳过 + 每个产物的路径。
 *
 * 缓存: 与 extract.py / transcribe.py 共用 ~/.dsh/file-intake-cache（命中即秒回）。
 *
 * 退出码: 0 = 全部成功；1 = 有失败；2 = 参数错误。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const inputs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const outDir = value('--out-dir', path.join(process.cwd(), 'file-intake-out'))
const maxFiles = Number(value('--max-files', '200'))
const includeRe = value('--include')
const dryRun = flag('--dry-run')

/** 本地可自动执行的处理器（其余只给命令）。 */
const AUTO_HANDLERS = new Set([
  'extract.py', 'extract.py(pypdf)', 'extract.py(convert)', 'extract.py(xlrd)',
  'extract.py(heic→png)', 'extract.py(psd→png)',
  'transcribe.py', 'transcribe.py(mido)', 'unzip.py',
])
const PY = 'py -X utf8'
/** 实际调用的 Python 解释器（Linux/macOS 可设 FILE_INTAKE_PY=python3）。 */
const PY_BIN = process.env.FILE_INTAKE_PY || 'py'

/** 递归收集文件。 */
function collect(target, acc = []) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      if (name.startsWith('_extract') || name.endsWith('_unzip')) continue
      collect(path.join(target, name), acc)
    }
    return acc
  }
  if (stat.isFile()) acc.push(path.resolve(target))
  return acc
}

/** 调用 route.mjs 拿路由结论。 */
function route(file) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'route.mjs'), file, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  try {
    return JSON.parse(res.stdout)
  } catch {
    return { ok: false, kind: 'unknown', handler: null, error: { code: 'ROUTE_FAILED', message: (res.stderr || '').slice(0, 200) } }
  }
}

/** 执行处理器，返回 { ok, artifacts, error, engine, summary }。 */
function execute(handler, file) {
  const out = path.join(outDir, path.basename(file) + '.txt')
  let cmd, args
  if (handler.startsWith('extract.py')) {
    cmd = PY_BIN
    args = ['-X', 'utf8', path.join(__dirname, 'extract.py'), file, '--out', out]
  } else if (handler.startsWith('transcribe.py')) {
    cmd = PY_BIN
    args = ['-X', 'utf8', path.join(__dirname, 'transcribe.py'), file, '--out', out]
  } else if (handler === 'unzip.py') {
    cmd = PY_BIN
    args = ['-X', 'utf8', path.join(__dirname, 'unzip.py'), file, '--out', path.join(outDir, path.basename(file, path.extname(file)) + '_unzip')]
  } else {
    return { ok: false, skipped: true, error: { code: 'NOT_AUTO', message: `handler ${handler} 需人工/agent 决策` } }
  }
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  try {
    const payload = JSON.parse(res.stdout)
    return {
      ok: payload.ok === true,
      artifacts: payload.artifacts ?? payload.files ?? [],
      engine: payload.engine,
      cached: payload.cached === true,
      chars: payload.chars,
      summary: payload.summary,
      error: payload.error,
    }
  } catch {
    return { ok: false, error: { code: 'HANDLER_FAILED', message: (res.stderr || res.stdout || '').slice(0, 200) } }
  }
}

function main() {
  if (!inputs.length) {
    console.log(JSON.stringify({ ok: false, error: { code: 'USAGE', message: '用法: node scripts/batch.mjs <路径...> [--out-dir 目录] [--dry-run]' } }, null, 2))
    return 2
  }
  fs.mkdirSync(outDir, { recursive: true })

  // 1) 展开输入（压缩包先解压）
  const queue = []
  const preExtracted = []
  for (const input of inputs) {
    const target = path.resolve(input)
    if (!fs.existsSync(target)) { queue.push({ file: target, missing: true }); continue }
    const r = route(target)
    if (r.kind === 'archive') {
      const un = execute('unzip.py', target)
      preExtracted.push({ archive: target, ok: un.ok, summary: un.summary, out_dir: path.join(outDir, path.basename(target, path.extname(target)) + '_unzip'), error: un.error })
      if (un.ok) for (const f of un.artifacts) queue.push({ file: f })
      continue
    }
    for (const f of collect(target)) queue.push({ file: f })
  }

  let files = queue.filter((q) => !q.missing).map((q) => q.file)
  if (includeRe) {
    const re = new RegExp(includeRe, 'i')
    files = files.filter((f) => re.test(f))
  }
  const truncated = files.length > maxFiles
  if (truncated) files = files.slice(0, maxFiles)

  // 2) 逐个路由 + 执行
  const results = queue.filter((q) => q.missing).map((q) => ({ file: q.file, status: 'missing', summary: '文件不存在' }))
  for (const file of files) {
    const r = route(file)
    const entry = { file, type: r.type, kind: r.kind, handler: r.handler, status: 'routed', artifacts: [], summary: r.summary }
    if (r.ok === false) {
      entry.status = 'unsupported'
      entry.reason = r.error?.code ?? r.hints?.[0] ?? '不支持'
      entry.summary = `不支持：${entry.reason}`
      results.push(entry)
      continue
    }
    if (dryRun) { results.push(entry); continue }
    if (r.handler && AUTO_HANDLERS.has(r.handler)) {
      const out = execute(r.handler, file)
      entry.status = out.ok ? (out.cached ? 'ok(cached)' : 'ok') : out.skipped ? 'needs-agent' : 'failed'
      entry.artifacts = out.artifacts ?? []
      entry.chars = out.chars
      if (out.summary) entry.summary = out.summary
      if (out.error) {
        entry.error = out.error
        entry.summary = `失败：${out.error.code ?? ''} ${out.error.message ?? ''}`.trim()
      }
    } else {
      entry.status = 'needs-agent'
      entry.command = r.command
      entry.summary = `需 agent 决策（${r.handler}）：${r.command ?? '见 route.mjs 输出'}`
    }
    results.push(entry)
  }

  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {})
  const summary = {
    ok: results.every((r) => ['ok', 'ok(cached)', 'routed', 'needs-agent'].includes(r.status)),
    handler: 'batch.mjs',
    source: inputs.map((i) => path.resolve(i)),
    type: 'batch',
    dryRun,
    outDir,
    inputs: inputs.length,
    files: files.length,
    truncated,
    archives: preExtracted,
    counts,
    artifacts: results.flatMap((r) => r.artifacts ?? []),
    summary: `批处理 ${files.length} 个文件：` +
      Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('，') +
      `（产物目录 ${outDir}）`,
    results,
  }
  console.log(JSON.stringify(summary, null, 2))
  return summary.ok ? 0 : 1
}

process.exit(main())
