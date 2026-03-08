"""
RabbitMQ publisher — gateway sends jobs to worker queues.

Queues:
  jobs.llm    — scenario parsing
  jobs.image  — image generation
  jobs.video  — video generation + stitch
"""

import json
import aio_pika
from ..config import settings

_connection: aio_pika.RobustConnection | None = None
_channel: aio_pika.Channel | None = None

QUEUES = {
    "llm":   "jobs.llm",
    "image": "jobs.image",
    "video": "jobs.video",
}


async def _get_channel() -> aio_pika.Channel:
    global _connection, _channel
    if _connection is None or _connection.is_closed:
        _connection = await aio_pika.connect_robust(settings.rabbitmq_url)
    if _channel is None or _channel.is_closed:
        _channel = await _connection.channel()
        for q in QUEUES.values():
            await _channel.declare_queue(q, durable=True)
    return _channel


async def publish_job(queue_key: str, payload: dict):
    """Publish a job message to the given queue (llm | image | video)."""
    ch = await _get_channel()
    queue_name = QUEUES[queue_key]
    await ch.default_exchange.publish(
        aio_pika.Message(
            body=json.dumps(payload).encode(),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            content_type="application/json",
        ),
        routing_key=queue_name,
    )


async def close():
    global _connection, _channel
    if _channel and not _channel.is_closed:
        await _channel.close()
    if _connection and not _connection.is_closed:
        await _connection.close()
    _connection = None
    _channel = None
