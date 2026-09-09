---
name: file-intake
description: >
  通用文件入口路由器：任何文件（拖入 DSH web 附件、给出本地路径或 URL）先识别类型，再路由到对应能力处理——
  图片→识图、视频→拆解/抽帧转写、音频→语音转文字、Word→docx、PDF→pdf、PPT/Excel→文本提取、
  文本/RTF→直读、ZIP→解压递归。用户拖入或引用任意文件并期望「分析/读取/处理/拆解」时触发，
  不限于图片（图片有 dsh-vision-skill 专项，但本 skill 统一入口）。DSH 0.1.3 起非图片附件原生支持，
  模型直接拿到只读副本路径。依赖：见 SKILL.md 依赖清单。
---

# 通用文件入口（file-intake）

> **路径约定（DSH 0.1.3+）**：本文档相对路径以**本技能资源目录**为基准解析（加载时 harness 给出 `Base directory for this skill`）；跨技能引用写 `..\<技能名>\...`（三个技能同根安装时成立）。

**一句话**：丢进来任何文件 → 自动识别类型 → 交给最擅长它的 skill/工具处理。

## 触发

- 用户消息带**文件附件**：
  - **非图片文件**（PDF/Word/Excel/音频/视频/压缩包…）→ DSH 0.1.3+ **原生支持**，模型直接收到 `[File "name" (N bytes, sha256:…): verbatim read-only copy saved at "<路径>"…]`，**路径可直接用**，无需任何解析
  - **图片** → 收到 image block（`attachmentId` 形如 `sha256:<hex>`），需用 `resolve_attachment.mjs` 解析磁盘路径
- 用户给出任意**本地路径 / URL**（文档、表格、音频、视频、压缩包…）
- 用户要求「读取/分析/拆解/处理这个文件」

## 工作流

1. **解析输入**：
   - 非图片附件 → 直接取消息里的**只读副本路径**（`…\attachments\v1\files\<sha前2位>\<sha>\<原名>`）
   - 图片附件 → `..\dsh-vision-skill\scripts\resolve_attachment.mjs` 解析 `attachmentId`
   - 路径/URL → 直接用
2. **识别类型**：按扩展名查 `references/route-table.md`
3. **路由执行**：按路由表调用对应 skill/脚本（**优先复用已有能力，不重复造轮子**）
4. **交付**：说明处理结果 + 用到的能力 + 输出路径

> ⚠️ 附件的副本是**只读**的：需要修改（改 Word/改图等）时先复制到工作目录再改；委派子代理时要把这个路径写进 prompt（只有同一执行环境的子代理能读到）。

## 依赖（已安装）

```powershell
# 已有：dsh-vision-skill（图片/识图）、docx skill、pdf skill、video-deconstruct、
#       ffmpeg、yt-dlp、deno、faster-whisper、openpyxl、python-pptx
# Python 库（已装）：openpyxl（Excel）、python-pptx（PPT）、mido（MIDI 可选）
# 常用路径（PATH 未刷新时用完整路径）：
#   ffmpeg:  $env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe
#   yt-dlp:  $env:LOCALAPPDATA\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_*\yt-dlp.exe
```

## 附件解析

**非图片文件（DSH 0.1.3+ 原生）**：消息里已带可读路径，直接读，不要再去解析 `attachmentId`：

```text
[File "report.pdf" (248135 bytes, sha256:1a2b3c4d): verbatim read-only copy saved at
 "C:\Users\<你>\.dsh\attachments\v1\files\1a\1a2b…\report.pdf". Read that path with your
 file tools when its contents are needed; copy it to a writable location before modifying it.]
```

**图片附件（image block，只有 attachmentId）**：复用 dsh-vision-skill 的脚本解析：

```powershell
node "..\dsh-vision-skill\scripts\resolve_attachment.mjs" "<attachmentId>"
# 找不到时：node "..\dsh-vision-skill\scripts\resolve_attachment.mjs" --search "<片段>"
```

> 图片附件存储在 `<DSH_HOME>\attachments\v1\objects\<hex前2位>\<hex>`（脚本自动按 `DSH_HOME` 或 `~/.dsh` 解析）。

## 快速路由速查

| 类型 | 交给谁 | 一句话做法 |
|---|---|---|
| 图片 | dsh-vision-skill | 多模态模型直接 `read_image`；纯文本模型走 `vision.js` 识图（可 `--schema img2img` 结构化） |
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
