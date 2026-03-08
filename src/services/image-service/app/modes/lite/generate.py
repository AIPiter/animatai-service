"""Lite mode image generation — OpenRouter / gpt-image-1 (port of imageGen.js)."""

import base64
import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
IMAGE_MODEL = "openai/gpt-image-1"


async def run(payload: dict, api_keys: dict) -> bytes:
    prompt         = payload["prompt"]
    openrouter_key = api_keys.get("openrouter", "")

    for attempt in range(1, 3):
        try:
            async with httpx.AsyncClient(timeout=180) as client:
                resp = await client.post(
                    OPENROUTER_URL,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {openrouter_key}",
                    },
                    json={
                        "model": IMAGE_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                )
                resp.raise_for_status()

            data    = resp.json()
            content = data["choices"][0]["message"]["content"]

            # Extract base64 image from various response shapes
            b64 = _extract_b64(content, data)
            if not b64:
                raise ValueError("No image data in response")

            return base64.b64decode(b64)

        except Exception as e:
            if attempt == 2:
                raise
            print(f"[image/lite] Attempt {attempt}/2 failed: {e}. Retrying…")


def _extract_b64(content, data: dict) -> str | None:
    # Shape 1: content_list with image_url
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "image_url":
                url = item.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    return url.split(",", 1)[1]

    # Shape 2: direct base64 string
    if isinstance(content, str) and len(content) > 100:
        try:
            base64.b64decode(content)
            return content
        except Exception:
            pass

    # Shape 3: images array on root
    images = data.get("images") or data.get("data") or []
    for img in images:
        if isinstance(img, dict):
            b64 = img.get("b64_json") or img.get("url", "")
            if b64.startswith("data:"):
                return b64.split(",", 1)[1]
            if b64:
                return b64

    return None
