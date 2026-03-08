"""
Deluxe mode — port of the existing Node.js splitScenarioDeluxe().
Always 3 scenes; image_prompt only for scene 1; voice markers in video_prompt.
"""

import json
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
        "guide": "High-quality 2D cartoon illustration, clean bold outlines, flat vibrant colors",
        "character_note": "Describe characters in classic cartoon style: exaggerated proportions, bold outlines.",
    },
    "pixar": {
        "guide": "Pixar-style 3D CGI render, soft subsurface scattering, rounded friendly character design",
        "character_note": "Describe characters in 3D Pixar style: rounded features, expressive faces, soft skin.",
    },
}


async def run(payload: dict, api_keys: dict) -> dict:
    scenario = payload["scenario"]
    style    = payload.get("style", "anime")
    preset   = STYLE_PRESETS.get(style, STYLE_PRESETS["anime"])

    system_prompt = f"""You are a professional animation storyboard artist.
Split the given scenario into exactly 3 scenes for a 15-second animated cartoon with ENGLISH voice acting and RUSSIAN subtitles.

ART STYLE: {preset['guide']}
{preset['character_note']}

IMPORTANT: ALL text fields except "description" and "subtitle_text" MUST be in English.
IMPORTANT: Do NOT reference any copyrighted characters, brands, or franchises.

HOW THE PIPELINE WORKS:
- Scene 1: We generate a static image from image_prompt, then animate it into a 5-second video clip.
- Scene 2: The last frame of clip 1 becomes the starting image.
- Scene 3: The last frame of clip 2 becomes the starting image.

VOICE ACTING:
- Use <<<voice_1>>> and <<<voice_2>>> markers in video_prompt.
- Keep dialogue SHORT (1-2 sentences per character). Must fit in 5 seconds.
- subtitle_text contains the RUSSIAN translation.

Return valid JSON:
1. "characters" — array of exactly 2 characters:
   - "name": short ORIGINAL English name
   - "visual": EN, max 20 words.
   - "voice_description": EN, 5-10 words (e.g. "young cheerful female voice")

2. "scenes" — array of exactly 3 objects:
   - "description": Russian, 1 sentence
   - "action": EN, max 20 words. Pose, camera, setting.
   - "video_prompt": EN, max 40 words. Motion + dialogue with voice markers.
   - "subtitle_text": Russian dialogue, phrases separated by "|"
   - "characters_in_scene": array of character names

JSON only, no markdown."""

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

            if not isinstance(scenes, list) or len(scenes) != 3:
                raise ValueError(f"Expected 3 scenes, got {len(scenes) if isinstance(scenes, list) else '?'}")

            char_map = {c["name"]: c for c in characters}
            preset_guide = preset["guide"]

            # image_prompt only for scene 1
            present = scenes[0].get("characters_in_scene") or [c["name"] for c in characters]
            char_parts = ". ".join(
                f"{n}: {char_map[n]['visual']}" for n in present if n in char_map
            )
            scenes[0]["image_prompt"] = f"{preset_guide}. {char_parts}. {scenes[0]['action']}"
            scenes[1]["image_prompt"] = None
            scenes[2]["image_prompt"] = None

            char_desc = "\n".join(f"{c['name']}: {c['visual']}" for c in characters)
            voice_descriptions = [
                {"name": c["name"], "voice_description": c.get("voice_description", "")}
                for c in characters
            ]

            return {
                "character_description": char_desc,
                "scenes":                scenes,
                "voice_descriptions":    voice_descriptions,
            }

        except Exception as e:
            if attempt == 2:
                raise
            print(f"[llm/deluxe] Attempt {attempt}/2 failed: {e}. Retrying…")


def _extract_json(text: str) -> dict:
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("No JSON in LLM response")
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", match.group())
        return json.loads(cleaned)
