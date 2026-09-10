#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""统一文档/表格/演示/文本提取（file-intake）。

用法:
    py -X utf8 scripts/extract.py <文件> [--max-chars N] [--chunk-chars N] [--out <文件>]
                                  [--no-cache] [--refresh]

支持:
    docx xlsx xlsm pptx  → 零依赖 / openpyxl / python-pptx
    xls                  → xlrd（旧版 Excel，无需 LibreOffice）
    pdf                  → pypdf（未装时给安装提示）
    rtf html ipynb csv tsv txt md json yaml xml log  → 零依赖
    epub srt vtt eml svg sqlite db → 零依赖（zip / email / sqlite3 / 正则）
    msg                  → extract-msg（Outlook .msg）
    parquet              → pyarrow（schema + 首批行）
    doc xls ppt pages key numbers → LibreOffice 转换后提取（需 soffice）
    heic heif            → 转 PNG（需 Pillow + pillow-heif）
    psd                  → 导出合成图 PNG（需 Pillow）

缓存: 按「文件 sha256 + 处理器 + 参数」缓存结果到 ~/.dsh/file-intake-cache
      （可用 FILE_INTAKE_CACHE 覆盖；--no-cache 跳过读，--refresh 强制重算）

输出（stdout，JSON）:
    { "ok": true, "type": "docx", "chars": 1234, "cached": false,
      "text": "...", "chunks": [...], "meta": {...}, "artifacts": [...] }

退出码: 0 = 成功；1 = 失败（JSON 带 error）。
"""
import csv
import email
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile

DEFAULT_MAX_CHARS = 20000


def fail(code: str, message: str, hint: str | None = None) -> dict:
    out = {"ok": False, "handler": "extract.py", "artifacts": [], "summary": f"{code}: {message}",
           "error": {"code": code, "message": message}}
    if hint:
        out["error"]["hint"] = hint
    return out


def summarize(ext: str, text: str, meta: dict) -> str:
    """一句话结论（统一交付契约的 summary 字段）。"""
    n = len(text or "")
    if ext in ("heic", "heif"):
        size = meta.get("size") or []
        return f"HEIC {size[0]}x{size[1]} 已转 PNG（产物见 artifacts），下一步交给识图" if size else "HEIC 已转 PNG"
    if ext == "psd":
        size = meta.get("size") or []
        return f"PSD {size[0]}x{size[1]} 已导出合成图 PNG（{meta.get('frames_or_layers', 1)} 图层），下一步交给识图"
    if ext == "parquet":
        return f"parquet：{meta.get('rows', 0)} 行 × {len(meta.get('columns', []))} 列，已取首批行"
    if ext in ("sqlite", "db"):
        return f"SQLite：{len(meta.get('tables', []))} 张表，已给出行数/列名/样本"
    if ext == "msg":
        return f"Outlook 邮件「{meta.get('subject', '')}」，正文 {n} 字符，附件 {len(meta.get('attachments', []))} 个"
    if ext == "eml":
        return f"邮件「{meta.get('subject', '')}」，正文 {n} 字符，附件 {len(meta.get('attachments', []))} 个"
    if ext == "pdf":
        return f"PDF {meta.get('pages', '?')} 页，提取文本 {n} 字符"
    if ext in ("xlsx", "xlsm", "xls"):
        sheets = meta.get("sheets", [])
        return f"表格 {len(sheets)} 个工作表，提取文本 {n} 字符"
    if ext == "pptx":
        return f"演示 {meta.get('slides', '?')} 页，提取文本 {n} 字符"
    if ext == "epub":
        return f"EPUB「{meta.get('title', '')}」{meta.get('chapters', '?')} 章，提取文本 {n} 字符"
    if meta.get("format") == "subtitle":
        return f"字幕 {meta.get('cues', '?')} 条，提取文本 {n} 字符"
    if ext == "svg":
        return f"SVG 文本节点 {meta.get('text_nodes', 0)} 个，提取文本 {n} 字符"
    return f"{ext}：提取文本 {n} 字符"


# ── 缓存 ──────────────────────────────────────────────────────

def cache_root() -> str:
    return os.environ.get("FILE_INTAKE_CACHE") or os.path.join(os.path.expanduser("~"), ".dsh", "file-intake-cache")


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_key(sha: str, handler: str, params: dict) -> str:
    tag = hashlib.sha256(json.dumps(params, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:10]
    return f"{sha}-{handler}-{tag}"


def cache_paths(key: str) -> tuple[str, str]:
    root = os.path.join(cache_root(), key[:2])
    return os.path.join(root, key + ".json"), os.path.join(root, key + ".txt")


def cache_get(key: str) -> dict | None:
    meta_path, text_path = cache_paths(key)
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        return None
    if os.path.isfile(text_path):
        with open(text_path, encoding="utf-8") as fh:
            payload["text"] = fh.read()
        arts = payload.setdefault("artifacts", [])
        if text_path not in arts:
            arts.insert(0, text_path)
    # 缓存里的产物路径来自当时的调用（--out 等），只保留仍存在的
    payload["artifacts"] = [p for p in payload.get("artifacts", []) if os.path.exists(p)]
    # 老缓存补齐交付契约字段
    payload.setdefault("handler", "extract.py")
    payload.setdefault("source", payload.get("source", ""))
    if not payload.get("summary"):
        payload["summary"] = summarize(payload.get("type", ""), payload.get("text", ""), payload.get("meta", {}))
    payload["cached"] = True
    return payload


def cache_put(key: str, payload: dict) -> None:
    meta_path, text_path = cache_paths(key)
    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    with open(text_path, "w", encoding="utf-8") as fh:
        fh.write(payload.get("text", ""))
    stored = {k: v for k, v in payload.items() if k != "text"}
    arts = stored.setdefault("artifacts", [])
    if text_path not in arts:
        arts.insert(0, text_path)
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(stored, fh, ensure_ascii=False, indent=2)


# ── LibreOffice 转换 ──────────────────────────────────────────

def find_soffice() -> str | None:
    env = os.environ.get("SOFFICE_BIN")
    if env and os.path.isfile(env):
        return env
    for cand in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if os.path.isfile(cand):
            return cand
    return shutil.which("soffice")


def convert_with_soffice(path: str, target_ext: str) -> tuple[str | None, dict | None]:
    exe = find_soffice()
    if not exe:
        return None, fail("MISSING_TOOL", "需要 LibreOffice 转换该格式", "winget install TheDocumentFoundation.LibreOffice")
    out_dir = tempfile.mkdtemp(prefix="file-intake-conv-")
    try:
        proc = subprocess.run(
            [exe, "--headless", "--norestore", "--convert-to", target_ext, "--outdir", out_dir, path],
            capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=180,
        )
    except Exception as exc:
        return None, fail("CONVERT_FAILED", f"LibreOffice 转换失败: {exc}")
    if proc.returncode != 0:
        return None, fail("CONVERT_FAILED", f"LibreOffice 返回码 {proc.returncode}: {(proc.stderr or '')[:200]}")
    for name in os.listdir(out_dir):
        if name.lower().endswith("." + target_ext):
            return os.path.join(out_dir, name), None
    return None, fail("CONVERT_FAILED", "LibreOffice 未产出目标文件")


# ── 各格式提取 ────────────────────────────────────────────────

def extract_docx(path):
    with zipfile.ZipFile(path) as zf:
        if "word/document.xml" not in zf.namelist():
            return fail("PARSE_ERROR", "docx 缺少 word/document.xml")
        xml = zf.read("word/document.xml").decode("utf-8", "ignore")
    xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t").replace("<w:br/>", "\n")
    text = re.sub(r"<[^>]+>", "", xml)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return {"text": text.strip(), "meta": {"format": "docx", "paragraphs": text.count("\n") + 1}}


def extract_xlsx(path, max_rows=20):
    try:
        import openpyxl
    except ImportError:
        return fail("MISSING_DEP", "缺少 openpyxl", "py -m pip install openpyxl")
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    parts, meta = [], {"format": "xlsx", "sheets": []}
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(max_row=min(max_rows, ws.max_row or 0), values_only=True):
            rows.append(" | ".join("" if v is None else str(v) for v in row))
        meta["sheets"].append({"name": ws.title, "rows": ws.max_row, "cols": ws.max_column})
        parts.append(f"=== {ws.title} ({ws.max_row}x{ws.max_column}) ===\n" + "\n".join(rows))
    wb.close()
    return {"text": "\n\n".join(parts).strip(), "meta": meta}


def extract_xls(path, max_rows=20):
    """旧版 .xls（BIFF）→ xlrd 读取，无需 LibreOffice。"""
    try:
        import xlrd
    except ImportError:
        return fail("MISSING_DEP", "缺少 xlrd", "py -m pip install xlrd（旧版 .xls 读取）")
    book = xlrd.open_workbook(path)
    parts, meta = [], {"format": "xls", "sheets": []}
    for ws in book.sheets():
        rows = []
        for r in range(min(max_rows, ws.nrows)):
            rows.append(" | ".join("" if ws.cell_value(r, c) in ("", None) else str(ws.cell_value(r, c)) for c in range(ws.ncols)))
        meta["sheets"].append({"name": ws.name, "rows": ws.nrows, "cols": ws.ncols})
        parts.append(f"=== {ws.name} ({ws.nrows}x{ws.ncols}) ===\n" + "\n".join(rows))
    return {"text": "\n\n".join(parts).strip(), "meta": meta}


def extract_pptx(path):
    try:
        from pptx import Presentation
    except ImportError:
        return fail("MISSING_DEP", "缺少 python-pptx", "py -m pip install python-pptx")
    prs = Presentation(path)
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        lines = [sh.text for sh in slide.shapes if getattr(sh, "has_text_frame", False) and sh.text.strip()]
        notes = ""
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = slide.notes_slide.notes_text_frame.text.strip()
        block = f"--- 第 {i} 页 ---\n" + "\n".join(lines)
        if notes:
            block += f"\n[备注] {notes}"
        parts.append(block)
    return {"text": "\n\n".join(parts).strip(), "meta": {"format": "pptx", "slides": len(prs.slides)}}


def extract_pdf(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        return fail("MISSING_DEP", "缺少 pypdf", "py -m pip install pypdf（或改用 pdf skill）")
    try:
        reader = PdfReader(path)
        page_count = len(reader.pages)
        encrypted = reader.is_encrypted
    except Exception as exc:
        return fail("PARSE_ERROR", f"PDF 解析失败（文件可能损坏/被截断/加密）: {type(exc).__name__}: {exc}",
                    "先确认文件完整；扫描件需 OCR；也可转给 pdf skill 处理")
    pages = []
    for i, page in enumerate(reader.pages, 1):
        try:
            pages.append(f"--- 第 {i} 页 ---\n{(page.extract_text() or '').strip()}")
        except Exception as exc:
            pages.append(f"--- 第 {i} 页 ---\n[提取失败] {exc}")
    return {"text": "\n\n".join(pages).strip(), "meta": {"format": "pdf", "pages": page_count, "encrypted": encrypted}}


def extract_rtf(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    raw = re.sub(r"\\'([0-9a-f]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252", "ignore"), raw)
    raw = re.sub(r"\\u(-?\d+)\??", lambda m: chr(int(m.group(1)) + 65536 if int(m.group(1)) < 0 else int(m.group(1))), raw)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", raw)
    text = text.replace("\\{", "{").replace("\\}", "}").replace("\\\n", "\n")
    text = re.sub(r"[{}]", "", text)
    return {"text": re.sub(r"\n{3,}", "\n\n", text).strip(), "meta": {"format": "rtf"}}


def strip_html(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>", "\n", raw)
    text = re.sub(r"<[^>]+>", " ", raw)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_html(path):
    return {"text": strip_html(open(path, encoding="utf-8", errors="ignore").read()), "meta": {"format": "html"}}


def extract_ipynb(path):
    nb = json.load(open(path, encoding="utf-8"))
    parts = []
    for i, cell in enumerate(nb.get("cells", []), 1):
        parts.append(f"--- cell {i} [{cell.get('cell_type')}] ---\n{''.join(cell.get('source', []))}")
    return {"text": "\n\n".join(parts).strip(), "meta": {"format": "ipynb", "cells": len(nb.get("cells", []))}}


def extract_csv(path, max_rows=50):
    with open(path, encoding="utf-8", errors="ignore", newline="") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample)
        except Exception:
            dialect = csv.excel
        rows = list(csv.reader(fh, dialect))[:max_rows]
    return {"text": "\n".join(" | ".join(r) for r in rows), "meta": {"format": "csv", "preview_rows": len(rows)}}


def extract_text(path):
    return {"text": open(path, encoding="utf-8", errors="ignore").read(), "meta": {"format": "text"}}


def extract_epub(path):
    """epub = zip + XHTML；按 OPF spine 顺序拼接（缺失时按文件名排序）。"""
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        order = []
        opf = next((n for n in names if n.endswith(".opf")), None)
        if opf:
            opf_xml = zf.read(opf).decode("utf-8", "ignore")
            base = os.path.dirname(opf)
            ids = dict(re.findall(r'<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf_xml))
            for idref in re.findall(r"<itemref[^>]*idref=\"([^\"]+)\"", opf_xml):
                href = ids.get(idref)
                if href:
                    order.append(os.path.normpath(os.path.join(base, href)).replace("\\", "/"))
        if not order:
            order = sorted(n for n in names if n.lower().endswith((".xhtml", ".html", ".htm")))
        parts = []
        for name in order:
            if name not in names:
                continue
            parts.append(strip_html(zf.read(name).decode("utf-8", "ignore")))
        title = ""
        if opf:
            m = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", zf.read(opf).decode("utf-8", "ignore"), re.S)
            title = (m.group(1).strip() if m else "")
    return {"text": "\n\n".join(p for p in parts if p).strip(), "meta": {"format": "epub", "chapters": len(parts), "title": title}}


def extract_subtitle(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    lines = []
    for block in re.split(r"\n\s*\n", raw.replace("\r\n", "\n")):
        kept = []
        for line in block.split("\n"):
            line = line.strip()
            if not line or line.upper().startswith(("WEBVTT", "NOTE")):
                continue
            if re.match(r"^\d+$", line):          # srt 序号
                continue
            if "-->" in line:                      # 时间轴
                continue
            kept.append(re.sub(r"<[^>]+>", "", line))
        if kept:
            lines.append(" ".join(kept))
    return {"text": "\n".join(lines).strip(), "meta": {"format": "subtitle", "cues": len(lines)}}


def extract_eml(path):
    with open(path, "rb") as fh:
        msg = email.message_from_binary_file(fh)
    body_parts = []
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.get_content_maintype() == "multipart":
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        charset = part.get_content_charset() or "utf-8"
        text = payload.decode(charset, "ignore")
        if ctype == "text/plain":
            body_parts.append(text)
        elif ctype == "text/html":
            body_parts.append(strip_html(text))
    meta = {
        "format": "eml",
        "from": msg.get("From", ""), "to": msg.get("To", ""),
        "subject": msg.get("Subject", ""), "date": msg.get("Date", ""),
        "attachments": [p.get_filename() for p in msg.walk() if p.get_filename()],
    }
    return {"text": "\n\n".join(p for p in body_parts if p.strip()).strip(), "meta": meta}


def extract_svg(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    texts = re.findall(r"<(?:text|tspan)[^>]*>(.*?)</(?:text|tspan)>", raw, re.S)
    title = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S)
    meta = {"format": "svg", "bytes": len(raw), "text_nodes": len(texts)}
    if title:
        meta["title"] = title.group(1).strip()
    return {"text": "\n".join(t.strip() for t in texts if t.strip()), "meta": meta}


def extract_sqlite(path, max_rows=5):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table' order by name")]
    parts, meta = [], {"format": "sqlite", "tables": []}
    for name in tables:
        try:
            count = con.execute(f'select count(*) from "{name}"').fetchone()[0]
            cols = [d[1] for d in con.execute(f'pragma table_info("{name}")')]
            rows = con.execute(f'select * from "{name}" limit {max_rows}').fetchall()
        except Exception as exc:
            parts.append(f"=== {name} ===\n[读取失败] {exc}")
            continue
        meta["tables"].append({"name": name, "rows": count, "cols": cols})
        sample = "\n".join(" | ".join("" if v is None else str(v) for v in row) for row in rows)
        parts.append(f"=== {name} ({count} 行, {len(cols)} 列) ===\n列: {', '.join(cols)}\n样本:\n{sample}")
    con.close()
    return {"text": "\n\n".join(parts).strip(), "meta": meta}


def extract_heic(path, out_dir):
    try:
        from PIL import Image
    except ImportError:
        return fail("MISSING_DEP", "缺少 Pillow", "py -m pip install pillow pillow-heif")
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        return fail("MISSING_DEP", "缺少 pillow-heif，无法解码 HEIC/HEIF",
                    "py -m pip install pillow-heif  （装好后重跑；或先用系统「照片」导出为 PNG）")
    img = Image.open(path)
    png = os.path.join(out_dir, os.path.splitext(os.path.basename(path))[0] + ".png")
    img.convert("RGB").save(png)
    return {"text": "", "meta": {"format": "heic", "converted": True, "size": list(img.size)},
            "artifacts": [png], "note": "已转 PNG；下一步用 dsh-vision-skill 的 vision.js 识别该 PNG"}


def extract_psd(path, out_dir):
    """PSD → 合成图 PNG + 图层元数据。"""
    try:
        from PIL import Image
    except ImportError:
        return fail("MISSING_DEP", "缺少 Pillow", "py -m pip install pillow")
    img = Image.open(path)
    meta = {"format": "psd", "size": list(img.size), "mode": img.mode,
            "frames_or_layers": getattr(img, "n_frames", 1)}
    png = os.path.join(out_dir, os.path.splitext(os.path.basename(path))[0] + ".png")
    img.convert("RGB").save(png)
    return {"text": "", "meta": meta, "artifacts": [png],
            "note": "已导出合成图 PNG（PSD 为合成视图，未合并图层的独立内容不在此图内）；可用 vision.js 识别"}


def extract_parquet(path, max_rows=10):
    """parquet → schema + 首个 row group 前 N 行（不全量读入内存）。"""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return fail("MISSING_DEP", "缺少 pyarrow", "py -m pip install pyarrow（parquet 读取）")
    pf = pq.ParquetFile(path)
    schema = pf.schema_arrow
    meta = {
        "format": "parquet",
        "rows": pf.metadata.num_rows,
        "row_groups": pf.metadata.num_row_groups,
        "columns": [{"name": f.name, "type": str(f.type)} for f in schema],
    }
    table = pf.read_row_group(0).slice(0, max_rows)
    header = " | ".join(f.name for f in schema)
    lines = [header, "-" * len(header)]
    for row in table.to_pylist():
        lines.append(" | ".join("" if row.get(f.name) is None else str(row.get(f.name)) for f in schema))
    text = (f"=== parquet: {meta['rows']} 行 × {len(meta['columns'])} 列"
            f"（{meta['row_groups']} 个 row group） ===\n" + "\n".join(lines))
    return {"text": text, "meta": meta}


def extract_msg(path):
    """Outlook .msg（OLE 复合文档）→ 主题/收发件人/日期/附件名/正文。"""
    try:
        import extract_msg
    except ImportError:
        return fail("MISSING_DEP", "缺少 extract-msg", "py -m pip install extract-msg（Outlook .msg 读取）")
    opener = getattr(extract_msg, "openMsg", None) or extract_msg.Message
    msg = opener(path)
    body = ""
    try:
        atts = []
        for att in getattr(msg, "attachments", []) or []:
            name = getattr(att, "longFilename", None) or getattr(att, "shortFilename", None) or "(未命名)"
            atts.append(name)
        meta = {
            "format": "msg",
            "subject": getattr(msg, "subject", "") or "",
            "sender": getattr(msg, "sender", "") or "",
            "to": getattr(msg, "to", "") or "",
            "cc": getattr(msg, "cc", "") or "",
            "date": str(getattr(msg, "date", "") or ""),
            "attachments": atts,
        }
        body = getattr(msg, "body", None) or ""
        if not body:
            html = getattr(msg, "htmlBody", None)
            if isinstance(html, bytes):
                body = strip_html(html.decode("utf-8", "ignore"))
            elif isinstance(html, str):
                body = strip_html(html)
    finally:
        try:
            msg.close()
        except Exception:
            pass
    return {"text": body.strip(), "meta": meta}


DIRECT = {
    "docx": extract_docx, "xlsx": extract_xlsx, "xlsm": extract_xlsx, "xls": extract_xls, "pptx": extract_pptx,
    "pdf": extract_pdf, "rtf": extract_rtf, "html": extract_html, "htm": extract_html,
    "ipynb": extract_ipynb, "csv": extract_csv, "tsv": extract_csv,
    "txt": extract_text, "md": extract_text, "json": extract_text, "yaml": extract_text,
    "yml": extract_text, "xml": extract_text, "log": extract_text,
    "epub": extract_epub, "srt": extract_subtitle, "vtt": extract_subtitle,
    "eml": extract_eml, "svg": extract_svg, "sqlite": extract_sqlite, "db": extract_sqlite,
    "msg": extract_msg, "parquet": extract_parquet,
}

CONVERT = {"doc": "docx", "ppt": "pptx", "pages": "docx", "key": "pptx", "numbers": "xlsx"}


def sniff_ext(path: str) -> str | None:
    """按魔数兜底判定类型（扩展名缺失/不可信时用，与 route.mjs 的 sniff 同源）。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(512)
    except OSError:
        return None
    if head[:5] == b"%PDF-":
        return "pdf"
    if head[:4] == b"PK\x03\x04":
        try:
            with zipfile.ZipFile(path) as zf:
                names = "\n".join(zf.namelist())
        except Exception:
            return "zip"
        if "word/document.xml" in names:
            return "docx"
        if "xl/workbook.xml" in names or "xl/workbook.bin" in names:
            return "xlsx"
        if "ppt/presentation.xml" in names:
            return "pptx"
        if names.startswith("mimetype") and "epub" in names[:200]:
            return "epub"
        return "zip"
    if head[:4] == b"Rar!":
        return "rar"
    if head[:6] == b"7z\xbc\xaf\x27\x1c":
        return "7z"
    if head[:4] == b"\xd0\xcf\x11\xe0":
        return "doc"
    if head[:15] == b"SQLite format 3":
        return "sqlite"
    if head[:5] == b"{\\rtf":
        return "rtf"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        return "heic" if brand in (b"heic", b"heix", b"mif1", b"msf1") else None
    text_head = head.lstrip()[:200].lower()
    if text_head.startswith((b"<?xml", b"<svg", b"<!doctype html", b"<html")):
        return "svg" if b"<svg" in head[:2000].lower() else "html"
    return None


def resolve_ext(path: str) -> tuple[str, bool]:
    """返回 (有效扩展名, 是否由魔数推断)。"""
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    known = set(DIRECT) | set(CONVERT) | {"heic", "heif"}
    if ext in known:
        return ext, False
    guess = sniff_ext(path)
    if guess and (guess in known or guess in ("zip", "rar", "7z")):
        return guess, True
    return ext, False



def parse_args(argv):
    path, max_chars, chunk_chars, out_path = None, DEFAULT_MAX_CHARS, 0, None
    no_cache, refresh = False, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--max-chars" and i + 1 < len(argv):
            max_chars = int(argv[i + 1]); i += 2; continue
        if a == "--chunk-chars" and i + 1 < len(argv):
            chunk_chars = int(argv[i + 1]); i += 2; continue
        if a == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]; i += 2; continue
        if a == "--no-cache":
            no_cache = True; i += 1; continue
        if a == "--refresh":
            refresh = True; i += 1; continue
        if path is None:
            path = a
        i += 1
    return path, max_chars, chunk_chars, out_path, no_cache, refresh


def main() -> int:
    path, max_chars, chunk_chars, out_path, no_cache, refresh = parse_args(sys.argv[1:])
    if not path:
        print(json.dumps(fail("USAGE", "用法: py -X utf8 scripts/extract.py <文件> [--max-chars N] [--chunk-chars N] [--out 文件]"), ensure_ascii=False, indent=2))
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(json.dumps(fail("NOT_FOUND", f"文件不存在: {path}"), ensure_ascii=False, indent=2))
        return 1

    ext, guessed = resolve_ext(path)
    if ext in ("zip", "rar", "7z"):
        print(json.dumps(fail("IS_ARCHIVE", f"这是压缩包（.{ext}），不是文档", "用 node scripts/route.mjs <文件> 或 py -X utf8 scripts/unzip.py <文件>"), ensure_ascii=False, indent=2))
        return 1
    out_dir = os.path.dirname(out_path) if out_path else os.path.join(os.path.dirname(path), "_extract")

    key = cache_key(file_sha256(path), f"extract:{ext}",
                    {"max_chars": max_chars, "chunk_chars": chunk_chars,
                     "name": os.path.basename(path), "out": os.path.basename(out_path) if out_path else None})
    if not no_cache and not refresh:
        hit = cache_get(key)
        if hit:
            print(json.dumps(hit, ensure_ascii=False, indent=2))
            return 0

    if ext in ("heic", "heif"):
        os.makedirs(out_dir, exist_ok=True)
        try:
            result = extract_heic(path, out_dir)
        except Exception as exc:
            result = fail("PARSE_ERROR", f"{ext} 转码失败: {type(exc).__name__}: {exc}",
                          "文件可能不是有效 HEIC（或已损坏）；可用系统「照片」另存为 PNG 后重试")
    elif ext == "psd":
        os.makedirs(out_dir, exist_ok=True)
        try:
            result = extract_psd(path, out_dir)
        except Exception as exc:
            result = fail("PARSE_ERROR", f"psd 解析失败: {type(exc).__name__}: {exc}",
                          "PSD 可能损坏或用了 Pillow 不支持的压缩方式；可在 Photoshop 里另存为 PNG 后重试")
    elif ext in DIRECT:
        try:
            result = DIRECT[ext](path)
        except Exception as exc:
            result = fail("PARSE_ERROR", f"{ext} 解析失败: {type(exc).__name__}: {exc}",
                          "文件可能损坏/加密/不是该格式；可先跑 node scripts/route.mjs <文件> 复核类型")
    elif ext in CONVERT:
        converted, err = convert_with_soffice(path, CONVERT[ext])
        if err:
            print(json.dumps(err, ensure_ascii=False, indent=2))
            return 1
        try:
            result = DIRECT[CONVERT[ext]](converted)
        except Exception as exc:
            result = fail("PARSE_ERROR", f"{ext} 转换后解析失败: {type(exc).__name__}: {exc}")
        result.setdefault("meta", {})["converted_from"] = ext
        result.setdefault("artifacts", []).append(converted)
    else:
        result = fail("UNSUPPORTED_TYPE", f"extract.py 不支持 .{ext}", "先跑 node scripts/route.mjs <文件> 看路由结论")

    if not result.get("ok", True):
        result.setdefault("source", path)
        result.setdefault("type", ext)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    full_text = result.get("text", "")
    text = full_text
    truncated = False
    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True

    payload = {
        "ok": True,
        "source": path,
        "type": ext,
        "handler": "extract.py",
        "artifacts": result.get("artifacts", []),
        "summary": summarize(ext, full_text, result.get("meta", {})),
        "chars": len(full_text),
        "truncated": truncated,
        "cached": False,
        "meta": result.get("meta", {}),
        "text": text,
    }
    if guessed:
        payload["typeInferred"] = True
        payload["meta"]["ext_inferred"] = True
        payload["note"] = f"扩展名缺失/未知，按魔数判定为 {ext}。"
    if result.get("note"):
        payload["note"] = result["note"]

    if chunk_chars > 0 and full_text:
        chunks = [full_text[i:i + chunk_chars] for i in range(0, len(full_text), chunk_chars)]
        payload["chunks"] = [{"index": i + 1, "chars": len(c), "text": c} for i, c in enumerate(chunks)]
        payload["meta"]["chunk_chars"] = chunk_chars
        payload["meta"]["chunk_count"] = len(chunks)
        payload["note"] = (payload.get("note", "") + " " if payload.get("note") else "") + \
            f"文本较长，已切成 {len(chunks)} 块；可逐块交给子代理处理后再汇总。"

    if out_path:
        out_abs = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_abs), exist_ok=True)
        with open(out_abs, "w", encoding="utf-8") as fh:
            fh.write(full_text)
        payload["artifacts"] = payload["artifacts"] + [out_abs]
        payload["text"] = text[:2000]

    if chunk_chars > 0 and payload.get("chunks"):
        payload["summary"] += f"；已切 {len(payload['chunks'])} 块便于逐块处理"

    cache_put(key, {**payload, "text": full_text, "chunks": payload.get("chunks", [])})
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:  # 兜底：永远输出 JSON，不把栈丢给调用方
        print(json.dumps(fail("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}"), ensure_ascii=False, indent=2))
        sys.exit(1)
