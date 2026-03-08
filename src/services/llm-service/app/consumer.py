"""
RabbitMQ consumer for the LLM service.
Routes jobs by mode to the correct handler, then persists results to DB
and publishes a status update via Redis.
"""

import asyncio
import json
import uuid

import aio_pika
import asyncpg

from .config import settings
from .messaging.status import publish
from .modes.lite    import split_scenario as lite
from .modes.deluxe  import split_scenario as deluxe
from .modes.standard import subject_parser as standard

QUEUE_NAME = "jobs.llm"


async def _get_db_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)


async def _handle_job(job: dict, pool: asyncpg.Pool):
    project_id = job["project_id"]
    mode       = job["mode"]
    action     = job["action"]
    payload    = job["payload"]
    api_keys   = job.get("api_keys", {})

    print(f"[llm] job={job['job_id']} mode={mode} action={action}")

    try:
        if action != "parse_scenario":
            raise ValueError(f"Unknown action: {action}")

        if mode == "lite":
            result = await lite.run(payload, api_keys)
        elif mode == "deluxe":
            result = await deluxe.run(payload, api_keys)
        elif mode == "standard":
            result = await standard.run(payload, api_keys)
        else:
            raise ValueError(f"Unknown mode: {mode}")

        # Persist scenes to DB
        scenes = result["scenes"]
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE projects SET character_description = $1, scene_count = $2, status = $3 WHERE id = $4",
                result.get("character_description"),
                len(scenes),
                "scenes_ready",
                project_id,
            )
            for i, scene in enumerate(scenes):
                scene_id = str(uuid.uuid4())
                await conn.execute(
                    """
                    INSERT INTO scenes (id, project_id, scene_number, description, image_prompt,
                                       subtitle_text, video_prompt, scene_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    scene_id,
                    project_id,
                    i + 1,
                    scene.get("description", ""),
                    scene.get("image_prompt"),
                    scene.get("subtitle_text"),
                    scene.get("video_prompt"),
                    scene.get("scene_type", "main"),
                )

        await publish(project_id, "llm_done", {
            "scene_count": len(scenes),
            "status":      "scenes_ready",
        })

    except Exception as e:
        print(f"[llm] ERROR job={job['job_id']}: {e}")
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE projects SET status = 'error' WHERE id = $1", project_id
            )
        await publish(project_id, "error", {"message": str(e)})


async def run():
    pool = await _get_db_pool()
    connection = await aio_pika.connect_robust(settings.rabbitmq_url)
    channel    = await connection.channel()
    await channel.set_qos(prefetch_count=2)

    queue = await channel.declare_queue(QUEUE_NAME, durable=True)
    print(f"[llm] Listening on {QUEUE_NAME}")

    async with queue.iterator() as q_iter:
        async for message in q_iter:
            async with message.process():
                try:
                    job = json.loads(message.body)
                    await _handle_job(job, pool)
                except Exception as e:
                    print(f"[llm] Unhandled exception: {e}")
