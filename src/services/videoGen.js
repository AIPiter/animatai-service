import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFalClient } from '@fal-ai/client';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, '..', '..', 'storage', 'clips');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'storage', 'images');

const MINIMAX_MODEL = process.env.VIDEO_MODEL || 'fal-ai/minimax-video/image-to-video';
const KLING_MODEL = 'fal-ai/kling-video/v2.6/pro/image-to-video';

async function downloadWithRetry(url, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      console.error(`[videoGen] Download attempt ${attempt}/${maxAttempts} failed:`, err.message);
      if (attempt === maxAttempts) throw new Error(`Failed to download video after ${maxAttempts} attempts: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
}

async function uploadImageToFal(imagePath, fal) {
  const absolutePath = path.join(__dirname, '..', '..', imagePath.replace(/^\//, ''));
  const imageFile = new File(
    [fs.readFileSync(absolutePath)],
    path.basename(absolutePath),
    { type: 'image/png' }
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fal.storage.upload(imageFile);
    } catch (err) {
      console.error(`[videoGen] Upload attempt ${attempt}/2 failed:`, err.message);
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Submit minimax video generation — returns { request_id, model }
export async function submitVideoMinimax(imagePath, prompt, duration, falKey) {
  const fal = createFalClient({ credentials: () => falKey || process.env.FAL_KEY });
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const imageUrl = await uploadImageToFal(imagePath, fal);

  const { request_id } = await fal.queue.submit(MINIMAX_MODEL, {
    input: {
      image_url: imageUrl,
      prompt,
      duration: String(duration || 5),
    },
  });

  console.log(`[videoGen-minimax] Submitted, request_id: ${request_id}`);
  return { request_id, model: MINIMAX_MODEL };
}

// Submit kling video generation — returns { request_id, model }
export async function submitVideoKling(startImagePath, prompt, duration, falKey, { endImagePath, generateAudio = false, voiceIds = [] } = {}) {
  const fal = createFalClient({ credentials: () => falKey || process.env.FAL_KEY });
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const startImageUrl = await uploadImageToFal(startImagePath, fal);

  const input = {
    start_image_url: startImageUrl,
    prompt,
    duration: String(duration || 5),
    generate_audio: generateAudio,
  };

  if (generateAudio && voiceIds.length > 0) {
    const looksLikeCustomId = voiceIds.every(id => id.length > 20);
    if (looksLikeCustomId) {
      input.voice_ids = voiceIds;
    }
  }

  if (endImagePath) {
    input.end_image_url = await uploadImageToFal(endImagePath, fal);
  }

  console.log(`[videoGen-kling] Submitting with input:`, JSON.stringify({ ...input, start_image_url: '[url]' }));
  const { request_id } = await fal.queue.submit(KLING_MODEL, { input });

  console.log(`[videoGen-kling] Submitted, request_id: ${request_id}`);
  return { request_id, model: KLING_MODEL };
}

// Poll until done, download, save to disk — returns web path
export async function pollVideo(model, requestId, filename, falKey) {
  const fal = createFalClient({ credentials: () => falKey || process.env.FAL_KEY });
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const startTime = Date.now();
  const MAX_WAIT = 20 * 60 * 1000;
  const POLL_INTERVAL = 10_000;

  while (Date.now() - startTime < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    let status;
    try {
      status = await fal.queue.status(model, { requestId, logs: true });
    } catch (err) {
      console.error(`[pollVideo] Status poll failed (will retry):`, err.message);
      continue;
    }

    if (status.logs) {
      for (const log of status.logs) {
        console.log(`[pollVideo] ${filename}: ${log.message}`);
      }
    }

    if (status.status === 'COMPLETED') {
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await fal.queue.result(model, { requestId });
          break;
        } catch (err) {
          console.error(`[pollVideo] Result fetch attempt ${attempt}/3 failed:`, err.message);
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      const videoUrl = result.data?.video?.url;
      if (!videoUrl) throw new Error(`No video URL in fal.ai response: ${JSON.stringify(result?.data).slice(0, 200)}`);

      const buffer = await downloadWithRetry(videoUrl);
      const outputPath = path.join(CLIPS_DIR, filename);
      fs.writeFileSync(outputPath, buffer);

      return `/storage/clips/${filename}`;
    }

    if (status.status === 'FAILED') {
      throw new Error(`Video generation failed: ${JSON.stringify(status.error || 'unknown error')}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[pollVideo] ${filename}: ${status.status} (${elapsed}s elapsed)`);
  }

  throw new Error(`Video generation timed out after 20 minutes (request_id: ${requestId})`);
}

export async function extractLastFrame(videoPath, outputFilename) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const absoluteVideoPath = path.join(__dirname, '..', '..', videoPath.replace(/^\//, ''));
  const outputPath = path.join(IMAGES_DIR, outputFilename);

  await execFileAsync('ffmpeg', [
    '-sseof', '-0.1',
    '-i', absoluteVideoPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-y',
    outputPath,
  ]);

  return `/storage/images/${outputFilename}`;
}

// Backward-compat wrappers
export async function generateVideo(imagePath, prompt, filename, falKey) {
  const { request_id, model } = await submitVideoMinimax(imagePath, prompt, 5, falKey);
  return pollVideo(model, request_id, filename, falKey);
}

export async function generateVideoKling(startImagePath, prompt, filename, endImagePath, { generateAudio = false, voiceIds = [] } = {}, falKey) {
  const { request_id, model } = await submitVideoKling(startImagePath, prompt, 5, falKey, { endImagePath, generateAudio, voiceIds });
  return pollVideo(model, request_id, filename, falKey);
}
