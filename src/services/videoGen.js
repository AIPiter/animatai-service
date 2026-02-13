import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fal } from '@fal-ai/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, '..', '..', 'storage', 'clips');

fal.config({ credentials: () => process.env.FAL_KEY });

const MODEL = process.env.VIDEO_MODEL || 'fal-ai/minimax/hailuo-02/standard/image-to-video';

export async function generateVideo(imagePath, prompt, filename) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  // imagePath is relative like /storage/images/xxx.png — resolve to absolute
  const absoluteImagePath = path.join(__dirname, '..', '..', imagePath.replace(/^\//, ''));
  const imageFile = new File(
    [fs.readFileSync(absoluteImagePath)],
    path.basename(absoluteImagePath),
    { type: 'image/png' }
  );

  const imageUrl = await fal.storage.upload(imageFile);

  let result;
  try {
    result = await fal.subscribe(MODEL, {
      input: {
        image_url: imageUrl,
        prompt,
        duration: 6,
        prompt_optimizer: true,
      },
      logs: true,
      onQueueUpdate(update) {
        if (update.status === 'IN_PROGRESS' && update.logs) {
          for (const log of update.logs) {
            console.log(`[videoGen] ${log.message}`);
          }
        }
      },
    });
  } catch (err) {
    // Log full validation error details
    if (err.body) console.error('[videoGen] API error details:', JSON.stringify(err.body));
    throw err;
  }

  const videoUrl = result.data?.video?.url;
  if (!videoUrl) {
    throw new Error('No video URL in fal.ai response');
  }

  // Download the video file with retries (fal.ai CDN can be slow)
  let buffer;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
      break;
    } catch (err) {
      console.error(`[videoGen] Download attempt ${attempt}/3 failed:`, err.message);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }

  const outputPath = path.join(CLIPS_DIR, filename);
  fs.writeFileSync(outputPath, buffer);

  return `/storage/clips/${filename}`;
}
