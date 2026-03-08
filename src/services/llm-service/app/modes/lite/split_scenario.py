"""
Lite mode — port of the existing Node.js splitScenario().
Generates N scenes with image_prompt for each scene.
"""

import json
import math
import re
import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
LLM_MODEL = "google/gemini-2.5-pro"

STYLE_PRESETS = {
    "anime": {
        "guide": "Japanese anime style, clean cel-shaded coloring, expressive eyes, detailed hair, vibrant colors",
        "character_note": "Describe characters in anime style: large expressive eyes, stylized hair, anime proportions.",
    },
    "cartoon": {
        "guide": "High-quality 2D cartoon illustration, clean bold outlines, flat vibrant colors with subtle shading",
        "character_note": "Describe characters in classic cartoon style: exaggerated proportions, bold outlines.",
    },
    "pixar": {
        "guide": "Pixar-style 3D CGI render, soft subsurface scattering on skin, rounded friendly character design",
        "character_note": "Describe characters in 3D Pixar style: rounded features, expressive faces, soft skin.",
    },
}


async def run(payload: dict, api_keys: dict) -> dict:
    scenario    = payload["scenario"]
    duration    = payload["duration"]
    style       = payload.get("style", "anime")
    scene_count = payload.get("scene_count") or math.ceil(duration / 6)

    preset = STYLE_PRESETS.get(style, STYLE_PRESETS["anime"])

    system_prompt = f"""You are a professional animation storyboard artist.
Split the given scenario into exactly {scene_count} scenes for a {duration}-second animated cartoon.
Structure with a clear arc: exposition → escalation → resolution.

ART STYLE: {preset['guide']}
{preset['character_note']}

IMPORTANT: ALL text fields except "description" and "subtitle_text" MUST be in English.
IMPORTANT: Do NOT reference any copyrighted characters, brands, or franchises.

Return valid JSON with:
1. "characters" — array of ALL characters:
   - "name": short ORIGINAL English name
   - "visual": EN, max 20 words. Key visual traits only.

2. "scenes" — array of {scene_count} objects:
   - "description": what happens (Russian, 1 sentence)
   - "action": EN, max 20 words. Pose, camera, setting.
   - "video_prompt": EN, max 12 words. Motion/camera ONLY.
   - "subtitle_text": same language as scenario. 2-3 short phrases separated by "|".
   - "characters_in_scene": array of character names

JSON only, no markdown, no comments."""

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
                        "model": LLM_MODEL,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user",   "content": scenario},
                        ],
                        "temperature": 0.7,
                        "max_tokens":  4096,
                    },
                )
                resp.raise_for_status()

            data    = resp.json()
            content = data["choices"][0]["message"]["content"]
            parsed  = _extract_json(content)

            characters = parsed.get("characters", [])
            scenes     = parsed["scenes"]

            if not isinstance(scenes, list) or len(scenes) == 0:
                raise ValueError("Invalid scenes array")

            char_map = {c["name"]: c for c in characters}

            for scene in scenes:
                present = scene.get("characters_in_scene") or [c["name"] for c in characters]
                char_parts = ". ".join(
                    f"{n}: {char_map[n]['visual']}" for n in present if n in char_map
                )
                scene["image_prompt"] = f"{preset['guide']}. {char_parts}. {scene['action']}"

            char_desc = "\n".join(f"{c['name']}: {c['visual']}" for c in characters)

            return {
                "character_description": char_desc,
                "style_guide":           preset["guide"],
                "scenes":                scenes,
            }

        except Exception as e:
            if attempt == 2:
                raise
            print(f"[llm/lite] Attempt {attempt}/2 failed: {e}. Retrying…")


def _extract_json(text: str) -> dict:
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("No JSON in LLM response")
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", match.group())
        return json.loads(cleaned)
