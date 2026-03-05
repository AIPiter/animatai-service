import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFalClient } from '@fal-ai/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, '..', '..', 'storage', 'clips');

const KLING3_MODEL = 'fal-ai/kling-video/v3/pro/image-to-video';

async function uploadBufferToFal(buffer, filename, fal) {
  const file = new File([buffer], filename, { type: 'image/png' });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fal.storage.upload(file);
    } catch (err) {
      console.error(`[kling3] Upload attempt ${attempt}/2 failed:`, err.message);
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

export async function generateLoopVideo({ firstFrameBuffer, firstFrameName, lastFrameBuffer, lastFrameName, prompt, duration, falKey }) {
  const fal = createFalClient({ credentials: () => falKey || process.env.FAL_KEY });
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  console.log('[kling3] Uploading frames to fal.ai storage...');
  const [firstImageUrl, lastImageUrl] = await Promise.all([
    uploadBufferToFal(firstFrameBuffer, firstFrameName, fal),
    uploadBufferToFal(lastFrameBuffer, lastFrameName, fal),
  ]);

  const input = {
    image_url: firstImageUrl,
    tail_image_url: lastImageUrl,
    prompt,
    duration: String(duration),
    aspect_ratio: '16:9',
    negative_prompt: 'blur, distort, low quality, camera shake, sudden cut',
    cfg_scale: 0.5,
  };

  const { request_id } = await fal.queue.submit(KLING3_MODEL, { input });
  console.log(`[kling3] Submitted loop video, request_id: ${request_id}`);

  const startTime = Date.now();
  const MAX_WAIT = 3 * 60 * 1000; // 3 minutes
  const POLL_INTERVAL = 10_000;

  while (Date.now() - startTime < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    let status;
    try {
      status = await fal.queue.status(KLING3_MODEL, { requestId: request_id, logs: true });
    } catch (err) {
      console.error('[kling3] Status poll failed (will retry):', err.message);
      continue;
    }

    if (status.logs) {
      for (const log of status.logs) console.log(`[kling3] ${log.message}`);
    }

    if (status.status === 'COMPLETED') {
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await fal.queue.result(KLING3_MODEL, { requestId: request_id });
          break;
        } catch (err) {
          console.error(`[kling3] Result fetch attempt ${attempt}/3 failed:`, err.message);
          if (attempt === 3) throw new Error(`Kling 3 result fetch failed: ${err.message}`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      const videoUrl = result.data?.video?.url;
      if (!videoUrl) throw new Error(`No video URL in Kling 3 response: ${JSON.stringify(result?.data).slice(0, 300)}`);

      console.log('[kling3] Downloading generated video...');
      const response = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Failed to download video: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());

      const filename = `loop_${request_id.slice(0, 8)}_${Date.now()}.mp4`;
      const outputPath = path.join(CLIPS_DIR, filename);
      fs.writeFileSync(outputPath, buffer);

      console.log(`[kling3] Saved to ${filename}`);
      return `/storage/clips/${filename}`;
    }

    if (status.status === 'FAILED') {
      throw new Error(`Kling 3 generation failed: ${JSON.stringify(status.error || 'unknown error')}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[kling3] ${status.status} (${elapsed}s elapsed)`);
  }

  throw new Error(`Kling 3 video generation timed out after 3 minutes (request_id: ${request_id})`);
}
