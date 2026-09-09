#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""统一文档/表格/演示文本提取（file-intake）。

用法:
    py -X utf8 scripts/extract.py <文件> [--max-chars N] [--out <输出文件>]

支持: docx / xlsx / xlsm / pptx / pdf(需 pypdf) / rtf / html / htm / ipynb /
      csv / tsv / txt / md / json / yaml / xml / log / heic|heif(转 PNG)

输出（stdout，JSON）:
    { "ok": true, "type": "docx", "chars": 1234, "text": "...", "meta": {...}, "artifacts": [...] }
    { "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }

退出码: 0 = 成功；1 = 失败（JSON 里带 error）。
"""
import csv
import io
import json
import os
import re
import sys
import zipfile

DEFAULT_MAX_CHARS = 20000


def fail(code: str, message: str, hint: str | None = None) -> dict:
    out = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        out["error"]["hint"] = hint
    return out


def parse_args(argv):
    path = None
    max_chars = DEFAULT_MAX_CHARS
    out_path = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--max-chars" and i + 1 < len(argv):
            max_chars = int(argv[i + 1]); i += 2; continue
        if a == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]; i += 2; continue
        if path is None:
            path = a
        i += 1
    return path, max_chars, out_path


# ── 各格式提取 ────────────────────────────────────────────────

def extract_docx(path):
    """docx = zip + XML；直接解 XML 文本，零第三方依赖。"""
    with zipfile.ZipFile(path) as zf:
        names = [n for n in zf.namelist() if n == "word/document.xml"]
        if not names:
            return fail("PARSE_ERROR", "docx 缺少 word/document.xml")
        xml = zf.read("word/document.xml").decode("utf-8", "ignore")
    # 段落 </w:p> → 换行；制表 <w:tab/> → \t
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
    reader = PdfReader(path)
    pages = []
    for i, page in enumerate(reader.pages, 1):
        try:
            pages.append(f"--- 第 {i} 页 ---\n{(page.extract_text() or '').strip()}")
        except Exception as exc:  # 单页失败不影响整体
            pages.append(f"--- 第 {i} 页 ---\n[提取失败] {exc}")
    meta = {"format": "pdf", "pages": len(reader.pages), "encrypted": reader.is_encrypted}
    return {"text": "\n\n".join(pages).strip(), "meta": meta}


def extract_rtf(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    raw = re.sub(r"\\'([0-9a-f]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252", "ignore"), raw)
    raw = re.sub(r"\\u(-?\d+)\??", lambda m: chr(int(m.group(1)) + 65536 if int(m.group(1)) < 0 else int(m.group(1))), raw)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", raw)
    text = text.replace("\\{", "{").replace("\\}", "}").replace("\\\n", "\n")
    text = re.sub(r"[{}]", "", text)
    return {"text": re.sub(r"\n{3,}", "\n\n", text).strip(), "meta": {"format": "rtf"}}


def extract_html(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", raw)
    text = re.sub(r"<[^>]+>", " ", raw)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return {"text": re.sub(r"\n{3,}", "\n\n", text).strip(), "meta": {"format": "html"}}


def extract_ipynb(path):
    nb = json.load(open(path, encoding="utf-8"))
    parts = []
    for i, cell in enumerate(nb.get("cells", []), 1):
        src = "".join(cell.get("source", []))
        parts.append(f"--- cell {i} [{cell.get('cell_type')}] ---\n{src}")
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
    text = "\n".join(" | ".join(r) for r in rows)
    return {"text": text, "meta": {"format": "csv", "preview_rows": len(rows)}}


def extract_text(path):
    text = open(path, encoding="utf-8", errors="ignore").read()
    return {"text": text, "meta": {"format": "text"}}


def extract_heic(path, out_dir):
    """HEIC/HEIF → PNG（本机 ffmpeg 无 HEIF 解码器，走 Pillow + pillow-heif）。"""
    try:
        from PIL import Image
    except ImportError:
        return fail("MISSING_DEP", "缺少 Pillow", "py -m pip install pillow pillow-heif")
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        return fail(
            "MISSING_DEP",
            "缺少 pillow-heif，无法解码 HEIC/HEIF",
            "py -m pip install pillow-heif  （装好后重跑；或先用系统「照片」导出为 PNG）",
        )
    img = Image.open(path)
    png = os.path.join(out_dir, os.path.splitext(os.path.basename(path))[0] + ".png")
    img.convert("RGB").save(png)
    return {
        "text": "",
        "meta": {"format": "heic", "converted": True, "size": list(img.size)},
        "artifacts": [png],
        "note": "已转 PNG；下一步用 dsh-vision-skill 的 vision.js 识别该 PNG",
    }


HANDLERS = {
    "docx": extract_docx,
    "xlsx": extract_xlsx,
    "xlsm": extract_xlsx,
    "pptx": extract_pptx,
    "pdf": extract_pdf,
    "rtf": extract_rtf,
    "html": extract_html,
    "htm": extract_html,
    "ipynb": extract_ipynb,
    "csv": extract_csv,
    "tsv": extract_csv,
    "txt": extract_text,
    "md": extract_text,
    "json": extract_text,
    "yaml": extract_text,
    "yml": extract_text,
    "xml": extract_text,
    "log": extract_text,
}


def main() -> int:
    path, max_chars, out_path = parse_args(sys.argv[1:])
    if not path:
        print(json.dumps(fail("USAGE", "用法: py -X utf8 scripts/extract.py <文件> [--max-chars N] [--out 文件]"), ensure_ascii=False, indent=2))
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(json.dumps(fail("NOT_FOUND", f"文件不存在: {path}"), ensure_ascii=False, indent=2))
        return 1

    ext = os.path.splitext(path)[1].lower().lstrip(".")
    out_dir = os.path.dirname(out_path) if out_path else os.path.join(os.path.dirname(path), "_extract")

    if ext in ("heic", "heif"):
        os.makedirs(out_dir, exist_ok=True)
        result = extract_heic(path, out_dir)
    elif ext in HANDLERS:
        result = HANDLERS[ext](path)
    else:
        result = fail("UNSUPPORTED_TYPE", f"extract.py 不支持 .{ext}", "先跑 node scripts/route.mjs <文件> 看路由结论")

    if not result.get("ok", True):
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    text = result.get("text", "")
    truncated = False
    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True
    payload = {
        "ok": True,
        "source": path,
        "type": ext,
        "chars": len(result.get("text", "")),
        "truncated": truncated,
        "meta": result.get("meta", {}),
        "artifacts": result.get("artifacts", []),
        "text": text,
    }
    if result.get("note"):
        payload["note"] = result["note"]
    if out_path:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(result.get("text", ""))
        payload["artifacts"] = payload["artifacts"] + [os.path.abspath(out_path)]
        payload["text"] = text[:2000]
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
