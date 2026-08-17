---
name: file-intake
description: >
  通用文件入口路由器：任何文件拖入 DSH web（附件）或给出路径/URL，先识别类型，再路由到对应能力处理——
  图片→识图、视频→拆解/抽帧转写、音频→语音转文字、Word→docx、PDF→pdf、PPT/Excel→文本提取、
  文本/RTF→直读、ZIP→解压递归。用户拖入或引用任意文件并期望「分析/读取/处理/拆解」时触发，
  不限于图片（图片有 dsh-vision-skill 专项，但本 skill 统一入口）。依赖：见 SKILL.md 依赖清单。
---

# 通用文件入口（file-intake）

**一句话**：丢进来任何文件 → 自动识别类型 → 交给最擅长它的 skill/工具处理。

## 触发

- 用户消息带**任意文件附件**（attachmentId 形如 `sha256:<hex>`，不只图片）
- 用户给出任意**本地路径 / URL**（文档、表格、音频、视频、压缩包…）
- 用户要求「读取/分析/拆解/处理这个文件」

## 工作流

1. **解析输入**：附件 → `resolve_attachment.mjs` 解析磁盘路径（dsh-vision-skill 的脚本，见下）；路径/URL 直接用
2. **识别类型**：按扩展名查 `references/route-table.md`
3. **路由执行**：按路由表调用对应 skill/脚本（**优先复用已有能力，不重复造轮子**）
4. **交付**：说明处理结果 + 用到的能力 + 输出路径

## 依赖（已安装）

```powershell
# 已有：dsh-vision-skill（图片/识图）、docx skill、pdf skill、video-deconstruct、
#       ffmpeg、yt-dlp、deno、faster-whisper、openpyxl、python-pptx
# Python 库（已装）：openpyxl（Excel）、python-pptx（PPT）、mido（MIDI 可选）
# 常用路径（PATH 未刷新时用完整路径）：
#   ffmpeg:  $env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe
#   yt-dlp:  $env:LOCALAPPDATA\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_*\yt-dlp.exe
```

## 附件解析（复用 dsh-vision-skill 脚本）

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-vision-skill\scripts\resolve_attachment.mjs" "<attachmentId>"
# 找不到时：node "...\resolve_attachment.mjs" --search "<片段>"
```

## 快速路由速查

| 类型 | 交给谁 | 一句话做法 |
|---|---|---|
| 图片 | dsh-vision-skill | `vision.js` 识图（可 `--schema img2img` 结构化） |
| 视频 | video-deconstruct | ffmpeg 抽帧 + faster-whisper 转写 + 拆解报告 |
| 音频 | faster-whisper | ffmpeg 转 wav → whisper 转写（中文 `language='zh'`） |
| Word | docx skill | 按其文档处理（提取/修改/生成） |
| PDF | pdf skill | 按其文档处理（提取/合并/分析） |
| PPT/PPTX | python-pptx | 提取全部文本（见 route-table） |
| Excel | openpyxl | 读 sheet/单元格/公式（见 route-table） |
| TXT/MD/RTF | 直读 | 文本直接读；RTF strip 控制字 |
| ZIP | zipfile | 解压到临时目录 → 逐个递归走本路由 |
| MIDI | mido | 解析曲速/音轨/音符数（见 route-table） |

详见 `references/route-table.md`（含具体命令）。
