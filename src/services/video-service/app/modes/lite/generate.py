"""
Lite mode video generation — MiniMax via fal.ai queue (port of videoGen.js submitVideoMinimax).
Processes all scenes independently (no chaining).
"""

import asyncio
import io
import fal_client
import httpx

FAL_MODEL     = "fal-ai/minimax-video/image-to-video"
POLL_INTERVAL = 10
MAX_WAIT      = 20 * 60  # 20 minutes


async def generate_clip(scene: dict, api_keys: dict) -> bytes:
    """Submit + poll one scene. Returns raw video bytes."""
    fal_key      = api_keys.get("fal", "")
    image_path   = scene["image_path"]
    video_prompt = scene.get("video_prompt", "")
    duration     = str(scene.get("clip_duration", 5))

    _set_fal_key(fal_key)
    try:
        # Upload start image
        image_bytes = await _fetch_asset(image_path)
        image_url   = await fal_client.upload_async(
            io.BytesIO(image_bytes), content_type="image/png"
        )

        handler = await fal_client.submit_async(
            FAL_MODEL,
            arguments={
                "image_url": image_url,
                "prompt":    video_prompt,
                "duration":  duration,
            },
        )

        start = asyncio.get_event_loop().time()
        while True:
            elapsed = asyncio.get_event_loop().time() - start
            if elapsed > MAX_WAIT:
                raise TimeoutError(f"Video generation timed out after {MAX_WAIT}s")

            status = await handler.status()
            if status == "COMPLETED":
                break
            if status == "FAILED":
                raise RuntimeError("fal.ai video generation failed")
            await asyncio.sleep(POLL_INTERVAL)

        result    = await handler.get()
        video_url = result["video"]["url"]

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(video_url)
            resp.raise_for_status()
            return resp.content

    finally:
        _restore_fal_key()


async def _fetch_asset(path: str) -> bytes:
    """Fetch image bytes from MinIO storage path."""
    from ...storage import download_file
    return download_file(path)


_fal_key_backup: str | None = None


def _set_fal_key(key: str):
    global _fal_key_backup
    import os
    _fal_key_backup = os.environ.get("FAL_KEY")
    if key:
        os.environ["FAL_KEY"] = key


def _restore_fal_key():
    import os
    if _fal_key_backup is None:
        os.environ.pop("FAL_KEY", None)
    else:
        os.environ["FAL_KEY"] = _fal_key_backup
