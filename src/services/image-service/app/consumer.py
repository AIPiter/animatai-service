import asyncio
import json

import aio_pika
import asyncpg

from .config import settings
from .messaging.status import publish
from .storage import upload_image
from .modes.lite     import generate as lite_gen
from .modes.deluxe   import generate as deluxe_gen
from .modes.standard import generate as standard_gen

QUEUE_NAME = "jobs.image"

MODE_HANDLERS = {
    "lite":     lite_gen.run,
    "deluxe":   deluxe_gen.run,
    "standard": standard_gen.run,
}


async def _get_db_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)


async def _handle_job(job: dict, pool: asyncpg.Pool):
    project_id = job["project_id"]
    scene_id   = job["scene_id"]
    mode       = job["mode"]
    payload    = job["payload"]
    api_keys   = job.get("api_keys", {})
    filename   = payload.get("filename", f"scene-{scene_id}.png")

    print(f"[image] job={job['job_id']} mode={mode} scene={scene_id}")

    try:
        handler = MODE_HANDLERS.get(mode)
        if not handler:
            raise ValueError(f"Unknown mode: {mode}")

        image_bytes = await handler(payload, api_keys)
        image_path  = upload_image(image_bytes, f"images/{filename}")

        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE scenes SET image_path = $1, status = 'done', error_message = NULL WHERE id = $2",
                image_path, scene_id,
            )
            # Check if all scenes for this project are done
            total  = await conn.fetchval("SELECT COUNT(*) FROM scenes WHERE project_id = $1", project_id)
            done   = await conn.fetchval(
                "SELECT COUNT(*) FROM scenes WHERE project_id = $1 AND status = 'done'", project_id
            )
            if total and done >= total:
                await conn.execute(
                    "UPDATE projects SET status = 'scenes_ready' WHERE id = $1", project_id
                )

        await publish(project_id, "image_done", {"scene_id": scene_id, "path": image_path})

    except Exception as e:
        print(f"[image] ERROR job={job['job_id']}: {e}")
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE scenes SET status = 'error', error_message = $1 WHERE id = $2",
                str(e), scene_id,
            )
        await publish(project_id, "image_error", {"scene_id": scene_id, "message": str(e)})


async def run():
    pool       = await _get_db_pool()
    connection = await aio_pika.connect_robust(settings.rabbitmq_url)
    channel    = await connection.channel()
    await channel.set_qos(prefetch_count=3)

    queue = await channel.declare_queue(QUEUE_NAME, durable=True)
    print(f"[image] Listening on {QUEUE_NAME}")

    async with queue.iterator() as q_iter:
        async for message in q_iter:
            async with message.process():
                try:
                    job = json.loads(message.body)
                    await _handle_job(job, pool)
                except Exception as e:
                    print(f"[image] Unhandled exception: {e}")
