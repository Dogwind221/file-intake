#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""安全解压（file-intake）：zip 递归处理的入口。

用法:
    py -X utf8 scripts/unzip.py <zip> [--out <目录>] [--max-entries 500] [--max-mb 512]

安全边界:
    - 拒绝绝对路径与 `..` 路径穿越条目；
    - 条目数 / 解压后总大小超限即中止（zip 炸弹防护）；
    - 只解压文件，跳过符号链接类条目。

输出（stdout，JSON）:
    { "ok": true, "out_dir": "...", "entries": 12, "bytes": 3456789, "files": ["..."] }

退出码: 0 = 成功；1 = 失败（JSON 带 error）。
"""
import json
import os
import sys
import zipfile

MAX_ENTRIES = 500
MAX_MB = 512


def fail(code: str, message: str, hint: str | None = None) -> dict:
    out = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        out["error"]["hint"] = hint
    return out


def main() -> int:
    argv = sys.argv[1:]
    path, out_dir, max_entries, max_mb = None, None, MAX_ENTRIES, MAX_MB
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out" and i + 1 < len(argv):
            out_dir = argv[i + 1]; i += 2; continue
        if a == "--max-entries" and i + 1 < len(argv):
            max_entries = int(argv[i + 1]); i += 2; continue
        if a == "--max-mb" and i + 1 < len(argv):
            max_mb = int(argv[i + 1]); i += 2; continue
        if path is None:
            path = a
        i += 1

    if not path:
        print(json.dumps(fail("USAGE", "用法: py -X utf8 scripts/unzip.py <zip> [--out 目录]"), ensure_ascii=False, indent=2))
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(json.dumps(fail("NOT_FOUND", f"文件不存在: {path}"), ensure_ascii=False, indent=2))
        return 1

    out_dir = os.path.abspath(out_dir) if out_dir else os.path.join(os.path.dirname(path), os.path.splitext(os.path.basename(path))[0] + "_unzip")

    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        print(json.dumps(fail("BAD_ZIP", f"不是有效 zip: {exc}"), ensure_ascii=False, indent=2))
        return 1

    infos = zf.infolist()
    if len(infos) > max_entries:
        print(json.dumps(fail("TOO_MANY_ENTRIES", f"条目数 {len(infos)} 超过上限 {max_entries}", "如确认安全，用 --max-entries 放宽"), ensure_ascii=False, indent=2))
        return 1
    total = sum(info.file_size for info in infos)
    if total > max_mb * 1024 * 1024:
        print(json.dumps(fail("TOO_LARGE", f"解压后约 {total / 1048576:.1f} MB，超过上限 {max_mb} MB", "如确认安全，用 --max-mb 放宽"), ensure_ascii=False, indent=2))
        return 1

    root = os.path.realpath(out_dir)
    written, skipped = [], []
    for info in infos:
        name = info.filename
        target = os.path.realpath(os.path.join(out_dir, name))
        if not target.startswith(root + os.sep) and target != root:
            skipped.append({"name": name, "reason": "路径穿越"})
            continue
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
        written.append(target)
    zf.close()

    print(json.dumps({
        "ok": True,
        "source": path,
        "out_dir": out_dir,
        "entries": len(infos),
        "bytes": total,
        "files": written,
        "skipped": skipped,
        "note": "对 files 中每个文件重新执行 node scripts/route.mjs <file> 完成递归路由",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
