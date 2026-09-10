# file-intake

通用文件入口路由器 Skill：任何文件拖入 DSH web（附件）或给出路径/URL，
先识别类型，再路由到对应能力处理。

| 文件类型 | 路由 |
|---|---|
| 图片 | 识图（dsh-vision-skill）；HEIC/HEIF 先转 PNG |
| 视频 | 拆解/抽帧转写（video-deconstruct） |
| 音频 | 语音转文字（faster-whisper，长音频自动分段） |
| Word / PDF / PPT / Excel（含旧版 xls）/ EPUB / 字幕 / 邮件（eml·msg）/ SVG / PSD / SQLite / parquet | `extract.py` 文本提取 |
| 文本 / RTF | 直读或 `extract.py` |
| zip / rar / 7z | 安全解压（Bandizip 引擎）并递归 |
| 目录 / 多文件 / 压缩包 | `batch.mjs` 批量路由 + 汇总 |

路由表见 [references/route-table.md](./references/route-table.md)。

## 用法

```powershell
node scripts/route.mjs "<文件|URL|目录>"     # 第一步：拿路由结论（JSON）
node scripts/batch.mjs <目录> --out-dir <产物目录>   # 批量：路由+执行+汇总
node scripts/doctor.mjs                     # 依赖自检
```

**DSH 0.1.3 起非图片附件原生支持**：模型直接收到只读副本路径，无需任何补丁。

## 核心优点

- **统一入口，不重复造轮子**：任何文件一个入口，路由到**最擅长它的能力**（识图/拆解/转写/docx/pdf…），而非为每种格式重写解析
- **魔数优先，扩展名其次**：改名 / 无扩展名的文件也能正确路由（PDF、OOXML、EPUB、HEIC、SQLite、7z/RAR…）
- **批量 + 汇总**：`batch.mjs` 对目录/多文件/压缩包自动解压、递归、执行本地处理器，输出成功/失败/待人工清单
- **sha256 结果缓存**：重复处理秒回（`~/.dsh/file-intake-cache`，`--refresh` 强制重算）
- **大文件策略**：文本 `--chunk-chars` 分块，音视频 `--chunk-minutes` 分段转写
- **安全解压**：条目数/解压体积/路径穿越三重防护；rar/7z 走 Bandizip `bz.exe`（7-Zip 兜底）
- **失败也是 JSON**：任何错误都返回 `error.code` + `error.hint`，不把栈丢给调用方
- **零新增依赖**：全部复用已装工具链（ffmpeg / yt-dlp / openpyxl / python-pptx / faster-whisper / pypdf / pillow-heif）

完整说明见 [SKILL.md](./SKILL.md)。
