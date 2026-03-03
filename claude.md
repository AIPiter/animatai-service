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
OPENROUTER_API_KEY=   # Used for both LLM (scenario splitting) and image generation
FAL_KEY=              # fal.ai for FLUX image gen (deluxe/freetrial) and video gen
PORT=3000
LLM_MODEL=            # optional, defaults to google/gemini-2.5-pro
IMAGE_MODEL=          # optional, defaults to openai/gpt-image-1
VIDEO_MODEL=          # optional, defaults to fal-ai/minimax-video/image-to-video
```

## Architecture

**ESM modules** throughout (`"type": "module"` in package.json). Use `import`/`export` syntax.

All Express routes are defined directly in `src/server.js` (not split into route files). All DB queries are prepared statements exported from `src/db.js`.

**Database:** SQLite via `better-sqlite3`. Schema is in `src/db.js` with inline `try/catch` migrations (`ALTER TABLE` wrapped in try/catch for idempotency). DB file is `animatai.db` at project root.

**File storage:** Generated assets are saved to `storage/` at project root:
- `storage/images/` — generated frames and extracted last-frames
- `storage/clips/` — generated video clips
- `storage/output/` — final stitched videos + ASS subtitle files

Paths stored in DB are relative web paths like `/storage/images/filename.png`.

## Project Modes

Four modes control pipeline behavior:

| Mode | Scenes | Duration | Image Gen | Video Gen |
|------|--------|----------|-----------|-----------|
| `standard` | N = duration/6 | 30/60/120s | OpenRouter (gpt-image-1) | MiniMax via fal.ai |
| `pro` | 3 main + 2 transitions | ~25s | OpenRouter (gpt-image-1) | Kling v2.6 pro via fal.ai |
| `deluxe` | 3 (chained last-frame) | ~15s | FLUX-2-pro via fal.ai | Kling v2.6 pro + audio |
| `freetrial` | 2 | ~10s | FLUX-2-pro via fal.ai | MiniMax via fal.ai |

**Pro mode** interleaves main scenes and transitions: `main(1), transition(2), main(3), transition(4), main(5)`. Transitions don't have images — they morph from the last frame of the previous main clip to the first frame of the next.

**Deluxe mode** uses a chained pipeline: only scene 1 generates an image. After each clip is generated, the last frame is extracted via FFmpeg and used as the starting image for the next scene.

## Key API Endpoints

```
POST   /api/projects                              — create project + split scenario (LLM)
GET    /api/projects/:id                          — get project with scenes
POST   /api/projects/:id/generate                 — generate images for all scenes
POST   /api/projects/:id/scenes/:sceneId/regenerate — regenerate single scene image
PATCH  /api/projects/:id/scenes/:sceneId          — approve scene or update video_prompt
POST   /api/projects/:id/video                    — start video generation (fire-and-forget)
POST   /api/projects/:id/step                     — deluxe only: generate next scene video
POST   /api/projects/:id/video/reset              — reset stuck video generation
POST   /api/projects/:id/render                   — stitch clips + burn subtitles (FFmpeg)
GET    /api/projects/:id/download                 — download final .mp4
DELETE /api/projects/:id                          — delete project + all files
```

Video generation returns immediately with `202`-style response and processes in the background (fire-and-forget with `processor.catch`).

## Scene Status Flow

```
image status: pending → done → approved → (video generation)
video_status: pending → generating → done | error
project status: created → scenes_ready → generating → done → generating_videos → videos_ready → rendering → rendered
```

## Subtitle Format

`subtitle_text` in DB uses `|` as a phrase separator. During render, each scene's text is split by `|` and timed evenly within the clip duration. Subtitles are rendered as TikTok-style ASS (Arial Bold, white with black outline, bottom-center, 200ms fade).

## External APIs

- **LLM + standard image gen:** OpenRouter (`https://openrouter.ai/api/v1/chat/completions`) — supports both chat and image generation models via the same endpoint
- **FLUX images:** `@fal-ai/client` queue API with polling (5-min timeout)
- **Video (MiniMax):** `fal-ai/minimax-video/image-to-video` via fal.ai queue (20-min timeout)
- **Video (Kling):** `fal-ai/kling-video/v2.6/pro/image-to-video` via fal.ai queue — supports `start_image_url` + optional `end_image_url` for transitions, `generate_audio` + `voice_ids` for deluxe

All fal.ai calls use the queue pattern: `fal.queue.submit()` → poll `fal.queue.status()` → `fal.queue.result()`.
