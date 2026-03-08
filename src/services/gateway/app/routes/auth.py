import random
import string
from datetime import timezone

from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr

from ..auth import (
    create_access_token,
    create_refresh_token_raw,
    hash_password,
    hash_token,
    refresh_token_expires_at,
    verify_password,
)
from .. import db

router = APIRouter(prefix="/auth", tags=["auth"])


def _code() -> str:
    return "".join(random.choices(string.digits, k=6))


# ── Register (step 1 — send code) ────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    username: str
    password: str


@router.post("/register")
async def register(body: RegisterRequest, response: Response):
    if len(body.username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    existing = await db.get_user_by_email(body.email)
    if existing:
        raise HTTPException(409, "Email already registered")

    pw_hash = hash_password(body.password)
    user = await db.create_user(body.email, body.username, pw_hash)
    return await _issue_tokens(user["id"], response)


# ── Verify (step 2 — confirm code, create user) ───────────────────────────────

class VerifyRequest(BaseModel):
    email: EmailStr
    code: str


@router.post("/verify")
async def verify(body: VerifyRequest, response: Response):
    record = await db.get_email_verification(body.email)
    if not record:
        raise HTTPException(400, "No pending verification for this email")

    if record["attempts"] >= 5:
        raise HTTPException(429, "Too many attempts. Please register again.")

    if record["code"] != body.code:
        await db.increment_verification_attempts(body.email)
        raise HTTPException(400, "Invalid verification code")

    user = await db.create_user(body.email, record["username"], record["password_hash"])
    await db.delete_email_verification(body.email)

    return await _issue_tokens(user["id"], response)


# ── Login ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str


@router.post("/login")
async def login(body: LoginRequest, response: Response):
    user = await db.get_user_by_email(body.email)
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid credentials")
    return await _issue_tokens(user["id"], response)


# ── Refresh ───────────────────────────────────────────────────────────────────

@router.post("/refresh")
async def refresh(response: Response, refresh_token: str | None = Cookie(default=None)):
    if not refresh_token:
        raise HTTPException(401, "No refresh token")

    token_hash = hash_token(refresh_token)
    record = await db.get_refresh_token(token_hash)
    if not record:
        raise HTTPException(401, "Invalid or expired refresh token")

    await db.delete_refresh_token(token_hash)
    return await _issue_tokens(str(record["user_id"]), response)


# ── Logout ────────────────────────────────────────────────────────────────────

@router.post("/logout")
async def logout(response: Response, refresh_token: str | None = Cookie(default=None)):
    if refresh_token:
        await db.delete_refresh_token(hash_token(refresh_token))
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}


# ── Me ────────────────────────────────────────────────────────────────────────

@router.get("/me")
async def me(request: Request):
    user_id = request.state.user_id
    user = await db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return {"id": user["id"], "email": user["email"], "username": user["username"]}


# ── Helper ────────────────────────────────────────────────────────────────────

async def _issue_tokens(user_id, response: Response) -> dict:
    user_id = str(user_id)
    access_token = create_access_token(user_id)

    raw_refresh = create_refresh_token_raw()
    token_hash = hash_token(raw_refresh)
    expires_at = refresh_token_expires_at()
    await db.create_refresh_token(user_id, token_hash, expires_at)

    response.set_cookie(
        "refresh_token",
        raw_refresh,
        httponly=True,
        secure=False,   # set True in production with HTTPS
        samesite="lax",
        max_age=30 * 24 * 3600,
    )
    return {"access_token": access_token}
