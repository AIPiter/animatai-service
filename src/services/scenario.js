const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function splitScenario(scenario, duration) {
  const numScenes = Math.round(duration / 6);

  const systemPrompt = `You are a professional animation storyboard artist.
Split the given scenario into exactly ${numScenes} scenes for a ${duration}-second animated cartoon.

Return three fields:

1. "characters" — array of ALL characters. For each:
   - "name": short name
   - "visual": ONE compact sentence with the most recognizable visual traits: hair, outfit color, one distinctive feature. Max 20 words. Example: "young girl, long red braids, green dress, freckles, big round glasses"

2. "style_guide" — ONE sentence defining the art style. This is CRITICAL for visual consistency. Be very specific. Max 25 words. Example: "flat 2D cel-shaded cartoon, bold black outlines, pastel color palette, simple shapes, no shading, white background"

3. "scenes" — array of ${numScenes} objects:
   - "description": what happens (in Russian)
   - "action": what is shown in the image — pose, camera angle, setting. In English, max 25 words. Do NOT mention character appearance or style. Example: "walking through a dark forest at night, looking scared, tall trees around, moonlight from above"
   - "video_prompt": SHORT prompt for image-to-video AI model. Describe ONLY the motion, animation and camera movement for this scene. Max 15 words. The model already sees the image — do NOT describe appearance, style, or setting. Focus on: what moves, how it moves, camera motion. Use gentle/subtle movements. Examples: "character slowly turns head to the right, gentle breeze moves hair", "slow zoom in, character blinks and smiles softly", "camera pans left, leaves falling gently in the wind"
   - "subtitle_text": subtitle (same language as scenario)
   - "characters_in_scene": array of character names in this scene

Return ONLY valid JSON:
{
  "characters": [{"name":"...","visual":"..."}],
  "style_guide": "...",
  "scenes": [{"description":"...","action":"...","video_prompt":"...","subtitle_text":"...","characters_in_scene":["..."]}]
}`;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: scenario },
      ],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter LLM error: ${response.status} ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from LLM');
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse LLM response as JSON: ${content.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const characters = parsed.characters || [];
  const styleGuide = parsed.style_guide || '';
  const scenes = parsed.scenes;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('LLM returned empty or invalid scenes array');
  }

  // Build compact character lookup
  const charMap = Object.fromEntries(characters.map(c => [c.name, c]));

  // Assemble final prompts: STYLE FIRST, then characters, then action
  for (const scene of scenes) {
    const presentNames = scene.characters_in_scene || characters.map(c => c.name);
    const charParts = presentNames
      .map(name => {
        const c = charMap[name];
        return c ? `${c.name}: ${c.visual}` : null;
      })
      .filter(Boolean)
      .join('. ');

    // Style is FIRST — Flux follows early instructions most strongly
    scene.image_prompt = `${styleGuide}. ${charParts}. ${scene.action}`;
  }

  const characterDescription = characters
    .map(c => `${c.name}: ${c.visual}`)
    .join('\n');

  return { characterDescription, styleGuide, scenes };
}
