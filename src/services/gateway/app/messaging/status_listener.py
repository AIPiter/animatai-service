"""
Redis pub/sub listener — receives status updates from worker services
and forwards them to connected SSE clients.

Channel pattern: project:{project_id}:events
"""

import asyncio
import json
import redis.asyncio as aioredis
from ..config import settings

# project_id → set of asyncio.Queue instances (one per SSE connection)
_subscribers: dict[str, set[asyncio.Queue]] = {}

_redis: aioredis.Redis | None = None
_listener_task: asyncio.Task | None = None


def channel_name(project_id: str) -> str:
    return f"project:{project_id}:events"


async def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def subscribe(project_id: str) -> asyncio.Queue:
    """Register a new SSE listener for project_id. Returns a queue to read events from."""
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    _subscribers.setdefault(project_id, set()).add(q)
    return q


def unsubscribe(project_id: str, q: asyncio.Queue):
    if project_id in _subscribers:
        _subscribers[project_id].discard(q)
        if not _subscribers[project_id]:
            del _subscribers[project_id]


async def _dispatch(project_id: str, message: str):
    for q in list(_subscribers.get(project_id, [])):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            pass  # slow consumer — drop message


async def _listener_loop():
    r = await _get_redis()
    pubsub = r.pubsub()
    # Subscribe to wildcard pattern — requires psubscribe
    await pubsub.psubscribe("project:*:events")
    async for raw in pubsub.listen():
        if raw["type"] != "pmessage":
            continue
        # Extract project_id from channel name
        channel: str = raw["channel"]
        parts = channel.split(":")
        if len(parts) >= 2:
            project_id = parts[1]
            await _dispatch(project_id, raw["data"])


async def start_listener():
    global _listener_task
    if _listener_task is None or _listener_task.done():
        _listener_task = asyncio.create_task(_listener_loop())


async def publish_status(project_id: str, event: str, data: dict):
    """Publish a status update from within the gateway (e.g. render complete)."""
    r = await _get_redis()
    payload = json.dumps({"event": event, "data": data})
    await r.publish(channel_name(project_id), payload)
