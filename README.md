# AnimatAI

AI-powered animated video generation service. Describe a scenario in text, get a fully rendered video with scenes, transitions, and subtitles.

## How It Works

1. **Write a scenario** — describe what should happen in the video
2. **AI splits it into scenes** — LLM breaks the story into a shot-list with image/video prompts
3. **Images are generated** — each scene gets a keyframe image via AI image models
4. **Videos are generated** — images are animated into video clips
5. **Final render** — clips are stitched together with subtitles via ffmpeg

## Three Generation Modes

| Mode       | Scenes | Best For                        | Speed   |
|------------|--------|---------------------------------|---------|
| **Lite**   | 1–12   | Quick drafts, simple animations | Fast    |
| **Deluxe** | 3      | High-quality shorts with audio  | Medium  |
| **Standard** | 2–7  | Subject-consistent video        | Slower  |

- **Lite** — Gemini generates images, MiniMax animates them. Independent scenes.
- **Deluxe** — FLUX-2-pro images, Kling v2.6 pro video with audio. Scenes are chained (last frame → next scene start image).
- **Standard** — Full orchestrated pipeline: a master reference image is generated, then FLUX Kontext creates consistent keyframes across all scenes. User reviews frames before video generation proceeds with WAN FLF2V.

## Architecture

```
┌──────────┐     ┌─────────┐     ┌────────────┐     ┌───────────────┐
│ Frontend │────▶│ Gateway │────▶│  RabbitMQ  │────▶│  LLM Service  │
│ React+TS │◀────│ FastAPI │◀────│            │     │  (lite/deluxe) │
└──────────┘ SSE └─────────┘     │            │────▶│ Image Service  │
                      │          │            │────▶│ Video Service  │
                      │          └────────────┘     │ (+ standard    │
                      │                             │   orchestrator)│
                   ┌──┴──┐                          └───────────────┘
                   │Redis│  pub/sub status updates         │
                   └─────┘                           ┌─────┴─────┐
                                                     │   MinIO   │
                   ┌──────────┐                      │  (files)  │
                   │PostgreSQL│                      └───────────┘
                   └──────────┘
```

- **Gateway** — FastAPI. Auth, REST API, SSE event streaming, publishes jobs to RabbitMQ
- **LLM Service** — Consumes `jobs.llm`, splits scenarios into scenes (lite/deluxe modes)
- **Image Service** — Consumes `jobs.image`, generates images, uploads to MinIO
- **Video Service** — Consumes `jobs.video`, generates video clips, runs standard mode orchestrator, stitches final video with ffmpeg
- **Frontend** — React 18 + Vite + TypeScript, served via nginx

## Quick Start

### Prerequisites

- Docker & Docker Compose
- API keys: [fal.ai](https://fal.ai) and [OpenRouter](https://openrouter.ai)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/AIPiter/animatai-service.git
cd animatai-service

# 2. Create .env from example
cp .env.example .env

# 3. Generate JWT secret and add to .env
python -c "import secrets; print(secrets.token_hex(64))"
# Paste the output as JWT_SECRET= in .env

# 4. Build and start all services
docker compose up --build -d

# 5. Open the app
open http://localhost:5173
```

API keys (fal.ai and OpenRouter) are entered in the frontend UI — they are never stored on the server.

### Common Commands

```bash
docker compose up --build -d           # Build and start all services
docker compose down                    # Stop all services
docker compose logs gateway -f         # Follow gateway logs
docker compose logs video-service -f   # Follow video service logs
docker compose up --build -d gateway   # Rebuild a single service
```

## Tech Stack

### Backend
- **Python 3.12** + **FastAPI** (async)
- **PostgreSQL 16** — users, projects, scenes
- **RabbitMQ** — job queue (durable, persistent messages)
- **Redis** — pub/sub for real-time SSE status updates + standard pipeline state
- **MinIO** — S3-compatible object storage for images/videos
- **ffmpeg** — video stitching and subtitle burning
- **uv** — Python package manager

### Frontend
- **React 18** + **TypeScript** (strict)
- **Vite 6** — build tool
- **TanStack Query v5** — server state, invalidated by SSE events
- **Zustand v5** — client state (auth, API keys, sidebar)
- **Framer Motion** — animations
- **nginx** — serves built SPA, proxies API requests

### External AI APIs
- **OpenRouter** — LLM (Gemini 2.5 Pro, Claude Sonnet 4.5), image generation (Gemini Flash, FLUX Kontext)
- **fal.ai** — image generation (FLUX-pro, FLUX-2-pro, FLUX Kontext), video generation (MiniMax, Kling, WAN FLF2V)

## API Overview

### Auth
| Method | Endpoint          | Description                    |
|--------|-------------------|--------------------------------|
| POST   | `/auth/register`  | Register (returns JWT + cookie)|
| POST   | `/auth/login`     | Login                          |
| POST   | `/auth/refresh`   | Rotate refresh token           |
| POST   | `/auth/logout`    | Invalidate refresh token       |
| GET    | `/auth/me`        | Current user info              |

### Projects
| Method | Endpoint                                      | Description                          |
|--------|-----------------------------------------------|--------------------------------------|
| GET    | `/api/projects`                               | List user's projects                 |
| POST   | `/api/projects`                               | Create project + start pipeline      |
| GET    | `/api/projects/:id`                           | Get project with scenes              |
| DELETE | `/api/projects/:id`                           | Delete project and all files         |
| POST   | `/api/projects/:id/generate`                  | Generate images for all scenes       |
| POST   | `/api/projects/:id/video`                     | Generate videos for all scenes       |
| POST   | `/api/projects/:id/render`                    | Stitch clips + burn subtitles        |
| POST   | `/api/projects/:id/pipeline/resume`           | Resume standard mode pipeline        |
| GET    | `/api/projects/:id/download`                  | Get final video URL                  |
| PATCH  | `/api/projects/:id/scenes/:sid`               | Update scene prompts / approve       |
| POST   | `/api/projects/:id/scenes/:sid/regenerate`    | Regenerate single scene image        |
| POST   | `/api/projects/:id/scenes/:sid/video`         | Generate video for single scene      |
| GET    | `/api/projects/:id/history/:sid`              | Scene version history                |
| GET    | `/api/events/:id?token=<jwt>`                 | SSE stream for status updates        |

## Environment Variables

| Variable          | Required | Default                                    | Description                |
|-------------------|----------|--------------------------------------------|----------------------------|
| `JWT_SECRET`      | Yes      | —                                          | Secret for JWT signing     |
| `DATABASE_URL`    | No       | `postgresql://animatai:animatai@postgres:5432/animatai` | PostgreSQL connection |
| `RABBITMQ_URL`    | No       | `amqp://animatai:animatai@rabbitmq:5672/`  | RabbitMQ connection        |
| `REDIS_URL`       | No       | `redis://redis:6379`                       | Redis connection           |
| `MINIO_URL`       | No       | `minio:9000`                               | MinIO endpoint             |
| `MINIO_USER`      | No       | `animatai`                                 | MinIO access key           |
| `MINIO_PASS`      | No       | `animatai_secret`                          | MinIO secret key           |
| `MINIO_BUCKET`    | No       | `animatai`                                 | MinIO bucket name          |
| `RESEND_API_KEY`  | No       | —                                          | Email sending (optional)   |
| `PORT`            | No       | `3000`                                     | Gateway host port          |

## Infrastructure Ports

| Service  | Port  | Description            |
|----------|-------|------------------------|
| Frontend | 5173  | Web UI (nginx)         |
| Gateway  | 3000  | API (FastAPI → 8000)   |
| RabbitMQ | 15672 | Management UI          |
| MinIO    | 9001  | Console UI             |

## License

See [LICENSE](LICENSE) for details.
