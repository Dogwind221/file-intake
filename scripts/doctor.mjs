#!/usr/bin/env node
/**
 * 依赖自检：file-intake 用到的外部工具与 Python 库是否可用。
 *
 * 用法:
 *   node scripts/doctor.mjs [--json]
 *
 * 输出（stdout，JSON）:
 *   { ok, checks: [{ name, kind, ok, detail, hint }], missing: [...] }
 *
 * 退出码: 0 = 全部必需项就绪；1 = 有必需项缺失。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

const jsonOnly = process.argv.includes('--json')
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }

/** 与 route.mjs 同源：优先 Bandizip(bz.exe)，其次 7-Zip。 */
function findArchiver() {
  const envBz = process.env.BANDIZIP
  if (envBz && isFile(envBz)) return { engine: 'bandizip', exe: envBz, from: 'env:BANDIZIP' }
  const bzOnPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === 'win32' ? 'bz.exe' : 'bz'))
    .find(isFile)
  if (bzOnPath) return { engine: 'bandizip', exe: bzOnPath, from: 'PATH' }
  for (const cand of ['D:\\DD\\bandi\\Bandizip\\bz.exe', 'C:\\Program Files\\Bandizip\\bz.exe', 'C:\\Program Files (x86)\\Bandizip\\bz.exe']) {
    if (isFile(cand)) return { engine: 'bandizip', exe: cand, from: '常见安装路径' }
  }
  const env7z = process.env.SEVEN_ZIP
  if (env7z && isFile(env7z)) return { engine: '7z', exe: env7z, from: 'env:SEVEN_ZIP' }
  for (const cand of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']) {
    if (isFile(cand)) return { engine: '7z', exe: cand, from: '常见安装路径' }
  }
  return null
}

/** 执行命令并返回是否成功 + 首行输出。 */
function probe(cmd, args = ['--version'], timeout = 8000) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, detail: String(out).trim().split(/\r?\n/)[0].slice(0, 80) }
  } catch (error) {
    return { ok: false, detail: String(error?.message || error).slice(0, 80) }
  }
}

/** 探测 Python 模块是否可导入。 */
function probePyModule(mod) {
  const res = probe('py', ['-X', 'utf8', '-c', `import ${mod}`])
  return { ok: res.ok, detail: res.ok ? '已安装' : '未安装' }
}

const checks = []
const add = (name, kind, required, res, hint) => {
  checks.push({ name, kind, required, ok: res.ok, detail: res.detail, ...(res.ok ? {} : { hint }) })
}

// ── 运行时 ──
add('node', 'runtime', true, probe('node'), '安装 Node.js 22+')
add('python(py)', 'runtime', true, probe('py', ['--version']), '安装 Python 3.10+')

// ── 外部工具 ──
add('ffmpeg', 'tool', true, probe('ffmpeg', ['-version']), 'winget install Gyan.FFmpeg')
add('yt-dlp', 'tool', false, probe('yt-dlp', ['--version']), 'winget install yt-dlp.yt-dlp（链接类视频才需要）')
add('deno', 'tool', false, probe('deno', ['--version']), 'winget install DenoLand.Deno（video-deconstruct 部分链路需要）')
const archiver = findArchiver()
add(
  archiver ? `archiver(${archiver.engine})` : 'archiver(Bandizip/7-Zip)',
  'tool', false,
  archiver ? { ok: true, detail: `${archiver.exe}（${archiver.from}）` } : { ok: false, detail: '未检测到 bz.exe / 7z.exe' },
  'winget install Bandizip.Bandizip（rar/7z 解压需要；装好即在 PATH 上，或设 BANDIZIP 指向 bz.exe）',
)
add('LibreOffice', 'tool', false, probe('soffice', ['--version']), 'winget install TheDocumentFoundation.LibreOffice（旧版 doc/ppt/pages/key/numbers 转换需要；.xls 已由 xlrd 直接支持）')

// ── Python 库 ──
add('faster-whisper', 'python', true, probePyModule('faster_whisper'), 'py -m pip install faster-whisper（音频/视频转写）')
add('openpyxl', 'python', true, probePyModule('openpyxl'), 'py -m pip install openpyxl（xlsx 读取）')
add('xlrd', 'python', false, probePyModule('xlrd'), 'py -m pip install xlrd（旧版 .xls 读取）')
add('python-pptx', 'python', true, probePyModule('pptx'), 'py -m pip install python-pptx（pptx 读取）')
add('mido', 'python', false, probePyModule('mido'), 'py -m pip install mido（MIDI 元数据）')
add('Pillow', 'python', false, probePyModule('PIL'), 'py -m pip install pillow')
add('pypdf', 'python', false, probePyModule('pypdf'), 'py -m pip install pypdf（PDF 文本提取）')
add('pillow-heif', 'python', false, probePyModule('pillow_heif'), 'py -m pip install pillow-heif（HEIC/HEIF 转 PNG 后识图）')
add('pyarrow', 'python', false, probePyModule('pyarrow'), 'py -m pip install pyarrow（parquet 读取）')
add('extract-msg', 'python', false, probePyModule('extract_msg'), 'py -m pip install extract-msg（Outlook .msg 读取）')

// ── 同目录脚本 ──
for (const f of ['route.mjs', 'sniff.py', 'extract.py', 'transcribe.py', 'unzip.py', 'batch.mjs', 'selftest.mjs']) {
  const p = new URL(`./${f}`, import.meta.url)
  const ok = existsSync(p)
  checks.push({ name: f, kind: 'script', required: true, ok, detail: ok ? '存在' : '缺失', ...(ok ? {} : { hint: '仓库文件不完整，请重新拉取' }) })
}

const missing = checks.filter((c) => c.required && !c.ok).map((c) => c.name)
const optionalMissing = checks.filter((c) => !c.required && !c.ok).map((c) => c.name)
const result = { ok: missing.length === 0, missing, optionalMissing, checks }

if (!jsonOnly) {
  const line = (c) => `  ${c.ok ? 'OK  ' : c.required ? 'MISS' : 'opt '} ${c.name.padEnd(16)} ${c.detail}${c.ok || !c.hint ? '' : '  → ' + c.hint}`
  console.log('file-intake 依赖自检')
  for (const kind of ['runtime', 'tool', 'python', 'script']) {
    console.log(`\n[${kind}]`)
    for (const c of checks.filter((x) => x.kind === kind)) console.log(line(c))
  }
  console.log(`\n结论: ${result.ok ? '必需项齐备' : '缺少必需项: ' + missing.join(', ')}` + (optionalMissing.length ? `（可选缺失: ${optionalMissing.join(', ')}）` : ''))
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
