import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'storage', 'output');
const ROOT_DIR = path.join(__dirname, '..', '..');

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function generateSrtFile(subtitles, outputPath) {
  const lines = subtitles.map((sub, i) => {
    return `${i + 1}\n${formatSrtTime(sub.start)} --> ${formatSrtTime(sub.end)}\n${sub.text}\n`;
  });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
  return outputPath;
}

export async function stitchVideo(clipPaths, subtitles, projectId) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Resolve clip paths to absolute
  const absoluteClips = clipPaths.map(p => path.join(ROOT_DIR, p.replace(/^\//, '')));

  // Create concat list file
  const concatListPath = path.join(OUTPUT_DIR, `${projectId}_concat.txt`);
  const concatContent = absoluteClips.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf-8');

  // Create SRT subtitles file
  const srtPath = path.join(OUTPUT_DIR, `${projectId}.srt`);
  generateSrtFile(subtitles, srtPath);

  const outputPath = path.join(OUTPUT_DIR, `${projectId}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .input(srtPath)
      .inputOptions(['-f', 'srt'])
      .outputOptions([
        '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-an',
        '-c:s', 'mov_text',        // embed subtitles as soft subs
        '-map', '0:v', '-map', '1', // map video from concat + subtitle stream
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[stitcher] ffmpeg:', cmd))
      .on('error', (err) => {
        // Clean up temp files
        try { fs.unlinkSync(concatListPath); } catch {}
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .on('end', () => {
        // Clean up temp files
        try { fs.unlinkSync(concatListPath); } catch {}
        resolve(`/storage/output/${projectId}.mp4`);
      })
      .run();
  });
}
