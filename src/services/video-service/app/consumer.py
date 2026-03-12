"""
Video service consumer — handles generate_videos and render actions.
Routes by mode (lite / deluxe / standard).
"""

import asyncio
import json

import aio_pika
import asyncpg

from .config import settings
from .messaging.status import publish
from .storage import upload_file, download_file
from .stitcher import stitch_videos
from .modes.lite     import generate as lite_gen
from .modes.deluxe   import generate as deluxe_gen
from .modes.standard import generate as standard_gen
from .modes.standard.orchestrator import (
    run_standard_pipeline,
    resume_standard_pipeline,
    get_pipeline_job,
)

QUEUE_NAME = "jobs.video"


async def _get_db_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)


# ── generate_videos ───────────────────────────────────────────────────────────

async def _handle_generate(job: dict, pool: asyncpg.Pool):
    project_id = job["project_id"]
    mode       = job["mode"]
    scenes     = job["payload"]["scenes"]
    api_keys   = job.get("api_keys", {})
    voice_ids  = job["payload"].get("voice_ids") or []
    if isinstance(voice_ids, str):
        import json as _json
        try:
            voice_ids = _json.loads(voice_ids)
        except Exception:
            voice_ids = []

    if mode == "lite":
        await _generate_lite(project_id, scenes, api_keys, pool)
    elif mode == "deluxe":
        await _generate_deluxe(project_id, scenes, api_keys, pool, voice_ids)
    elif mode == "standard":
        await _generate_standard(project_id, scenes, api_keys, pool)
    else:
        raise ValueError(f"Unknown mode: {mode}")


async def _generate_lite(project_id, scenes, api_keys, pool):
    """Generate each clip independently (no chaining)."""
    for scene in scenes:
        scene_id = scene["id"]
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_status = 'generating' WHERE id = $1", scene_id
                )
            video_bytes = await lite_gen.generate_clip(scene, api_keys)
            path        = upload_file(video_bytes, f"clips/clip-{scene_id}.mp4")
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_path = $1, video_status = 'done', video_error = NULL WHERE id = $2",
                    path, scene_id,
                )
            await publish(project_id, "video_done", {"scene_id": scene_id, "path": path})
        except Exception as e:
            print(f"[video] ERROR scene={scene_id}: {e}")
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_status = 'error', video_error = $1 WHERE id = $2",
                    str(e), scene_id,
                )
            await publish(project_id, "video_error", {"scene_id": scene_id, "message": str(e)})

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE projects SET status = 'videos_ready' WHERE id = $1", project_id
        )
    await publish(project_id, "all_videos_done", {})


async def _generate_deluxe(project_id, scenes, api_keys, pool, voice_ids):
    """Chained: last frame of clip N → start image of clip N+1."""
    sorted_scenes = sorted(scenes, key=lambda s: s["scene_number"])
    next_start_bytes: bytes | None = None

    for scene in sorted_scenes:
        scene_id = scene["id"]
        try:
            if next_start_bytes is None:
                # Scene 1: use stored image
                next_start_bytes = download_file(scene["image_path"])

            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_status = 'generating' WHERE id = $1", scene_id
                )

            video_bytes, last_frame = await deluxe_gen.generate_clip(
                scene, api_keys, next_start_bytes, voice_ids or None
            )
            next_start_bytes = last_frame

            clip_path  = upload_file(video_bytes, f"clips/clip-{scene_id}.mp4")
            frame_path = upload_file(last_frame,  f"images/lastframe-{scene_id}.jpg", "image/jpeg")

            async with pool.acquire() as conn:
                await conn.execute(
                    """UPDATE scenes SET video_path = $1, last_frame_path = $2,
                       video_status = 'done', video_error = NULL WHERE id = $3""",
                    clip_path, frame_path, scene_id,
                )
            await publish(project_id, "video_done", {"scene_id": scene_id, "path": clip_path})

        except Exception as e:
            print(f"[video] ERROR scene={scene_id}: {e}")
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_status = 'error', video_error = $1 WHERE id = $2",
                    str(e), scene_id,
                )
            await publish(project_id, "video_error", {"scene_id": scene_id, "message": str(e)})
            break  # deluxe chain breaks on error

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE projects SET status = 'videos_ready' WHERE id = $1", project_id
        )
    await publish(project_id, "all_videos_done", {})


async def _generate_standard(project_id, scenes, api_keys, pool):
    """Standard: each scene has its own generated start frame; clips independent."""
    sorted_scenes = sorted(scenes, key=lambda s: s["scene_number"])

    for scene in sorted_scenes:
        scene_id = scene["id"]
        try:
            start_bytes = download_file(scene["image_path"])
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_status = 'generating' WHERE id = $1", scene_id
                )
            video_bytes = await standard_gen.generate_clip(scene, api_keys, start_bytes)
            path        = upload_file(video_bytes, f"clips/clip-{scene_id}.mp4")
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_path = $1, video_status = 'done', video_error = NULL WHERE id = $2",
                    path, scene_id,
                )
            await publish(project_id, "video_done", {"scene_id": scene_id, "path": path})
        except Exception as e:
            print(f"[video] ERROR scene={scene_id}: {e}")
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scenes SET video_status = 'error', video_error = $1 WHERE id = $2",
                    str(e), scene_id,
                )
            await publish(project_id, "video_error", {"scene_id": scene_id, "message": str(e)})

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE projects SET status = 'videos_ready' WHERE id = $1", project_id
        )
    await publish(project_id, "all_videos_done", {})


# ── render ────────────────────────────────────────────────────────────────────

async def _handle_render(job: dict, pool: asyncpg.Pool):
    project_id = job["project_id"]
    mode       = job["mode"]
    scenes     = job["payload"]["scenes"]

    clips      = [download_file(s["video_path"]) for s in scenes]
    keep_audio = mode == "deluxe"

    final_bytes = stitch_videos(clips, scenes, project_id, keep_audio=keep_audio)
    final_path  = upload_file(final_bytes, f"output/project-{project_id}.mp4")

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE projects SET final_video_path = $1, status = 'rendered' WHERE id = $2",
            final_path, project_id,
        )
    await publish(project_id, "render_done", {"path": final_path})


# ── Main consumer loop ────────────────────────────────────────────────────────

async def run():
    pool       = await _get_db_pool()
    connection = await aio_pika.connect_robust(settings.rabbitmq_url)
    channel    = await connection.channel()
    await channel.set_qos(prefetch_count=1)  # video jobs are heavy

    queue = await channel.declare_queue(QUEUE_NAME, durable=True)
    print(f"[video] Listening on {QUEUE_NAME}")

    async with queue.iterator() as q_iter:
        async for message in q_iter:
            async with message.process():
                try:
                    job    = json.loads(message.body)
                    action = job.get("action")
                    print(f"[video] job={job['job_id']} action={action} mode={job['mode']}")

                    if action == "generate_videos":
                        await _handle_generate(job, pool)
                    elif action == "render":
                        await _handle_render(job, pool)
                    elif action == "standard_pipeline":
                        await run_standard_pipeline(
                            project_id=job["project_id"],
                            user_id=job["user_id"],
                            payload=job["payload"],
                            api_keys=job.get("api_keys", {}),
                            pool=pool,
                        )
                    elif action == "standard_pipeline_resume":
                        await resume_standard_pipeline(
                            project_id=job["project_id"],
                            api_keys=job.get("api_keys", {}),
                            pool=pool,
                            from_stage=job["payload"].get("from_stage", "video_prompts"),
                        )
                    else:
                        print(f"[video] Unknown action: {action}")
                except Exception as e:
                    print(f"[video] Unhandled exception: {e}")
