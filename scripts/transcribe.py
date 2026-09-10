#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""音频/视频转写与 MIDI 元数据（file-intake）。

用法:
    py -X utf8 scripts/transcribe.py <文件> [--model small] [--lang zh] [--out <文本文件>]
                                     [--chunk-minutes 10] [--no-cache] [--refresh]

音频: mp3 wav m4a flac ogg aac opus wma aiff  → faster-whisper 转写
视频: mp4 avi mkv mov webm flv wmv m4v 3gp    → faster-whisper 直接解码（内含 ffmpeg 解码）
MIDI: mid  → mido 解析曲速/音轨/音符数（不做语音转写）

大文件策略: 时长超过 --chunk-minutes（默认 10 分钟；0 = 不分段）时用 ffmpeg 分段转写，
            再按时间偏移合并——长音频一次性转写容易吃满内存或超时。

缓存: 按「文件 sha256 + 处理器 + 模型/语言/分段」缓存到 ~/.dsh/file-intake-cache
      （FILE_INTAKE_CACHE 可覆盖；--no-cache 跳过读、--refresh 强制重算）。whisper 很贵，重复处理应秒回。

输出（stdout，JSON）:
    { "ok": true, "type": "audio", "chars": 123, "cached": false,
      "text": "...", "meta": {...}, "artifacts": [...] }

退出码: 0 = 成功；1 = 失败（JSON 带 error）。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time


def fail(code: str, message: str, hint: str | None = None) -> dict:
    out = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        out["error"]["hint"] = hint
    return out


# ── 缓存（与 extract.py 同一格式，可互相复用） ────────────────

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
        payload.setdefault("artifacts", []).insert(0, text_path)
    payload["cached"] = True
    return payload


def cache_put(key: str, payload: dict) -> None:
    meta_path, text_path = cache_paths(key)
    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    with open(text_path, "w", encoding="utf-8") as fh:
        fh.write(payload.get("text", ""))
    stored = {k: v for k, v in payload.items() if k != "text"}
    stored.setdefault("artifacts", []).insert(0, text_path)
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(stored, fh, ensure_ascii=False, indent=2)


def parse_args(argv):
    path, model, lang, out_path = None, "small", "zh", None
    chunk_minutes, no_cache, refresh = 10.0, False, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--model" and i + 1 < len(argv):
            model = argv[i + 1]; i += 2; continue
        if a == "--lang" and i + 1 < len(argv):
            lang = argv[i + 1]; i += 2; continue
        if a == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]; i += 2; continue
        if a == "--chunk-minutes" and i + 1 < len(argv):
            chunk_minutes = float(argv[i + 1]); i += 2; continue
        if a == "--no-cache":
            no_cache = True; i += 1; continue
        if a == "--refresh":
            refresh = True; i += 1; continue
        if path is None:
            path = a
        i += 1
    return path, model, lang, out_path, chunk_minutes, no_cache, refresh


def find_ffmpeg() -> str | None:
    env = os.environ.get("FFMPEG_BIN")
    if env and os.path.isfile(env):
        return env
    return shutil.which("ffmpeg")


def probe_duration(path: str) -> float:
    """用 ffprobe/ffmpeg 估时长；失败返回 0（视为不分段）。"""
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
                capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=60,
            )
            return float(json.loads(out.stdout)["format"]["duration"])
        except Exception:
            pass
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        try:
            out = subprocess.run([ffmpeg, "-i", path], capture_output=True, text=True,
                                 encoding="utf-8", errors="ignore", timeout=60)
            text = (out.stderr or "") + (out.stdout or "")
            h = int((__import__("re").search(r"Duration: (\d+):(\d+):(\d+)", text) or [0, 0, 0, 0])[1] or 0)
            m = int((__import__("re").search(r"Duration: (\d+):(\d+):(\d+)", text) or [0, 0, 0, 0])[2] or 0)
            s = int((__import__("re").search(r"Duration: (\d+):(\d+):(\d+)", text) or [0, 0, 0, 0])[3] or 0)
            return h * 3600 + m * 60 + s
        except Exception:
            return 0
    return 0


def transcribe_midi(path):
    try:
        import mido
    except ImportError:
        return fail("MISSING_DEP", "缺少 mido", "py -m pip install mido")
    mid = mido.MidiFile(path)
    tracks = []
    for track in mid.tracks:
        notes = sum(1 for m in track if m.type == "note_on" and m.velocity > 0)
        tempos = [round(mido.tempo2bpm(m.tempo)) for m in track if m.type == "set_tempo"]
        tracks.append({"name": track.name or "(未命名)", "events": len(track), "notes": notes, "tempo_bpm": tempos[:3]})
    return {
        "ok": True, "type": "midi", "chars": 0, "text": "",
        "meta": {"format": "midi", "midi_type": mid.type, "duration_sec": round(mid.length, 1), "tracks": tracks},
    }


def transcribe_file(model, path, lang):
    """单段转写，返回 (segments, info)。"""
    segments, info = model.transcribe(path, language=lang, vad_filter=True)
    items = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
    return items, info


def transcribe_audio(path, model_name, lang, chunk_minutes):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return fail("MISSING_DEP", "缺少 faster-whisper", "py -m pip install faster-whisper")
    started = time.time()
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    except Exception as exc:
        return fail("MODEL_LOAD_FAILED", f"模型加载失败: {exc}", "首次运行需联网下载模型（必要时设 HTTPS_PROXY）")

    duration = probe_duration(path)
    chunked = False
    segments_all, language, lang_prob = [], lang, 0.0
    chunks_meta = []
    tmp_dir = None
    try:
        if chunk_minutes > 0 and duration > chunk_minutes * 60:
            ffmpeg = find_ffmpeg()
            if not ffmpeg:
                return fail("MISSING_TOOL", "长文件需要 ffmpeg 分段", "装 ffmpeg 或加 --chunk-minutes 0 强制整段转写")
            chunked = True
            tmp_dir = tempfile.mkdtemp(prefix="file-intake-chunk-")
            step = int(chunk_minutes * 60)
            offset = 0
            index = 0
            while offset < duration:
                index += 1
                out = os.path.join(tmp_dir, f"part{index:03d}.wav")
                subprocess.run(
                    [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", str(offset), "-t", str(step),
                     "-i", path, "-ar", "16000", "-ac", "1", out],
                    capture_output=True, timeout=900,
                )
                if not os.path.isfile(out) or os.path.getsize(out) == 0:
                    break
                items, info = transcribe_file(model, out, lang)
                language = getattr(info, "language", language)
                lang_prob = max(lang_prob, float(getattr(info, "language_probability", 0)))
                for item in items:
                    segments_all.append({
                        "start": round(item["start"] + offset, 2),
                        "end": round(item["end"] + offset, 2),
                        "text": item["text"],
                        "chunk": index,
                    })
                chunks_meta.append({
                    "index": index,
                    "start_sec": round(offset, 1),
                    "end_sec": round(min(offset + step, duration), 1),
                    "segments": len(items),
                    "chars": len("".join(i["text"] for i in items)),
                })
                offset += step
        else:
            items, info = transcribe_file(model, path, lang)
            language = getattr(info, "language", lang)
            lang_prob = float(getattr(info, "language_probability", 0))
            segments_all = items
    except Exception as exc:
        return fail("TRANSCRIBE_FAILED", f"转写失败: {exc}", "确认文件可被 ffmpeg 解码；视频建议先转 wav")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    parts = [s["text"] for s in segments_all if s["text"]]
    text = "\n".join(parts)
    note = None
    if chunked and not text:
        note = f"已分 {len(chunks_meta)} 段转写，但未识别到语音内容（纯音乐/静音/元数据音轨）。"
    return {
        "ok": True,
        "type": "audio",
        "chars": len("".join(parts)),
        "text": text,
        "note": note,
        "meta": {
            "format": os.path.splitext(path)[1].lstrip("."),
            "model": model_name,
            "language": language,
            "language_probability": round(lang_prob, 3),
            "duration_sec": round(duration, 1),
            "elapsed_sec": round(time.time() - started, 1),
            "chunked": chunked,
            "chunk_count": len(chunks_meta) if chunked else 1,
            "chunks": chunks_meta,
            "segments": segments_all,
        },
    }


def main() -> int:
    path, model, lang, out_path, chunk_minutes, no_cache, refresh = parse_args(sys.argv[1:])
    if not path:
        print(json.dumps(fail("USAGE", "用法: py -X utf8 scripts/transcribe.py <音频/视频/MIDI> [--model small] [--lang zh] [--chunk-minutes 10]"), ensure_ascii=False, indent=2))
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(json.dumps(fail("NOT_FOUND", f"文件不存在: {path}"), ensure_ascii=False, indent=2))
        return 1

    ext = os.path.splitext(path)[1].lower().lstrip(".")
    key = cache_key(file_sha256(path), f"transcribe:{ext}", {"model": model, "lang": lang, "chunk_minutes": chunk_minutes})
    if not no_cache and not refresh:
        hit = cache_get(key)
        if hit:
            print(json.dumps(hit, ensure_ascii=False, indent=2))
            return 0

    if ext in ("mid", "midi"):
        result = transcribe_midi(path)
    elif ext in ("mp3", "wav", "m4a", "flac", "ogg", "aac", "opus", "wma", "aiff",
                 "mp4", "avi", "mkv", "mov", "webm", "flv", "wmv", "m4v", "3gp"):
        result = transcribe_audio(path, model, lang, chunk_minutes)
    else:
        result = fail("UNSUPPORTED_TYPE", f"transcribe.py 不支持 .{ext}", "先跑 node scripts/route.mjs <文件>")

    if not result.get("ok"):
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    payload = {
        "ok": True,
        "source": path,
        "type": result.get("type", ext),
        "chars": result.get("chars", 0),
        "cached": False,
        "meta": result.get("meta", {}),
        "artifacts": result.get("artifacts", []),
        "text": result.get("text", ""),
    }
    if out_path:
        out_abs = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_abs), exist_ok=True)
        with open(out_abs, "w", encoding="utf-8") as fh:
            fh.write(result.get("text", ""))
        payload["artifacts"].append(out_abs)
        payload["text"] = payload["text"][:2000]
    cache_put(key, {**payload, "text": result.get("text", "")})
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:  # 兜底：永远输出 JSON
        print(json.dumps(fail("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}"), ensure_ascii=False, indent=2))
        sys.exit(1)
