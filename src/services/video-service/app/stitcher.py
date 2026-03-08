"""
Video stitching — port of stitcher.js.
Concatenates clips with optional crossfade, burns ASS subtitles.
"""

import math
import os
import subprocess
import tempfile
import uuid


def _build_ass(subtitles: list[dict]) -> str:
    """Build ASS subtitle file content from scene subtitle data."""
    header = """\
[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,Arial,56,&H00FFFFFF,&H00000000,-1,0,1,3,1,2,60,60,80

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    current_time = 0.0

    for sub in subtitles:
        phrases    = [p.strip() for p in (sub.get("subtitle_text") or "").split("|") if p.strip()]
        duration   = sub.get("clip_duration", 5)
        if not phrases:
            current_time += duration
            continue

        time_per   = duration / len(phrases)
        for phrase in phrases:
            t_start = current_time
            t_end   = current_time + time_per - 0.1
            events.append(
                f"Dialogue: 0,{_ts(t_start)},{_ts(t_end)},Default,,0,0,0,,{phrase}"
            )
            current_time += time_per

    return header + "\n".join(events) + "\n"


def _ts(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def stitch_videos(
    clips: list[bytes],
    subtitles: list[dict],
    project_id: str,
    *,
    keep_audio: bool = False,
) -> bytes:
    """
    Stitch clips together and burn subtitles.
    Returns final MP4 bytes.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        # Write clip files
        clip_paths = []
        for i, clip in enumerate(clips):
            p = os.path.join(tmpdir, f"clip_{i:03d}.mp4")
            with open(p, "wb") as f:
                f.write(clip)
            clip_paths.append(p)

        # Write concat list
        concat_file = os.path.join(tmpdir, "concat.txt")
        with open(concat_file, "w") as f:
            for p in clip_paths:
                f.write(f"file '{p}'\n")

        # Write ASS subtitle file
        ass_path = os.path.join(tmpdir, "subs.ass")
        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(_build_ass(subtitles))

        # Concatenate
        concat_out = os.path.join(tmpdir, "concat.mp4")
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", concat_file,
        ]
        if not keep_audio:
            cmd += ["-an"]
        cmd += ["-c:v", "libx264", "-c:a", "aac" if keep_audio else "copy", concat_out]
        subprocess.run(cmd, check=True, capture_output=True)

        # Burn subtitles
        final_out = os.path.join(tmpdir, "final.mp4")
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", concat_out,
                "-vf", f"ass={ass_path}",
                "-c:v", "libx264", "-crf", "23", "-preset", "fast",
                "-c:a", "copy" if keep_audio else "an",
                final_out,
            ],
            check=True, capture_output=True,
        )

        with open(final_out, "rb") as f:
            return f.read()
