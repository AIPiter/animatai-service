"""
Standard mode — Python port of src/services/standard-mode/subject-parser.js
Extracts structured shot-list from user text via LLM.
"""

import json
import math
import re
import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
LLM_MODEL      = "anthropic/claude-sonnet-4-5"

VALID_ANGLES     = {"front", "side", "top", "closeup", "wide"}
VALID_STYLE_TYPES = {"realistic", "cartoon", "cinematic", "product", "animation"}
MIN_SCENES, MAX_SCENES = 2, 7


async def run(payload: dict, api_keys: dict) -> dict:
    user_text       = payload["scenario"]
    target_duration = payload["duration"]
    style_hint      = payload.get("style_hint")

    scene_count = min(max(math.ceil(target_duration / 5), MIN_SCENES), MAX_SCENES)

    style_rule = (
        f'The style.type field MUST be "{style_hint}".'
        if style_hint else
        f"Choose the most fitting style.type from: {', '.join(VALID_STYLE_TYPES)}."
    )

    system_prompt = f"""You are a cinematography expert who breaks down video scenarios into structured shot lists.
Your output must be valid JSON only. No markdown, no explanation, no preamble.

Given a user's video description, extract:
- The MAIN SUBJECT — the object/character/product that must look identical across all frames
- KEY FEATURES — specific visual attributes (colors, shapes, texture, material)
- VISUAL STYLE — photography/art style
- SCENE LIST — each shot as a distinct visual moment

Rules:
- Output EXACTLY {scene_count} scenes
- Camera angles must vary; use one of: {', '.join(sorted(VALID_ANGLES))}
- If description is too vague, set subject.description to exactly "UNCLEAR"
- {style_rule}
- Output language: English only

Return ONLY this JSON:
{{
  "subject": {{
    "description": "<specific main subject>",
    "keyFeatures": ["<feature 1>"],
    "styleKeywords": ["<style word 1>"]
  }},
  "style": {{
    "type": "<realistic|cartoon|cinematic|product|animation>",
    "lighting": "<lighting description>",
    "colorPalette": "<color description>",
    "renderingStyle": "<full style lock string>"
  }},
  "scenes": [
    {{
      "index": 0,
      "description": "<what happens>",
      "cameraAngle": "<front|side|top|closeup|wide>",
      "action": "<what changes>",
      "backgroundHint": "<environment>"
    }}
  ]
}}"""

    user_message = (
        f"Video description: {user_text}\n"
        f"Target duration: {target_duration} seconds\n"
        f"Required scenes: {scene_count}"
    )
    if style_hint:
        user_message += f"\nStyle preference: {style_hint}"

    openrouter_key = api_keys.get("openrouter", "")
    for attempt in range(1, 3):
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    OPENROUTER_URL,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {openrouter_key}",
                    },
                    json={
                        "model":       LLM_MODEL,
                        "messages":    [
                            {"role": "system", "content": system_prompt},
                            {"role": "user",   "content": user_message},
                        ],
                        "temperature": 0.3,
                        "max_tokens":  2048,
                    },
                )
                resp.raise_for_status()

            content = resp.json()["choices"][0]["message"]["content"]
            parsed  = _extract_json(content)

            _normalise(parsed, scene_count)
            _validate(parsed)

            if parsed["subject"]["description"] == "UNCLEAR":
                raise ValueError(
                    "SUBJECT_UNCLEAR: Description too vague. "
                    "Please describe the main subject more specifically."
                )

            # Build image_prompt and video_prompt for each scene
            enriched_scenes = _build_scene_prompts(parsed)

            return {
                "subject":                parsed["subject"],
                "style":                  parsed["style"],
                "character_description":  json.dumps({
                    "subject": parsed["subject"],
                    "style":   parsed["style"],
                }),
                "scenes":     enriched_scenes,
                "frame_count": len(enriched_scenes) + 1,
                "clip_count":  len(enriched_scenes),
            }

        except Exception as e:
            if "SUBJECT_UNCLEAR" in str(e) or attempt == 2:
                raise
            print(f"[llm/standard] Attempt {attempt}/2 failed: {e}. Retrying…")


def _build_scene_prompts(parsed: dict) -> list[dict]:
    """Enrich each scene with image_prompt, video_prompt, subtitle_text."""
    subject = parsed["subject"]
    style   = parsed["style"]
    features = ", ".join(subject.get("keyFeatures", []))
    render   = style.get("renderingStyle", "")

    scenes = []
    for s in parsed["scenes"]:
        image_prompt = (
            f"{subject['description']}, {features}, "
            f"{s.get('action', '')}, {s.get('backgroundHint', '')}, "
            f"{s.get('cameraAngle', 'front')} angle, "
            f"{render}, high detail, sharp focus."
        )
        video_prompt = (
            f"{subject['description']} {s.get('action', '')}. "
            f"{s.get('description', '')}. "
            f"Camera: {s.get('cameraAngle', 'front')}."
        )
        scenes.append({
            **s,
            "image_prompt":  image_prompt,
            "video_prompt":  video_prompt,
            "subtitle_text": s.get("description", ""),
            "scene_type":    "main",
        })

    return scenes


def _normalise(data: dict, expected: int):
    if not isinstance(data.get("scenes"), list):
        return
    data["scenes"] = [
        {
            **s,
            "index":       i,
            "cameraAngle": s.get("cameraAngle") if s.get("cameraAngle") in VALID_ANGLES else "front",
        }
        for i, s in enumerate(data["scenes"][:expected])
    ]


def _validate(data: dict):
    assert data.get("subject", {}).get("description"), "Missing subject.description"
    assert isinstance(data.get("subject", {}).get("keyFeatures"), list), "Missing subject.keyFeatures"
    assert data.get("style", {}).get("type") in VALID_STYLE_TYPES, "Invalid style.type"
    assert data.get("style", {}).get("lighting"), "Missing style.lighting"
    assert data.get("style", {}).get("renderingStyle"), "Missing style.renderingStyle"
    scenes = data.get("scenes", [])
    assert len(scenes) >= MIN_SCENES, f"Too few scenes: {len(scenes)}"
    for i, s in enumerate(scenes):
        assert s.get("description"), f"Scene {i}: missing description"
        assert s.get("action"),      f"Scene {i}: missing action"
        assert s.get("backgroundHint"), f"Scene {i}: missing backgroundHint"


def _extract_json(text: str) -> dict:
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("No JSON in LLM response")
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", match.group())
        return json.loads(cleaned)
