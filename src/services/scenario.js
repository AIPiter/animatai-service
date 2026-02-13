const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function callLLM(systemPrompt, userMessage) {
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
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter LLM error: ${response.status} ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from LLM');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${content.slice(0, 200)}`);
  }

  // Try parsing, then try fixing common LLM JSON errors
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    const cleaned = jsonMatch[0]
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\x00-\x1f]/g, c => c === '\n' || c === '\r' || c === '\t' ? c : '');
    return JSON.parse(cleaned);
  }
}

export async function splitScenario(scenario, duration) {
  const numScenes = Math.round(duration / 6);

  const systemPrompt = `You are a professional animation storyboard artist.
Split the given scenario into exactly ${numScenes} scenes for a ${duration}-second animated cartoon.

IMPORTANT: ALL text fields except "description" and "subtitle_text" MUST be in English. Keep values short to save tokens.

Return valid JSON with these fields:

1. "characters" — array of ALL characters:
   - "name": short name (English)
   - "visual": EN, max 20 words. Key visual traits only. Example: "young girl, long red braids, green dress, freckles, big round glasses"

2. "style_guide" — EN, ONE sentence, max 25 words. Example: "flat 2D cel-shaded cartoon, bold black outlines, pastel color palette, simple shapes, no shading"

3. "scenes" — array of ${numScenes} objects:
   - "description": what happens (Russian, 1 sentence)
   - "action": EN, max 20 words. Pose, camera, setting. No character appearance. Example: "walking through dark forest at night, looking scared, moonlight"
   - "video_prompt": EN, max 12 words. Motion/camera ONLY. Example: "slow zoom in, character blinks and smiles softly"
   - "subtitle_text": same language as scenario. Write 2-3 short phrases separated by "|". Each phrase is a piece of narration or dialogue that tells the story. Make it expressive and engaging, like TikTok captions. Example: "Она бежала через лес...|Сердце бешено колотилось|А тень всё ближе..."
   - "characters_in_scene": array of character names

JSON only, no markdown, no comments.`;

  // Retry up to 2 times on parse failure
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callLLM(systemPrompt, scenario);

      const characters = parsed.characters || [];
      const styleGuide = parsed.style_guide || '';
      const scenes = parsed.scenes;

      if (!Array.isArray(scenes) || scenes.length === 0) {
        throw new Error('LLM returned empty or invalid scenes array');
      }

      const charMap = Object.fromEntries(characters.map(c => [c.name, c]));

      for (const scene of scenes) {
        const presentNames = scene.characters_in_scene || characters.map(c => c.name);
        const charParts = presentNames
          .map(name => {
            const c = charMap[name];
            return c ? `${c.name}: ${c.visual}` : null;
          })
          .filter(Boolean)
          .join('. ');

        scene.image_prompt = `${styleGuide}. ${charParts}. ${scene.action}`;
      }

      const characterDescription = characters
        .map(c => `${c.name}: ${c.visual}`)
        .join('\n');

      return { characterDescription, styleGuide, scenes };
    } catch (err) {
      console.error(`[scenario] Attempt ${attempt}/2 failed:`, err.message);
      if (attempt === 2) throw err;
    }
  }
}
