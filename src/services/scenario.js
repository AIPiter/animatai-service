const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const STYLE_PRESETS = {
  anime: {
    name: '2D Anime',
    guide: 'Japanese anime style, clean cel-shaded coloring, expressive eyes, detailed hair, vibrant colors, soft gradients, light and shadow contrast, no outlines on skin',
    characterNote: 'Describe characters in anime style: large expressive eyes, stylized hair, anime proportions.',
  },
  cartoon: {
    name: '2D Cartoon',
    guide: 'High-quality 2D cartoon illustration, clean bold outlines, flat vibrant colors with subtle shading, smooth vector-like shapes, expressive character animation style, rich detailed backgrounds, Disney/Cartoon Network quality, hand-drawn feel with polished finish',
    characterNote: 'Describe characters in classic cartoon style: exaggerated proportions, bold outlines, simple but expressive faces, clean shapes, bright appealing colors.',
  },
  pixar: {
    name: 'Pixar 3D',
    guide: 'Pixar-style 3D CGI render, soft subsurface scattering on skin, rounded friendly character design, warm cinematic lighting, rich saturated colors, detailed textures, shallow depth of field',
    characterNote: 'Describe characters in 3D Pixar style: rounded features, expressive faces, soft skin, detailed clothing textures.',
  },
};

async function callLLM(systemPrompt, userMessage, openrouterKey) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey || process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'google/gemini-2.5-pro',
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

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    const cleaned = jsonMatch[0]
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\x00-\x1f]/g, c => c === '\n' || c === '\r' || c === '\t' ? c : '');
    return JSON.parse(cleaned);
  }
}

export async function splitScenarioDeluxe(scenario, style = 'anime', openrouterKey) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.anime;

  const systemPrompt = `You are a professional animation storyboard artist.
Split the given scenario into exactly 3 scenes for a 15-second animated cartoon with ENGLISH voice acting and RUSSIAN subtitles.

ART STYLE: ${preset.guide}
${preset.characterNote}

IMPORTANT: ALL text fields except "description" and "subtitle_text" MUST be in English.
IMPORTANT: Do NOT reference any copyrighted characters, brands, or franchises. Create original characters only.

HOW THE PIPELINE WORKS:
- Scene 1: We generate a static image from image_prompt, then animate it into a 5-second video clip with audio.
- Scene 2: The last frame of clip 1 becomes the starting image. We animate it into clip 2.
- Scene 3: The last frame of clip 2 becomes the starting image. We animate it into clip 3.
- This creates seamless chain: each clip starts exactly where the previous one ended.

VOICE ACTING:
- Characters speak ENGLISH in the video (via text-to-speech).
- Use <<<voice_1>>> and <<<voice_2>>> markers in video_prompt to indicate which character speaks.
- Format: <<<voice_1>>> "Hello there!" <<<voice_2>>> "Hi, nice to meet you!"
- Keep dialogue SHORT (1-2 sentences per character per scene). The TTS must fit in 5 seconds.
- subtitle_text contains the RUSSIAN translation of the dialogue.

Return valid JSON with these fields:

1. "characters" — array of exactly 2 characters:
   - "name": short ORIGINAL English name
   - "visual": EN, max 20 words. Key visual traits only.
   - "voice_description": EN, 5-10 words describing the voice (e.g. "young cheerful female voice", "deep calm male voice")

2. "scenes" — array of exactly 3 scene objects:
   - "description": what happens (Russian, 1 sentence)
   - "action": EN, max 20 words. Pose, camera, setting. No character appearance.
   - "video_prompt": EN, max 40 words. Motion/camera + dialogue with <<<voice_1>>>/<<<voice_2>>> markers. Example: "character walks forward, turns to friend. <<<voice_1>>> \\"Hey, look at this!\\" <<<voice_2>>> \\"Wow, amazing!\\""
   - "subtitle_text": Russian translation of dialogue. 1-3 short phrases separated by "|". Example: "Эй, посмотри!|Ого, потрясающе!"
   - "characters_in_scene": array of character names

JSON only, no markdown, no comments.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callLLM(systemPrompt, scenario, openrouterKey);

      const characters = parsed.characters || [];
      const scenes = parsed.scenes;

      if (!Array.isArray(scenes) || scenes.length !== 3) {
        throw new Error(`Expected 3 scenes, got ${scenes?.length}`);
      }
      if (!Array.isArray(characters) || characters.length < 1) {
        throw new Error('Expected at least 1 character');
      }

      const charMap = Object.fromEntries(characters.map(c => [c.name, c]));

      // Build image_prompt ONLY for scene 1
      const scene1 = scenes[0];
      const presentNames = scene1.characters_in_scene || characters.map(c => c.name);
      const charParts = presentNames
        .map(name => {
          const c = charMap[name];
          return c ? `${c.name}: ${c.visual}` : null;
        })
        .filter(Boolean)
        .join('. ');
      scene1.image_prompt = `${preset.guide}. ${charParts}. ${scene1.action}`;

      // Scenes 2 and 3 don't need image_prompt (they'll use last_frame)
      scenes[1].image_prompt = null;
      scenes[2].image_prompt = null;

      const characterDescription = characters
        .map(c => `${c.name}: ${c.visual}`)
        .join('\n');

      const voiceDescriptions = characters.map(c => ({
        name: c.name,
        voice_description: c.voice_description || '',
      }));

      return { characterDescription, scenes, voiceDescriptions };
    } catch (err) {
      console.error(`[scenario-deluxe] Attempt ${attempt}/2 failed:`, err.message);
      if (attempt === 2) throw err;
    }
  }
}

export async function splitScenario(scenario, sceneCount, style = 'anime', openrouterKey) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.anime;
  const duration = sceneCount * 5;

  const systemPrompt = `You are a professional animation storyboard artist.
Split the given scenario into exactly ${sceneCount} scenes for a ${duration}-second animated cartoon.
Structure with a clear arc: exposition → escalation → resolution, proportioned across ${sceneCount} scenes.

ART STYLE: ${preset.guide}
${preset.characterNote}

IMPORTANT: ALL text fields except "description" and "subtitle_text" MUST be in English. Keep values short to save tokens.
IMPORTANT: Do NOT reference any copyrighted characters, brands, or franchises. Create original characters only.

Return valid JSON with these fields:

1. "characters" — array of ALL characters:
   - "name": short ORIGINAL English name (no copyrighted names)
   - "visual": EN, max 20 words. Key visual traits only. Example: "young girl, long red braids, green dress, freckles, big round glasses"

2. "scenes" — array of ${sceneCount} objects:
   - "description": what happens (Russian, 1 sentence)
   - "action": EN, max 20 words. Pose, camera, setting. No character appearance or style. Example: "walking through dark forest at night, looking scared, moonlight"
   - "video_prompt": EN, max 12 words. Motion/camera ONLY. Example: "slow zoom in, character blinks and smiles softly"
   - "subtitle_text": same language as scenario. Write 2-3 short phrases separated by "|". Each phrase is a piece of narration or dialogue that tells the story. Make it expressive and engaging, like TikTok captions. Example: "Она бежала через лес...|Сердце бешено колотилось|А тень всё ближе..."
   - "characters_in_scene": array of character names

JSON only, no markdown, no comments.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callLLM(systemPrompt, scenario, openrouterKey);

      const characters = parsed.characters || [];
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

        scene.image_prompt = `${preset.guide}. ${charParts}. ${scene.action}`;
      }

      const characterDescription = characters
        .map(c => `${c.name}: ${c.visual}`)
        .join('\n');

      return { characterDescription, styleGuide: preset.guide, scenes };
    } catch (err) {
      console.error(`[scenario] Attempt ${attempt}/2 failed:`, err.message);
      if (attempt === 2) throw err;
    }
  }
}
