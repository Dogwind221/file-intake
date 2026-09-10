# file-intake 路由表（人读版）

> ⚠️ **机器以 `scripts/route.mjs` 为准**（先嗅探魔数、再看扩展名，直接给出可执行命令）。
> 本文件只保留各类型的补充说明；两边不一致时以 `route.mjs` 为准。
> 依赖缺失请先跑 `node scripts/doctor.mjs`。
> **这里不再内联长命令**——全部实现都在 `scripts/` 下，避免文档与代码漂移。

**优先复用已有 skill/工具，不重复造轮子**。

## 总原则

1. `node scripts/route.mjs "<文件|URL|目录>"` → 按 `handler` 办事；
2. 目录/多文件/压缩包 → `node scripts/batch.mjs <路径>`（自动递归 + 汇总）；
3. 文本太大 → `extract.py --chunk-chars`；音视频太长 → `transcribe.py --chunk-minutes`；
4. 重复处理命中 `~/.dsh/file-intake-cache`（sha256 键）会直接标 `cached: true`。

## 图片（→ dsh-vision-skill）

| 扩展名 | 处理 |
|---|---|
| jpg jpeg png webp gif | 多模态模型直接 `read_image`（原生支持）；纯文本模型走 `node "..\dsh-vision-skill\scripts\vision.js" "<路径>" [--schema img2img\|ecom\|ground]` |
| bmp tiff avif | 原生 `read_image` 不支持 → 走 `vision.js` |
| heic heif | `extract.py` 用 Pillow + pillow-heif 转 PNG（`artifacts` 给路径）→ 再识图；未装 pillow-heif 时 route.mjs 报 `image-needs-convert` 并给安装命令 |
| 生图需求 | 转 img2img-studio（图生图工作流） |

## 视频（→ video-deconstruct，默认拆解）

| 扩展名 | 处理 |
|---|---|
| mp4 avi mkv mov webm flv wmv m4v 3gp | 按 video-deconstruct 工作流：抽帧（ffmpeg）+ 转写（`transcribe.py`）+ 拆解报告 |
| 链接（抖音/小红书/B站/YouTube） | 按 video-deconstruct：yt-dlp/API 获取 → 字幕/ASR → 拆解报告 |

只要文字（不要拆解）时直接 `py -X utf8 scripts/transcribe.py "<视频>"`（内部用 ffmpeg 抽音轨）。

## 音频（→ faster-whisper 转写）

| 扩展名 | 处理 |
|---|---|
| mp3 wav m4a flac ogg aac opus wma aiff | `transcribe.py`（faster-whisper，中文 `--lang zh`，长音频自动分段） |
| midi | `transcribe.py` 走 mido 分支：曲速/音轨/音符数（不做语音转写） |

首次跑会下载 whisper 模型（必要时设 `HTTPS_PROXY`）；无语音（纯音乐/静音）时返回空文本 + `note` 说明，不是失败。

## 文档

| 扩展名 | 处理 |
|---|---|
| docx | `extract.py`：零依赖解析 `word/document.xml` |
| doc（旧二进制） | `extract.py` 用 LibreOffice 转 docx 后提取；没装 soffice 时 route.mjs 给 `needs-tool` + 安装命令（或用 WPS/Office 另存为 docx） |
| pdf | `extract.py`（pypdf）：按页输出，`meta.pages`；损坏/加密返回 `PARSE_ERROR` + hint（不抛栈）。扫描件需 OCR，复杂操作转 pdf skill |
| pptx | `extract.py`（python-pptx）：每页文本 + 备注 |
| ppt（旧格式） | 同 doc，走 LibreOffice 转换 |
| epub | `extract.py`：按 OPF spine 顺序拼章节，`meta.chapters/title` |
| srt vtt | `extract.py`：去序号与时间轴，`meta.cues` |
| eml | `extract.py`：正文（text/plain + html）+ 收发件人/主题/日期/附件名 |
| msg（Outlook） | `extract.py`（extract-msg）：OLE 复合文档 → 主题/收发件人/日期/附件名/正文；未装库时 `MISSING_DEP` + 安装命令 |
| svg | `extract.py`：提取 `<text>/<tspan>` 与 title（矢量图内容需渲染时先转 PNG） |
| psd | `extract.py`（Pillow）：导出合成图 PNG（`artifacts` 给路径）+ 尺寸/模式/图层数，再走识图 |
| html htm | `extract.py`：去脚本/样式后取正文 |
| ipynb rtf | `extract.py` |
| txt md json yaml xml log csv tsv | `extract.py` 统一结构化输出；也可用 `read` 工具直读 |
| pages key numbers | 走 LibreOffice 转换（→ docx/pptx/xlsx）后提取 |
| ai（Illustrator） | PDF 兼容版会被魔数识别为 pdf 直接提取；纯 PostScript 版提示导出 PDF/PNG |

## 表格

| 扩展名 | 处理 |
|---|---|
| xlsx xlsm | `extract.py`（openpyxl）：每表前 20 行 + 维度，`meta.sheets` |
| xls（旧格式） | `extract.py`（xlrd）：BIFF 直接解析，**无需** LibreOffice |
| csv tsv | `extract.py`：嗅探分隔符 + 前 50 行预览 |
| parquet | `extract.py`（pyarrow）：行列数 + row group 数 + 列类型 + 首批行（不全量载入） |

## 数据库

| 扩展名 | 处理 |
|---|---|
| sqlite db | `extract.py`：只读打开（`mode=ro`），表清单 + 行数 + 列名 + 前 5 行样本 |

## 压缩包（→ 递归）

| 扩展名 | 处理 |
|---|---|
| zip zipx | `unzip.py` 走 Python `zipfile`（无需外部工具） |
| rar 7z 001 tar gz bz2 xz iso lzh alz egg | `unzip.py` 走外部引擎：**Bandizip `bz.exe` 优先**（`$BANDIZIP` → PATH → 常见安装路径），没有才用 7-Zip（`$SEVEN_ZIP` → 常见路径 → PATH） |

安全边界（两引擎一致）：条目数上限（`--max-entries`，默认 500）、解压体积上限（`--max-mb`，默认 512MB）、拒绝绝对路径与 `..` 穿越条目（zip 逐条跳过并记 `skipped`，rar/7z 整包拒绝并报 `UNSAFE_ARCHIVE`）。

解压后对每个产物重新 `route.mjs`；直接 `node scripts/batch.mjs "<压缩包>"` 可自动解压 + 递归 + 汇总。

## 未知/其他

- 扩展名缺失/改名：`route.mjs`/`extract.py` 都按魔数兜底（PDF、OOXML、EPUB、HEIC、SQLite、RTF、7z/RAR、OLE…）；
  纯文本 → 直接 `read`；二进制无法判定 → `ok: false, kind: unknown` + 魔数十六进制（便于人工判断）。
- exe dll msi bat cmd ps1 sh com scr vbs js jar → **拒绝**（安全边界），需明确用途再单独处理。
- indd sketch → 本机无解析器，提示先转通用格式。

## 路由优先级

1. 用户明确要求（"拆解这个视频"→ video-deconstruct；"改这个 Word"→ docx skill）
2. 无明确要求 → 按上表默认处理（视频默认拆解、音频默认转写、文档默认提取内容摘要）
3. 多文件/目录 → `batch.mjs` 一次跑完并汇总
