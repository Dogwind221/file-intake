#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""魔数嗅探（独立 CLI）。

用法:
    py -X utf8 scripts/sniff.py <文件> [<文件> ...]

输出（stdout，JSON 数组）:
    [{ "file": "...", "type": "pdf", "head": "255044462d..." }]

说明: route.mjs 内部已有等价嗅探逻辑（Node 实现，无子进程开销）；
本脚本用于手动排查/其他语言调用。两者判定表保持一致。
"""
import json
import os
import sys

MAGIC = [
    (b"%PDF-", "pdf"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"BM", "bmp"),
    (b"II*\x00", "tiff"),
    (b"MM\x00*", "tiff"),
    (b"fLaC", "flac"),
    (b"OggS", "ogg"),
    (b"MThd", "midi"),
    (b"ID3", "mp3"),
    (b"\x1aE\xdf\xa3", "mkv"),
    (b"{\\rtf", "rtf"),
    (b"SQLite format 3", "sqlite"),
    (b"Rar!", "rar"),
    (b"7z\xbc\xaf\x27\x1c", "7z"),
    (b"MZ", "exe"),
    (b"\x7fELF", "elf"),
    (b"\xd0\xcf\x11\xe0", "ole"),
]

TEXT_SAFE = bytes(range(0x09, 0x0E)) + bytes(range(0x20, 0x7F))


def sniff(data: bytes) -> str | None:
    if len(data) < 4:
        return None
    if data.startswith(b"PK\x03\x04"):
        raw = data
        if b"word/document.xml" in raw:
            return "docx"
        if b"xl/workbook.xml" in raw:
            return "xlsx"
        if b"ppt/presentation.xml" in raw:
            return "pptx"
        if b"mimetype" in raw and b"epub" in raw:
            return "epub"
        return "zip"
    if data[:4] == b"RIFF" and data[8:12] in (b"WEBP", b"WAVE", b"AVI "):
        return {b"WEBP": "webp", b"WAVE": "wav", b"AVI ": "avi"}[data[8:12]]
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand.startswith(b"qt"):
            return "mov"
        if brand == b"M4A ":
            return "m4a"
        if brand in (b"heic", b"heix", b"mif1", b"msf1"):
            return "heic"
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand in (b"3gp4", b"3gp5"):
            return "3gp"
        return "mp4"
    for magic, name in MAGIC:
        if data.startswith(magic):
            return name
    if data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    return None


def is_text(data: bytes) -> bool:
    if b"\x00" in data:
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return all(byte in TEXT_SAFE for byte in data)


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print("用法: py -X utf8 scripts/sniff.py <文件> [<文件> ...]", file=sys.stderr)
        return 1
    out = []
    for raw in args:
        path = os.path.abspath(raw)
        if not os.path.isfile(path):
            out.append({"file": path, "type": None, "error": "NOT_FOUND"})
            continue
        with open(path, "rb") as fh:
            head = fh.read(4096)
        detected = sniff(head)
        out.append({
            "file": path,
            "type": detected or ("text" if is_text(head) else None),
            "head": head[:12].hex(),
        })
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if all(item.get("type") for item in out) else 2


if __name__ == "__main__":
    sys.exit(main())
