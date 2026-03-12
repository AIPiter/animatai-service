"""Deluxe mode image generation — FLUX-2-pro via fal.ai."""

import httpx
import fal_client

FAL_MODEL = "fal-ai/flux-2-pro"


async def run(payload: dict, api_keys: dict) -> bytes:
    prompt  = payload["prompt"]
    fal_key = api_keys.get("fal", "")

    os_env_backup = _set_fal_key(fal_key)
    try:
        print(f"[image/deluxe] Submitting to fal.ai: {FAL_MODEL}")
        handler = await fal_client.submit_async(
            FAL_MODEL,
            arguments={
                "prompt":     prompt,
                "image_size": "landscape_16_9",
            },
        )

        result = await handler.get()
        image_url = result["images"][0]["url"]
        print(f"[image/deluxe] Done, downloading from {image_url[:80]}...")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(image_url)
            resp.raise_for_status()
            return resp.content

    finally:
        _restore_fal_key(os_env_backup)


def _set_fal_key(key: str):
    import os
    backup = os.environ.get("FAL_KEY")
    if key:
        os.environ["FAL_KEY"] = key
    return backup


def _restore_fal_key(backup):
    import os
    if backup is None:
        os.environ.pop("FAL_KEY", None)
    else:
        os.environ["FAL_KEY"] = backup
