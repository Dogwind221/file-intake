#!/usr/bin/env node
/**
 * file-intake 自测：自动造样例文件 → 断言路由 / 提取 / 缓存 / 安全防护 / 批量汇总。
 *
 * 用法:
 *   node scripts/selftest.mjs [--keep] [--verbose]
 *
 * 设计:
 *   - 不依赖仓库里的二进制样本：样例文件在系统临时目录现场生成（纯 Node 写 zip/pdf/文本，
 *     个别格式用 py 生成）；缺依赖的可选项自动 skip，不算失败；
 *   - 缓存放临时目录（FILE_INTAKE_CACHE 覆盖），不污染 ~/.dsh/file-intake-cache；
 *   - 退出码: 0 = 全部通过（含 skip）；1 = 有断言失败；2 = 环境不可用（连 node/py 都跑不起来）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const VERBOSE = argv.includes('--verbose')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-intake-selftest-'))
const fx = path.join(tmp, 'fx')
const out = path.join(tmp, 'out')
const cache = path.join(tmp, 'cache')
fs.mkdirSync(fx, { recursive: true })
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(cache, { recursive: true })
const env = { ...process.env, FILE_INTAKE_CACHE: cache, PYTHONDONTWRITEBYTECODE: '1' }
/** 实际调用的 Python 解释器（Linux/macOS 可设 FILE_INTAKE_PY=python3；CI 上必须设）。 */
const PY_BIN = process.env.FILE_INTAKE_PY || 'py'

/* ================= 断言框架 ================= */

const results = []
const ok = (name, detail = '') => results.push({ name, status: 'PASS', detail })
const bad = (name, detail = '') => results.push({ name, status: 'FAIL', detail })
const skip = (name, detail = '') => results.push({ name, status: 'SKIP', detail })
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail))

/* ================= 子进程 ================= */

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 300000, cwd: opts.cwd })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', failedToStart: Boolean(res.error) }
}

const hasPy = !run(PY_BIN, ['-X', 'utf8', '-c', 'print(1)']).failedToStart
/** 调试用：FILE_INTAKE_SELFTEST_FAKE_MISSING=pyarrow,xlwt 可强制把某些依赖当缺失，验证 skip 分支。 */
const FAKE_MISSING = (process.env.FILE_INTAKE_SELFTEST_FAKE_MISSING || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
const pyModule = (mod) => !FAKE_MISSING.includes(mod) && hasPy && run(PY_BIN, ['-X', 'utf8', '-c', `import ${mod}`]).code === 0

const route = (file) => {
  const r = run(process.execPath, [path.join(__dirname, 'route.mjs'), file, '--json'])
  try { return JSON.parse(r.stdout) } catch { return null }
}
const extract = (file, extraArgs = []) => {
  const r = run(PY_BIN, ['-X', 'utf8', path.join(__dirname, 'extract.py'), file, ...extraArgs])
  try { return JSON.parse(r.stdout) } catch { return null }
}
const unzip = (file, extraArgs = []) => {
  const r = run(PY_BIN, ['-X', 'utf8', path.join(__dirname, 'unzip.py'), file, ...extraArgs])
  try { return JSON.parse(r.stdout) } catch { return null }
}
const batch = (file, extraArgs = []) => {
  const r = run(process.execPath, [path.join(__dirname, 'batch.mjs'), file, ...extraArgs])
  try { return JSON.parse(r.stdout) } catch { return null }
}

const CONTRACT = ['ok', 'source', 'type', 'handler', 'artifacts', 'summary']
const hasContract = (obj) => Boolean(obj) && CONTRACT.every((k) => k in obj) &&
  Array.isArray(obj.artifacts) && typeof obj.summary === 'string' && obj.summary.length > 0

/* ================= 样例生成：纯 Node ================= */

/** CRC32（zip 用）。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * 极简 zip 写入器（store 模式，无压缩）——用于造 docx/xlsx/pptx/epub/zip 样例。
 * @param {{name: string, data: Buffer|string}[]} entries - 条目。
 * @returns {Buffer} zip 字节。
 */
function zipStore(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)   // UTF-8 名
    lh.writeUInt16LE(0, 8)        // store
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, Buffer.from(name))
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** 最小可用 PDF（带真实 xref，可被 pypdf 解析）。 */
function minimalPdf(text) {
  const content = `BT /F1 12 Tf 20 40 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'utf8')
}

const MARK = 'FILEINTAKE_SELFTEST_OK'
const write = (name, data) => {
  const p = path.join(fx, name)
  fs.writeFileSync(p, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
  return p
}
/** 按文件名取样例路径（样例都在 fx/ 下）。 */
const sample = (name) => path.join(fx, name)

const F = {}
F.txt = write('sample.txt', `${MARK} 纯文本\n`)
F.csv = write('sample.csv', `id,name\n1,${MARK}\n`)
F.srt = write('sample.srt', `1\n00:00:00,000 --> 00:00:01,000\n${MARK}\n\n2\n00:00:01,000 --> 00:00:02,000\nsecond\n`)
F.vtt = write('sample.vtt', `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${MARK}\n`)
F.svg = write('sample.svg', `<svg xmlns="http://www.w3.org/2000/svg"><title>t</title><text>${MARK}</text></svg>`)
F.eml = write('sample.eml', `From: a@example.com\nTo: b@example.com\nSubject: ${MARK}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nbody ${MARK}\n`)
F.pdf = write('sample.pdf', minimalPdf(MARK))
F.noext = write('noext_doc', minimalPdf(MARK))
F.exe = write('fake.exe', Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64)]))
F.bin = write('mystery.bin', Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.alloc(64, 7)]))
F.docx = write('sample.docx', zipStore([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: `<w:document><w:body><w:p><w:r><w:t>${MARK}</w:t></w:r></w:p></w:body></w:document>` },
]))
F.xlsx = write('sample.xlsx', zipStore([
  { name: 'xl/workbook.xml', data: '<workbook/>' },
]))
F.pptx = write('sample.pptx', zipStore([
  { name: 'ppt/presentation.xml', data: '<presentation/>' },
]))
F.epub = write('sample.epub', zipStore([
  { name: 'mimetype', data: 'application/epub+zip' },
  { name: 'content.opf', data: `<package><metadata><dc:title>${MARK}</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>` },
  { name: 'c1.xhtml', data: `<html><body><p>${MARK}</p></body></html>` },
]))
F.zip = write('sample.zip', zipStore([
  { name: 'inside/hello.txt', data: MARK },
  { name: 'inside/second.txt', data: 'two' },
]))

/* ================= 样例生成：Python（可选依赖自动跳过） ================= */

const pyFixtures = {}
function pyMake(key, code, requires) {
  if (requires && !pyModule(requires)) { pyFixtures[key] = { skipped: requires }; return }
  if (!hasPy) { pyFixtures[key] = { skipped: 'py' }; return }
  const r = run(PY_BIN, ['-X', 'utf8', '-c', code])
  pyFixtures[key] = r.code === 0 ? { file: path.join(fx, key) } : { failed: (r.stderr || '').trim().split('\n').slice(-1)[0] }
}

pyMake('sample.db', `
import sqlite3
c = sqlite3.connect(r"${path.join(fx, 'sample.db')}")
c.execute('create table t(id integer, name text)')
c.executemany('insert into t values(?,?)', [(1,'${MARK}'), (2,'beta')])
c.commit(); c.close()
`)
pyMake('evil.zip', `
import zipfile
z = zipfile.ZipFile(r"${path.join(fx, 'evil.zip')}", 'w')
z.writestr('inside/ok.txt', 'ok')
z.writestr('../escaped.txt', 'should never be written')
z.close()
`)
pyMake('bomb.zip', `
import zipfile
z = zipfile.ZipFile(r"${path.join(fx, 'bomb.zip')}", 'w', zipfile.ZIP_DEFLATED)
z.writestr('big.txt', b'0' * (30 * 1024 * 1024))
z.close()
`)
pyMake('sample.parquet', `
import pyarrow as pa, pyarrow.parquet as pq
pq.write_table(pa.table({'id': pa.array([1,2], pa.int64()), 'name': pa.array(['${MARK}','beta'])}), r"${path.join(fx, 'sample.parquet')}")
`, 'pyarrow')
pyMake('sample.heic', `
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()
Image.new('RGB', (32, 24), (10, 120, 200)).save(r"${path.join(fx, 'sample.heic')}", format='HEIF')
`, 'pillow_heif')
pyMake('sample.xls', `
import xlwt
wb = xlwt.Workbook(); ws = wb.add_sheet('S1')
ws.write(0, 0, '${MARK}')
wb.save(r"${path.join(fx, 'sample.xls')}")
`, 'xlwt')

/* ================= 用例 ================= */

// 1) 路由：常见类型
{
  const cases = [
    ['sample.txt', (r) => r.ok && r.handler === 'extract.py'],
    ['sample.pdf', (r) => r.ok && r.kind === 'pdf' && String(r.handler).startsWith('extract.py')],
    ['noext_doc', (r) => r.ok && r.type === 'pdf' && r.sniffed === 'pdf'],
    ['sample.docx', (r) => r.ok && r.type === 'docx' && r.handler === 'extract.py'],
    ['sample.xlsx', (r) => r.ok && r.type === 'xlsx' && r.handler === 'extract.py'],
    ['sample.pptx', (r) => r.ok && r.type === 'pptx' && r.handler === 'extract.py'],
    ['sample.epub', (r) => r.ok && r.type === 'epub' && r.handler === 'extract.py'],
    ['sample.srt', (r) => r.ok && r.type === 'srt'],
    ['sample.svg', (r) => r.ok && r.type === 'svg'],
    ['sample.eml', (r) => r.ok && r.type === 'eml'],
    ['sample.zip', (r) => r.ok && r.kind === 'archive' && r.handler === 'unzip.py'],
    ['evil.zip', (r) => r.ok && r.handler === 'unzip.py'],
  ]
  for (const [name, pred] of cases) {
    if (!pred) continue
    const r = route(sample(name))
    check(`route ${name}`, pred(r ?? {}), r ? `${r.kind}/${r.handler} ${r.summary}` : '未返回 JSON')
  }
  const r = route(fx)
  check('route 目录 → batch.mjs', r?.ok && r.handler === 'batch.mjs', r?.summary ?? '')
}

// 2) 路由：安全边界与未知类型
{
  const r = route(F.exe)
  check('route .exe 拒绝（refuse）', r?.ok === false && r.handler === 'refuse', r?.summary ?? '')
  check('route .exe summary 说明安全边界', /拒绝路由|不路由/.test(r?.summary ?? ''), r?.summary ?? '')
  const b = route(F.bin)
  check('route 未知二进制 → ok=false', b?.ok === false && b.kind === 'unknown', `${b?.kind} ${b?.summary}`)
  const missing = route(path.join(fx, 'nope.pdf'))
  check('route 不存在文件 → NOT_FOUND', missing?.error?.code === 'NOT_FOUND', missing?.summary ?? '')
}

// 3) 路由交付契约
{
  const r = route(F.docx)
  check('route 交付契约字段', hasContract(r), CONTRACT.join(','))
}

// 4) 提取：内容与契约
{
  const expect = [
    ['sample.txt', 'text'],
    ['sample.pdf', 'text'],
    ['noext_doc', 'text'],
    ['sample.docx', 'text'],
    ['sample.epub', 'text'],
    ['sample.eml', 'text'],
  ]
  for (const [name] of expect) {
    const r = extract(sample(name))
    check(`extract ${name} 契约`, hasContract(r), r ? `handler=${r.handler}` : '未返回 JSON')
    check(`extract ${name} 含标记文本`, typeof r?.text === 'string' && r.text.includes(MARK), (r?.text ?? '').slice(0, 60))
  }
  const csv = extract(F.csv)
  check('extract csv 契约+内容', hasContract(csv) && csv.text.includes(MARK), csv?.summary ?? '')
  const srt = extract(F.srt)
  check('extract srt 去时间轴', hasContract(srt) && srt.text.includes(MARK) && !srt.text.includes('-->'), srt?.summary ?? '')
  const svg = extract(F.svg)
  check('extract svg 文本节点', hasContract(svg) && svg.text.includes(MARK), svg?.summary ?? '')
}

// 5) 提取：依赖就绪才跑的可选项
{
  const optional = [
    ['sample.db', 'sqlite3'],
    ['sample.xls', 'xlwt'],
    ['sample.parquet', 'pyarrow'],
    ['sample.heic', 'pillow_heif'],
  ]
  for (const [name, mod] of optional) {
    const made = pyFixtures[name]
    if (!made || made.skipped) { skip(`extract ${name}`, `样例生成跳过（缺 ${made?.skipped ?? mod}）`); continue }
    if (made.failed) { bad(`extract ${name}`, `样例生成失败: ${made.failed}`); continue }
    if (name === 'sample.heic') {
      const r = extract(made.file)
      check('extract heic → PNG 产物',
        hasContract(r) && r.ok === true && Array.isArray(r.artifacts) && r.artifacts.some((p) => p.endsWith('.png') && fs.existsSync(p)),
        r?.summary ?? '')
    } else {
      const r = extract(made.file)
      check(`extract ${name} 契约+内容`, hasContract(r) && r.text.includes(MARK), r?.summary ?? '')
    }
  }
}

// 6) 缓存命中
{
  const first = extract(F.docx, ['--refresh'])
  const second = extract(F.docx)
  check('缓存首跑 cached=false', first?.cached === false, String(first?.cached))
  check('缓存二跑 cached=true', second?.cached === true && second.text.includes(MARK), `cached=${second?.cached}`)
  check('缓存命中仍带契约', hasContract(second), second?.summary ?? '')
}

// 7) 解压安全防护
{
  const traversal = unzip(pyFixtures['evil.zip']?.file ?? '', ['--out', path.join(out, 'evil')])
  if (!pyFixtures['evil.zip']?.file) {
    skip('解压：路径穿越防护', 'evil.zip 样例未生成')
  } else {
    const skippedNames = (traversal?.skipped ?? []).map((s) => s.name).join(',')
    check('解压拒绝路径穿越条目', traversal?.ok === true && /escaped\.txt/.test(skippedNames), `skipped=[${skippedNames}]`)
    check('穿越条目未落盘', !fs.existsSync(path.join(out, 'escaped.txt')), 'out/escaped.txt 不应存在')
    check('正常条目已解出', fs.existsSync(path.join(out, 'evil', 'inside', 'ok.txt')), '')
  }

  const many = unzip(F.zip, ['--out', path.join(out, 'many'), '--max-entries', '1'])
  check('条目数上限 → TOO_MANY_ENTRIES', many?.error?.code === 'TOO_MANY_ENTRIES', many?.error?.message ?? '')

  if (pyFixtures['bomb.zip']?.file) {
    const bomb = unzip(pyFixtures['bomb.zip'].file, ['--out', path.join(out, 'bomb'), '--max-mb', '1'])
    check('解压体积上限 → TOO_LARGE', bomb?.error?.code === 'TOO_LARGE', bomb?.error?.message ?? '')
    check('超限时未解压落盘', !fs.existsSync(path.join(out, 'bomb', 'big.txt')), '')
  } else {
    skip('解压体积上限 → TOO_LARGE', 'bomb.zip 样例未生成')
  }

  const z = unzip(F.zip, ['--out', path.join(out, 'zip')])
  check('解压契约+产物清单',
    hasContract(z) && z.ok === true && z.artifacts.length === 2 && z.artifacts.every((p) => fs.existsSync(p)),
    z?.summary ?? '')
}

// 8) 批量汇总
{
  const dir = path.join(tmp, 'batchsrc')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(F.docx, path.join(dir, 'a.docx'))
  fs.copyFileSync(F.csv, path.join(dir, 'b.csv'))
  fs.copyFileSync(F.exe, path.join(dir, 'c.exe'))
  const r = batch(dir, ['--out-dir', path.join(out, 'batch')])
  check('batch 顶层交付契约', hasContract(r), r?.summary ?? '未返回 JSON')
  check('batch counts 统计', r?.counts?.ok === 2 && r?.counts?.unsupported === 1, JSON.stringify(r?.counts ?? {}))
  check('batch 顶层 artifacts 汇总', (r?.artifacts ?? []).length >= 2, `${(r?.artifacts ?? []).length} 个`)
  check('batch 每文件 summary', (r?.results ?? []).every((e) => typeof e.summary === 'string' && e.summary.length > 0), '')
  check('batch .exe 标 unsupported', (r?.results ?? []).some((e) => e.file.endsWith('c.exe') && e.status === 'unsupported'), '')
  const dry = batch(dir, ['--dry-run', '--out-dir', path.join(out, 'batch')])
  const planned = (dry?.counts?.routed ?? 0) + (dry?.counts?.unsupported ?? 0)
  check('batch --dry-run 只计划不执行',
    dry?.dryRun === true && planned === 3 && (dry?.artifacts ?? []).length === 0,
    JSON.stringify(dry?.counts ?? {}))
}

// 9) doctor 可运行
{
  const r = run(process.execPath, [path.join(__dirname, 'doctor.mjs'), '--json'])
  let parsed = null
  try { parsed = JSON.parse(r.stdout) } catch { /* ignore */ }
  check('doctor 输出 JSON 且有 checks', Array.isArray(parsed?.checks) && parsed.checks.length > 5, `${parsed?.checks?.length ?? 0} 项`)
  check('doctor 脚本完整性包含 selftest', (parsed?.checks ?? []).some((c) => c.name === 'selftest.mjs' || c.name === 'batch.mjs'), '')
}

/* ================= 汇总 ================= */

const passed = results.filter((r) => r.status === 'PASS')
const failed = results.filter((r) => r.status === 'FAIL')
const skipped = results.filter((r) => r.status === 'SKIP')

console.log('file-intake 自测')
for (const r of results) {
  if (r.status === 'PASS' && !VERBOSE) continue
  console.log(`  ${r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'skip' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
}
console.log(`\n合计: ${passed.length} 通过 / ${failed.length} 失败 / ${skipped.length} 跳过`)
console.log(JSON.stringify({
  ok: failed.length === 0,
  handler: 'selftest.mjs',
  source: fx,
  type: 'selftest',
  artifacts: [],
  summary: `自测 ${passed.length} 通过 / ${failed.length} 失败 / ${skipped.length} 跳过`,
  counts: { pass: passed.length, fail: failed.length, skip: skipped.length },
  failures: failed.map((f) => ({ name: f.name, detail: f.detail })),
  skipped: skipped.map((s) => ({ name: s.name, detail: s.detail })),
}, null, 2))

if (KEEP) console.log(`\n临时目录（--keep）: ${tmp}`)
else fs.rmSync(tmp, { recursive: true, force: true })

process.exit(failed.length === 0 ? 0 : 1)
