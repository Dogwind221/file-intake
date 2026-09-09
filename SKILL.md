---
name: file-intake
description: >
  通用文件入口路由器：任何文件（拖入 DSH web 附件、给出本地路径或 URL）先识别类型，再路由到对应能力处理——
  图片→识图、视频→拆解/抽帧转写、音频→语音转文字、Word/PDF/PPT/Excel→文本提取、
  文本/RTF→直读、ZIP→解压递归。用户拖入或引用任意文件并期望「分析/读取/处理/拆解」时触发，
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

输出 JSON（退出码 0=已识别 / 2=未知或不支持 / 1=参数或读文件失败）：

```json
{ "ok": true, "kind": "document", "ext": "docx", "sniffed": "docx",
  "handler": "extract.py", "skill": "file-intake",
  "command": "py -X utf8 \"scripts/extract.py\" \"<文件>\"",
  "notes": ["..."], "hints": ["..."] }
```

规则：

1. **先嗅探魔数，再看扩展名**——改名/无扩展名的文件也能正确路由（`--sniff` 只看嗅探结果）。
2. **只执行 `command` 字段**给出的命令；`hints` 里的补装/转换建议按需执行。
3. 命令失败或类型未知（退出码 2）时，再看 `references/route-table.md` 兜底。
4. `handler = refuse`（可执行文件）或 `needs-tool`/`needs-convert`（缺依赖/旧格式）→ 如实告知用户，不要硬凑。

## 环境自检（首次使用/报错时跑一次）

```powershell
node scripts/doctor.mjs        # 必需项缺失会给出安装命令
```

## 触发

- 用户消息带**文件附件**：
  - **非图片文件**（PDF/Word/Excel/音频/视频/压缩包…）→ DSH 0.1.3+ **原生支持**，模型直接收到 `[File "name" (N bytes, sha256:…): verbatim read-only copy saved at "<路径>"…]`，**路径可直接用**，无需解析
  - **图片** → image block（`attachmentId` 形如 `sha256:<hex>`），需用 `..\dsh-vision-skill\scripts\resolve_attachment.mjs` 解析磁盘路径
- 用户给出任意**本地路径 / URL**（文档、表格、音频、视频、压缩包…）
- 用户要求「读取/分析/拆解/处理这个文件」

> ⚠️ 附件副本是**只读**的：需要修改（改 Word/改图等）时先复制到工作目录再改；委派子代理时要把路径写进 prompt（只有同一执行环境的子代理能读到）。

## 工作流

1. **取路径**：非图片附件用消息里的只读副本路径；图片附件用 `resolve_attachment.mjs`；路径/URL 直接用。
2. **路由**：`node scripts/route.mjs "<路径>"`。
3. **执行**：跑 `command`（`extract.py` 提取文本 / `transcribe.py` 转写 / `unzip.py` 解压 / `vision.js` 识图 / video-deconstruct 拆解）。
4. **递归**：压缩包解压后，对每个产物重新跑 route.mjs。
5. **交付**：说明结果 + 用到的能力 + 产物路径（脚本都输出 JSON，含 `artifacts`）。

## 脚本清单

| 脚本 | 作用 | 典型命令 |
|---|---|---|
| `scripts/route.mjs` | 路由入口（魔数+扩展名 → kind/handler/command） | `node scripts/route.mjs <文件>` |
| `scripts/sniff.py` | 魔数嗅探独立 CLI（手动排查用） | `py -X utf8 scripts/sniff.py <文件>` |
| `scripts/doctor.mjs` | 依赖自检（工具 + Python 库 + 脚本完整性） | `node scripts/doctor.mjs` |
| `scripts/extract.py` | docx/xlsx/pptx/pdf/rtf/html/ipynb/csv/txt → JSON 文本 | `py -X utf8 scripts/extract.py <文件> [--max-chars N]` |
| `scripts/transcribe.py` | 音频/视频转写（faster-whisper）、MIDI 元数据（mido） | `py -X utf8 scripts/transcribe.py <文件> [--model small] [--lang zh]` |
| `scripts/unzip.py` | 安全解压 zip（防路径穿越/zip 炸弹） | `py -X utf8 scripts/unzip.py <zip> [--out 目录]` |

全部脚本统一输出 JSON，失败时带 `error.code`（`NOT_FOUND` / `MISSING_DEP` / `UNSUPPORTED_TYPE` / `PARSE_ERROR` / `TOO_LARGE` …）与 `error.hint`。

## 快速路由速查（人读版，机器以 route.mjs 为准）

| 类型 | 交给谁 | 说明 |
|---|---|---|
| 图片 png/jpg/webp/gif | 原生 `read_image` 或 dsh-vision-skill | 多模态模型直接 `read_image`；纯文本模型走 `vision.js` |
| 图片 bmp/tiff/avif | dsh-vision-skill | 不在原生支持列表，走 `vision.js` |
| 图片 heic/heif | 先转码 | 本机 ffmpeg 无 HEIF 解码器 → `pip install pillow-heif` 后用 `extract.py` 转 PNG |
| 文档 docx/rtf/html/ipynb | `extract.py` | 零依赖 XML/正则提取 |
| 表格 xlsx/xlsm | `extract.py`（openpyxl） | 每表前 20 行 + 维度 |
| 演示 pptx | `extract.py`（python-pptx） | 每页文本 + 备注 |
| PDF | `extract.py`（pypdf） | 未装 pypdf 时提示安装；扫描件需 OCR |
| 旧版 doc/xls/ppt | 需转换 | 另存为 docx/xlsx 或装 LibreOffice |
| 音频 | `transcribe.py` | faster-whisper，中文 `--lang zh` |
| MIDI | `transcribe.py` | mido 解析曲速/音轨/音符数 |
| 视频 | video-deconstruct | 抽帧 + 转写 + 拆解报告（只取文字可直接 `transcribe.py`） |
| zip | `unzip.py` → 递归 | 有大小/条目数/路径穿越防护 |
| rar/7z | 需 7-Zip | `winget install 7zip.7zip` |
| sqlite/db | pwsh + sqlite3 | 先列表再查询 |
| exe/dll/bat/ps1 | 拒绝 | 安全边界 |
| 无扩展名/改名 | 嗅探决定 | 文本类直接 `read`，二进制按嗅探结果路由 |

详见 `references/route-table.md`（含各类型的额外说明与历史命令）。
