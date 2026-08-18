# file-intake

通用文件入口路由器 Skill：任何文件拖入 DSH web（附件）或给出路径/URL，
先识别类型，再路由到对应能力处理。

| 文件类型 | 路由 |
|---|---|
| 图片 | 识图（dsh-vision-skill） |
| 视频 | 拆解/抽帧转写（video-deconstruct） |
| 音频 | 语音转文字 |
| Word | docx skill |
| PDF | pdf skill |
| PPT / Excel | 文本提取 |
| 文本 / RTF | 直读 |
| ZIP | 解压递归 |

路由表见 [references/route-table.md](./references/route-table.md)。

## 配套 DSH 附件补丁

DSH 附件系统原生只接受图片（png/jpeg/webp/gif）。本 skill 配套一个幂等补丁脚本
（`dsh-repatch-file-intake.cjs`），让 DSH 接受任意文件拖入：

- 前端 `imageMediaType` 放行非图片
- 后端 `dsh-attachment-local` 接受任意文件（100MB 上限）
- 服务器端 prompt schema 放行非图片 mediaType

dsh 升级覆盖 node_modules 后，运行一次补丁脚本即可恢复（已自动接入启动脚本）。

完整说明见 [SKILL.md](./SKILL.md)。

## 核心优点

- **统一入口，不重复造轮子**：任何文件一个入口，路由到**最擅长它的能力**（识图/拆解/转写/docx/pdf…），而非为每种格式重写解析
- **类型全覆盖路由表**：图片、视频、音频、Word、PDF、PPT/Excel、TXT/MD/RTF、ZIP（解压递归）、MIDI——见 [references/route-table.md](./references/route-table.md)
- **输入形式多样**：DSH 附件（attachmentId）/ 本地路径 / URL 均可
- **配套 DSH 附件补丁**：让 DSH 原生接受非图片附件（前端放行 + 后端存储 + 服务器 schema 三处幂等补丁），**dsh 升级后自动恢复**（已接入启动脚本）
- **零新增依赖**：全部复用已装工具链（ffmpeg / yt-dlp / openpyxl / python-pptx / faster-whisper）
- **ZIP 递归路由**：压缩包解压后逐文件再走本路由，深层文件也不漏
