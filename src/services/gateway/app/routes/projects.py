import uuid
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import db
from ..messaging.publisher import publish_job

router = APIRouter(prefix="/api/projects", tags=["projects"])

VALID_MODES   = {"lite", "deluxe", "standard"}
VALID_STYLES  = {"anime", "cartoon", "pixar"}
VALID_DURATIONS = {30, 60, 120}


def _api_keys(request: Request) -> dict:
    return {
        "fal":        request.headers.get("x-fal-key", ""),
        "openrouter": request.headers.get("x-openrouter-key", ""),
    }


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
async def list_projects(request: Request):
    projects = await db.list_projects(request.state.user_id)
    return projects


# ── Create ────────────────────────────────────────────────────────────────────

class CreateProjectRequest(BaseModel):
    scenario: str
    duration: int = 30
    style: str = "anime"
    mode: str = "standard"
    scene_count: int | None = None


@router.post("")
async def create_project(body: CreateProjectRequest, request: Request):
    if body.mode not in VALID_MODES:
        raise HTTPException(400, f"mode must be one of: {', '.join(VALID_MODES)}")
    if body.style not in VALID_STYLES:
        raise HTTPException(400, f"style must be one of: {', '.join(VALID_STYLES)}")
    if body.duration not in VALID_DURATIONS:
        raise HTTPException(400, f"duration must be one of: {', '.join(str(d) for d in VALID_DURATIONS)}")

    project_id = str(uuid.uuid4())
    await db.create_project(
        project_id=project_id,
        user_id=request.state.user_id,
        scenario=body.scenario,
        duration=body.duration,
        char_desc=None,
        status="created",
        style=body.style,
        mode=body.mode,
        scene_count=body.scene_count,
    )

    # Dispatch LLM parsing job
    await publish_job("llm", {
        "job_id":     str(uuid.uuid4()),
        "project_id": project_id,
        "user_id":    request.state.user_id,
        "mode":       body.mode,
        "action":     "parse_scenario",
        "payload": {
            "scenario":    body.scenario,
            "duration":    body.duration,
            "style":       body.style,
            "scene_count": body.scene_count,
        },
        "api_keys": _api_keys(request),
    })

    return {"id": project_id, "status": "created"}


# ── Get ───────────────────────────────────────────────────────────────────────

@router.get("/{project_id}")
async def get_project(project_id: str, request: Request):
    project = await db.get_project(project_id)
    if not project or str(project["user_id"]) != request.state.user_id:
        raise HTTPException(404, "Project not found")
    scenes = await db.get_scenes_by_project(project_id)
    return {**project, "scenes": scenes}


# ── Generate images ───────────────────────────────────────────────────────────

@router.post("/{project_id}/generate")
async def generate_images(project_id: str, request: Request):
    project = await _owned_project(project_id, request)
    scenes = await db.get_scenes_by_project(project_id)

    for scene in scenes:
        if not scene.get("image_prompt"):
            continue
        await db.update_scene_status("generating", str(scene["id"]))
        await publish_job("image", {
            "job_id":     str(uuid.uuid4()),
            "project_id": project_id,
            "scene_id":   str(scene["id"]),
            "user_id":    request.state.user_id,
            "mode":       project["mode"],
            "action":     "generate_image",
            "payload": {
                "prompt":    scene["image_prompt"],
                "filename":  f"scene-{scene['id']}.png",
                "style":     project.get("style", "anime"),
            },
            "api_keys": _api_keys(request),
        })

    await db.update_project_status("generating", project_id)
    return {"message": "Image generation started"}


# ── Approve / update scene ────────────────────────────────────────────────────

class PatchSceneRequest(BaseModel):
    approved: bool | None = None
    video_prompt: str | None = None
    image_prompt: str | None = None


@router.patch("/{project_id}/scenes/{scene_id}")
async def patch_scene(project_id: str, scene_id: str, body: PatchSceneRequest, request: Request):
    await _owned_project(project_id, request)
    scene = await db.get_scene(scene_id)
    if not scene or str(scene["project_id"]) != project_id:
        raise HTTPException(404, "Scene not found")

    if body.approved is True:
        await db.update_scene_status("approved", scene_id)
    if body.video_prompt is not None:
        await db.update_scene_video_prompt(body.video_prompt, scene_id)
    if body.image_prompt is not None:
        await db.update_scene_prompt(body.image_prompt, scene_id)

    return {"message": "Updated"}


# ── Regenerate single scene image ─────────────────────────────────────────

@router.post("/{project_id}/scenes/{scene_id}/regenerate")
async def regenerate_scene_image(project_id: str, scene_id: str, request: Request):
    project = await _owned_project(project_id, request)
    scene = await db.get_scene(scene_id)
    if not scene or str(scene["project_id"]) != project_id:
        raise HTTPException(404, "Scene not found")
    if not scene.get("image_prompt"):
        raise HTTPException(400, "Scene has no image prompt")

    await db.update_scene_status("generating", scene_id)
    await publish_job("image", {
        "job_id":     str(uuid.uuid4()),
        "project_id": project_id,
        "scene_id":   scene_id,
        "user_id":    request.state.user_id,
        "mode":       project["mode"],
        "action":     "generate_image",
        "payload": {
            "prompt":   scene["image_prompt"],
            "filename": f"scene-{scene_id}.png",
            "style":    project.get("style", "anime"),
        },
        "api_keys": _api_keys(request),
    })
    return {"message": "Regenerating image"}


# ── Single scene video ───────────────────────────────────────────────────

@router.post("/{project_id}/scenes/{scene_id}/video")
async def single_scene_video(project_id: str, scene_id: str, request: Request):
    project = await _owned_project(project_id, request)
    scene = await db.get_scene(scene_id)
    if not scene or str(scene["project_id"]) != project_id:
        raise HTTPException(404, "Scene not found")
    if not scene.get("image_path"):
        raise HTTPException(400, "Scene has no image — generate image first")

    await db.update_scene_video_status("queued", scene_id)
    await publish_job("video", {
        "job_id":     str(uuid.uuid4()),
        "project_id": project_id,
        "user_id":    request.state.user_id,
        "mode":       project["mode"],
        "action":     "generate_videos",
        "payload": {
            "scenes": [{
                "id":             scene_id,
                "scene_number":   scene["scene_number"],
                "image_path":     scene.get("image_path"),
                "video_prompt":   scene.get("video_prompt"),
                "clip_duration":  scene.get("clip_duration", 5),
                "scene_type":     scene.get("scene_type", "main"),
                "last_frame_path": scene.get("last_frame_path"),
            }],
        },
        "api_keys": _api_keys(request),
    })
    return {"message": "Video generation started for scene"}


# ── Start video generation ────────────────────────────────────────────────────

@router.post("/{project_id}/video")
async def start_video(project_id: str, request: Request):
    project = await _owned_project(project_id, request)
    scenes = await db.get_scenes_by_project(project_id)

    await publish_job("video", {
        "job_id":     str(uuid.uuid4()),
        "project_id": project_id,
        "user_id":    request.state.user_id,
        "mode":       project["mode"],
        "action":     "generate_videos",
        "payload": {
            "scenes": [
                {
                    "id":           str(s["id"]),
                    "scene_number": s["scene_number"],
                    "image_path":   s.get("image_path"),
                    "video_prompt": s.get("video_prompt"),
                    "clip_duration": s.get("clip_duration", 5),
                    "scene_type":   s.get("scene_type", "main"),
                    "last_frame_path": s.get("last_frame_path"),
                }
                for s in scenes
            ],
            "voice_ids": project.get("voice_ids"),
        },
        "api_keys": _api_keys(request),
    })

    await db.update_project_status("generating_videos", project_id)
    return {"message": "Video generation started"}


# ── Render (stitch) ───────────────────────────────────────────────────────────

@router.post("/{project_id}/render")
async def render(project_id: str, request: Request):
    project = await _owned_project(project_id, request)
    scenes = await db.get_scenes_by_project(project_id)

    await publish_job("video", {
        "job_id":     str(uuid.uuid4()),
        "project_id": project_id,
        "user_id":    request.state.user_id,
        "mode":       project["mode"],
        "action":     "render",
        "payload": {
            "scenes": [
                {
                    "id":             str(s["id"]),
                    "video_path":     s.get("video_path"),
                    "subtitle_text":  s.get("subtitle_text"),
                    "clip_duration":  s.get("clip_duration", 5),
                }
                for s in scenes if s.get("video_path")
            ],
        },
        "api_keys": _api_keys(request),
    })

    await db.update_project_status("rendering", project_id)
    return {"message": "Render started"}


# ── Download ──────────────────────────────────────────────────────────────────

@router.get("/{project_id}/download")
async def download(project_id: str, request: Request):
    project = await _owned_project(project_id, request)
    if not project.get("final_video_path"):
        raise HTTPException(404, "Final video not ready")
    # Return the MinIO URL or redirect — handled by video service upload
    return {"url": project["final_video_path"]}


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{project_id}")
async def delete_project(project_id: str, request: Request):
    await _owned_project(project_id, request)
    await db.delete_project(project_id)
    return {"message": "Deleted"}


# ── Scene history ─────────────────────────────────────────────────────────────

@router.get("/{project_id}/history/{scene_id}")
async def scene_history(project_id: str, scene_id: str, request: Request):
    await _owned_project(project_id, request)
    history = await db.get_scene_history(scene_id)
    return history


# ── Internal helper ───────────────────────────────────────────────────────────

async def _owned_project(project_id: str, request: Request) -> dict:
    project = await db.get_project(project_id)
    if not project or str(project["user_id"]) != request.state.user_id:
        raise HTTPException(404, "Project not found")
    return project
