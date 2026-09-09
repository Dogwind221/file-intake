#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""音频/视频转写与 MIDI 元数据（file-intake）。

用法:
    py -X utf8 scripts/transcribe.py <文件> [--model small] [--lang zh] [--out <文本文件>]

音频: mp3 wav m4a flac ogg aac opus wma aiff  → faster-whisper 转写
视频: mp4 avi mkv mov webm flv wmv m4v 3gp    → faster-whisper 直接解码（内含 ffmpeg 解码）
MIDI: mid  → mido 解析曲速/音轨/音符数（不做语音转写）

输出（stdout，JSON）:
    { "ok": true, "type": "audio", "language": "zh", "duration": 12.3,
      "model": "small", "chars": 123, "text": "...", "segments": [...], "artifacts": [...] }

退出码: 0 = 成功；1 = 失败（JSON 带 error）。
"""
import json
import os
import sys
import time


def fail(code: str, message: str, hint: str | None = None) -> dict:
    out = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        out["error"]["hint"] = hint
    return out


def parse_args(argv):
    path, model, lang, out_path = None, "small", "zh", None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--model" and i + 1 < len(argv):
            model = argv[i + 1]; i += 2; continue
        if a == "--lang" and i + 1 < len(argv):
            lang = argv[i + 1]; i += 2; continue
        if a == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]; i += 2; continue
        if path is None:
            path = a
        i += 1
    return path, model, lang, out_path


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
        "meta": {"format": "midi", "type": mid.type, "duration_sec": round(mid.length, 1), "tracks": tracks},
    }


def transcribe_audio(path, model_name, lang):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return fail("MISSING_DEP", "缺少 faster-whisper", "py -m pip install faster-whisper")
    started = time.time()
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    except Exception as exc:
        return fail("MODEL_LOAD_FAILED", f"模型加载失败: {exc}", "首次运行需联网下载模型（必要时设 HTTPS_PROXY）")
    try:
        segments, info = model.transcribe(path, language=lang, vad_filter=True)
        items, parts = [], []
        for seg in segments:
            items.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
            parts.append(seg.text.strip())
    except Exception as exc:
        return fail("TRANSCRIBE_FAILED", f"转写失败: {exc}", "确认文件可被 ffmpeg 解码；视频建议先转 wav")
    return {
        "ok": True,
        "type": "audio",
        "chars": len("".join(parts)),
        "text": "\n".join(parts),
        "meta": {
            "format": os.path.splitext(path)[1].lstrip("."),
            "model": model_name,
            "language": getattr(info, "language", lang),
            "language_probability": round(float(getattr(info, "language_probability", 0)), 3),
            "duration_sec": round(float(getattr(info, "duration", 0)), 1),
            "elapsed_sec": round(time.time() - started, 1),
            "segments": items,
        },
    }


def main() -> int:
    path, model, lang, out_path = parse_args(sys.argv[1:])
    if not path:
        print(json.dumps(fail("USAGE", "用法: py -X utf8 scripts/transcribe.py <音频/视频/MIDI> [--model small] [--lang zh] [--out 文件]"), ensure_ascii=False, indent=2))
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(json.dumps(fail("NOT_FOUND", f"文件不存在: {path}"), ensure_ascii=False, indent=2))
        return 1

    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext in ("mid", "midi"):
        result = transcribe_midi(path)
    elif ext in ("mp3", "wav", "m4a", "flac", "ogg", "aac", "opus", "wma", "aiff",
                 "mp4", "avi", "mkv", "mov", "webm", "flv", "wmv", "m4v", "3gp"):
        result = transcribe_audio(path, model, lang)
    else:
        result = fail("UNSUPPORTED_TYPE", f"transcribe.py 不支持 .{ext}", "先跑 node scripts/route.mjs <文件>")

    if not result.get("ok"):
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    if out_path:
        out_abs = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_abs), exist_ok=True)
        with open(out_abs, "w", encoding="utf-8") as fh:
            fh.write(result.get("text", ""))
        result.setdefault("artifacts", []).append(out_abs)
        result["text"] = result.get("text", "")[:2000]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
