"""
Standard mode — video concatenation.

Takes N video clips and produces one final MP4. Normalizes codecs/fps
if needed, then uses ffmpeg concat demuxer for lossless joining.
"""

import asyncio
import os
import subprocess
import tempfile

import httpx

from ...storage import upload_file, download_file

TARGET_FPS = 24


async def concat_clips(
    clips: list[dict],
    job_id: str,
    output_format: str = "mp4",
    target_fps: int = TARGET_FPS,
) -> dict:
    """
    Download, normalize, and concatenate video clips into a single file.

    Args:
        clips:          list of GeneratedClip dicts (must have "video_url" and "index")
        job_id:         unique job identifier
        output_format:  "mp4" (default) or "webm"
        target_fps:     target frame rate (default 24)

    Returns ConcatResult dict:
        output_url, duration_seconds, resolution, file_size_bytes
    """
    _check_ffmpeg()

    sorted_clips = sorted(clips, key=lambda c: c["index"])

    with tempfile.TemporaryDirectory(prefix=f"concat-{job_id}-") as tmpdir:
        # Step 1: Download clips in parallel
        raw_paths = await _download_clips(sorted_clips, tmpdir)

        # Step 2: Normalize clips to consistent codec/fps
        norm_paths = _normalize_clips(raw_paths, tmpdir, target_fps)

        # Step 3: Concat via ffmpeg demuxer
        final_path = _concat(norm_paths, tmpdir, job_id, output_format)

        # Step 4: Read result and get metadata
        with open(final_path, "rb") as f:
            final_bytes = f.read()

        probe = _probe(final_path)

        # Step 5: Upload to MinIO
        ext = output_format
        output_name = f"output/{job_id}/final.{ext}"
        content_type = "video/mp4" if ext == "mp4" else "video/webm"
        output_url = upload_file(final_bytes, output_name, content_type=content_type)

    # tmpdir cleaned up automatically

    return {
        "output_url":      output_url,
        "output_bytes":    final_bytes,
        "duration_seconds": probe["duration"],
        "resolution":      probe["resolution"],
        "file_size_bytes":  len(final_bytes),
    }


async def _download_clips(clips: list[dict], tmpdir: str) -> list[str]:
    """Download all clips in parallel. Returns list of local file paths."""
    async def _dl(clip: dict, idx: int) -> str:
        path = os.path.join(tmpdir, f"clip_{idx:02d}.mp4")
        video_url = clip["video_url"]

        # If it's a MinIO storage path, download from MinIO
        if video_url.startswith("/storage/"):
            data = download_file(video_url)
        elif "video_bytes" in clip:
            data = clip["video_bytes"]
        else:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.get(video_url)
                resp.raise_for_status()
                data = resp.content

        with open(path, "wb") as f:
            f.write(data)
        return path

    tasks = [_dl(clip, i) for i, clip in enumerate(clips)]
    return await asyncio.gather(*tasks)


def _normalize_clips(raw_paths: list[str], tmpdir: str, target_fps: int) -> list[str]:
    """
    Normalize all clips to the same codec, fps, and pixel format.
    Always re-encodes to guarantee concat compatibility.
    """
    norm_paths = []
    for i, raw in enumerate(raw_paths):
        norm = os.path.join(tmpdir, f"norm_{i:02d}.mp4")
        cmd = [
            "ffmpeg", "-y",
            "-i", raw,
            "-vf", f"fps={target_fps},scale=1280:720:force_original_aspect_ratio=decrease,"
                   f"pad=1280:720:(ow-iw)/2:(oh-ih)/2",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-an",
            norm,
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            print(f"[video/concat] Normalize clip {i} stderr: {result.stderr.decode()[-500:]}")
            raise RuntimeError(f"Failed to normalize clip {i}: ffmpeg exit {result.returncode}")
        norm_paths.append(norm)

    return norm_paths


def _concat(norm_paths: list[str], tmpdir: str, job_id: str, fmt: str) -> str:
    """Concatenate normalized clips using ffmpeg concat demuxer."""
    concat_list = os.path.join(tmpdir, "list.txt")
    with open(concat_list, "w") as f:
        for p in norm_paths:
            f.write(f"file '{p}'\n")

    final = os.path.join(tmpdir, f"final_{job_id}.{fmt}")
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_list,
        "-c", "copy",
        final,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        # Fallback: re-encode concat if copy fails
        print(f"[video/concat] Copy-concat failed, falling back to re-encode")
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", concat_list,
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            final,
        ]
        subprocess.run(cmd, check=True, capture_output=True)

    return final


def _probe(path: str) -> dict:
    """Get duration and resolution from an MP4 file via ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format", "-show_streams",
                path,
            ],
            capture_output=True, check=True,
        )
        import json
        info = json.loads(result.stdout)

        duration = float(info.get("format", {}).get("duration", 0))

        resolution = "1280x720"
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                resolution = f"{stream['width']}x{stream['height']}"
                break

        return {"duration": duration, "resolution": resolution}

    except Exception:
        # Fallback: estimate from clip count
        return {"duration": 0, "resolution": "1280x720"}


def _check_ffmpeg():
    """Verify ffmpeg is available."""
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except FileNotFoundError:
        raise RuntimeError(
            "ffmpeg is required for video concatenation but was not found. "
            "Install ffmpeg: apt-get install ffmpeg"
        )
