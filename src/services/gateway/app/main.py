from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .auth import verify_access_token
from .db import close_pool
from .messaging.publisher import close as close_publisher
from .messaging.status_listener import start_listener
from .routes import auth, events, projects

UNPROTECTED = {"/auth/register", "/auth/verify", "/auth/login", "/auth/refresh", "/health"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    await start_listener()
    yield
    await close_pool()
    await close_publisher()


app = FastAPI(title="AnimatAI Gateway", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth middleware ───────────────────────────────────────────────────────────

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in UNPROTECTED or request.method == "OPTIONS":
        return await call_next(request)

    token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]

    # SSE connections (EventSource) can't send headers — accept token as query param
    if not token:
        token = request.query_params.get("token") or None

    if not token:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)

    user_id = verify_access_token(token)
    if not user_id:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)

    request.state.user_id = user_id
    return await call_next(request)


# ── Routes ────────────────────────────────────────────────────────────────────

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(events.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
