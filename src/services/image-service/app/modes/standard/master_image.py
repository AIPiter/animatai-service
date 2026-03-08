"""
Standard mode — master image generator.

Generates ONE canonical reference image of the main subject via fal.ai FLUX-pro.
This image becomes the visual source of truth for all subsequent scene frames
(which use Kontext to keep the subject consistent).
"""

import random
import time

import fal_client
import httpx


FAL_MODEL = "fal-ai/flux-pro/v1.1"


async def generate(payload: dict, api_keys: dict) -> dict:
    """
    Generate master reference image from subject + style data.

    Input payload keys:
        subject.description   — main visual subject
        subject.keyFeatures   — list of critical visual attributes
        subject.styleKeywords — visual style words
        style.renderingStyle  — full style lock string
        style.lighting        — lighting description
        style.colorPalette    — color description

    Returns dict with:
        image_bytes  — raw PNG bytes
        seed         — seed used (for reproducibility)
        prompt_used  — exact prompt sent to model
    """
    subject = payload["subject"]
    style   = payload["style"]
    fal_key = api_keys.get("fal", "")

    seed = random.randint(1, 2**31)
    prompt = _build_prompt(subject, style)

    print(f"[image/standard/master] Generating master image, seed={seed}")
    start = time.monotonic()

    _set_fal_key(fal_key)
    try:
        handler = await fal_client.submit_async(
            FAL_MODEL,
            arguments={
                "prompt":               prompt,
                "image_size":           {"width": 1024, "height": 1024},
                "num_inference_steps":  35,
                "guidance_scale":       3.5,
                "seed":                 seed,
                "num_images":           1,
                "safety_tolerance":     "5",
            },
        )

        result    = await handler.get()
        image_url = result["images"][0]["url"]

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(image_url)
            resp.raise_for_status()
            image_bytes = resp.content

        elapsed = int((time.monotonic() - start) * 1000)
        print(f"[image/standard/master] Master image generated in {elapsed}ms")

        return {
            "image_bytes": image_bytes,
            "seed":        seed,
            "prompt_used": prompt,
        }

    finally:
        _restore_fal_key()


def _build_prompt(subject: dict, style: dict) -> str:
    """
    Build master image prompt in prescribed order:
    [SUBJECT] + isolation + [STYLE] + reference shot directives + negative.
    """
    desc     = subject["description"]
    features = ", ".join(subject.get("keyFeatures", []))
    render   = style.get("renderingStyle", "")
    lighting = style.get("lighting", "")
    palette  = style.get("colorPalette", "")

    parts = [
        f"{desc}, {features}, isolated on neutral background,",
        "all key details visible, no motion blur, sharp focus.",
        f"{render}." if render else "",
        f"{lighting}, {palette}." if lighting else "",
        "Product reference shot, centered composition, full subject visible,",
        "high detail, consistent lighting.",
        "Negative: cropped, motion blur, low detail, stylistic inconsistency,",
        "background clutter, dramatic shadows obscuring subject details,",
        "multiple instances of subject, partial view.",
    ]

    return " ".join(p for p in parts if p)


# ── fal key management ────────────────────────────────────────────────────────

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
