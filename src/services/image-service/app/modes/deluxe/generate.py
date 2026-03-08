"""Deluxe mode image generation — FLUX-2-pro via fal.ai (port of imageGenFal.js)."""

import asyncio
import httpx
import fal_client

FAL_MODEL = "fal-ai/flux-2-pro"
POLL_INTERVAL = 5
TIMEOUT = 5 * 60  # 5 minutes


async def run(payload: dict, api_keys: dict) -> bytes:
    prompt  = payload["prompt"]
    fal_key = api_keys.get("fal", "")

    os_env_backup = _set_fal_key(fal_key)
    try:
        handler = await fal_client.submit_async(
            FAL_MODEL,
            arguments={
                "prompt":     prompt,
                "image_size": "landscape_16_9",
            },
        )

        start = asyncio.get_event_loop().time()
        while True:
            if asyncio.get_event_loop().time() - start > TIMEOUT:
                raise TimeoutError("FLUX image generation timed out after 5 minutes")

            status = await handler.status()
            if status == "COMPLETED":
                break
            await asyncio.sleep(POLL_INTERVAL)

        result = await handler.get()
        image_url = result["images"][0]["url"]

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
