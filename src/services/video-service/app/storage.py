"""MinIO client for video-service — download source assets, upload results."""

import io
import httpx
from minio import Minio
from .config import settings

_client: Minio | None = None


def _get_client() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            settings.minio_url,
            access_key=settings.minio_user,
            secret_key=settings.minio_pass,
            secure=False,
        )
        if not _client.bucket_exists(settings.minio_bucket):
            _client.make_bucket(settings.minio_bucket)
            import json
            policy = {
                "Version": "2012-10-17",
                "Statement": [{
                    "Effect": "Allow",
                    "Principal": {"AWS": ["*"]},
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{settings.minio_bucket}/*"],
                }],
            }
            _client.set_bucket_policy(settings.minio_bucket, json.dumps(policy))
    return _client


def upload_file(data: bytes, object_name: str, content_type: str = "video/mp4") -> str:
    client = _get_client()
    client.put_object(
        settings.minio_bucket,
        object_name,
        io.BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
    return f"/storage/{object_name}"


def download_file(object_name: str) -> bytes:
    """Download an object from MinIO by its object name (strips leading /storage/)."""
    key = object_name.lstrip("/").removeprefix("storage/")
    client = _get_client()
    response = client.get_object(settings.minio_bucket, key)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


async def download_url(url: str) -> bytes:
    """Download from an external URL (fal.ai CDN, etc.)."""
    async with httpx.AsyncClient(timeout=120) as client:
        for attempt in range(1, 4):
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                return resp.content
            except Exception as e:
                if attempt == 3:
                    raise
                import asyncio
                await asyncio.sleep(5 * attempt)
