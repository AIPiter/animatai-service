import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'storage', 'output');
const ROOT_DIR = path.join(__dirname, '..', '..');

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function generateAssFile(subtitles, outputPath) {
  // TikTok-style subtitles: large bold white text, black outline, bottom-center
  // Fade in 200ms, fade out 200ms for smooth appearance
  const FADE = '\\fad(200,200)';

  const header = `[Script Info]
Title: AnimatAI Subtitles
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,0,2,15,15,25,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Style breakdown:
  // Font: Arial Bold, size 28 (scaled to PlayRes)
  // PrimaryColour: white (&H00FFFFFF)
  // OutlineColour: black (&H00000000) with thickness 3
  // BackColour: semi-transparent black (&H96000000)
  // Alignment: 2 = bottom-center
  // MarginV: 25 = offset from bottom edge
  // Shadow: 0 (no shadow, just outline)

  const events = subtitles.map(sub => {
    const start = formatAssTime(sub.start);
    const end = formatAssTime(sub.end);
    const text = sub.text.replace(/\n/g, '\\N');
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,{${FADE}}${text}`;
  });

  fs.writeFileSync(outputPath, header + events.join('\n') + '\n', 'utf-8');
  return outputPath;
}

// Escape path for ffmpeg filtergraph
function escapeFilterPath(p) {
  return p
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

export async function stitchVideo(clipPaths, subtitles, projectId) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const absoluteClips = clipPaths.map(p => path.join(ROOT_DIR, p.replace(/^\//, '')));

  // Create concat list file
  const concatListPath = path.join(OUTPUT_DIR, `${projectId}_concat.txt`);
  const concatContent = absoluteClips.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf-8');

  // Create ASS subtitles (TikTok style: bold, outlined, bottom-center, fade in/out)
  const assPath = path.join(OUTPUT_DIR, `${projectId}.ass`);
  generateAssFile(subtitles, assPath);

  const outputPath = path.join(OUTPUT_DIR, `${projectId}.mp4`);
  const escapedAssPath = escapeFilterPath(assPath);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .videoFilter(`ass='${escapedAssPath}'`)
      .outputOptions(['-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-an'])
      .output(outputPath)
      .on('start', (cmd) => console.log('[stitcher] ffmpeg:', cmd))
      .on('error', (err) => {
        try { fs.unlinkSync(concatListPath); } catch {}
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .on('end', () => {
        try { fs.unlinkSync(concatListPath); } catch {}
        resolve(`/storage/output/${projectId}.mp4`);
      })
      .run();
  });
}
