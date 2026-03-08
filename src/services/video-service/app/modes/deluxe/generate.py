"""
Deluxe mode video generation — Kling v2.6 pro via fal.ai.
Scenes are chained: last frame of clip N -> start image of clip N+1.
Supports generate_audio + voice_ids.
"""

import subprocess
import tempfile
import os
import fal_client
import httpx

FAL_MODEL = "fal-ai/kling-video/v2.6/pro/image-to-video"


async def generate_clip(
    scene: dict,
    api_keys: dict,
    start_image_bytes: bytes,
    voice_ids: list[str] | None = None,
) -> tuple[bytes, bytes]:
    """
    Generate one deluxe clip.
    Returns (video_bytes, last_frame_bytes).
    """
    fal_key      = api_keys.get("fal", "")
    video_prompt = scene.get("video_prompt", "")
    duration     = str(scene.get("clip_duration", 5))

    _set_fal_key(fal_key)
    try:
        start_url = await fal_client.upload_async(
            start_image_bytes, content_type="image/png"
        )

        args: dict = {
            "start_image_url": start_url,
            "prompt":          video_prompt,
            "duration":        duration,
            "generate_audio":  True,
        }

        if voice_ids:
            looks_custom = all(len(v) > 20 for v in voice_ids)
            if looks_custom:
                args["voice_ids"] = voice_ids

        print(f"[video/deluxe] Submitting to fal.ai: {FAL_MODEL}")
        handler = await fal_client.submit_async(FAL_MODEL, arguments=args)
        result    = await handler.get()
        video_url = result["video"]["url"]
        print(f"[video/deluxe] Done, downloading from {video_url[:80]}...")

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(video_url)
            resp.raise_for_status()
            video_bytes = resp.content

        last_frame = _extract_last_frame(video_bytes)
        return video_bytes, last_frame

    finally:
        _restore_fal_key()


def _extract_last_frame(video_bytes: bytes) -> bytes:
    """Use ffmpeg to extract the last frame from video bytes. Returns JPEG bytes."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as vid_tmp:
        vid_tmp.write(video_bytes)
        vid_tmp_path = vid_tmp.name

    out_path = vid_tmp_path + "_last.jpg"
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-sseof", "-0.1",
                "-i", vid_tmp_path,
                "-frames:v", "1",
                "-q:v", "2",
                out_path,
            ],
            check=True,
            capture_output=True,
        )
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(vid_tmp_path)
        if os.path.exists(out_path):
            os.unlink(out_path)


_fal_key_backup: str | None = None


def _set_fal_key(key: str):
    global _fal_key_backup
    _fal_key_backup = os.environ.get("FAL_KEY")
    if key:
        os.environ["FAL_KEY"] = key


def _restore_fal_key():
    if _fal_key_backup is None:
        os.environ.pop("FAL_KEY", None)
    else:
        os.environ["FAL_KEY"] = _fal_key_backup
