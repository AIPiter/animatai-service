"""Publish status updates to Redis so the Gateway can forward them via SSE."""

import json
import redis.asyncio as aioredis
from ..config import settings

_redis: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def publish(project_id: str, event: str, data: dict):
    r = await _get_redis()
    payload = json.dumps({"event": event, "data": data})
    await r.publish(f"project:{project_id}:events", payload)
