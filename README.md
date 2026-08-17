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
