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
import { existsSync } from 'node:fs'

const jsonOnly = process.argv.includes('--json')

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
add('7-Zip', 'tool', false, probe('7z'), 'winget install 7zip.7zip（rar/7z 解压需要）')
add('LibreOffice', 'tool', false, probe('soffice', ['--version']), 'winget install TheDocumentFoundation.LibreOffice（旧版 doc/xls/ppt 转换需要）')

// ── Python 库 ──
add('faster-whisper', 'python', true, probePyModule('faster_whisper'), 'py -m pip install faster-whisper（音频/视频转写）')
add('openpyxl', 'python', true, probePyModule('openpyxl'), 'py -m pip install openpyxl（xlsx 读取）')
add('python-pptx', 'python', true, probePyModule('pptx'), 'py -m pip install python-pptx（pptx 读取）')
add('mido', 'python', false, probePyModule('mido'), 'py -m pip install mido（MIDI 元数据）')
add('Pillow', 'python', false, probePyModule('PIL'), 'py -m pip install pillow')
add('pypdf', 'python', false, probePyModule('pypdf'), 'py -m pip install pypdf（PDF 文本提取）')
add('pillow-heif', 'python', false, probePyModule('pillow_heif'), 'py -m pip install pillow-heif（HEIC/HEIF 转 PNG 后识图）')

// ── 同目录脚本 ──
for (const f of ['route.mjs', 'sniff.py', 'extract.py', 'transcribe.py', 'unzip.py']) {
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
