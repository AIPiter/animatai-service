"""
Standard mode — video prompt builder.

Pure prompt construction utility (no API calls). For each pair of consecutive
frames (start_frame → end_frame), builds a structured video generation prompt
for fal.ai WAN FLF2V.
"""

CAMERA_MOTION_MAP = {
    "front":   "slow dolly push forward",
    "side":    "smooth lateral slider",
    "closeup": "gentle zoom in",
    "wide":    "static or very slow pull back",
    "top":     "subtle crane down",
}

NEGATIVE_PROMPT = ", ".join([
    "subject appearance change",
    "style drift from reference",
    "teleportation or jump cut",
    "camera shake or handheld wobble",
    "color palette shift",
    "new elements not in reference",
    "fast motion blur",
    "text overlay",
    "watermark",
    "flash or flicker",
])

DEFAULT_MODEL_PARAMS = {
    "guidance_scale":      0.5,
    "num_inference_steps": 30,
    "fps":                 24,
}

DURATION_SECONDS = 5


def build_video_prompt(
    start_frame: dict,
    end_frame: dict,
    scene: dict,
    visual_anchor: dict,
    style: dict,
    clip_index: int,
    total_clips: int,
) -> dict:
    """
    Build a structured video prompt for one clip.

    Args:
        start_frame:    GeneratedFrame dict (index, image_url, ...)
        end_frame:      GeneratedFrame dict
        scene:          scene dict (description, cameraAngle, action, backgroundHint)
        visual_anchor:  dict (anchorText, consistencyLock, styleString, validationKeywords)
        style:          style dict (renderingStyle, lighting, ...)
        clip_index:     0-based clip index
        total_clips:    total number of clips

    Returns dict:
        text_prompt, negative_prompt, start_frame_url, end_frame_url,
        duration_seconds, model_params
    """
    camera_angle = scene.get("cameraAngle", "front")
    camera_motion = CAMERA_MOTION_MAP.get(camera_angle, "static camera")
    rendering = style.get("renderingStyle", "")
    lighting = style.get("lighting", "")

    text_prompt = (
        f"{visual_anchor['consistencyLock']} — subject appearance locked to @Image1.\n"
        f"\n"
        f"Transition: @Image1 shows {scene.get('description', '')} at start position.\n"
        f"@Image2 shows {scene.get('description', '')} at end position.\n"
        f"Motion: {scene.get('action', '')}. Camera: {camera_angle} shot, {camera_motion}.\n"
        f"\n"
        f"{rendering}. {lighting}.\n"
        f"Clip {clip_index + 1} of {total_clips} — continuous smooth motion,\n"
        f"no jump cuts, 24fps cinematic."
    )

    return {
        "text_prompt":      text_prompt,
        "negative_prompt":  NEGATIVE_PROMPT,
        "start_frame_url":  start_frame["image_url"],
        "end_frame_url":    end_frame["image_url"],
        "duration_seconds": DURATION_SECONDS,
        "model_params":     dict(DEFAULT_MODEL_PARAMS),
    }


def build_all_video_prompts(
    frames: list[dict],
    scenes: list[dict],
    visual_anchor: dict,
    style: dict,
) -> list[dict]:
    """
    Build video prompts for all clips from consecutive frame pairs.

    frames has len(scenes) + 1 entries:
        clip 0: frames[0] → frames[1]  (scene 0)
        clip 1: frames[1] → frames[2]  (scene 1)
        ...
        clip N-1: frames[N-1] → frames[N]  (scene N-1)

    Returns list of VideoPrompt dicts, one per clip.
    """
    total_clips = len(scenes)
    prompts = []

    for i, scene in enumerate(scenes):
        prompt = build_video_prompt(
            start_frame=frames[i],
            end_frame=frames[i + 1],
            scene=scene,
            visual_anchor=visual_anchor,
            style=style,
            clip_index=i,
            total_clips=total_clips,
        )
        prompts.append(prompt)

    return prompts
