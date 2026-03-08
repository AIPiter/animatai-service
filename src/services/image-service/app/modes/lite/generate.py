"""Lite mode image generation — OpenRouter chat completions with image modality."""

import base64
import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
IMAGE_MODEL = "google/gemini-3.1-flash-image-preview"


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
                        "modalities": ["image", "text"],
                    },
                )
                if resp.status_code >= 400:
                    print(f"[image/lite] OpenRouter {resp.status_code}: {resp.text[:500]}")
                resp.raise_for_status()

            data    = resp.json()
            message = data["choices"][0]["message"]

            # Extract base64 from images array
            images = message.get("images", [])
            for img in images:
                url = img.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    b64 = url.split(",", 1)[1]
                    return base64.b64decode(b64)

            # Fallback: check content for inline base64
            content = message.get("content", "")
            if isinstance(content, str) and len(content) > 200:
                try:
                    return base64.b64decode(content)
                except Exception:
                    pass

            raise ValueError("No image data in response")

        except Exception as e:
            if attempt == 2:
                raise
            print(f"[image/lite] Attempt {attempt}/2 failed: {e}. Retrying…")
