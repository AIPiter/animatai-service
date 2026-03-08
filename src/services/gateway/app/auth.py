import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from .config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(seconds=settings.jwt_access_ttl)
    return jwt.encode(
        {"sub": user_id, "exp": expire, "type": "access"},
        settings.jwt_secret,
        algorithm="HS256",
    )


def create_refresh_token_raw() -> str:
    return secrets.token_hex(64)


def verify_access_token(token: str) -> str | None:
    """Returns user_id if valid, None otherwise."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        if payload.get("type") != "access":
            return None
        return payload.get("sub")
    except JWTError:
        return None


def refresh_token_expires_at() -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=settings.jwt_refresh_ttl)
