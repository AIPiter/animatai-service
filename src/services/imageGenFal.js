import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fal } from '@fal-ai/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'images');

fal.config({ credentials: () => process.env.FAL_KEY });

const FLUX_MODEL = 'fal-ai/flux-2-pro';

export async function generateImageFlux(prompt, filename) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const { request_id } = await fal.queue.submit(FLUX_MODEL, {
    input: {
      prompt,
      image_size: 'landscape_16_9',
      output_format: 'png',
    },
  });

  console.log(`[imageGenFal] Submitted ${filename}, request_id: ${request_id}`);

  const startTime = Date.now();
  const MAX_WAIT = 5 * 60 * 1000;
  const POLL_INTERVAL = 5_000;

  while (Date.now() - startTime < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    let status;
    try {
      status = await fal.queue.status(FLUX_MODEL, { requestId: request_id, logs: true });
    } catch (err) {
      console.error(`[imageGenFal] Status poll failed (will retry):`, err.message);
      continue;
    }

    if (status.status === 'COMPLETED') {
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await fal.queue.result(FLUX_MODEL, { requestId: request_id });
          break;
        } catch (err) {
          console.error(`[imageGenFal] Result fetch attempt ${attempt}/3 failed:`, err.message);
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      const imageUrl = result.data?.images?.[0]?.url;
      if (!imageUrl) throw new Error('No image URL in FLUX response');

      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const filePath = path.join(STORAGE_DIR, filename);
      fs.writeFileSync(filePath, buffer);

      return `/storage/images/${filename}`;
    }

    if (status.status === 'FAILED') {
      throw new Error(`FLUX image generation failed: ${JSON.stringify(status.error || 'unknown error')}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[imageGenFal] ${filename}: ${status.status} (${elapsed}s elapsed)`);
  }

  throw new Error(`FLUX image generation timed out after 5 minutes (request_id: ${request_id})`);
}
