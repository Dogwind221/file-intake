---
name: file-intake
description: >
  通用文件入口路由器：任何文件（拖入 DSH web 附件、给出本地路径或 URL）先识别类型，再路由到对应能力处理——
  图片→识图、视频→拆解/抽帧转写、音频→语音转文字、Word/PDF/PPT/Excel/EPUB/字幕/邮件（eml·msg）/数据库/PSD/parquet→文本提取、
  文本/RTF→直读、zip/rar/7z→解压递归。支持目录批量（batch.mjs，带汇总）、sha256 结果缓存、
  大文件分块（--chunk-chars / --chunk-minutes）。用户拖入或引用任意文件并期望「分析/读取/处理/拆解」时触发，
  不限于图片（图片有 dsh-vision-skill 专项，但本 skill 统一入口）。DSH 0.1.3 起非图片附件原生支持，
  模型直接拿到只读副本路径。入口命令：node scripts/route.mjs <文件>。
---

# 通用文件入口（file-intake）

> **路径约定（DSH 0.1.3+）**：本文档相对路径以**本技能资源目录**为基准解析（加载时 harness 给出 `Base directory for this skill`）；跨技能引用写 `..\<技能名>\...`（三个技能同根安装时成立）。

**一句话**：任何文件 → `route.mjs` 给结论 → 按结论执行对应脚本/skill。

## ⛔ 第一步永远是路由（不要凭扩展名猜）

```powershell
node scripts/route.mjs "<文件路径或URL>"
```

输出 JSON（统一交付契约，见下；退出码 0=已识别 / 2=未知或不支持 / 1=参数或读文件失败）：

```json
{ "ok": true, "source": "<绝对路径|URL>", "kind": "document", "type": "docx", "ext": "docx", "sniffed": "docx",
  "handler": "extract.py", "skill": "file-intake",
  "command": "py -X utf8 \"scripts/extract.py\" \"<文件>\"",
  "artifacts": [], "summary": "document（.docx） → extract.py",
  "notes": ["..."], "hints": ["..."] }
```

规则：

1. **先嗅探魔数，再看扩展名**——改名/无扩展名的文件也能正确路由（`--sniff` 只看嗅探结果）。
2. **只执行 `command` 字段**给出的命令；`hints` 里的补装/转换建议按需执行。
3. 命令失败或类型未知（退出码 2）时，再看 `references/route-table.md` 兜底。
4. `handler = refuse` → **安全边界**：`.exe/.dll/.msi/.bat/.cmd/.ps1/.sh/.com/.scr/.vbs/.js/.jar` 一律拒绝路由（`arg` 里也不放命令），只回一句「可执行/脚本文件不路由」，要分析二进制必须用户明确说明用途后另走工具。`needs-tool` / `needs-convert`（缺依赖或旧格式）→ 如实告知并给安装/转换命令，不要硬凑。
5. **只读副本**：附件副本不可写；要改（改 Word/改图/打补丁）先复制到工作目录再动，路由与提取都只读原文件。

## 统一交付契约（下游消费用）

所有脚本（`route.mjs` / `extract.py` / `transcribe.py` / `unzip.py` / `batch.mjs`）都输出同一套 JSON 外壳，下游 skill 只认这几个字段即可：

```json
{ "ok": true, "source": "<输入文件绝对路径|URL>", "type": "docx|audio|archive|batch|...",
  "handler": "extract.py", "artifacts": ["产物绝对路径..."], "summary": "一句话结论" }
```

其余字段是各脚本的细节（`text` / `meta` / `chunks` / `counts` / `results` / `notes` / `hints`）。

| 下游 | 吃什么 |
|---|---|
| img2img-studio | `artifacts[]` 里的图片路径（HEIC/PSD 已转出的 PNG）+ `summary` 里的尺寸信息 |
| video-deconstruct | `transcribe.py` 的 `text` / `meta.segments`（带时间轴）+ `summary` |
| dsh-vision-skill | 图片路径（`artifacts[]` 或原图）；`summary` 里已标明是否需要先转 PNG |
| 人/agent 汇报 | 直接念 `summary`，再按需展开 `results` / `meta` |

失败时字段一致：`{ "ok": false, "handler": "...", "artifacts": [], "summary": "CODE: 说明", "error": { "code", "message", "hint" } }`。

## 环境自检（首次使用/报错时跑一次）

```powershell
node scripts/doctor.mjs        # 必需项缺失会给出安装命令
```

## 触发

- 用户消息带**文件附件**：
  - **非图片文件**（PDF/Word/Excel/音频/视频/压缩包…）→ DSH 0.1.3+ **原生支持**：模型直接拿到 `[File "name" (N bytes, sha256:…): verbatim read-only copy saved at "<路径>"…]`，**那个路径就是最终路径，直接用**——**不要**去调 `resolve_attachment.mjs`，也不要再解析什么 id（多跑一步纯属浪费）
  - **图片** → image block（`attachmentId` 形如 `sha256:<hex>`，**没有现成路径**）→ 这一步才是 `..\dsh-vision-skill\scripts\resolve_attachment.mjs` 的唯一用途：图片专用分支，把 `attachmentId` 解析成磁盘路径（多模态模型也可以直接用 harness 的 `read_image` 吃该 id）
- 用户给出任意**本地路径 / URL**（文档、表格、音频、视频、压缩包…）
- 用户要求「读取/分析/拆解/处理这个文件」

> 判断顺序：**先看消息里有没有现成路径**（非图片附件一定有）→ 有就直接路由；**只有图片附件**才走 `resolve_attachment.mjs`。

## 工作流

1. **取路径**：非图片附件 → 用消息里的只读副本路径（**不调 resolve_attachment.mjs**）；图片附件 → `resolve_attachment.mjs`（图片专用分支）；本地路径/URL → 直接用。
2. **路由**：`node scripts/route.mjs "<路径>"`（目录会直接给出 `batch.mjs` 命令）。
3. **执行**：跑 `command`（`extract.py` 提取文本 / `transcribe.py` 转写 / `unzip.py` 解压 / `vision.js` 识图 / video-deconstruct 拆解）。
4. **递归/批量**：压缩包解压后对每个产物重新路由；文件多就直接上 `node scripts/batch.mjs <目录>`（自动递归 + 汇总）。
5. **交付**：念 `summary` + 产物 `artifacts[]`（下游按统一契约消费）；重复处理命中缓存会标 `cached: true`。

## 脚本清单

| 脚本 | 作用 | 典型命令 |
|---|---|---|
| `scripts/route.mjs` | 路由入口（魔数+扩展名 → kind/handler/command） | `node scripts/route.mjs <文件>` |
| `scripts/batch.mjs` | 目录/多文件/压缩包批量：路由+执行+汇总清单 | `node scripts/batch.mjs <目录> --out-dir <产物目录>` |
| `scripts/sniff.py` | 魔数嗅探独立 CLI（手动排查用） | `py -X utf8 scripts/sniff.py <文件>` |
| `scripts/doctor.mjs` | 依赖自检（工具 + Python 库 + 脚本完整性） | `node scripts/doctor.mjs` |
| `scripts/extract.py` | 文档/表格/演示/PDF/EPUB/字幕/邮件/SVG/SQLite/PSD/parquet/msg → JSON 文本 | `py -X utf8 scripts/extract.py <文件> [--max-chars N] [--chunk-chars N] [--out 文件]` |
| `scripts/transcribe.py` | 音频/视频转写（faster-whisper）、MIDI 元数据（mido） | `py -X utf8 scripts/transcribe.py <文件> [--model small] [--lang zh] [--chunk-minutes 10]` |
| `scripts/unzip.py` | 安全解压 zip/rar/7z（防路径穿越/zip 炸弹） | `py -X utf8 scripts/unzip.py <压缩包> [--out 目录] [--list]` |
| `scripts/selftest.mjs` | 自测：自动生成样例文件，跑通路由/提取/缓存/防护断言 | `node scripts/selftest.mjs` |

全部脚本统一交付契约（`source`/`type`/`handler`/`artifacts`/`summary`），失败时带 `error.code`（`NOT_FOUND` / `MISSING_DEP` / `UNSUPPORTED_TYPE` / `PARSE_ERROR` / `TOO_LARGE` / `TOO_MANY_ENTRIES` / `UNSAFE_ARCHIVE` …）与 `error.hint`。

### 自测（改脚本后跑一次）

```powershell
node scripts/selftest.mjs          # 临时目录自动造样例 → 断言路由/提取/缓存/防护，退出码非 0 即失败
node scripts/selftest.mjs --keep   # 保留临时目录便于排查
```

覆盖：路由结论（含魔数兜底、拒绝、目录）、`extract.py` 交付契约与文本内容、缓存命中、zip 路径穿越拒绝、条目数上限、`batch.mjs` 汇总。缺依赖的可选项（pillow-heif / pyarrow / extract-msg / Bandizip）自动跳过并在末尾列出 `skip`。

### 批量（`batch.mjs`）

输入可以是**目录、多个文件、压缩包**（压缩包先解压再递归）。它对每个文件路由 + 执行「本地可自动完成」的处理器（`extract.py` / `transcribe.py` / `unzip.py`），识图（耗额度）与视频拆解只给命令。输出 JSON 汇总：`counts` + 顶层 `artifacts[]` + `summary`，每个文件带 `status`（`ok` / `ok(cached)` / `failed` / `unsupported` / `needs-agent`）、`artifacts[]` 与自己的 `summary`。

```powershell
node scripts/batch.mjs F:\some\dir --out-dir F:\some\out          # 实跑
node scripts/batch.mjs F:\some\dir --dry-run                      # 只看计划
node scripts/batch.mjs F:\a.zip --include "\.(pdf|docx)$"          # 只处理匹配文件
```

退出码：0 = 全部成功；1 = 有失败；2 = 参数错误。

### 缓存与大文件

- **结果缓存**：`extract.py` / `transcribe.py` 按「文件 sha256 + 处理器 + 参数」缓存到 `~/.dsh/file-intake-cache`（可用 `FILE_INTAKE_CACHE` 改路径）。重复处理秒回，`cached: true`；`--no-cache` 跳过读、`--refresh` 强制重算。
- **文本分块**：`extract.py --chunk-chars 8000` → 输出 `chunks[]`，便于逐块交子代理后汇总（默认 `--max-chars 20000` 截断）。
- **长音频分段**：`transcribe.py --chunk-minutes 10`（默认）超过阈值时用 ffmpeg 分段转写，`meta.chunks[]` 给出每段时间范围；`--chunk-minutes 0` 强制整段。
- **压缩引擎**：rar/7z 走 **Bandizip `bz.exe`**（优先，PATH 或 `BANDIZIP` 环境变量），没有才退回 7-Zip（`SEVEN_ZIP`）。

## 快速路由速查（人读版，机器以 route.mjs 为准）

| 类型 | 交给谁 | 说明 |
|---|---|---|
| 图片 png/jpg/webp/gif | 原生 `read_image` 或 dsh-vision-skill | 多模态模型直接 `read_image`；纯文本模型走 `vision.js` |
| 图片 bmp/tiff/avif | dsh-vision-skill | 不在原生支持列表，走 `vision.js` |
| 图片 heic/heif | `extract.py` 转 PNG → 再识图 | 装了 pillow-heif 就地转 PNG（`artifacts` 给路径），没装则提示安装 |
| 文档 docx/rtf/html/ipynb | `extract.py` | 零依赖 XML/正则提取 |
| 表格 xlsx/xlsm | `extract.py`（openpyxl） | 每表前 20 行 + 维度 |
| 演示 pptx | `extract.py`（python-pptx） | 每页文本 + 备注 |
| PDF | `extract.py`（pypdf） | 损坏/加密会返回 `PARSE_ERROR` + hint，不抛栈 |
| EPUB | `extract.py` | 按 OPF spine 顺序拼章节，`meta.chapters`/`title` |
| 字幕 srt/vtt | `extract.py` | 去序号与时间轴，`meta.cues` |
| 邮件 eml | `extract.py` | 正文（text/plain + html）+ 收发件人/主题/附件名 |
| 邮件 msg（Outlook） | `extract.py`（extract-msg） | OLE 复合文档：主题/收发件人/日期/附件名/正文 |
| parquet | `extract.py`（pyarrow） | schema + 行列数 + 首批行（不全量载入） |
| PSD | `extract.py`（Pillow） | 导出合成图 PNG（`artifacts` 给路径）+ 图层数，再识图 |
| 矢量 svg | `extract.py` | 提取 `<text>/<tspan>` 文本节点与 title |
| 数据库 sqlite/db | `extract.py` | 表清单 + 行数 + 列名 + 前 5 行样本 |
| 旧版 xls | `extract.py`（xlrd） | BIFF 直接解析，**无需** LibreOffice |
| 旧版 doc/ppt | LibreOffice 转换 | 装 LibreOffice 后 `extract.py` 自动转换提取；未装时给安装提示 |
| pages/key/numbers | LibreOffice 转换 | 同上（→ docx/pptx/xlsx 后提取） |
| 音频 | `transcribe.py` | faster-whisper，中文 `--lang zh`，长音频自动分段 |
| MIDI | `transcribe.py` | mido 解析曲速/音轨/音符数 |
| 视频 | video-deconstruct | 抽帧 + 转写 + 拆解报告（只取文字可直接 `transcribe.py`） |
| zip / rar / 7z | `unzip.py` → 递归 | zip 走 zipfile，rar/7z 走 Bandizip；有大小/条目数/路径穿越防护 |
| exe/dll/bat/ps1 | 拒绝 | 安全边界 |
| 无扩展名/改名 | 嗅探决定 | 文本类直接 `read`；二进制按魔数路由（PDF/OOXML/HEIC… 都能认） |
| ai（Illustrator） | 看版本 | PDF 兼容版按魔数走 PDF 提取；纯 PostScript 版提示导出 PDF/PNG |
| indd/sketch | 暂不支持 | 返回 `no-parser` + 转换建议 |

详见 `references/route-table.md`（含各类型的额外说明与历史命令）。
