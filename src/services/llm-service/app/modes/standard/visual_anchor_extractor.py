"""
Standard mode — visual anchor extractor.

Calls a Vision LLM on the master image to produce a deterministic, detailed
text description (the "visual anchor") that will be prepended to every frame
and video prompt to enforce visual consistency across all scenes.
"""

import json
import re
import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
VISION_MODEL   = "anthropic/claude-sonnet-4-5"

MIN_ANCHOR_LEN = 100

VISION_PROMPT = """Analyze this image and describe it with extreme precision for the purpose of reproducing it identically in other images.
Output a JSON object with these fields:
{
  "anchorText": "Complete visual description in one paragraph. Include: exact colors with adjectives, quantities of elements, specific shapes, textures, relative sizes, spatial arrangement, lighting direction and quality. Write as if instructing an artist who cannot see the image.",
  "consistencyLock": "MUST MATCH: [list only the 5-7 most critical visual features that must be identical across all frames]",
  "styleString": "[Art style, rendering technique, photography style in 10-15 words]",
  "validationKeywords": ["keyword1", "keyword2", ...] // 8-12 specific words that should appear when this subject is correctly rendered
}
Be precise about:
- Colors: not 'pink' but 'soft dusty rose pink'
- Quantities: not 'flowers' but 'approximately 12 blooms'
- Textures: not 'soft' but 'velvety matte petals with slight translucency at edges'
- Arrangement: spatial relationships between elements

Output JSON only. No markdown."""


async def extract_visual_anchor(
    master_image_url: str,
    subject: dict,
    style: dict,
    api_keys: dict,
) -> dict:
    """
    Extract visual anchor from master image via Vision LLM.

    Args:
        master_image_url: publicly accessible URL of the master image
        subject: ParsedScenario subject dict (description, keyFeatures, styleKeywords)
        style: ParsedScenario style dict (type, lighting, colorPalette, renderingStyle)
        api_keys: dict with "openrouter" key

    Returns dict with:
        anchorText          — full description for use in prompts
        consistencyLock     — shorter must-match features
        styleString         — style-only portion, reusable
        validationKeywords  — words to check in subsequent frame descriptions
    """
    openrouter_key = api_keys.get("openrouter", "")
    anchor = await _call_vision(master_image_url, openrouter_key, temperature=0.3)

    # Quality check: if anchorText is too short, re-run with higher temperature
    if len(anchor.get("anchorText", "")) < MIN_ANCHOR_LEN:
        print("[llm/standard/anchor] anchorText too short, retrying with higher temperature")
        anchor = await _call_vision(master_image_url, openrouter_key, temperature=0.7)

    # Append subject.keyFeatures to validationKeywords for extra coverage
    key_features = subject.get("keyFeatures", [])
    existing_keywords = anchor.get("validationKeywords", [])
    merged = list(dict.fromkeys(existing_keywords + key_features))  # dedupe, preserve order
    anchor["validationKeywords"] = merged

    print(f"[llm/standard/anchor] Extracted anchor: {len(anchor['anchorText'])} chars, "
          f"{len(anchor['validationKeywords'])} keywords")

    return anchor


async def _call_vision(image_url: str, openrouter_key: str, temperature: float) -> dict:
    """Call OpenRouter vision endpoint with the master image."""
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
                        "model":       VISION_MODEL,
                        "messages":    [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": image_url},
                                    },
                                    {
                                        "type": "text",
                                        "text": VISION_PROMPT,
                                    },
                                ],
                            },
                        ],
                        "temperature": temperature,
                        "max_tokens":  2048,
                    },
                )
                resp.raise_for_status()

            content = resp.json()["choices"][0]["message"]["content"]
            return _extract_json(content)

        except Exception as e:
            if attempt == 2:
                raise
            print(f"[llm/standard/anchor] Attempt {attempt}/2 failed: {e}. Retrying…")


def _extract_json(text: str) -> dict:
    """Safely parse JSON from LLM response, stripping markdown fences if present."""
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("No JSON in vision LLM response")
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", match.group())
        return json.loads(cleaned)
