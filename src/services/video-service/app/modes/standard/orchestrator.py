"""
Standard mode — full pipeline orchestrator.

Coordinates all stages of the standard mode pipeline:
  parsing → master_image → visual_anchor → frames → [PAUSE] → clips → concat → complete

Runs within the video-service (which has fal_client, minio, httpx, ffmpeg).
For LLM/vision stages, calls OpenRouter directly via httpx.
For image/video stages, uses fal_client directly.

Job state is persisted to Redis (JSON) and DB status updates are pushed
after each stage so the frontend can track progress in real-time.
"""

import json
import math
import os
import random
import re
import time
import uuid
from datetime import datetime, timezone

import asyncpg
import fal_client
import httpx
import redis.asyncio as aioredis

from ...config import settings
from ...storage import upload_file, download_file, download_url

from .video_prompt_builder import build_all_video_prompts
from .clip_generator import generate_clips
from .video_concat import concat_clips

# ── Constants ────────────────────────────────────────────────────────────────

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
LLM_MODEL      = "anthropic/claude-sonnet-4-5"
VISION_MODEL    = "anthropic/claude-sonnet-4-5"

FAL_MASTER_MODEL  = "fal-ai/flux-pro/v1.1"
FAL_KONTEXT_MODEL = "fal-ai/flux-pro/kontext"

VALID_ANGLES      = {"front", "side", "top", "closeup", "wide"}
VALID_STYLE_TYPES = {"realistic", "cartoon", "cinematic", "product", "animation"}
MIN_SCENES, MAX_SCENES = 2, 7

STAGES = [
    "parsing", "master_image", "visual_anchor", "frames",
    "video_prompts", "clips", "concat", "complete",
]

REDIS_KEY_PREFIX = "standard_pipeline:"

_redis: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def _publish_event(project_id: str, event: str, data: dict):
    r = await _get_redis()
    await r.publish(
        f"project:{project_id}:events",
        json.dumps({"event": event, "data": data}),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Public API
# ══════════════════════════════════════════════════════════════════════════════

async def run_standard_pipeline(
    project_id: str,
    user_id: str,
    payload: dict,
    api_keys: dict,
    pool: asyncpg.Pool,
):
    """
    Run the full standard mode pipeline up to the PAUSE point (after frames).

    Stages: parsing → master_image → visual_anchor → frames → PAUSE

    After PAUSE, the user reviews frames and calls resume_standard_pipeline()
    to continue: video_prompts → clips → concat → complete
    """
    job_id = str(uuid.uuid4())
    job = _init_job(job_id, project_id, user_id, payload)

    try:
        # ── Stage 1: Parsing ──────────────────────────────────────────────
        await _set_stage(job, "parsing", project_id, pool)
        parsed = await _stage_parsing(payload, api_keys)
        job["parsed_scenario"] = parsed

        # Persist scenes to DB
        scene_ids = await _persist_scenes(parsed, project_id, pool)
        job["scene_ids"] = scene_ids

        # Generate project name
        name = await _generate_name(payload.get("scenario", ""), api_keys)
        if name:
            async with pool.acquire() as conn:
                await conn.execute("UPDATE projects SET name = $1 WHERE id = $2", name, project_id)

        await _publish_event(project_id, "llm_done", {
            "scene_count": len(parsed["scenes"]),
            "status": "scenes_ready",
        })

        # ── Stage 2: Master Image ────────────────────────────────────────
        await _set_stage(job, "master_image", project_id, pool)
        master = await _stage_master_image(parsed, api_keys)
        job["master_image"] = {
            "image_url": master["image_url"],
            "seed": master["seed"],
            "prompt_used": master["prompt_used"],
        }

        # Store master image path on first scene
        if scene_ids:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET image_path = $1, status = 'done' WHERE id = $2",
                    master["image_url"], scene_ids[0],
                )
            await _publish_event(project_id, "image_done", {
                "scene_id": scene_ids[0], "path": master["image_url"],
            })

        # ── Stage 3: Visual Anchor ───────────────────────────────────────
        await _set_stage(job, "visual_anchor", project_id, pool)
        # Master image is in MinIO — build full URL for vision API
        master_public_url = master["fal_url"]  # use the original fal.ai URL
        anchor = await _stage_visual_anchor(
            master_public_url, parsed["subject"], parsed["style"], api_keys,
        )
        job["visual_anchor"] = anchor

        # ── Stage 4: Frames ──────────────────────────────────────────────
        await _set_stage(job, "frames", project_id, pool)
        frames = await _stage_frames(
            master_public_url, anchor, parsed["scenes"], parsed["style"],
            job_id, api_keys, scene_ids, pool, project_id,
        )
        job["frames"] = [
            {k: v for k, v in f.items() if k != "image_bytes"}
            for f in frames
        ]

        # ── PAUSE — wait for user approval ───────────────────────────────
        await _set_stage(job, "frames_ready", project_id, pool)
        await _save_job(job)

        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE projects SET status = 'scenes_ready' WHERE id = $1", project_id,
            )
        await _publish_event(project_id, "standard_frames_ready", {
            "frame_count": len(frames),
        })

        print(f"[standard/orchestrator] Pipeline paused at frames_ready for project {project_id}")
        return job

    except Exception as e:
        job["error"] = {"stage": job.get("stage", "unknown"), "message": str(e)}
        job["stage"] = "failed"
        await _save_job(job)

        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE projects SET status = 'error' WHERE id = $1", project_id,
            )
        await _publish_event(project_id, "error", {"message": str(e)})
        print(f"[standard/orchestrator] Pipeline FAILED at {job['error']['stage']}: {e}")
        raise


async def resume_standard_pipeline(
    project_id: str,
    api_keys: dict,
    pool: asyncpg.Pool,
    from_stage: str = "video_prompts",
):
    """
    Resume pipeline after user approval of frames.

    Stages: video_prompts → clips → concat → complete
    """
    job = await _load_job(project_id)
    if not job:
        raise ValueError(f"No pipeline state found for project {project_id}")

    try:
        parsed = job["parsed_scenario"]
        anchor = job["visual_anchor"]
        frames = job["frames"]

        # ── Stage 5: Video Prompts (no API call) ─────────────────────────
        if _stage_index(from_stage) <= _stage_index("video_prompts"):
            await _set_stage(job, "video_prompts", project_id, pool)
            video_prompts = build_all_video_prompts(
                frames, parsed["scenes"], anchor, parsed["style"],
            )
            job["video_prompts"] = video_prompts

        # ── Stage 6: Clips ───────────────────────────────────────────────
        if _stage_index(from_stage) <= _stage_index("clips"):
            await _set_stage(job, "clips", project_id, pool)
            scene_ids = job.get("scene_ids", [])

            async def on_clip_done(clip_index, stored_path):
                if clip_index < len(scene_ids):
                    sid = scene_ids[clip_index]
                    async with pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE scenes SET video_path = $1, video_status = 'done' WHERE id = $2",
                            stored_path, sid,
                        )
                    await _publish_event(project_id, "video_done", {
                        "scene_id": sid, "path": stored_path,
                    })

            clips = await generate_clips(
                job["video_prompts"], job["job_id"], api_keys, on_clip_complete=on_clip_done,
            )
            job["clips"] = [
                {k: v for k, v in c.items() if k != "video_bytes"}
                for c in clips
            ]

        # ── Stage 7: Concat ──────────────────────────────────────────────
        if _stage_index(from_stage) <= _stage_index("concat"):
            await _set_stage(job, "concat", project_id, pool)
            concat_result = await concat_clips(
                clips if 'clips' in dir() else job["clips"],
                job["job_id"],
            )
            job["final_video"] = {
                k: v for k, v in concat_result.items() if k != "output_bytes"
            }

            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE projects SET final_video_path = $1, status = 'rendered' WHERE id = $2",
                    concat_result["output_url"], project_id,
                )

        # ── Complete ─────────────────────────────────────────────────────
        job["stage"] = "complete"
        await _save_job(job)

        await _publish_event(project_id, "render_done", {
            "path": job["final_video"]["output_url"],
        })
        await _publish_event(project_id, "all_videos_done", {})

        print(f"[standard/orchestrator] Pipeline COMPLETE for project {project_id}")
        return job

    except Exception as e:
        job["error"] = {"stage": job.get("stage", "unknown"), "message": str(e)}
        job["stage"] = "failed"
        await _save_job(job)

        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE projects SET status = 'error' WHERE id = $1", project_id,
            )
        await _publish_event(project_id, "error", {"message": str(e)})
        print(f"[standard/orchestrator] Resume FAILED at {job['error']['stage']}: {e}")
        raise


async def get_pipeline_job(project_id: str) -> dict | None:
    """Retrieve current pipeline state."""
    return await _load_job(project_id)


# ══════════════════════════════════════════════════════════════════════════════
# Stage implementations
# ══════════════════════════════════════════════════════════════════════════════

async def _stage_parsing(payload: dict, api_keys: dict) -> dict:
    """Parse user scenario into structured scenes via LLM."""
    user_text = payload["scenario"]
    target_duration = payload.get("duration", 30)
    style_hint = payload.get("style")
    scene_count_override = payload.get("scene_count")

    if scene_count_override:
        scene_count = min(max(int(scene_count_override), MIN_SCENES), MAX_SCENES)
    else:
        scene_count = min(max(math.ceil(target_duration / 5), MIN_SCENES), MAX_SCENES)

    style_rule = (
        f'The style.type field MUST be "{style_hint}".'
        if style_hint else
        f"Choose the most fitting style.type from: {', '.join(VALID_STYLE_TYPES)}."
    )

    system_prompt = f"""You are a cinematography expert who breaks down video scenarios into structured shot lists.
Your output must be valid JSON only. No markdown, no explanation, no preamble.

Given a user's video description, extract:
- The MAIN SUBJECT — the object/character/product that must look identical across all frames
- KEY FEATURES — specific visual attributes (colors, shapes, texture, material)
- VISUAL STYLE — photography/art style
- SCENE LIST — each shot as a distinct visual moment

Rules:
- Output EXACTLY {scene_count} scenes
- Camera angles must vary; use one of: {', '.join(sorted(VALID_ANGLES))}
- If description is too vague, set subject.description to exactly "UNCLEAR"
- {style_rule}
- Output language: English only

Return ONLY this JSON:
{{
  "subject": {{
    "description": "<specific main subject>",
    "keyFeatures": ["<feature 1>"],
    "styleKeywords": ["<style word 1>"]
  }},
  "style": {{
    "type": "<realistic|cartoon|cinematic|product|animation>",
    "lighting": "<lighting description>",
    "colorPalette": "<color description>",
    "renderingStyle": "<full style lock string>"
  }},
  "scenes": [
    {{
      "index": 0,
      "description": "<what happens>",
      "cameraAngle": "<front|side|top|closeup|wide>",
      "action": "<what changes>",
      "backgroundHint": "<environment>"
    }}
  ]
}}"""

    user_message = (
        f"Video description: {user_text}\n"
        f"Target duration: {target_duration} seconds\n"
        f"Required scenes: {scene_count}"
    )
    if style_hint:
        user_message += f"\nStyle preference: {style_hint}"

    openrouter_key = api_keys.get("openrouter", "")
    for attempt in range(1, 3):
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    OPENROUTER_URL,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {openrouter_key}",
                    },
                    json={
                        "model": LLM_MODEL,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user",   "content": user_message},
                        ],
                        "temperature": 0.3,
                        "max_tokens": 2048,
                    },
                )
                resp.raise_for_status()

            content = resp.json()["choices"][0]["message"]["content"]
            parsed = _extract_json(content)

            _normalise_scenes(parsed, scene_count)
            _validate_parsed(parsed)

            if parsed["subject"]["description"] == "UNCLEAR":
                raise ValueError(
                    "SUBJECT_UNCLEAR: Description too vague. "
                    "Please describe the main subject more specifically."
                )

            # Enrich scenes with prompts
            parsed["scenes"] = _build_scene_prompts(parsed)

            parsed["character_description"] = json.dumps({
                "subject": parsed["subject"],
                "style": parsed["style"],
            })

            print(f"[standard/orchestrator] Parsed {len(parsed['scenes'])} scenes")
            return parsed

        except Exception as e:
            if "SUBJECT_UNCLEAR" in str(e) or attempt == 2:
                raise
            print(f"[standard/orchestrator] Parse attempt {attempt}/2 failed: {e}")


async def _stage_master_image(parsed: dict, api_keys: dict) -> dict:
    """Generate master reference image via FLUX-pro."""
    subject = parsed["subject"]
    style = parsed["style"]
    fal_key = api_keys.get("fal", "")

    seed = random.randint(1, 2**31)
    prompt = _build_master_prompt(subject, style)

    print(f"[standard/orchestrator] Generating master image, seed={seed}")
    start = time.monotonic()

    _set_fal_key(fal_key)
    try:
        handler = await fal_client.submit_async(
            FAL_MASTER_MODEL,
            arguments={
                "prompt": prompt,
                "image_size": {"width": 1024, "height": 1024},
                "num_inference_steps": 35,
                "guidance_scale": 3.5,
                "seed": seed,
                "num_images": 1,
                "safety_tolerance": "5",
            },
        )
        result = await handler.get()
        fal_url = result["images"][0]["url"]

        # Download and store to MinIO
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(fal_url)
            resp.raise_for_status()
            image_bytes = resp.content

        image_path = upload_file(image_bytes, f"images/master-{seed}.png", "image/png")

        elapsed = int((time.monotonic() - start) * 1000)
        print(f"[standard/orchestrator] Master image generated in {elapsed}ms")

        return {
            "image_url": image_path,
            "fal_url": fal_url,
            "seed": seed,
            "prompt_used": prompt,
        }
    finally:
        _restore_fal_key()


async def _stage_visual_anchor(
    master_image_url: str,
    subject: dict,
    style: dict,
    api_keys: dict,
) -> dict:
    """Extract visual anchor from master image via Vision LLM."""
    openrouter_key = api_keys.get("openrouter", "")

    vision_prompt = """Analyze this image and describe it with extreme precision for the purpose of reproducing it identically in other images.
Output a JSON object with these fields:
{
  "anchorText": "Complete visual description in one paragraph. Include: exact colors with adjectives, quantities of elements, specific shapes, textures, relative sizes, spatial arrangement, lighting direction and quality. Write as if instructing an artist who cannot see the image.",
  "consistencyLock": "MUST MATCH: [list only the 5-7 most critical visual features that must be identical across all frames]",
  "styleString": "[Art style, rendering technique, photography style in 10-15 words]",
  "validationKeywords": ["keyword1", "keyword2", ...]
}
Be precise about:
- Colors: not 'pink' but 'soft dusty rose pink'
- Quantities: not 'flowers' but 'approximately 12 blooms'
- Textures: not 'soft' but 'velvety matte petals with slight translucency at edges'
- Arrangement: spatial relationships between elements

Output JSON only. No markdown."""

    print(f"[standard/orchestrator] Extracting visual anchor")
    anchor = await _call_vision(master_image_url, vision_prompt, openrouter_key, 0.3)

    # Quality check
    if len(anchor.get("anchorText", "")) < 100:
        print("[standard/orchestrator] anchorText too short, retrying")
        anchor = await _call_vision(master_image_url, vision_prompt, openrouter_key, 0.7)

    # Merge keyFeatures into validationKeywords
    key_features = subject.get("keyFeatures", [])
    existing = anchor.get("validationKeywords", [])
    anchor["validationKeywords"] = list(dict.fromkeys(existing + key_features))

    print(f"[standard/orchestrator] Visual anchor: {len(anchor['anchorText'])} chars, "
          f"{len(anchor['validationKeywords'])} keywords")
    return anchor


async def _stage_frames(
    master_image_url: str,
    anchor: dict,
    scenes: list[dict],
    style: dict,
    job_id: str,
    api_keys: dict,
    scene_ids: list[str],
    pool: asyncpg.Pool,
    project_id: str,
) -> list[dict]:
    """Generate keyframe chain via Kontext."""
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

            prompt = _build_frame_prompt(anchor, scene, role, style)
            seed = 1000 + i * 37

            print(f"[standard/orchestrator] Frame {i}/{total - 1} "
                  f"(scene {scene_index}, role={role})")
            start = time.monotonic()

            handler = await fal_client.submit_async(
                FAL_KONTEXT_MODEL,
                arguments={
                    "image_url": reference_url,
                    "prompt": prompt,
                    "seed": seed,
                    "guidance_scale": 3.5,
                    "num_inference_steps": 28,
                },
            )
            result = await handler.get()
            fal_url = result["images"][0]["url"]
            actual_seed = result.get("seed", seed)

            # Download and store
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(fal_url)
                resp.raise_for_status()
                image_bytes = resp.content

            filename = f"images/frame-{job_id}-{i:02d}.png"
            stored_path = upload_file(image_bytes, filename, "image/png")

            elapsed = int((time.monotonic() - start) * 1000)
            print(f"[standard/orchestrator] Frame {i} done in {elapsed}ms")

            frame = {
                "index": i,
                "image_url": stored_path,
                "fal_url": fal_url,
                "scene_index": scene_index,
                "role": role,
                "prompt_used": prompt,
                "seed": actual_seed,
            }
            frames.append(frame)

            # Update DB: store frame as scene image (frame i → scene i for i < len(scenes))
            if i < len(scene_ids):
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE scenes SET image_path = $1, status = 'done' WHERE id = $2",
                        stored_path, scene_ids[i],
                    )
                await _publish_event(project_id, "image_done", {
                    "scene_id": scene_ids[i], "path": stored_path,
                })

            # Chain: next frame uses this one as reference
            reference_url = fal_url

        return frames
    finally:
        _restore_fal_key()


# ══════════════════════════════════════════════════════════════════════════════
# Helper functions
# ══════════════════════════════════════════════════════════════════════════════

def _init_job(job_id: str, project_id: str, user_id: str, payload: dict) -> dict:
    return {
        "job_id": job_id,
        "project_id": project_id,
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "stage": "parsing",
        "input": {
            "user_text": payload.get("scenario", ""),
            "target_duration": payload.get("duration", 30),
            "style_hint": payload.get("style"),
        },
    }


async def _save_job(job: dict):
    r = await _get_redis()
    key = f"{REDIS_KEY_PREFIX}{job['project_id']}"
    await r.set(key, json.dumps(job, default=str), ex=86400 * 7)  # 7 day TTL


async def _load_job(project_id: str) -> dict | None:
    r = await _get_redis()
    raw = await r.get(f"{REDIS_KEY_PREFIX}{project_id}")
    return json.loads(raw) if raw else None


async def _set_stage(job: dict, stage: str, project_id: str, pool: asyncpg.Pool):
    job["stage"] = stage
    await _save_job(job)
    await _publish_event(project_id, "pipeline_stage", {"stage": stage})
    print(f"[standard/orchestrator] Stage → {stage}")


def _stage_index(stage: str) -> int:
    try:
        return STAGES.index(stage)
    except ValueError:
        return 0


async def _persist_scenes(parsed: dict, project_id: str, pool: asyncpg.Pool) -> list[str]:
    """Insert parsed scenes into DB. Returns list of scene IDs."""
    scenes = parsed["scenes"]
    scene_ids = []
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE projects SET character_description = $1, scene_count = $2, status = 'scenes_ready' WHERE id = $3",
            parsed.get("character_description"),
            len(scenes),
            project_id,
        )
        for i, scene in enumerate(scenes):
            scene_id = str(uuid.uuid4())
            scene_ids.append(scene_id)
            await conn.execute(
                """INSERT INTO scenes (id, project_id, scene_number, description, image_prompt,
                                      subtitle_text, video_prompt, scene_type)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                scene_id, project_id, i + 1,
                scene.get("description", ""),
                scene.get("image_prompt"),
                scene.get("subtitle_text"),
                scene.get("video_prompt"),
                scene.get("scene_type", "main"),
            )
    return scene_ids


async def _generate_name(scenario: str, api_keys: dict) -> str | None:
    if not scenario.strip():
        return None
    try:
        key = api_keys.get("openrouter", "")
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                OPENROUTER_URL,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                json={
                    "model": "google/gemini-2.5-flash",
                    "messages": [
                        {"role": "system", "content": "Придумай короткое название (2-4 слова) для мультфильма по сценарию. Ответь ТОЛЬКО названием, без кавычек."},
                        {"role": "user", "content": scenario[:500]},
                    ],
                    "temperature": 0.8,
                    "max_tokens": 30,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()[:60]
    except Exception as e:
        print(f"[standard/orchestrator] Name generation failed (non-fatal): {e}")
        return None


async def _call_vision(image_url: str, prompt: str, api_key: str, temperature: float) -> dict:
    for attempt in range(1, 3):
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    OPENROUTER_URL,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                    json={
                        "model": VISION_MODEL,
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": image_url}},
                                {"type": "text", "text": prompt},
                            ],
                        }],
                        "temperature": temperature,
                        "max_tokens": 2048,
                    },
                )
                resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return _extract_json(content)
        except Exception as e:
            if attempt == 2:
                raise
            print(f"[standard/orchestrator] Vision attempt {attempt}/2 failed: {e}")


def _build_master_prompt(subject: dict, style: dict) -> str:
    desc = subject["description"]
    features = ", ".join(subject.get("keyFeatures", []))
    render = style.get("renderingStyle", "")
    lighting = style.get("lighting", "")
    palette = style.get("colorPalette", "")

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


def _ensure_str(val) -> str:
    if isinstance(val, list):
        return ", ".join(str(v) for v in val)
    return str(val) if val else ""


def _build_frame_prompt(anchor: dict, scene: dict, role: str, style: dict) -> str:
    action_prefix = "beginning of — " if role in ("start", "both") else "end of — "
    return "\n".join([
        _ensure_str(anchor.get("anchorText", "")),
        _ensure_str(anchor.get("consistencyLock", "")),
        "",
        f"Scene context: {scene.get('description', '')}",
        f"Camera: {scene.get('cameraAngle', 'front')} shot",
        f"Action/State: {action_prefix}{scene.get('action', '')}",
        f"Environment: {scene.get('backgroundHint', '')}",
        _ensure_str(anchor.get("styleString", "")),
        "",
        "CRITICAL: Subject must match reference image exactly.",
        "Only change: camera angle, background context, subject pose/state.",
        f"Do not alter: {_ensure_str(anchor.get('consistencyLock', ''))}",
        "",
        "Negative: different subject appearance, style change, new elements,",
        "missing key features, color shift from reference, blur, text, watermark.",
    ]).strip()


def _build_scene_prompts(parsed: dict) -> list[dict]:
    subject = parsed["subject"]
    style = parsed["style"]
    features = ", ".join(subject.get("keyFeatures", []))
    render = style.get("renderingStyle", "")

    scenes = []
    for s in parsed["scenes"]:
        image_prompt = (
            f"{subject['description']}, {features}, "
            f"{s.get('action', '')}, {s.get('backgroundHint', '')}, "
            f"{s.get('cameraAngle', 'front')} angle, "
            f"{render}, high detail, sharp focus."
        )
        video_prompt = (
            f"{subject['description']} {s.get('action', '')}. "
            f"{s.get('description', '')}. "
            f"Camera: {s.get('cameraAngle', 'front')}."
        )
        scenes.append({
            **s,
            "image_prompt": image_prompt,
            "video_prompt": video_prompt,
            "subtitle_text": s.get("description", ""),
            "scene_type": "main",
        })
    return scenes


def _normalise_scenes(data: dict, expected: int):
    if not isinstance(data.get("scenes"), list):
        return
    data["scenes"] = [
        {
            **s,
            "index": i,
            "cameraAngle": s.get("cameraAngle") if s.get("cameraAngle") in VALID_ANGLES else "front",
        }
        for i, s in enumerate(data["scenes"][:expected])
    ]


def _validate_parsed(data: dict):
    assert data.get("subject", {}).get("description"), "Missing subject.description"
    assert isinstance(data.get("subject", {}).get("keyFeatures"), list), "Missing subject.keyFeatures"
    assert data.get("style", {}).get("type") in VALID_STYLE_TYPES, "Invalid style.type"
    assert data.get("style", {}).get("lighting"), "Missing style.lighting"
    assert data.get("style", {}).get("renderingStyle"), "Missing style.renderingStyle"
    scenes = data.get("scenes", [])
    assert len(scenes) >= MIN_SCENES, f"Too few scenes: {len(scenes)}"
    for i, s in enumerate(scenes):
        assert s.get("description"), f"Scene {i}: missing description"
        assert s.get("action"), f"Scene {i}: missing action"
        assert s.get("backgroundHint"), f"Scene {i}: missing backgroundHint"


def _extract_json(text: str) -> dict:
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("No JSON in LLM response")
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", match.group())
        return json.loads(cleaned)


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
