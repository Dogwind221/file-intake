# file-intake

通用文件入口路由器 Skill：任何文件拖入 DSH web（附件）或给出路径/URL，
先识别类型，再路由到对应能力处理。

**它解决的是「拿到一个文件不知道谁该处理」这个问题**：不用记哪种格式用哪个工具、不用为每种格式重写解析、
也不用把二进制硬塞给模型——一次路由，交给最擅长它的能力，并给出可复现的命令。

## 覆盖范围

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
node scripts/selftest.mjs                   # 自测：自动造样例跑通全链路
node scripts/doctor.mjs                     # 依赖自检
```

**DSH 0.1.3 起非图片附件原生支持**：模型直接收到只读副本路径，**直接用那个路径**即可；
`resolve_attachment.mjs` 只服务于**图片附件**（只有 `attachmentId`、没有现成路径）——非图片不要多跑这一步。

所有脚本输出统一的交付契约，下游 skill 直接消费：

```json
{ "ok": true, "source": "<绝对路径|URL>", "type": "docx", "handler": "extract.py",
  "artifacts": ["产物绝对路径"], "summary": "一句话结论" }
```

## 核心优势

### 1. 一个入口，只做路由不做重复造轮子

识图归 `dsh-vision-skill`、视频拆解归 `video-deconstruct`、PPT/Word 归 `extract.py`、数据库归 sqlite 只读查询——
file-intake **不重新实现任何解析器**，只负责「把文件送到对的地方」并给出可执行命令。
好处是：新增格式只要改一张路由表，不用动下游；下游升级了，file-intake 自动受益。

### 2. 魔数优先，扩展名只作辅助

先读文件头再信扩展名，所以**改名、无扩展名、扩展名写错**的文件也能正确路由：

| 情况 | 结果 |
|---|---|
| `noext_doc`（无扩展名，内容是 PDF） | `type=pdf` → `extract.py(pypdf)` |
| 改名的 OOXML（zip 容器 + 中央目录判定） | `type=docx/xlsx/pptx`，不会被当成普通压缩包 |
| `.xls`（OLE 复合文档） | 按 OLE 家族 + 扩展名判语义，走 xlrd 直读 |
| 未知二进制 | 明确回 `ok:false, kind:unknown` + 魔数十六进制，**不猜** |

zip 家族会同时查「文件头局部区 + 尾部中央目录」（条目名两处都可能在），这是修掉「`xlsx` 被误判成压缩包」的关键。

### 3. 统一交付契约，下游零适配

`source` / `type` / `handler` / `artifacts[]` / `summary` 五个字段所有脚本一致（`route.mjs`、`extract.py`、
`transcribe.py`、`unzip.py`、`batch.mjs`、`selftest.mjs`），失败时同构：`{ok:false, handler, artifacts:[], summary, error:{code,message,hint}}`。

- `img2img-studio` 吃 `artifacts[]` 里的图片路径（HEIC/PSD 已转出的 PNG）+ `summary` 里的尺寸
- `video-deconstruct` 吃 `transcribe.py` 的 `text` / `meta.segments`（带时间轴）+ `summary`
- 人/agent 汇报直接念 `summary`，要细节再看 `meta` / `results`

### 4. 批量与汇总

`batch.mjs` 接受**目录、多个文件、压缩包**：压缩包先安全解压再递归，逐个路由 + 执行本地可自动完成的处理器
（`extract.py` / `transcribe.py` / `unzip.py`），识图（耗额度）与视频拆解只给命令不擅自执行。
输出一份汇总：`counts`（ok / ok(cached) / failed / unsupported / needs-agent）+ 顶层 `artifacts[]` + 每个文件自己的 `summary`，
失败项带 `error.code`，不需要人去 grep 日志。

### 5. 缓存与「大文件不炸上下文」

- **sha256 结果缓存**：按「文件 sha256 + 处理器 + 参数 + 文件名」命中即秒回（`cached:true`），重复处理零成本
- **文本分块**：`extract.py --chunk-chars N` 输出 `chunks[]`，可逐块交子代理后汇总
- **音视频分段**：`transcribe.py --chunk-minutes N` 超阈值用 ffmpeg 分段转写，`meta.chunks[]` 给每段时间范围

### 6. 安全边界是硬规则

| 规则 | 行为 |
|---|---|
| 可执行/脚本（`.exe/.dll/.msi/.bat/.cmd/.ps1/.sh/.com/.scr/.vbs/.js/.jar`） | **拒绝路由**，`command` 字段留空，只回一句说明；要分析二进制必须用户明确说明用途后另走工具 |
| 解压（zip/rar/7z） | 条目数上限 + 解压体积上限 + 路径穿越拒绝（zip 逐条跳过并记 `skipped`，rar/7z 整包拒绝报 `UNSAFE_ARCHIVE`） |
| 附件副本 | 只读；要改先复制到工作目录，路由与提取全程只读原文件 |

### 7. 可维护性：改脚本即有回归

- **失败也是 JSON**：任何解析异常都转成 `PARSE_ERROR` / `INTERNAL_ERROR` + `hint`，不把栈丢给调用方（损坏 PDF、假 HEIC 都实测过）
- **依赖自检** `doctor.mjs`：工具 + Python 库 + 脚本完整性逐项报，缺哪个给哪条安装命令
- **55 项离线自测** `selftest.mjs`：现场造样例（真实 PDF / HEIC / xls / parquet / sqlite，以及**路径穿越 zip**、**30MB zip 炸弹**、伪装 exe、未知二进制），
  覆盖路由结论、魔数兜底、拒绝与未知类型、交付契约、缓存命中、三类解压防护、批量汇总与 `--dry-run`；缺依赖自动 skip（PSD / msg 需真样本，另行手工验证过）
- **CI**：推送/PR 自动跑同一套（Linux + `python3`），跨平台靠 `FILE_INTAKE_PY` 覆盖（默认 Windows 的 `py`）

### 8. 零新增依赖

全部复用已装工具链：`ffmpeg` / `yt-dlp` / `openpyxl` / `xlrd` / `python-pptx` / `faster-whisper` / `pypdf` /
`pillow-heif` / `pyarrow` / `extract-msg` / Bandizip `bz.exe`（7-Zip 兜底）。
脚本自身**不引入新依赖**：Node 侧零 npm 包，Python 侧只用「按格式按需安装」的解析库——
没装哪个就只影响那种格式，返回 `MISSING_DEP` + 安装命令，其余格式照跑。

## 能力边界：哪些**不是**本技能的锅

> 先说结论：下面这些限制来自**模型 / harness 的当前能力**，不是 file-intake 的缺陷。
> file-intake 能做的是「在现有条件下给出最优路径」，换任何入口都躲不开同样的物理限制。

### 视频：所谓「多模态看视频」，本质仍是「抽帧图片 + 字幕/音频文本」

**为什么必然如此**：DSH 原生附件只把 `png/jpeg/webp/gif` 作为图像块送进模型，其它文件（含视频）
只给一个**只读副本路径**——视频本体根本进不了模型上下文。所以任何方案都只能先把视频**拆成模型能读的东西**：

```
视频 ──ffmpeg 抽帧──→ 图片序列 ──┐
     └─抽音轨──────→ 音频 ──faster-whisper──→ 转写文本 + 时间轴 ──┤──→ 模型上下文
     └─已有字幕文件（srt/vtt）──→ 文本 ────────────────────────────┘
```

file-intake 在这个链路里的角色是**认出来 + 路由 + 给命令**：`route.mjs` 判到视频就交给
`video-deconstruct`（抽帧 + 转写 + 拆解报告），只要你只要文字就直接跑 `transcribe.py`（内部自己抽音轨）。

**由此产生的客观限制（任何入口都一样）**：

| 限制 | 原因 | file-intake 能做的缓解 |
|---|---|---|
| 画面细节受**抽帧密度**决定 | 帧是采样，不是连续观看 | 调抽帧频率（`fps=1/5` 或更密）后再交给识图 |
| 一闪而过的**画面文字**容易漏 | 采样恰好没覆盖到那一帧 | 加大帧率 / 指定时间段精抽 |
| 文本面受**音轨与字幕质量**决定 | 无音轨、无字幕时只剩帧可看 | 有字幕优先用 `srt/vtt`（比 ASR 准）；ASR 可换 `--model` / `--lang` |
| 长视频**成本线性上升** | 帧数 + 转写时长都在涨 | `transcribe.py --chunk-minutes` 分段 + sha256 缓存，重复处理秒回 |

**什么时候不受这些限制**：你只想要**文本内容**（讲稿、字幕、要点、口播文案）时——
直接 `py -X utf8 scripts/transcribe.py "<视频>"`，不需要抽帧、不需要识图，误差只来自 ASR 本身。
需要「画面 + 语音」一起判断时（拆解爆款结构、看镜头画面）才必须走抽帧 + 转写两条腿。

### 其他边界（同样是环境限制，技能只如实告知）

| 情况 | 现状 | 提示方式 |
|---|---|---|
| 扫描件 PDF（无文本层） | 本机无 OCR 引擎 | route.mjs 的 `notes` 直接提示「扫描件需 OCR」，提取为空时如实返回空文本而不是编内容 |
| `.doc` / `.ppt` / `.pages` / `.key` / `.numbers` | 需 LibreOffice 转换（`.xls` 已由 xlrd 直读，不需要） | route.mjs 给 `needs-tool` + 安装/另存为命令 |
| `ai`（纯 PostScript）/ `indd` / `sketch` | 无本地解析器 | `no-parser` + 转换建议（PDF 兼容版 `.ai` 会按魔数当 PDF 提取） |
| 可执行文件 | 安全边界 | `refuse`（见上） |
| 损坏 / 伪造文件 | 解析失败 | `PARSE_ERROR` + hint，不抛栈、不猜内容 |

完整说明见 [SKILL.md](./SKILL.md)。
