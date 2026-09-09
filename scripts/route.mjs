#!/usr/bin/env node
/**
 * file-intake 路由表（可执行版）。
 *
 * 用法:
 *   node scripts/route.mjs <文件路径|URL> [--json] [--sniff]
 *
 * 输出（stdout，永远 JSON）:
 *   { ok, input, kind, ext, sniffed, handler, skill, command, notes[], hints[] }
 *
 * 退出码: 0 = 已识别；2 = 未知/不支持（仍输出 JSON）；1 = 参数或读文件错误。
 *
 * 设计要点:
 *  - 先看魔数（内容），扩展名只作辅助——改名/无扩展名的文件也能正确路由；
 *  - 只输出「路由结论 + 可直接复制执行的命令」，不内联复杂命令（命令实现都在 scripts/ 下）；
 *  - 与 dsh-vision-skill / video-deconstruct / pdf / docx 等技能解耦：只给路径，不重复造轮子。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(__dirname, '..')
const PY = 'py -X utf8'

/* ================= 魔数嗅探 ================= */

/** 读取文件头若干字节（默认 512）。 */
function head(file, size = 512) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size)
    const n = fs.readSync(fd, buf, 0, size, 0)
    return buf.subarray(0, n)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

const ascii = (buf, offset, len) => buf.subarray(offset, offset + len).toString('latin1')
const hex = (buf, offset, len) => buf.subarray(offset, offset + len).toString('hex')

/**
 * 按文件头判定真实类型。
 * @param {Buffer|null} buf - 文件头字节。
 * @returns {string|null} 类型 id（与扩展名同域），无法判定返回 null。
 */
function sniff(buf) {
  if (!buf || buf.length < 4) return null
  const b = buf
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf'
  if (hex(b, 0, 4) === '504b0304') {
    // ZIP 家族：OOXML 靠条目名区分
    const raw = b.toString('latin1')
    if (raw.includes('word/document.xml')) return 'docx'
    if (raw.includes('xl/workbook.xml')) return 'xlsx'
    if (raw.includes('ppt/presentation.xml')) return 'pptx'
    if (raw.includes('mimetype') && raw.includes('epub')) return 'epub'
    return 'zip'
  }
  if (hex(b, 0, 3) === 'ffd8ff') return 'jpg'
  if (hex(b, 0, 8) === '89504e470d0a1a0a') return 'png'
  if (ascii(b, 0, 4) === 'GIF8') return 'gif'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return 'avi'
  if (ascii(b, 0, 2) === 'BM') return 'bmp'
  if (hex(b, 0, 4) === '49492a00' || hex(b, 0, 4) === '4d4d002a') return 'tiff'
  if (ascii(b, 0, 4) === 'fLaC') return 'flac'
  if (ascii(b, 0, 4) === 'OggS') return 'ogg'
  if (ascii(b, 0, 4) === 'MThd') return 'midi'
  if (ascii(b, 0, 3) === 'ID3') return 'mp3'
  if (hex(b, 0, 2) === 'fffb' || hex(b, 0, 2) === 'fff3' || hex(b, 0, 2) === 'fff2') return 'mp3'
  // ISO-BMFF（mp4/mov/m4a/heic/avif）：ftyp box 在偏移 4
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (brand.startsWith('qt')) return 'mov'
    if (brand === 'M4A ') return 'm4a'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'heic'
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (brand === '3gp4' || brand === '3gp5') return '3gp'
    return 'mp4'
  }
  if (hex(b, 0, 4) === '1a45dfa3') return 'mkv'
  if (ascii(b, 0, 5) === '{\\rtf') return 'rtf'
  if (ascii(b, 0, 15) === 'SQLite format 3') return 'sqlite'
  if (ascii(b, 0, 4) === 'Rar!') return 'rar'
  if (hex(b, 0, 6) === '377abcaf271c') return '7z'
  if (ascii(b, 0, 2) === 'MZ') return 'exe'
  if (hex(b, 0, 4) === '7f454c46') return 'elf'
  if (hex(b, 0, 4) === 'd0cf11e0') return 'ole' // 旧 Office（doc/xls/ppt 二进制）
  return null
}

/* ================= 路由表 ================= */

/** 图片（走识图）：原生 read_image 只认 png/jpeg/webp/gif。 */
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'avif'])
/** 需要先转码才能识图。 */
const IMAGE_NEEDS_CONVERT = new Set(['heic', 'heif'])
/** 文档/表格/演示 → extract.py。 */
const EXTRACT = new Set(['docx', 'xlsx', 'xlsm', 'pptx', 'rtf', 'html', 'htm', 'ipynb', 'csv', 'tsv', 'txt', 'md', 'json', 'yaml', 'yml', 'log', 'xml'])
/** 音频 → transcribe.py。 */
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus', 'wma', 'aiff'])
/** 视频 → video-deconstruct。 */
const VIDEO = new Set(['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'mpg', 'mpeg', 'ts'])
/** 可执行/脚本：拒绝路由。 */
const EXECUTABLE = new Set(['exe', 'dll', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'com', 'scr', 'vbs', 'js', 'jar'])
/** 旧 Office 二进制（.doc/.xls/.ppt）。 */
const OLE = new Set(['doc', 'xls', 'ppt'])

const rel = (p) => `"${path.relative(SKILL_DIR, p).replace(/\\/g, '/')}"`

/**
 * 生成路由结论。
 * @param {string} input - 用户给的路径或 URL。
 * @param {object} opts - 选项。
 * @returns {object} 路由结果。
 */
function route(input, opts = {}) {
  const isUrl = /^https?:\/\//i.test(input)
  const notes = []
  const hints = []

  if (isUrl) {
    const host = (() => { try { return new URL(input).hostname } catch { return '' } })()
    const social = /(douyin|xiaohongshu|xhslink|bilibili|b23|youtube|youtu\.be)/i.test(host)
    const imageUrl = /\.(png|jpe?g|webp|gif|bmp|tiff|avif)(\?|$)/i.test(input)
    if (imageUrl) {
      return finish({ ok: true, input, kind: 'image-url', ext: '', sniffed: null, handler: 'vision.js', skill: 'dsh-vision-skill', command: `node "..\\dsh-vision-skill\\scripts\\vision.js" --url "${input}" "<问题>"`, notes })
    }
    if (social) {
      return finish({ ok: true, input, kind: 'video-url', ext: '', sniffed: null, handler: 'video-deconstruct', skill: 'video-deconstruct', command: `<按 video-deconstruct 工作流：yt-dlp/API 获取 → 字幕/ASR → 拆解报告>`, notes: [...notes, '链接类视频默认按「拆解」处理'] })
    }
    return finish({ ok: true, input, kind: 'url', ext: '', sniffed: null, handler: 'web-fetch', skill: 'web', command: `<用 web_fetch 工具抓取；若是图片用 vision.js --url>`, notes })
  }

  const file = path.resolve(input)
  if (!fs.existsSync(file)) return finish({ ok: false, input, error: { code: 'NOT_FOUND', message: `文件不存在: ${file}` } })
  const stat = fs.statSync(file)
  if (stat.isDirectory()) {
    return finish({
      ok: true, input: file, kind: 'directory', ext: '', sniffed: null, handler: 'batch', skill: 'file-intake',
      command: `# 目录：对其中每个文件依次执行 node scripts/route.mjs <file>`,
      notes: ['目录不递归解压，逐个文件路由'],
    })
  }

  const ext = (path.extname(file).slice(1) || '').toLowerCase()
  const buf = head(file)
  const sniffed = sniff(buf)
  const eff = sniffed ?? ext

  if (EXECUTABLE.has(eff)) {
    return finish({ ok: false, input: file, kind: 'executable', ext, sniffed, handler: 'refuse', skill: null, command: null, notes: ['可执行/脚本文件不路由（安全边界）'], hints: ['如需分析二进制，请明确说明用途后用 pwsh/反汇编工具单独处理'] })
  }

  if (IMAGE.has(eff)) {
    const native = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
    const notes2 = [...notes]
    if (native.has(eff)) notes2.push('原生 read_image 也支持该格式：多模态模型直接 read_image，不要走脚本')
    else notes2.push(`${eff.toUpperCase()} 不在原生 read_image 支持列表（png/jpeg/webp/gif），需走 vision.js`)
    return finish({
      ok: true, input: file, kind: 'image', ext, sniffed, handler: 'vision.js', skill: 'dsh-vision-skill',
      command: `node "..\\dsh-vision-skill\\scripts\\vision.js" "${file}" "<问题>"`,
      notes: notes2,
      hints: ['多模态会话直接 read_image；纯文本会话才用本命令', '需要结构化字段时加 --schema img2img|ecom|ground'],
    })
  }

  if (IMAGE_NEEDS_CONVERT.has(eff)) {
    return finish({
      ok: false, input: file, kind: 'image-needs-convert', ext, sniffed, handler: 'convert', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
      notes: ['本机 ffmpeg 不含 HEIF 解码器，HEIC/HEIF 必须先转码'],
      hints: ['py -m pip install pillow-heif  （装好后 extract.py 会自动转 PNG 再识图）', '或：用系统「照片」/预览导出为 PNG 后重跑 route.mjs'],
    })
  }

  if (EXTRACT.has(eff)) {
    return finish({
      ok: true, input: file, kind: 'document', ext, sniffed, handler: 'extract.py', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
      notes: ['纯文本类（txt/md/json/csv/log）原生 read 工具也可直读；本脚本用于统一结构化输出'],
    })
  }

  if (eff === 'pdf') {
    return finish({
      ok: true, input: file, kind: 'pdf', ext, sniffed, handler: 'extract.py(pypdf)', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
      notes: ['PDF 文本层提取依赖 pypdf；扫描件需 OCR'],
      hints: ['若未装：py -m pip install pypdf', '复杂 PDF（表格/表单/合并）可转 pdf skill'],
    })
  }

  if (OLE.has(eff) || eff === 'ole') {
    return finish({
      ok: false, input: file, kind: 'legacy-office', ext, sniffed, handler: 'needs-convert', skill: null, command: null,
      notes: ['旧版二进制 Office 格式（doc/xls/ppt）无本地解析器'],
      hints: ['用 Word/Excel 另存为 docx/xlsx 后重跑', '或安装 LibreOffice 后用 soffice --convert-to docx'],
    })
  }

  if (eff === 'midi') {
    return finish({
      ok: true, input: file, kind: 'midi', ext, sniffed, handler: 'transcribe.py(mido)', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'transcribe.py'))} "${file}"`,
      notes: ['MIDI 只解析曲速/音轨/音符元数据，不做语音转写'],
    })
  }

  if (AUDIO.has(eff)) {
    return finish({
      ok: true, input: file, kind: 'audio', ext, sniffed, handler: 'transcribe.py', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'transcribe.py'))} "${file}"`,
      notes: ['首次运行会下载 whisper 模型（需网络/代理）'],
      hints: ['长音频用 --model small --lang zh 控制速度与准确率'],
    })
  }

  if (VIDEO.has(eff)) {
    return finish({
      ok: true, input: file, kind: 'video', ext, sniffed, handler: 'video-deconstruct', skill: 'video-deconstruct',
      command: `# 按 video-deconstruct 工作流：ffmpeg 抽帧 + transcribe.py 转写 + 拆解报告\n${PY} ${rel(path.join(__dirname, 'transcribe.py'))} "${file}"`,
      notes: ['视频默认按「拆解」处理；只要文字可直接跑 transcribe.py'],
    })
  }

  if (eff === 'zip') {
    return finish({
      ok: true, input: file, kind: 'archive', ext, sniffed, handler: 'unzip.py', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'unzip.py'))} "${file}"`,
      notes: ['解压后对每个文件重新跑 route.mjs（递归路由）'],
      hints: ['有大小/条目数上限保护，超限会拒绝'],
    })
  }

  if (eff === 'rar' || eff === '7z') {
    return finish({
      ok: false, input: file, kind: 'archive', ext, sniffed, handler: 'needs-tool', skill: null, command: null,
      notes: ['本机未检测到 7-Zip / WinRAR'],
      hints: ['winget install 7zip.7zip', '或先手动解压再用 file-intake 处理解压后的文件'],
    })
  }

  if (eff === 'sqlite' || eff === 'db') {
    return finish({
      ok: true, input: file, kind: 'database', ext, sniffed, handler: 'pwsh', skill: null,
      command: `${PY} -c "import sqlite3,sys; c=sqlite3.connect(r'${file}'); print([r[0] for r in c.execute(\\"select name from sqlite_master where type='table'\\")])"`,
      notes: ['SQLite：先用上面的命令列出表，再按需查询'],
    })
  }

  // 无扩展名 / 未知：若是文本，直接读；否则报告未知
  const isText = buf !== null && !buf.includes(0) && /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(buf.toString('utf8'))
  if (isText) {
    return finish({
      ok: true, input: file, kind: 'text', ext, sniffed, handler: 'read', skill: null,
      command: `<用 read 工具直接读取（文本文件，无扩展名或未知扩展名）>`,
      notes: [`嗅探结果: ${sniffed ?? '文本'}；扩展名: ${ext || '(无)'}`],
    })
  }

  return finish({
    ok: false, input: file, kind: 'unknown', ext, sniffed, handler: 'unknown', skill: null, command: null,
    notes: [`魔数: ${buf ? hex(buf, 0, 8) : '(读不到)'}；扩展名: ${ext || '(无)'}`],
    hints: ['可在 route-table.md 的「未知/其他」分支处理，或告知用户暂不支持'],
  })
}

function finish(payload) {
  return {
    ok: payload.ok !== false,
    input: payload.input,
    kind: payload.kind ?? 'unknown',
    ext: payload.ext ?? '',
    sniffed: payload.sniffed ?? null,
    handler: payload.handler ?? null,
    skill: payload.skill ?? null,
    command: payload.command ?? null,
    notes: payload.notes ?? [],
    hints: payload.hints ?? [],
    ...(payload.error ? { error: payload.error } : {}),
  }
}

/* ================= CLI ================= */

const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const sniffOnly = argv.includes('--sniff')
const input = argv.find((a) => !a.startsWith('--'))

if (!input) {
  console.error('用法: node scripts/route.mjs <文件路径|URL> [--json] [--sniff]')
  process.exit(1)
}

if (sniffOnly) {
  const file = path.resolve(input)
  const buf = fs.existsSync(file) && fs.statSync(file).isFile() ? head(file) : null
  console.log(JSON.stringify({ input: file, sniffed: sniff(buf), head: buf ? hex(buf, 0, 12) : null }, null, 2))
  process.exit(buf ? 0 : 1)
}

const result = route(input)
if (jsonOnly || true) console.log(JSON.stringify(result, null, 2))
if (result.error) process.exit(1)
process.exit(result.ok ? 0 : 2)
