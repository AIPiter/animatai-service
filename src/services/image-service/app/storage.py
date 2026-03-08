"""MinIO client — upload image buffers, return public URLs."""

import io
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
        # Ensure bucket exists
        if not _client.bucket_exists(settings.minio_bucket):
            _client.make_bucket(settings.minio_bucket)
            # Set public read policy
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


def upload_image(data: bytes, object_name: str, content_type: str = "image/png") -> str:
    """Upload bytes to MinIO. Returns a URL path usable by the frontend."""
    client = _get_client()
    client.put_object(
        settings.minio_bucket,
        object_name,
        io.BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
    host = settings.minio_url.replace(":9000", "")
    return f"/storage/{object_name}"   # served via gateway proxy or direct MinIO URL
