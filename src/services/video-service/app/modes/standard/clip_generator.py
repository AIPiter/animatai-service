"""
Standard mode — video clip generator via fal.ai.

Generates video clips sequentially using WAN 2.1 FLF2V (first+last frame).
Falls back to Kling O1 if WAN fails.

CRITICAL: This module uses ONLY fal.ai (FAL_KEY). No OpenRouter calls.
"""

import os
import time
from datetime import datetime, timezone

import fal_client
import httpx

from ...storage import upload_file, download_url

PRIMARY_MODEL  = "fal-ai/wan-flf2v"
FALLBACK_MODEL = "fal-ai/kling-video/o1/image-to-video"


async def generate_clips(
    video_prompts: list[dict],
    job_id: str,
    api_keys: dict,
    on_clip_complete=None,
) -> list[dict]:
    """
    Generate video clips sequentially from VideoPrompt dicts.

    Clips are generated one at a time to:
    1. Allow the user to see the first clip while others generate
    2. Avoid fal.ai rate limits
    3. Call on_clip_complete callback after each clip

    Args:
        video_prompts:    list of VideoPrompt dicts from video_prompt_builder
        job_id:           unique job identifier for file naming
        api_keys:         dict with "fal" key (NO openrouter)
        on_clip_complete: optional async callback(clip_index, stored_path)

    Returns list of GeneratedClip dicts.
    """
    fal_key = api_keys.get("fal", "")
    _set_fal_key(fal_key)

    try:
        results = []

        for index, prompt in enumerate(video_prompts):
            print(f"[video/standard/clips] Generating clip {index + 1}/{len(video_prompts)} "
                  f"via {PRIMARY_MODEL}")
            start = time.monotonic()

            try:
                video_url, model_used = await _generate_wan(prompt)
            except Exception as e:
                print(f"[video/standard/clips] WAN failed for clip {index}: {e}. "
                      f"Falling back to {FALLBACK_MODEL}")
                video_url, model_used = await _generate_kling_fallback(prompt)

            # Download and store to MinIO
            video_bytes = await download_url(video_url)
            filename = f"clips/{job_id}/clip-{index:02d}.mp4"
            stored_path = upload_file(video_bytes, filename)

            elapsed = int((time.monotonic() - start) * 1000)
            print(f"[video/standard/clips] Clip {index} done in {elapsed}ms → {stored_path}")

            clip = {
                "index":            index,
                "video_url":        stored_path,
                "video_bytes":      video_bytes,
                "duration_seconds": prompt["duration_seconds"],
                "start_frame_url":  prompt["start_frame_url"],
                "end_frame_url":    prompt["end_frame_url"],
                "generated_at":     datetime.now(timezone.utc).isoformat(),
                "model_used":       model_used,
            }
            results.append(clip)

            if on_clip_complete:
                await on_clip_complete(index, stored_path)

        print(f"[video/standard/clips] All {len(video_prompts)} clips generated for job {job_id}")
        return results

    finally:
        _restore_fal_key()


async def _generate_wan(prompt: dict) -> tuple[str, str]:
    """
    Generate clip via WAN 2.1 FLF2V (first+last frame interpolation).
    Returns (video_url, model_name).
    """
    args: dict = {
        "prompt":        prompt["text_prompt"],
        "image_url":     prompt["start_frame_url"],
        "num_frames":    121,       # ~5 sec at 24fps
        "resolution":    "720p",
        "guidance_scale": prompt["model_params"]["guidance_scale"],
    }

    # Add last frame if available
    if prompt.get("end_frame_url"):
        args["tail_image_url"] = prompt["end_frame_url"]

    # Add negative prompt if model supports it
    if prompt.get("negative_prompt"):
        args["negative_prompt"] = prompt["negative_prompt"]

    handler = await fal_client.submit_async(PRIMARY_MODEL, arguments=args)
    result = await handler.get()
    video_url = result["video"]["url"]

    return video_url, PRIMARY_MODEL


async def _generate_kling_fallback(prompt: dict) -> tuple[str, str]:
    """
    Fallback: generate clip via Kling O1 image-to-video.
    Returns (video_url, model_name).
    """
    args: dict = {
        "prompt":          prompt["text_prompt"],
        "start_image_url": prompt["start_frame_url"],
        "duration":        str(prompt["duration_seconds"]),
        "aspect_ratio":    "16:9",
        "cfg_scale":       prompt["model_params"]["guidance_scale"],
    }

    if prompt.get("end_frame_url"):
        args["end_image_url"] = prompt["end_frame_url"]

    handler = await fal_client.submit_async(FALLBACK_MODEL, arguments=args)
    result = await handler.get()
    video_url = result["video"]["url"]

    return video_url, FALLBACK_MODEL


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
