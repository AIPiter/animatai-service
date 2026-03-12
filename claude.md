# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker compose up --build -d           # Build and start all services
docker compose down                    # Stop all services
docker compose logs <service> -f       # Follow logs for a service
docker compose up --build -d <service> # Rebuild a single service
```

No test runner or linter is configured.

## Architecture

**Python FastAPI microservices** with a React/TypeScript frontend.

```
src/
  services/
    gateway/        # FastAPI — auth, project API, SSE, publishes jobs to RabbitMQ
    llm-service/    # Consumes jobs.llm — splits scenario into scenes (lite/deluxe)
    image-service/  # Consumes jobs.image — generates images, uploads to MinIO
    video-service/  # Consumes jobs.video — generates clips, stitches final video (ffmpeg)
                    # Also runs the full standard mode pipeline orchestrator
  frontend/         # React 18 + Vite + TypeScript — served via nginx
  schema.sql        # PostgreSQL schema (loaded by postgres on first init)
```

Each service uses **`uv`** as the Python package manager (`pyproject.toml` per service).
Docker base image: `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`

## Infrastructure (docker-compose.yml)

| Service   | Host port | Purpose                        |
|-----------|-----------|--------------------------------|
| postgres  | —         | PostgreSQL 16                  |
| rabbitmq  | 15672     | RabbitMQ (management UI)       |
| redis     | —         | Pub/sub for SSE status updates |
| minio     | 9001      | Object storage (MinIO console) |
| gateway   | 3000      | API gateway (maps → 8000)      |
| frontend  | 5173      | nginx serving built React SPA  |

All app services `depend_on` infra services with `condition: service_healthy`.

## Environment Variables

```
# Required
JWT_SECRET=           # python -c "import secrets; print(secrets.token_hex(32))"

# Defaults work out of the box with docker-compose
DATABASE_URL=postgresql://animatai:animatai@postgres:5432/animatai
RABBITMQ_URL=amqp://animatai:animatai@rabbitmq:5672/
REDIS_URL=redis://redis:6379
MINIO_URL=minio:9000
MINIO_USER=animatai
MINIO_PASS=animatai_secret
MINIO_BUCKET=animatai

# Optional
RESEND_API_KEY=       # email sending — not required, registration works without it
FROM_EMAIL=noreply@animatai.app
PORT=3000
```

API keys (FAL_KEY, OpenRouter key) are **never stored server-side** — passed per-request from the frontend via `X-Fal-Key` / `X-Openrouter-Key` headers and included in RabbitMQ job messages as `api_keys: {fal, openrouter}`.

## Auth

- JWT access tokens (15 min) via `python-jose` HS256
- Refresh tokens (30 days) stored as SHA-256 hash in `refresh_tokens` table, set as `HttpOnly` cookie
- Validation only in Gateway middleware (`src/services/gateway/app/main.py`)
- Unprotected paths: `/auth/register`, `/auth/login`, `/auth/refresh`, `/health`
- SSE connections pass token as `?token=` query param (EventSource can't send headers)
- **Email verification is disabled** — `/auth/register` directly creates user and returns tokens

## Project Modes

| Mode       | Scenes | LLM                                      | Image Gen                                    | Video Gen                                         |
|------------|--------|------------------------------------------|----------------------------------------------|----------------------------------------------------|
| `lite`     | 1–12   | `google/gemini-2.5-pro` via OpenRouter   | `google/gemini-3.1-flash-image-preview` via OpenRouter | MiniMax via fal.ai                                |
| `deluxe`   | 3      | `google/gemini-2.5-pro` via OpenRouter   | `fal-ai/flux-2-pro` via fal.ai               | `fal-ai/kling-video/v2.6/pro` + audio via fal.ai |
| `standard` | 2–7    | `anthropic/claude-sonnet-4-5` via OpenRouter | Master: `fal-ai/flux-pro/v1.1`, Frames: `fal-ai/flux-pro/kontext` via fal.ai | `fal-ai/wan-flf2v` (fallback: `fal-ai/kling-video/o1`) via fal.ai |

**Deluxe mode** chains scenes: only scene 1 gets an image; after each clip is generated the last frame is extracted via ffmpeg and used as the starting image for the next scene. Supports voice IDs for audio generation.

**Standard mode** runs a full orchestrated pipeline inside video-service (`orchestrator.py`):
1. **Parsing** — Claude Sonnet extracts structured shot-list (subject, style, scenes)
2. **Master image** — FLUX-pro generates one canonical reference image
3. **Visual anchor** — Claude Sonnet vision analyzes the master image for consistency lock
4. **Frames** — FLUX Kontext generates a keyframe chain (N+1 frames for N scenes)
5. **PAUSE** — user reviews frames in the UI
6. **Video prompts** — built locally from frames + scene data (no API call)
7. **Clips** — WAN FLF2V generates clips (falls back to Kling O1 on failure)
8. **Concat** — ffmpeg stitches clips into final video

Standard mode project creation publishes directly to `jobs.video` (not `jobs.llm`).

**Valid project parameters:** modes `{lite, deluxe, standard}`, styles `{anime, cartoon, pixar}`, durations `{30, 60, 120}` seconds.

## Messaging Flow

### Lite / Deluxe
1. Gateway publishes job → `jobs.llm` (RabbitMQ, durable, persistent)
2. `llm-service` consumes, splits scenario, inserts scenes to DB, publishes status → Redis `project:{id}:events`
3. Gateway's `status_listener` picks up Redis pub/sub and forwards to SSE clients (`/api/events/{project_id}`)
4. Frontend `useProjectEvents` hook invalidates React Query cache on each SSE event
5. Image/video generation follows same publish → consume → Redis notify pattern via `jobs.image` / `jobs.video`

### Standard
1. Gateway publishes job → `jobs.video` with `action: "standard_pipeline"`
2. `video-service` orchestrator runs stages 1–4 internally (parsing, master image, visual anchor, frames)
3. Pipeline state is saved to Redis (`standard_pipeline:{project_id}`, 7-day TTL)
4. Pipeline pauses, user reviews frames via SSE events
5. User resumes via `POST /api/projects/:id/pipeline/resume` → `action: "standard_pipeline_resume"`
6. Orchestrator completes stages 5–8 (video prompts, clips, concat)

## File Storage (MinIO)

- Images: `images/<uuid>.png` → web path `/storage/images/<uuid>.png`
- Frames: `images/frame-<job_id>-<nn>.png` (standard mode keyframes)
- Master: `images/master-<seed>.png` (standard mode reference)
- Clips: `clips/<uuid>.mp4` → web path `/storage/clips/<uuid>.mp4`
- Output: `output/<uuid>.mp4` → web path `/storage/output/<uuid>.mp4`
- DB stores relative web paths like `/storage/images/filename.png`
- Bucket has public-read policy (set automatically on first use in `storage.py`)

## Scene Status Flow

```
image status:   pending → generating → done | error
video_status:   pending → queued → generating → done | error
project status: created → scenes_ready → generating → generating_videos → videos_ready → rendering → rendered | error
```

## Key API Endpoints

### Auth
```
POST  /auth/register   — register → { access_token } + refresh_token cookie
POST  /auth/login       — login → { access_token } + refresh_token cookie
POST  /auth/refresh     — rotate refresh token
POST  /auth/logout      — invalidate refresh token
GET   /auth/me          — current user info
```

### Projects
```
GET    /api/projects              — list user's projects
POST   /api/projects              — create project + enqueue pipeline
GET    /api/projects/:id          — get project with scenes
DELETE /api/projects/:id          — delete project + files
```

### Scene Operations
```
PATCH  /api/projects/:id/scenes/:scene_id              — update scene prompts / approve
POST   /api/projects/:id/scenes/:scene_id/regenerate   — regenerate single scene image
POST   /api/projects/:id/scenes/:scene_id/video        — generate video for single scene
GET    /api/projects/:id/history/:scene_id              — get scene version history
```

### Generation
```
POST  /api/projects/:id/generate        — enqueue image gen for all scenes
POST  /api/projects/:id/video           — enqueue video gen for all scenes
POST  /api/projects/:id/render          — stitch clips + burn subtitles
POST  /api/projects/:id/pipeline/resume — resume standard mode after frame approval
GET   /api/projects/:id/download        — get final video URL
```

### SSE
```
GET   /api/events/:id?token=<jwt>  — SSE stream for project status updates
```

## Frontend (src/frontend/)

- React 18 + Vite + TypeScript (strict, `"moduleResolution": "bundler"`)
- TanStack Query v5 — server state, invalidated by SSE events
- Zustand v5 + persist — client state (auth, API keys stored locally, sidebar)
- Framer Motion — page/button animations
- nginx serves built SPA, proxies `/api`, `/auth`, `/health` to gateway with SSE buffering disabled

## Subtitle Format

`subtitle_text` in DB uses `|` as phrase separator. During render each phrase is timed evenly within the clip duration. Subtitles are TikTok-style ASS (Arial Bold, white + black outline, bottom-center, 200ms fade).

## External APIs

All external API calls go through **OpenRouter** or **fal.ai**. No direct provider APIs.

| Purpose              | Provider   | Model                                        |
|----------------------|------------|----------------------------------------------|
| LLM (lite/deluxe)   | OpenRouter | `google/gemini-2.5-pro`                      |
| LLM (standard)      | OpenRouter | `anthropic/claude-sonnet-4-5`                |
| Vision (standard)   | OpenRouter | `anthropic/claude-sonnet-4-5`                |
| Name generation      | OpenRouter | `google/gemini-2.5-flash`                    |
| Lite images          | OpenRouter | `google/gemini-3.1-flash-image-preview`      |
| Standard images      | OpenRouter | `fal-ai/flux-kontext/pro` (via `/images/generations`) |
| Standard master img  | fal.ai     | `fal-ai/flux-pro/v1.1`                      |
| Standard frames      | fal.ai     | `fal-ai/flux-pro/kontext`                    |
| Deluxe images        | fal.ai     | `fal-ai/flux-2-pro`                          |
| Lite video           | fal.ai     | `fal-ai/minimax-video/image-to-video`        |
| Deluxe video         | fal.ai     | `fal-ai/kling-video/v2.6/pro/image-to-video` |
| Standard video       | fal.ai     | `fal-ai/wan-flf2v` (fallback: `fal-ai/kling-video/o1/image-to-video`) |

All fal.ai calls: `fal_client.submit_async()` → `handler.get()`.

## Database Schema

5 tables: `users`, `refresh_tokens`, `projects`, `scenes`, `scene_history`, `email_verifications`.
See `src/schema.sql` for full schema. Key relationships:
- `projects.user_id → users.id` (CASCADE delete)
- `scenes.project_id → projects.id` (CASCADE delete)
- `scene_history.scene_id → scenes.id` (CASCADE delete)
