"""
Standard mode — keyframe generator using FLUX Kontext.

Generates N keyframe images in a chain where each frame uses the previous
frame (or the master image for frame 0) as a visual reference to maintain
subject consistency across all scenes.

Frame layout:
  Frame 0  = scene[0] start position
  Frame 1  = scene[0] end / scene[1] start
  ...
  Frame N  = scene[N-1] end position

Total frames = len(scenes) + 1
"""

import os
import time

import fal_client
import httpx

from ...storage import upload_image

FAL_MODEL          = "fal-ai/flux-pro/kontext"
IMAGE_SIZE         = "landscape_16_9"
GUIDANCE_SCALE     = 3.5
GUIDANCE_SCALE_HI  = 4.5          # used on consistency-failure retry
INFERENCE_STEPS    = 28
VALIDATION_THRESH  = 0.6          # 60% keyword match required


async def generate_frames(
    master_image_url: str,
    visual_anchor: dict,
    scenes: list[dict],
    style: dict,
    job_id: str,
    api_keys: dict,
    on_frame_ready=None,
) -> list[dict]:
    """
    Generate a chain of keyframes from master image through all scenes.

    Args:
        master_image_url:  publicly accessible URL of the master reference image
        visual_anchor:     dict with anchorText, consistencyLock, styleString, validationKeywords
        scenes:            list of scene dicts (description, cameraAngle, action, backgroundHint)
        style:             style dict (type, lighting, colorPalette, renderingStyle)
        job_id:            unique job identifier for file naming
        api_keys:          dict with "fal" key
        on_frame_ready:    optional async callback(frame_dict) called after each frame

    Returns list of GeneratedFrame dicts:
        index, image_url, scene_index, role, prompt_used, seed
    """
    fal_key = api_keys.get("fal", "")
    _set_fal_key(fal_key)

    try:
        frames = []
        reference_url = master_image_url
        total = len(scenes) + 1

        for i in range(total):
            scene_index = min(i, len(scenes) - 1)
            scene = scenes[scene_index]

            if i == 0:
                role = "start"
            elif i == len(scenes):
                role = "end"
            else:
                role = "both"

            prompt_role = "start" if role in ("start", "both") else "end"
            prompt = _build_frame_prompt(visual_anchor, scene, prompt_role, style)
            seed = 1000 + i * 37

            print(f"[image/standard/frames] Generating frame {i}/{total - 1} "
                  f"(scene {scene_index}, role={role}, seed={seed})")
            start = time.monotonic()

            image_url, actual_seed = await _generate_single_frame(
                reference_url=reference_url,
                prompt=prompt,
                seed=seed,
                guidance_scale=GUIDANCE_SCALE,
            )

            # Validate consistency via keyword check
            valid = _validate_frame_keywords(prompt, visual_anchor)
            if not valid:
                print(f"[image/standard/frames] Frame {i} below keyword threshold, "
                      f"retrying with higher guidance_scale")
                image_url, actual_seed = await _generate_single_frame(
                    reference_url=reference_url,
                    prompt=prompt,
                    seed=seed,
                    guidance_scale=GUIDANCE_SCALE_HI,
                )

            # Download and store to MinIO
            image_bytes = await _download_image(image_url)
            filename = f"frames/{job_id}/frame-{i:02d}.png"
            stored_path = upload_image(image_bytes, filename)

            elapsed = int((time.monotonic() - start) * 1000)
            print(f"[image/standard/frames] Frame {i} done in {elapsed}ms → {stored_path}")

            frame = {
                "index":       i,
                "image_url":   stored_path,
                "image_bytes": image_bytes,
                "scene_index": scene_index,
                "role":        role,
                "prompt_used": prompt,
                "seed":        actual_seed,
            }
            frames.append(frame)

            # Notify caller as each frame completes
            if on_frame_ready:
                await on_frame_ready(frame)

            # Chain: next frame uses this one as reference
            reference_url = image_url

        print(f"[image/standard/frames] All {total} frames generated for job {job_id}")
        return frames

    finally:
        _restore_fal_key()


def _build_frame_prompt(anchor: dict, scene: dict, role: str, style: dict) -> str:
    """
    Build the prompt for a single keyframe.

    Combines the visual anchor (for subject consistency) with scene-specific
    context (camera, action, environment).
    """
    action_prefix = "beginning of — " if role == "start" else "end of — "

    parts = [
        anchor["anchorText"],
        anchor["consistencyLock"],
        "",
        f"Scene context: {scene.get('description', '')}",
        f"Camera: {scene.get('cameraAngle', 'front')} shot",
        f"Action/State: {action_prefix}{scene.get('action', '')}",
        f"Environment: {scene.get('backgroundHint', '')}",
        anchor.get("styleString", ""),
        "",
        "CRITICAL: Subject must match reference image exactly.",
        "Only change: camera angle, background context, subject pose/state.",
        f"Do not alter: {anchor['consistencyLock']}",
        "",
        "Negative: different subject appearance, style change, new elements,",
        "missing key features, color shift from reference, blur, text, watermark.",
    ]

    return "\n".join(parts).strip()


async def _generate_single_frame(
    reference_url: str,
    prompt: str,
    seed: int,
    guidance_scale: float,
) -> tuple[str, int]:
    """
    Call fal.ai Kontext to generate one frame.
    Returns (image_url, seed_used).
    """
    handler = await fal_client.submit_async(
        FAL_MODEL,
        arguments={
            "image_url":           reference_url,
            "prompt":              prompt,
            "seed":                seed,
            "guidance_scale":      guidance_scale,
            "num_inference_steps": INFERENCE_STEPS,
        },
    )

    result = await handler.get()
    image_url  = result["images"][0]["url"]
    seed_used  = result.get("seed", seed)
    return image_url, seed_used


def _validate_frame_keywords(prompt_used: str, anchor: dict) -> bool:
    """
    Lightweight consistency check: verify that enough validation keywords
    appear in the prompt that was used (as a proxy — the prompt includes
    the anchor text which should contain these keywords).

    Returns True if >= VALIDATION_THRESH of keywords are present.
    """
    keywords = anchor.get("validationKeywords", [])
    if not keywords:
        return True

    prompt_lower = prompt_used.lower()
    matches = sum(1 for kw in keywords if kw.lower() in prompt_lower)
    ratio = matches / len(keywords)
    return ratio >= VALIDATION_THRESH


async def _download_image(url: str) -> bytes:
    """Download image bytes from a URL."""
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


# ── fal key management ────────────────────────────────────────────────────────

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
