"""Standard mode image generation — FLUX via OpenRouter."""

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/images/generations"
IMAGE_MODEL    = "fal-ai/flux-kontext/pro"


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
                        "model":           IMAGE_MODEL,
                        "prompt":          prompt,
                        "n":               1,
                        "size":            "1792x1024",
                        "response_format": "url",
                    },
                )
                resp.raise_for_status()

            item = resp.json()["data"][0]
            image_url = item.get("url")
            if not image_url:
                raise ValueError("No image URL in response")

            async with httpx.AsyncClient(timeout=60) as client:
                img_resp = await client.get(image_url)
                img_resp.raise_for_status()
                return img_resp.content

        except Exception as e:
            if attempt == 2:
                raise
            print(f"[image/standard] Attempt {attempt}/2 failed: {e}. Retrying…")
