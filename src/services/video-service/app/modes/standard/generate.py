"""Standard mode video generation — WAN 2.1 FLF2V via fal.ai (first+last frame)."""

import os
import fal_client
import httpx

FAL_MODEL = "fal-ai/wan-flf2v"


async def generate_clip(
    scene: dict,
    api_keys: dict,
    start_image_bytes: bytes,
    end_image_bytes: bytes | None = None,
) -> bytes:
    fal_key      = api_keys.get("fal", "")
    video_prompt = scene.get("video_prompt") or scene.get("action", "")
    duration     = str(scene.get("clip_duration", 5))

    _set_fal_key(fal_key)
    try:
        start_url = await fal_client.upload_async(
            start_image_bytes, content_type="image/png"
        )
        args: dict = {
            "image_url": start_url,
            "prompt":    video_prompt,
            "duration":  duration,
        }
        if end_image_bytes:
            end_url = await fal_client.upload_async(
                end_image_bytes, content_type="image/png"
            )
            args["tail_image_url"] = end_url

        print(f"[video/standard] Submitting to fal.ai: {FAL_MODEL}")
        handler = await fal_client.submit_async(FAL_MODEL, arguments=args)
        result    = await handler.get()
        video_url = result["video"]["url"]
        print(f"[video/standard] Done, downloading from {video_url[:80]}...")

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(video_url)
            resp.raise_for_status()
            return resp.content

    finally:
        _restore_fal_key()


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
