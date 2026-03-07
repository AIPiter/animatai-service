# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev    # Start with --watch (auto-restart on changes)
npm start      # Production start
```

No test runner or linter is configured.

## Environment Variables

```
DATABASE_URL=         # PostgreSQL connection string
JWT_SECRET=           # Secret for JWT signing
OPENROUTER_API_KEY=   # Used for both LLM (scenario splitting) and image generation
FAL_KEY=              # fal.ai for FLUX image gen (deluxe) and video gen
PORT=3000
LLM_MODEL=            # optional, defaults to google/gemini-2.5-pro
IMAGE_MODEL=          # optional, defaults to openai/gpt-image-1
VIDEO_MODEL=          # optional, defaults to fal-ai/minimax-video/image-to-video
RESEND_API_KEY=       # optional, for email verification (resend.com)
```

## Architecture

**ESM modules** throughout (`"type": "module"` in package.json). Use `import`/`export` syntax.

All Express routes are defined directly in `src/server.js` (not split into route files). All DB queries are prepared statements exported from `src/db.js`.

**Database:** PostgreSQL via `pg` (Pool with `DATABASE_URL`). Schema is maintained via inline `try/catch` migrations in `runMigrations()` in `src/db.js` (idempotent `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS` calls).

**File storage:** Generated assets are saved to `storage/` at project root:
- `storage/images/` — generated frames and extracted last-frames
- `storage/clips/` — generated video clips
- `storage/output/` — final stitched videos + ASS subtitle files

Paths stored in DB are relative web paths like `/storage/images/filename.png`.

**Auth:** JWT access tokens (15min) + refresh tokens (30 days). Middleware: `requireAuth` from `src/auth.js`. Requires `JWT_SECRET` env var. All project/scene routes require auth.

## Project Modes

Two active modes (pro/freetrial projects are deleted on startup):

| Mode | Scenes | Duration | Image Gen | Video Gen |
|------|--------|----------|-----------|-----------|
| `standard` | 1–12 (user-chosen) | scene_count × 5s | OpenRouter (gpt-image-1) | MiniMax via fal.ai |
| `deluxe` | 3 (chained last-frame) | ~15s | FLUX-2-pro via fal.ai | Kling v2.6 pro + audio |

**Deluxe mode** uses a chained pipeline: only scene 1 generates an image. After each clip is generated, the last frame is extracted via FFmpeg and used as the starting image for the next scene.

## Startup Sequence

On startup (in order):
1. `runMigrations()` — run DB migrations
2. `deleteObsoleteProjects()` — delete all `pro` and `freetrial` mode projects + their files
3. `resetOrphanedGeneratingScenes()` — reset stuck `generating`/`queued` scenes (no fal request ID) back to `pending`
4. `recoverVideoQueue()` — re-enqueue scenes that have a `fal_video_request_id` (already submitted but not polled)

## Video Queue

Global in-memory queue with max 2 concurrent jobs. Scenes pass through:
```
pending → queued → generating → done | error
```

- `enqueueVideo(sceneId, projectId, falKey)` — sets status to `queued` and adds to queue
- `drainQueue()` — starts jobs up to `MAX_CONCURRENT = 2`
- On server restart, scenes with a saved `fal_video_request_id` resume polling (recovery)

## Key API Endpoints

### Auth
```
POST   /api/auth/register     — register (email, username, password)
POST   /api/auth/login        — login → { accessToken, refreshToken }
POST   /api/auth/refresh      — rotate refresh token → { accessToken, refreshToken }
POST   /api/auth/logout       — invalidate refresh token
GET    /api/auth/me           — current user info (requireAuth)
```

### Projects
```
GET    /api/projects                                        — list user's projects
POST   /api/projects                                        — create project + split scenario (LLM)
GET    /api/projects/:id                                    — get project with scenes
PATCH  /api/projects/:id                                    — update project name
DELETE /api/projects/:id                                    — delete project + all files
```

### Images
```
POST   /api/projects/:id/generate                           — generate images for all scenes
POST   /api/projects/:id/scenes/:sceneId/generate-image     — generate/regenerate image for one scene
POST   /api/projects/:id/scenes/:sceneId/regenerate         — regenerate single scene image (alias)
```

### Scenes
```
PATCH  /api/projects/:id/scenes/:sceneId                    — update video_prompt or image_prompt
PATCH  /api/projects/:id/scenes/:sceneId/clip-duration      — set clip duration (deluxe: 5 or 10; standard: 6 only)
GET    /api/projects/:id/scenes                             — list scenes for project
```

### Video Generation
```
POST   /api/projects/:id/video                              — queue video for all scenes with images
POST   /api/projects/:id/scenes/:sceneId/video              — queue video for a single scene
```

### History
```
GET    /api/projects/:id/scenes/:sceneId/history                        — get image/video history
POST   /api/projects/:id/scenes/:sceneId/history/:historyId/restore     — restore a history item
```

### Render & Download
```
POST   /api/projects/:id/render     — stitch clips + burn subtitles (FFmpeg)
GET    /api/projects/:id/download   — download final .mp4
```

## Scene Status Flow

```
image status:  pending → done
video_status:  pending → queued → generating → done | error
project status: created → scenes_ready → generating → done → videos_ready → rendering → rendered
```

## Scene History

Each time an image or video is regenerated, the old file is saved to `scene_history`. Max 2 history items per type per scene (older ones are deleted). History can be restored via the restore endpoint, which swaps the current asset with the historical one.

## Subtitle Format

`subtitle_text` in DB uses `|` as a phrase separator. During render, each scene's text is split by `|` and timed evenly within the clip duration. Subtitles are rendered as TikTok-style ASS (Arial Bold, white with black outline, bottom-center, 200ms fade).

## External APIs

- **LLM + standard image gen:** OpenRouter (`https://openrouter.ai/api/v1/chat/completions`) — supports both chat and image generation models via the same endpoint
- **FLUX images:** `@fal-ai/client` queue API with polling (5-min timeout)
- **Video (MiniMax):** `fal-ai/minimax-video/image-to-video` via fal.ai queue (20-min timeout)
- **Video (Kling):** `fal-ai/kling-video/v2.6/pro/image-to-video` via fal.ai queue — supports `generate_audio` + `voice_ids` for deluxe

All fal.ai calls use the queue pattern: `fal.queue.submit()` → poll `fal.queue.status()` → `fal.queue.result()`.

API keys (`FAL_KEY`, `X-Openrouter-Key`) are passed from the frontend via request headers (`X-Fal-Key` / `X-Openrouter-Key`) for project pipeline calls.
