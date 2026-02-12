import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'images');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function extractBase64FromMessage(msg) {
  // Way 1: images field (seedream format)
  if (msg.images) {
    for (const image of msg.images) {
      const url = image?.image_url?.url;
      if (url && url.startsWith('data:image')) {
        return url.split(',', 2)[1];
      }
    }
  }

  const content = msg.content;

  // Way 2: content as list with image_url blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'image_url') {
        const url = block.image_url?.url;
        if (url) return url.split(',', 2)[1];
      }
    }
  }

  // Way 3: content as base64 data URI string
  if (typeof content === 'string' && content.startsWith('data:image')) {
    return content.split(',', 2)[1];
  }

  return null;
}

export async function generateImage(prompt, filename) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.IMAGE_MODEL || 'black-forest-labs/flux.2-klein-4b',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter image gen error: ${response.status} ${err}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message;

  if (!msg) {
    throw new Error('No message in image gen response');
  }

  const b64 = extractBase64FromMessage(msg);
  if (!b64) {
    throw new Error(
      `Could not extract image from response. Message keys: ${Object.keys(msg).join(', ')}`
    );
  }

  const buffer = Buffer.from(b64, 'base64');
  const filePath = path.join(STORAGE_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  return `/storage/images/${filename}`;
}
