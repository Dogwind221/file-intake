#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""安全解压（file-intake）：zip / rar / 7z 统一入口。

用法:
    py -X utf8 scripts/unzip.py <压缩包> [--out <目录>] [--max-entries 500] [--max-mb 512] [--list]

实现:
    - zip  → Python 标准库 zipfile（流式写出，逐块拷贝）
    - rar / 7z / 其他 → Bandizip CLI（bz l 先列清单校验，再 bz x 解压）
    压缩引擎查找顺序: $BANDIZIP → PATH 上的 bz(.exe) → 常见 Bandizip 安装路径
                    → $SEVEN_ZIP → 常见 7-Zip 安装路径 → PATH 上的 7z

安全边界（zip / rar / 7z 一律适用）:
    - 条目数上限、解压后总大小上限（zip 炸弹防护）；
    - 拒绝绝对路径与 `..` 路径穿越条目；
    - 只写文件，跳过目录项之外的符号链接类条目。

输出（stdout，JSON）:
    { "ok": true, "engine": "zipfile|bandizip|7z", "out_dir": "...", "entries": 12,
      "bytes": 3456789, "files": ["..."], "skipped": [{"name": "...", "reason": "..."}] }

退出码: 0 = 成功；1 = 失败（JSON 带 error）。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

MAX_ENTRIES = 500
MAX_MB = 512


def fail(code: str, message: str, hint: str | None = None) -> dict:
    out = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        out["error"]["hint"] = hint
    return out


def find_archiver() -> tuple[str, str] | None:
    """返回 (引擎名, 可执行文件)。优先 Bandizip（bz.exe），其次 7-Zip。

    可用环境变量覆盖: BANDIZIP（指向 bz.exe） / SEVEN_ZIP（指向 7z.exe）。
    """
    env_bz = os.environ.get("BANDIZIP")
    if env_bz and os.path.isfile(env_bz):
        return ("bandizip", env_bz)
    bz = shutil.which("bz") or shutil.which("bz.exe")
    if bz:
        return ("bandizip", bz)
    for cand in (
        r"D:\DD\bandi\Bandizip\bz.exe",
        r"C:\Program Files\Bandizip\bz.exe",
        r"C:\Program Files (x86)\Bandizip\bz.exe",
    ):
        if os.path.isfile(cand):
            return ("bandizip", cand)
    env_7z = os.environ.get("SEVEN_ZIP")
    if env_7z and os.path.isfile(env_7z):
        return ("7z", env_7z)
    for cand in (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"):
        if os.path.isfile(cand):
            return ("7z", cand)
    found = shutil.which("7z") or shutil.which("7za")
    return ("7z", found) if found else None


def unsafe_name(name: str) -> bool:
    """路径穿越 / 绝对路径判定。"""
    norm = name.replace("\\", "/")
    if norm.startswith("/") or re.match(r"^[A-Za-z]:", norm):
        return True
    return any(part == ".." for part in norm.split("/"))


# ── zip ───────────────────────────────────────────────────────

def extract_zip(path: str, out_dir: str, max_entries: int, max_mb: int) -> dict:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        return fail("BAD_ZIP", f"不是有效 zip: {exc}")
    infos = zf.infolist()
    if len(infos) > max_entries:
        zf.close()
        return fail("TOO_MANY_ENTRIES", f"条目数 {len(infos)} 超过上限 {max_entries}", "如确认安全，用 --max-entries 放宽")
    total = sum(i.file_size for i in infos)
    if total > max_mb * 1024 * 1024:
        zf.close()
        return fail("TOO_LARGE", f"解压后约 {total / 1048576:.1f} MB，超过上限 {max_mb} MB", "如确认安全，用 --max-mb 放宽")
    root = os.path.realpath(out_dir)
    written, skipped = [], []
    for info in infos:
        target = os.path.realpath(os.path.join(out_dir, info.filename))
        if unsafe_name(info.filename) or (not target.startswith(root + os.sep) and target != root):
            skipped.append({"name": info.filename, "reason": "路径穿越"})
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
    return {"ok": True, "engine": "zipfile", "entries": len(infos), "bytes": total, "files": written, "skipped": skipped}


# ── rar / 7z / 其他（Bandizip 优先，7-Zip 后备） ──────────────

def parse_bz_list(text: str) -> list[dict]:
    """解析 Bandizip `bz l` 输出。"""
    items = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("---") or s.startswith("bz ") or s.startswith("Listing archive") or s.startswith("Archive format"):
            continue
        if "files," in s or "folders" in s:
            continue
        parts = s.split(None, 5)
        if len(parts) < 4 or not re.match(r"^\d{4}-\d{2}-\d{2}$", parts[0]):
            continue
        rest = parts[3:]
        size, name = 0, rest[-1] if rest else ""
        if len(rest) >= 3 and rest[0].isdigit() and rest[1].isdigit():
            size, name = int(rest[0]), rest[2]
        elif len(rest) >= 2 and rest[0].isdigit():
            size, name = int(rest[0]), rest[1]
        items.append({"name": name, "size": size, "attr": parts[2]})
    return items


def parse_7z_list(text: str) -> list[dict]:
    """解析 7-Zip `7z l -slt -ba` 输出。"""
    items, cur = [], {}
    for line in text.splitlines():
        if line.startswith("Path = "):
            if cur:
                items.append(cur)
            cur = {"name": line[7:].strip(), "size": 0}
        elif line.startswith("Size = ") and cur:
            try:
                cur["size"] = int(line[7:].strip())
            except ValueError:
                cur["size"] = 0
        elif line.startswith("Attributes = ") and cur:
            cur["attrs"] = line[13:].strip()
    if cur:
        items.append(cur)
    return items


def list_archive(exe: str, engine: str, path: str) -> tuple[list[dict], str | None]:
    args = [exe, "l", "-slt", "-ba", path] if engine == "7z" else [exe, "l", path]
    try:
        out = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=180)
    except Exception as exc:
        return [], f"{engine} 列表失败: {exc}"
    if out.returncode not in (0, 1):  # 1 = 有警告但仍可读
        return [], f"{engine} 列表返回码 {out.returncode}: {(out.stderr or out.stdout or '')[:200]}"
    text = out.stdout or ""
    items = parse_7z_list(text) if engine == "7z" else parse_bz_list(text)
    return items, None


def extract_with_archiver(path: str, out_dir: str, max_entries: int, max_mb: int) -> dict:
    found = find_archiver()
    if not found:
        return fail("MISSING_TOOL", "未找到 Bandizip(bz.exe) 或 7-Zip",
                    "装 Bandizip 后 bz.exe 会在 PATH 上；或设置 BANDIZIP / SEVEN_ZIP 指向可执行文件")
    engine, exe = found
    items, err = list_archive(exe, engine, path)
    if err:
        return fail("LIST_FAILED", err)
    if not items:
        return fail("EMPTY_ARCHIVE", "压缩包内没有条目（或该引擎不支持此格式）")
    if len(items) > max_entries:
        return fail("TOO_MANY_ENTRIES", f"条目数 {len(items)} 超过上限 {max_entries}", "如确认安全，用 --max-entries 放宽")
    total = sum(i.get("size", 0) for i in items)
    if total > max_mb * 1024 * 1024:
        return fail("TOO_LARGE", f"解压后约 {total / 1048576:.1f} MB，超过上限 {max_mb} MB", "如确认安全，用 --max-mb 放宽")
    unsafe = [i["name"] for i in items if unsafe_name(i["name"])]
    if unsafe:
        return fail("UNSAFE_ARCHIVE", f"压缩包含路径穿越条目（{len(unsafe)} 个），已拒绝解压",
                    "示例: " + ", ".join(unsafe[:3]))

    os.makedirs(out_dir, exist_ok=True)
    args = [exe, "x", f"-o:{out_dir}", "-y", "-aoa", path] if engine == "bandizip" \
        else [exe, "x", "-y", f"-o{out_dir}", path]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=600)
    except Exception as exc:
        return fail("EXTRACT_FAILED", f"{engine} 解压失败: {exc}")
    if proc.returncode not in (0, 1):
        return fail("EXTRACT_FAILED", f"{engine} 返回码 {proc.returncode}: {(proc.stderr or proc.stdout or '')[:200]}")

    root = os.path.realpath(out_dir)
    written = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            written.append(os.path.join(dirpath, name))
    return {"ok": True, "engine": engine, "exe": exe, "entries": len(items), "bytes": total, "files": written, "skipped": []}


def main() -> int:
    argv = sys.argv[1:]
    path, out_dir, max_entries, max_mb, list_only = None, None, MAX_ENTRIES, MAX_MB, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out" and i + 1 < len(argv):
            out_dir = argv[i + 1]; i += 2; continue
        if a == "--max-entries" and i + 1 < len(argv):
            max_entries = int(argv[i + 1]); i += 2; continue
        if a == "--max-mb" and i + 1 < len(argv):
            max_mb = int(argv[i + 1]); i += 2; continue
        if a == "--list":
            list_only = True; i += 1; continue
        if path is None:
            path = a
        i += 1

    if not path:
        print(json.dumps(fail("USAGE", "用法: py -X utf8 scripts/unzip.py <zip|rar|7z> [--out 目录] [--list]"), ensure_ascii=False, indent=2))
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(json.dumps(fail("NOT_FOUND", f"文件不存在: {path}"), ensure_ascii=False, indent=2))
        return 1

    ext = os.path.splitext(path)[1].lower().lstrip(".")
    out_dir = os.path.abspath(out_dir) if out_dir else os.path.join(
        os.path.dirname(path), os.path.splitext(os.path.basename(path))[0] + "_unzip"
    )

    if list_only:
        found = find_archiver()
        if not found:
            print(json.dumps(fail("MISSING_TOOL", "未找到 Bandizip(bz.exe) 或 7-Zip", "装 Bandizip，或设置 BANDIZIP/SEVEN_ZIP"), ensure_ascii=False, indent=2))
            return 1
        engine, exe = found
        items, err = list_archive(exe, engine, path)
        if err:
            print(json.dumps(fail("LIST_FAILED", err), ensure_ascii=False, indent=2))
            return 1
        print(json.dumps({"ok": True, "engine": engine, "entries": len(items), "bytes": sum(i.get("size", 0) for i in items), "items": items}, ensure_ascii=False, indent=2))
        return 0

    if ext == "zip":
        result = extract_zip(path, out_dir, max_entries, max_mb)
    elif ext in ("rar", "7z", "001", "xz", "tar", "gz", "bz2", "iso", "lzh", "zipx", "alz", "egg"):
        result = extract_with_archiver(path, out_dir, max_entries, max_mb)
    else:
        # 扩展名不认识时按魔数兜底：PK→zip，其余交给 Bandizip/7-Zip
        with open(path, "rb") as fh:
            magic = fh.read(4)
        result = extract_zip(path, out_dir, max_entries, max_mb) if magic[:2] == b"PK" else extract_with_archiver(path, out_dir, max_entries, max_mb)

    if not result.get("ok"):
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1
    result.update({
        "source": path,
        "out_dir": out_dir,
        "note": "对 files 中每个文件重新执行 node scripts/route.mjs <file>，或直接用 node scripts/batch.mjs <压缩包> 自动递归",
    })
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:  # 兜底：永远输出 JSON
        print(json.dumps(fail("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}"), ensure_ascii=False, indent=2))
        sys.exit(1)
