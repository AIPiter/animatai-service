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

const MODEL = process.env.VIDEO_MODEL || 'fal-ai/minimax-video/image-to-video';

async function downloadWithRetry(url, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      console.error(`[videoGen] Download attempt ${attempt}/${maxAttempts} failed:`, err.message);
      if (attempt === maxAttempts) throw new Error(`Failed to download video after ${maxAttempts} attempts: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
}

export async function generateVideo(imagePath, prompt, filename, falKey) {
  const fal = createFalClient({ credentials: () => falKey || process.env.FAL_KEY });
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const absoluteImagePath = path.join(__dirname, '..', '..', imagePath.replace(/^\//, ''));
  const imageFile = new File(
    [fs.readFileSync(absoluteImagePath)],
    path.basename(absoluteImagePath),
    { type: 'image/png' }
  );

  // Upload image — retry on failure
  let imageUrl;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      imageUrl = await fal.storage.upload(imageFile);
      break;
    } catch (err) {
      console.error(`[videoGen] Upload attempt ${attempt}/2 failed:`, err.message);
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Submit to queue and get request ID (don't use subscribe — it can timeout on long polls)
  const { request_id } = await fal.queue.submit(MODEL, {
    input: {
      image_url: imageUrl,
      prompt,
      duration: '5',
    },
  });

  console.log(`[videoGen] Submitted ${filename}, request_id: ${request_id}`);

  // Poll for completion with generous timeout (~20 min max)
  const startTime = Date.now();
  const MAX_WAIT = 20 * 60 * 1000; // 20 minutes
  const POLL_INTERVAL = 10_000; // 10 seconds

  while (Date.now() - startTime < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    let status;
    try {
      status = await fal.queue.status(MODEL, { requestId: request_id, logs: true });
    } catch (err) {
      console.error(`[videoGen] Status poll failed (will retry):`, err.message);
      continue; // retry polling
    }

    if (status.logs) {
      for (const log of status.logs) {
        console.log(`[videoGen] ${filename}: ${log.message}`);
      }
    }

    if (status.status === 'COMPLETED') {
      // Fetch the result
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await fal.queue.result(MODEL, { requestId: request_id });
          break;
        } catch (err) {
          console.error(`[videoGen] Result fetch attempt ${attempt}/3 failed:`, err.message);
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      const videoUrl = result.data?.video?.url;
      if (!videoUrl) {
        throw new Error('No video URL in fal.ai response');
      }

      const buffer = await downloadWithRetry(videoUrl);
      const outputPath = path.join(CLIPS_DIR, filename);
      fs.writeFileSync(outputPath, buffer);

      return `/storage/clips/${filename}`;
    }

    if (status.status === 'FAILED') {
      throw new Error(`fal.ai generation failed: ${JSON.stringify(status.error || 'unknown error')}`);
    }

    // IN_QUEUE or IN_PROGRESS — keep polling
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[videoGen] ${filename}: ${status.status} (${elapsed}s elapsed)`);
  }

  throw new Error(`Video generation timed out after 20 minutes (request_id: ${request_id})`);
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

const KLING_MODEL = 'fal-ai/kling-video/v2.6/pro/image-to-video';

export async function generateVideoKling(startImagePath, prompt, filename, endImagePath, { generateAudio = false, voiceIds = [] } = {}, falKey) {
  const fal = createFalClient({ credentials: () => falKey || process.env.FAL_KEY });
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const startImageUrl = await uploadImageToFal(startImagePath, fal);

  const input = {
    start_image_url: startImageUrl,
    prompt,
    duration: '5',
    generate_audio: generateAudio,
  };

  if (generateAudio && voiceIds.length > 0) {
    // voice_ids must be created via fal-ai/kling-video/create-voice endpoint first
    // only pass them if they look like UUIDs (custom created voices), not preset names
    const looksLikeCustomId = voiceIds.every(id => id.length > 20);
    if (looksLikeCustomId) {
      input.voice_ids = voiceIds;
    }
  }

  if (endImagePath) {
    input.end_image_url = await uploadImageToFal(endImagePath, fal);
  }

  console.log(`[videoGen-kling] Input for ${filename}:`, JSON.stringify(input, null, 2));
  const { request_id } = await fal.queue.submit(KLING_MODEL, { input });
  console.log(`[videoGen-kling] Submitted ${filename}, request_id: ${request_id}`);

  const startTime = Date.now();
  const MAX_WAIT = 20 * 60 * 1000;
  const POLL_INTERVAL = 10_000;

  while (Date.now() - startTime < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    let status;
    try {
      status = await fal.queue.status(KLING_MODEL, { requestId: request_id, logs: true });
    } catch (err) {
      console.error(`[videoGen-kling] Status poll failed (will retry):`, err.message);
      continue;
    }

    if (status.logs) {
      for (const log of status.logs) {
        console.log(`[videoGen-kling] ${filename}: ${log.message}`);
      }
    }

    console.log(`[videoGen-kling] ${filename}: status=${status.status}${status.error ? ' error=' + JSON.stringify(status.error) : ''}`);

    if (status.status === 'COMPLETED') {
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await fal.queue.result(KLING_MODEL, { requestId: request_id });
          break;
        } catch (err) {
          const errBody = err.body || err.detail || err.response || '';
          console.error(`[videoGen-kling] Result fetch attempt ${attempt}/3 failed:`, err.message, JSON.stringify(errBody));
          if (attempt === 3) throw new Error(`Kling result fetch failed: ${err.message} ${JSON.stringify(errBody)}`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      console.log(`[videoGen-kling] Result keys:`, JSON.stringify(Object.keys(result?.data || result || {})));
      const videoUrl = result.data?.video?.url;
      if (!videoUrl) throw new Error(`No video URL in Kling response: ${JSON.stringify(result?.data || result).slice(0, 500)}`);

      const buffer = await downloadWithRetry(videoUrl);
      const outputPath = path.join(CLIPS_DIR, filename);
      fs.writeFileSync(outputPath, buffer);

      return `/storage/clips/${filename}`;
    }

    if (status.status === 'FAILED') {
      throw new Error(`Kling generation failed: ${JSON.stringify(status.error || 'unknown error')}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[videoGen-kling] ${filename}: ${status.status} (${elapsed}s elapsed)`);
  }

  throw new Error(`Kling video generation timed out after 20 minutes (request_id: ${request_id})`);
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
