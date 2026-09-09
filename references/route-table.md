# file-intake 路由表

按扩展名路由。**优先复用已有 skill/工具，不重复造轮子**。

## 图片（→ dsh-vision-skill）

| 扩展名 | 处理 |
|---|---|
| jpg jpeg png webp gif bmp heic heif | `node "..\dsh-vision-skill\scripts\vision.js" "<路径>" [--schema img2img\|ecom\|ground]` |
| 生图需求 | 转 img2img-studio（图生图工作流） |

## 视频（→ video-deconstruct，默认拆解）

| 扩展名 | 处理 |
|---|---|
| mp4 avi mkv mov webm flv | 按 video-deconstruct 工作流：抽帧（ffmpeg）+ 转写（faster-whisper）+ 拆解报告 |
| 链接（抖音/小红书/B站/YouTube） | 按 video-deconstruct：yt-dlp/API 获取 → 字幕/ASR → 拆解报告 |

常用命令：
```powershell
# 抽帧（每 5 秒一帧，最多 20 帧）
& "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe" -y -i "<视频>" -vf "fps=1/5,scale=640:-1" -frames:v 20 "frames/f%03d.png"
# 音频转 wav
& "<ffmpeg路径>" -y -i "<视频>" -ar 16000 -ac 1 "audio.wav"
```

## 音频（→ faster-whisper 转写）

| 扩展名 | 处理 |
|---|---|
| mp3 wav m4a flac ogg aac | ffmpeg 转 wav → whisper 转写（`language='zh'`） |
| midi | mido 解析（曲速/音轨/音符数，见下） |

```powershell
# 转写
$env:HTTPS_PROXY="http://127.0.0.1:7897"   # 仅首次下载模型需要
py -X utf8 -c "from faster_whisper import WhisperModel; m=WhisperModel('small', device='cpu', compute_type='int8'); segs,_=m.transcribe('audio.wav', language='zh', vad_filter=True); print('\n'.join(s.text for s in segs))"

# MIDI 元数据
py -X utf8 -c "import mido; m=mido.MidiFile('<文件>'); print('类型',m.type,'| 曲速',round(m.length,1),'s | 音轨',len(m.tracks)); [print('  音轨',t.name,'| 事件',len(t)) for t in m.tracks]"
```

## 文档

| 扩展名 | 处理 | 工具 |
|---|---|---|
| docx | docx skill（提取/修改/生成） | 已装 skill |
| doc（旧格式） | 用 LibreOffice/Word 转换或 docx skill 说明 | 提示用户或用 ChatGPT 网页兜底 |
| pdf | pdf skill（提取/合并/分析） | 已装 skill |
| pptx ppt | python-pptx 提取全部文本 | `py -X utf8 -c "from pptx import Presentation; p=Presentation('<文件>'); [print(f'--- 第{i+1}页 ---\n'+'\n'.join(sh.text for sh in s.shapes if sh.has_text_frame)) for i,s in enumerate(p.slides)]"` |
| txt md log csv | 直接读文本 | read 工具 |
| rtf | strip 控制字后读文本 | `py -X utf8 -c "import re; t=open('<文件>',encoding='utf-8',errors='ignore').read(); t=re.sub(r'\\[a-z]+-?[0-9]* ?','',t); t=re.sub(r'[{}]','',t); print(t)"` |

## 表格

| 扩展名 | 处理 | 工具 |
|---|---|---|
| xlsx xlsm | openpyxl 读取（sheet 列表 + 前 N 行 + 公式/数据） | openpyxl 已装 |
| xls（旧格式） | openpyxl 不支持 → 提示转 xlsx 或用 ChatGPT 网页兜底 | — |

```powershell
py -X utf8 -c "
import openpyxl
wb = openpyxl.load_workbook('<文件>', data_only=True)
for ws in wb.worksheets:
    print(f'=== {ws.title} ({ws.max_row}x{ws.max_column}) ===')
    for row in ws.iter_rows(max_row=min(10, ws.max_row), values_only=True):
        print(' | '.join('' if v is None else str(v) for v in row))
"
```

## 压缩包（→ 递归）

| 扩展名 | 处理 |
|---|---|
| zip | 解压到临时目录 → 逐个文件按本路由表处理 |
| rar 7z | 提示装 7-Zip 或用系统工具解压后再拖入 |

```powershell
py -X utf8 -c "import zipfile; zipfile.ZipFile('<文件>').extractall('<解压目录>'); print('解压完成')"
```

## 未知/其他

- 先尝试按内容嗅探（读文件头判断真实类型），再按路由表处理
- 都不匹配 → 告知用户支持范围，或用 ChatGPT 网页兜底（上传文件让 GPT 分析）

## 路由优先级

1. 用户明确要求（"拆解这个视频"→ video-deconstruct；"改这个 Word"→ docx）
2. 无明确要求 → 按上表默认处理（视频默认拆解、音频默认转写、文档默认提取内容摘要）
3. 多文件 → 逐个处理并汇总
