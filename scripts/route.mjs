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
import { spawnSync } from 'node:child_process'
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

/** 读取文件尾若干字节（默认 64KB）：zip 家族靠「中央目录」里的条目名判定最可靠。 */
function tail(file, size = 65536) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const len = Math.min(size, stat.size)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, stat.size - len)
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
 * @param {Buffer|null} tailBuf - 文件尾字节（zip 家族判定用，可省略）。
 * @returns {string|null} 类型 id（与扩展名同域），无法判定返回 null。
 */
function sniff(buf, tailBuf = null) {
  if (!buf || buf.length < 4) return null
  const b = buf
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf'
  if (hex(b, 0, 4) === '504b0304') {
    // ZIP 家族：条目名在「文件头局部区」和「尾部中央目录」两处，两处都查
    const raw = (b.toString('latin1') + (tailBuf ? '\u0000' + tailBuf.toString('latin1') : ''))
    if (raw.includes('word/document.xml')) return 'docx'
    if (raw.includes('xl/workbook.xml') || raw.includes('xl/workbook.bin')) return 'xlsx'
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
/** 文档/表格/演示/文本 → extract.py。 */
const EXTRACT = new Set([
  'docx', 'xlsx', 'xlsm', 'pptx', 'rtf', 'html', 'htm', 'ipynb', 'csv', 'tsv',
  'txt', 'md', 'json', 'yaml', 'yml', 'log', 'xml',
  'epub', 'srt', 'vtt', 'eml', 'svg', 'sqlite', 'db', 'msg', 'parquet',
  'pages', 'key', 'numbers',
])
/** 音频 → transcribe.py。 */
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus', 'wma', 'aiff'])
/** 视频 → video-deconstruct。 */
const VIDEO = new Set(['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'mpg', 'mpeg', 'ts'])
/** 可执行/脚本：拒绝路由。 */
const EXECUTABLE = new Set(['exe', 'dll', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'com', 'scr', 'vbs', 'js', 'jar'])
/** 旧 Office 二进制（.doc/.xls/.ppt）：LibreOffice 可转换。 */
const OLE = new Set(['doc', 'xls', 'ppt'])
/** 无本地解析器，只能提示。 */
const NO_PARSER = new Set(['ai', 'indd', 'sketch'])
/** zip 容器但语义是文档：扩展名优先于魔数。 */
const ZIP_FAMILY = new Set(['docx', 'xlsx', 'xlsm', 'pptx', 'epub'])
/** OLE 复合文档：扩展名决定语义（doc/xls/ppt/msg）。 */
const OLE_FAMILY = new Set(['doc', 'xls', 'ppt', 'msg'])

/** 查找压缩引擎：优先 Bandizip(bz.exe)，其次 7-Zip。 */
function findArchiver() {
  const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  const envBz = process.env.BANDIZIP
  if (envBz && isFile(envBz)) return { engine: 'bandizip', exe: envBz }
  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === 'win32' ? 'bz.exe' : 'bz'))
    .find(isFile)
  if (fromPath) return { engine: 'bandizip', exe: fromPath }
  for (const cand of ['D:\\DD\\bandi\\Bandizip\\bz.exe', 'C:\\Program Files\\Bandizip\\bz.exe', 'C:\\Program Files (x86)\\Bandizip\\bz.exe', '/usr/bin/bz']) {
    if (isFile(cand)) return { engine: 'bandizip', exe: cand }
  }
  const env7z = process.env.SEVEN_ZIP
  if (env7z && isFile(env7z)) return { engine: '7z', exe: env7z }
  for (const cand of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe', '/usr/bin/7z', '/usr/bin/7za']) {
    if (isFile(cand)) return { engine: '7z', exe: cand }
  }
  return null
}

/** 查找 LibreOffice（用于旧格式 / pages/key/numbers 转换）。 */
function findSoffice() {
  const env = process.env.SOFFICE_BIN
  if (env && fs.existsSync(env)) return env
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

/** Python 模块是否可导入（结果缓存，避免重复探测）。 */
const _pyMod = new Map()
function pyModule(mod) {
  if (_pyMod.has(mod)) return _pyMod.get(mod)
  let ok = false
  try {
    ok = spawnSync('py', ['-X', 'utf8', '-c', `import ${mod}`], { timeout: 20000, stdio: 'ignore' }).status === 0
  } catch {
    ok = false
  }
  _pyMod.set(mod, ok)
  return ok
}

/** pillow-heif 是否可用（HEIC/HEIF 能否自动转 PNG）。 */
function hasPillowHeif() {
  return pyModule('PIL') && pyModule('pillow_heif')
}

const rel = (p) => `"${path.relative(SKILL_DIR, p).replace(/\\/g, '/')}"`

/** 各类型路由备注。 */
function excNotes(eff) {
  const map = {
    msg: ['Outlook .msg：extract.py 用 extract-msg 读主题/收发件人/日期/附件名/正文'],
    parquet: ['parquet：extract.py 用 pyarrow 读 schema + 首批行（不全量载入）'],
    epub: ['EPUB：按 OPF spine 顺序拼章节，meta.chapters 给章节数'],
    srt: ['字幕：去序号与时间轴，meta.cues 给条数'],
    vtt: ['字幕：去 WEBVTT 头与时间轴，meta.cues 给条数'],
    eml: ['邮件：正文（text/plain + html）+ 收发件人/主题/附件名'],
    svg: ['SVG：提取 <text>/<tspan> 文本节点；要看图形先转 PNG 再识图'],
    sqlite: ['SQLite：只读打开，表清单 + 行数 + 列名 + 前 5 行样本'],
    db: ['SQLite：只读打开，表清单 + 行数 + 列名 + 前 5 行样本'],
  }
  if (map[eff]) return map[eff]
  return ['纯文本类（txt/md/json/csv/log/xml）原生 read 工具也可直读；本脚本用于统一结构化输出']
}

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
      ok: true, input: file, kind: 'directory', ext: '', sniffed: null, handler: 'batch.mjs', skill: 'file-intake',
      command: `node "scripts/batch.mjs" "${file}"`,
      notes: ['目录：批处理会对其中每个文件路由 + 执行本地处理器，并输出成功/失败/产物清单'],
      hints: ['加 --dry-run 只看计划不执行；加 --out-dir 指定产物目录'],
    })
  }

  const ext = (path.extname(file).slice(1) || '').toLowerCase()
  const buf = head(file)
  const sniffed = sniff(buf, tail(file))
  let eff = sniffed ?? ext
  // zip 容器 + OOXML/epub 扩展名：以扩展名为准（中央目录条目名偶尔判定不出）
  if (sniffed === 'zip' && ZIP_FAMILY.has(ext)) eff = ext
  // OLE 复合文档：doc/xls/ppt/msg 都是 d0cf11e0 开头，语义靠扩展名
  if (sniffed === 'ole' && OLE_FAMILY.has(ext)) eff = ext

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
    if (hasPillowHeif()) {
      return finish({
        ok: true, input: file, kind: 'image', ext, sniffed, handler: 'extract.py(heic→png)', skill: 'file-intake',
        command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
        notes: ['HEIC/HEIF：extract.py 用 Pillow + pillow-heif 转成 PNG（artifacts 给出路径）', '转出的 PNG 再交给识图：node "..\\dsh-vision-skill\\scripts\\vision.js" <png> "<问题>"'],
        hints: ['多模态会话可 read_image 该 PNG；纯文本会话用 vision.js'],
      })
    }
    return finish({
      ok: false, input: file, kind: 'image-needs-convert', ext, sniffed, handler: 'convert', skill: 'file-intake',
      command: null,
      notes: ['本机 ffmpeg 不含 HEIF 解码器，且未装 pillow-heif，HEIC/HEIF 无法自动转码'],
      hints: ['py -m pip install pillow-heif  （装好后 route.mjs 会自动改判为可处理）', '或：用系统「照片」/预览导出为 PNG 后重跑 route.mjs'],
    })
  }

  if (EXTRACT.has(eff)) {
    return finish({
      ok: true, input: file, kind: 'document', ext, sniffed, handler: 'extract.py', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
      notes: excNotes(eff),
    })
  }

  if (eff === 'psd') {
    if (pyModule('PIL')) {
      return finish({
        ok: true, input: file, kind: 'image', ext, sniffed, handler: 'extract.py(psd→png)', skill: 'file-intake',
        command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
        notes: ['PSD：extract.py 用 Pillow 导出合成图 PNG（artifacts 给路径）+ 图层数元数据', '导出的 PNG 再交给识图：node "..\\dsh-vision-skill\\scripts\\vision.js" <png> "<问题>"'],
        hints: ['只看最终效果图就够用；要单个图层请在 Photoshop 里导出'],
      })
    }
    return finish({
      ok: false, input: file, kind: 'no-parser', ext, sniffed, handler: 'needs-tool', skill: null, command: null,
      notes: ['缺少 Pillow，无法导出 PSD 合成图'],
      hints: ['py -m pip install pillow', '或在 Photoshop/预览里导出 PNG 后重跑'],
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
    const soffice = findSoffice()
    if (eff === 'xls' && pyModule('xlrd')) {
      return finish({
        ok: true, input: file, kind: 'spreadsheet', ext, sniffed, handler: 'extract.py(xlrd)', skill: 'file-intake',
        command: `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"`,
        notes: ['旧版 .xls（BIFF）：xlrd 直接解析，无需 LibreOffice', '每表前 20 行 + 行列数，meta.sheets'],
        hints: ['需要公式/图表等高级内容时，用 WPS/Excel 另存为 xlsx 后重跑'],
      })
    }
    return finish({
      ok: Boolean(soffice), input: file, kind: 'legacy-office', ext, sniffed,
      handler: soffice ? 'extract.py(convert)' : 'needs-tool', skill: 'file-intake',
      command: soffice ? `${PY} ${rel(path.join(__dirname, 'extract.py'))} "${file}"` : null,
      notes: [soffice ? '旧版 Office：extract.py 会用 LibreOffice 转成 docx/pptx 后提取' : '旧版二进制格式（doc/ppt）需要 LibreOffice 转换'],
      hints: soffice ? [] : ['winget install TheDocumentFoundation.LibreOffice', '或用 WPS/Office 另存为 docx/pptx 后重跑'],
    })
  }

  if (NO_PARSER.has(eff)) {
    return finish({
      ok: false, input: file, kind: 'no-parser', ext, sniffed, handler: 'unsupported', skill: null, command: null,
      notes: [`本机没有 .${eff} 的解析器`],
      hints: eff === 'ai'
        ? ['PDF 兼容的 .ai（多数新版）会被魔数识别为 pdf 直接提取；纯 PostScript 版请在 Illustrator 里导出 PDF/PNG']
        : [`如需处理 .${eff}，请先转成通用格式（png/pdf/csv）`],
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

  if (eff === 'zip' || eff === 'rar' || eff === '7z') {
    const archiver = findArchiver()
    const needExt = eff !== 'zip'
    if (needExt && !archiver) {
      return finish({
        ok: false, input: file, kind: 'archive', ext, sniffed, handler: 'needs-tool', skill: null, command: null,
        notes: ['未检测到 Bandizip(bz.exe) 或 7-Zip（rar/7z 需要其一）'],
        hints: ['装 Bandizip 后 bz.exe 在 PATH 上即可', '或设置 BANDIZIP / SEVEN_ZIP 指向可执行文件'],
      })
    }
    return finish({
      ok: true, input: file, kind: 'archive', ext, sniffed, handler: 'unzip.py', skill: 'file-intake',
      command: `${PY} ${rel(path.join(__dirname, 'unzip.py'))} "${file}"`,
      notes: [
        needExt ? `rar/7z 走 ${archiver.engine}（${archiver.exe}）` : 'zip 走 Python zipfile（无需外部工具）',
        '解压后对每个文件重新跑 route.mjs（或用 batch.mjs 自动递归）',
      ],
      hints: ['有条目数/解压体积/路径穿越防护，超限会拒绝', '批量递归：node scripts/batch.mjs "<压缩包>"'],
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
  const tailBuf = buf ? tail(file) : null
  console.log(JSON.stringify({ input: file, sniffed: sniff(buf, tailBuf), head: buf ? hex(buf, 0, 12) : null }, null, 2))
  process.exit(buf ? 0 : 1)
}

const result = route(input)
if (jsonOnly || true) console.log(JSON.stringify(result, null, 2))
if (result.error) process.exit(1)
process.exit(result.ok ? 0 : 2)
