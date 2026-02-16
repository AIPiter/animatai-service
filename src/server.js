import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import {
  createProject,
  getProject,
  listProjects,
  updateProjectStatus,
  updateProjectCharDesc,
  createScene,
  getScenesByProject,
  getScene,
  updateSceneImage,
  updateSceneError,
  updateScenePrompt,
  updateSceneVideo,
  updateSceneVideoError,
  updateSceneVideoPrompt,
  updateSceneLastFrame,
  updateProjectVideo,
  updateProjectVoiceIds,
  resetSceneVideos,
  deleteScenesByProject,
  deleteProject,
} from './db.js';
import fs from 'fs';
import { splitScenario, splitScenarioPro, splitScenarioDeluxe } from './services/scenario.js';
import { generateImage } from './services/imageGen.js';
import { generateVideo, generateVideoKling, extractLastFrame } from './services/videoGen.js';
import { stitchVideo } from './services/stitcher.js';
import { generateImageFlux } from './services/imageGenFal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/storage', express.static(path.join(__dirname, '..', 'storage')));

// --- API Routes ---

// List all projects
app.get('/api/projects', (req, res) => {
  const projects = listProjects.all();
  res.json(projects);
});

// Delete project with all files
app.delete('/api/projects/:id', (req, res) => {
  const project = getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const scenes = getScenesByProject.all(project.id);
  const storageRoot = path.join(__dirname, '..');

  // Delete scene files (images + clips)
  for (const scene of scenes) {
    if (scene.image_path) {
      try { fs.unlinkSync(path.join(storageRoot, scene.image_path.replace(/^\//, ''))); } catch {}
    }
    if (scene.video_path) {
      try { fs.unlinkSync(path.join(storageRoot, scene.video_path.replace(/^\//, ''))); } catch {}
    }
    if (scene.last_frame_path) {
      try { fs.unlinkSync(path.join(storageRoot, scene.last_frame_path.replace(/^\//, ''))); } catch {}
    }
  }

  // Delete final video + ASS/SRT files
  if (project.final_video_path) {
    try { fs.unlinkSync(path.join(storageRoot, project.final_video_path.replace(/^\//, ''))); } catch {}
  }
  const outputDir = path.join(storageRoot, 'storage', 'output');
  try { fs.unlinkSync(path.join(outputDir, `${project.id}.ass`)); } catch {}
  try { fs.unlinkSync(path.join(outputDir, `${project.id}.srt`)); } catch {}

  // Delete from DB (scenes first due to FK)
  deleteScenesByProject.run(project.id);
  deleteProject.run(project.id);

  res.json({ ok: true });
});

// Get project with scenes
app.get('/api/projects/:id', (req, res) => {
  const project = getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const scenes = getScenesByProject.all(project.id);
  res.json({ ...project, scenes });
});

// Create project + split scenario into scenes
app.post('/api/projects', async (req, res) => {
  try {
    const { scenario, duration, style, mode, voice_ids } = req.body;
    const projectMode = ['pro', 'deluxe'].includes(mode) ? mode : 'standard';

    if (!scenario) {
      return res.status(400).json({ error: 'scenario is required' });
    }

    if (projectMode === 'standard') {
      if (!duration || ![30, 60, 120].includes(duration)) {
        return res.status(400).json({ error: 'duration must be 30, 60, or 120' });
      }
    }

    const projectStyle = ['anime', 'cartoon', 'pixar'].includes(style) ? style : 'anime';
    const projectDuration = projectMode === 'pro' ? 25 : projectMode === 'deluxe' ? 15 : duration;
    const projectId = uuidv4();
    createProject.run(projectId, scenario, projectDuration, null, 'created', projectStyle, projectMode);

    // Store voice_ids for deluxe mode
    if (projectMode === 'deluxe' && voice_ids) {
      updateProjectVoiceIds.run(JSON.stringify(voice_ids), projectId);
    }

    // Split scenario via LLM
    let characterDescription, scenes;
    if (projectMode === 'deluxe') {
      const result = await splitScenarioDeluxe(scenario, projectStyle);
      characterDescription = result.characterDescription;
      scenes = result.scenes;
    } else if (projectMode === 'pro') {
      ({ characterDescription, scenes } = await splitScenarioPro(scenario, projectStyle));
    } else {
      ({ characterDescription, scenes } = await splitScenario(scenario, projectDuration, projectStyle));
    }

    if (characterDescription) {
      updateProjectCharDesc.run(characterDescription, projectId);
    }

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = uuidv4();
      createScene.run(
        sceneId,
        projectId,
        i + 1,
        scene.description,
        scene.image_prompt || null,
        scene.subtitle_text,
        scene.video_prompt || null,
        scene.scene_type || 'main'
      );
    }

    updateProjectStatus.run('scenes_ready', projectId);

    const project = getProject.get(projectId);
    const savedScenes = getScenesByProject.all(projectId);
    res.json({ ...project, scenes: savedScenes });
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get scenes for a project
app.get('/api/projects/:id/scenes', (req, res) => {
  const project = getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const scenes = getScenesByProject.all(project.id);
  res.json(scenes);
});

// Generate images for all pending scenes
app.post('/api/projects/:id/generate', async (req, res) => {
  try {
    const project = getProject.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const scenes = getScenesByProject.all(project.id);
    if (scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes found. Create project first.' });
    }

    updateProjectStatus.run('generating', project.id);

    // Generate images sequentially to avoid rate limits
    for (const scene of scenes) {
      if (scene.status === 'approved') continue;
      // In pro mode, skip transition scenes (no images needed)
      if (scene.scene_type === 'transition') continue;
      // In deluxe mode, only scene 1 has an image_prompt; scenes 2,3 get last_frame later
      if (project.mode === 'deluxe' && !scene.image_prompt) continue;

      try {
        const filename = `${project.id}_scene${scene.scene_number}.png`;
        let imagePath;
        if (project.mode === 'deluxe') {
          imagePath = await generateImageFlux(scene.image_prompt, filename);
        } else {
          imagePath = await generateImage(scene.image_prompt, filename);
        }
        updateSceneImage.run(imagePath, 'done', scene.id);
      } catch (err) {
        console.error(`Error generating image for scene ${scene.scene_number}:`, err);
        const errorMsg = (err.message.includes('Moderated') || err.message.includes('Derivative'))
          ? 'Заблокировано фильтром контента. Отредактируйте промпт — уберите упоминания конкретных персонажей/брендов.'
          : err.message;
        updateSceneError.run(errorMsg, scene.id);
      }
    }

    updateProjectStatus.run('done', project.id);

    const updatedScenes = getScenesByProject.all(project.id);
    res.json({ status: 'done', scenes: updatedScenes });
  } catch (err) {
    console.error('Error generating images:', err);
    res.status(500).json({ error: err.message });
  }
});

// Regenerate image for a single scene
app.post('/api/projects/:id/scenes/:sceneId/regenerate', async (req, res) => {
  try {
    const project = getProject.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const scene = getScene.get(req.params.sceneId);
    if (!scene || scene.project_id !== project.id) {
      return res.status(404).json({ error: 'Scene not found' });
    }

    // Allow updating the prompt
    const { image_prompt } = req.body || {};
    if (image_prompt) {
      updateScenePrompt.run(image_prompt, scene.id);
    }

    const prompt = image_prompt || scene.image_prompt;
    const filename = `${project.id}_scene${scene.scene_number}.png`;
    const imagePath = await generateImage(prompt, filename);
    updateSceneImage.run(imagePath, 'done', scene.id);

    const updatedScene = getScene.get(scene.id);
    res.json(updatedScene);
  } catch (err) {
    console.error('Error regenerating image:', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve a scene
app.patch('/api/projects/:id/scenes/:sceneId', (req, res) => {
  const project = getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const scene = getScene.get(req.params.sceneId);
  if (!scene || scene.project_id !== project.id) {
    return res.status(404).json({ error: 'Scene not found' });
  }

  const { status, video_prompt } = req.body;
  if (status && ['pending', 'done', 'approved'].includes(status)) {
    updateSceneImage.run(scene.image_path, status, scene.id);
  }
  if (video_prompt !== undefined) {
    updateSceneVideoPrompt.run(video_prompt, scene.id);
  }

  const updatedScene = getScene.get(scene.id);
  res.json(updatedScene);
});

// Reset stuck video generation
app.post('/api/projects/:id/video/reset', (req, res) => {
  const project = getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  resetSceneVideos.run(project.id);
  updateProjectStatus.run('done', project.id);

  const scenes = getScenesByProject.all(project.id);
  res.json({ ...getProject.get(project.id), scenes });
});

// Generate video clips from approved frames
app.post('/api/projects/:id/video', (req, res) => {
  try {
    const project = getProject.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (project.status === 'generating_videos') {
      return res.status(409).json({ error: 'Video generation already in progress' });
    }

    const scenes = getScenesByProject.all(project.id);
    const mainScenes = scenes.filter(s => s.scene_type !== 'transition');
    const allMainApproved = mainScenes.length > 0 && mainScenes.every(s => s.status === 'approved');
    if (!allMainApproved) {
      return res.status(400).json({ error: 'All main scenes must be approved before generating video' });
    }

    updateProjectStatus.run('generating_videos', project.id);

    // Return immediately — generate in background
    res.json({ status: 'generating_videos', message: 'Video generation started' });

    // Background processing (fire-and-forget with full error handling)
    const processor = project.mode === 'pro'
      ? processProVideoGeneration(project.id, scenes)
      : processVideoGeneration(project.id, scenes);

    processor.catch(err => {
      console.error(`[video] Fatal error for project ${project.id}:`, err);
      try { updateProjectStatus.run('done', project.id); } catch {}
    });
  } catch (err) {
    console.error('Error starting video generation:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

async function processVideoGeneration(projectId, scenes) {
  const pending = scenes.filter(s => s.video_status !== 'done');
  const CONCURRENCY = 2;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (scene) => {
      try {
        updateSceneVideo.run(null, 'generating', scene.id);
        const filename = `${projectId}_scene${scene.scene_number}.mp4`;
        const videoPrompt = scene.video_prompt || 'gentle subtle animation, slight movement, soft breathing motion';
        const videoPath = await generateVideo(scene.image_path, videoPrompt, filename);
        updateSceneVideo.run(videoPath, 'done', scene.id);
        console.log(`[video] Scene ${scene.scene_number} done`);
      } catch (err) {
        console.error(`[video] Error scene ${scene.scene_number}:`, err.message);
        try { updateSceneVideoError.run(err.message, scene.id); } catch {}
      }
    }));
  }

  const updated = getScenesByProject.all(projectId);
  const allDone = updated.filter(s => s.scene_type !== 'transition').every(s => s.video_status === 'done');
  updateProjectStatus.run(allDone ? 'videos_ready' : 'done', projectId);
  console.log(`[video] Project ${projectId} finished. All done: ${allDone}`);
}

async function processProVideoGeneration(projectId, scenes) {
  const mainScenes = scenes.filter(s => s.scene_type === 'main');
  const transitionScenes = scenes.filter(s => s.scene_type === 'transition');

  // Step 1: Generate main videos sequentially, extract last frame after each
  for (const scene of mainScenes) {
    if (scene.video_status === 'done' && scene.video_path) continue;

    try {
      updateSceneVideo.run(null, 'generating', scene.id);
      const filename = `${projectId}_scene${scene.scene_number}.mp4`;
      const videoPrompt = scene.video_prompt || 'gentle subtle animation, slight movement, soft breathing motion';
      const videoPath = await generateVideoKling(scene.image_path, videoPrompt, filename);
      updateSceneVideo.run(videoPath, 'done', scene.id);
      console.log(`[video-pro] Main scene ${scene.scene_number} done`);

      // Extract last frame
      const lastFrameFilename = `${projectId}_scene${scene.scene_number}_lastframe.png`;
      const lastFramePath = await extractLastFrame(videoPath, lastFrameFilename);
      updateSceneLastFrame.run(lastFramePath, scene.id);
      console.log(`[video-pro] Extracted last frame for scene ${scene.scene_number}`);
    } catch (err) {
      console.error(`[video-pro] Error main scene ${scene.scene_number}:`, err.message);
      try { updateSceneVideoError.run(err.message, scene.id); } catch {}
    }
  }

  // Refresh scenes to get updated paths
  const updatedScenes = getScenesByProject.all(projectId);
  const updatedMain = updatedScenes.filter(s => s.scene_type === 'main');

  // Step 2: Generate transitions
  // Transitions are interleaved: main(1), trans(2), main(3), trans(4), main(5), trans(6), main(7)
  for (const transition of transitionScenes) {
    if (transition.video_status === 'done' && transition.video_path) continue;

    try {
      // Find the previous main scene and next main scene
      const prevMain = updatedMain.find(s => s.scene_number === transition.scene_number - 1);
      const nextMain = updatedMain.find(s => s.scene_number === transition.scene_number + 1);

      if (!prevMain?.last_frame_path || !nextMain?.image_path) {
        console.error(`[video-pro] Missing images for transition ${transition.scene_number}`);
        updateSceneVideoError.run('Missing start/end images for transition', transition.id);
        continue;
      }

      updateSceneVideo.run(null, 'generating', transition.id);
      const filename = `${projectId}_scene${transition.scene_number}_transition.mp4`;
      const videoPrompt = transition.video_prompt || 'smooth camera transition, gentle morph';

      const videoPath = await generateVideoKling(
        prevMain.last_frame_path,
        videoPrompt,
        filename,
        nextMain.image_path
      );
      updateSceneVideo.run(videoPath, 'done', transition.id);
      console.log(`[video-pro] Transition ${transition.scene_number} done`);
    } catch (err) {
      console.error(`[video-pro] Error transition ${transition.scene_number}:`, err.message);
      try { updateSceneVideoError.run(err.message, transition.id); } catch {}
    }
  }

  const finalScenes = getScenesByProject.all(projectId);
  const allDone = finalScenes.every(s => s.video_status === 'done');
  updateProjectStatus.run(allDone ? 'videos_ready' : 'done', projectId);
  console.log(`[video-pro] Project ${projectId} finished. All done: ${allDone}`);
}

// Deluxe: step-by-step video generation (one scene at a time)
app.post('/api/projects/:id/step', async (req, res) => {
  try {
    const project = getProject.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.mode !== 'deluxe') return res.status(400).json({ error: 'Step endpoint is only for deluxe mode' });

    const scenes = getScenesByProject.all(project.id);

    // Find the next scene that is approved but video not yet generated
    const nextScene = scenes.find(s => s.status === 'approved' && s.video_status === 'pending');
    if (!nextScene) {
      return res.status(400).json({ error: 'No approved scene with pending video found' });
    }

    // Check that the scene has an image (scene 1 from FLUX, scenes 2-3 from last_frame)
    if (!nextScene.image_path) {
      return res.status(400).json({ error: `Scene ${nextScene.scene_number} has no image. Previous clip must be generated first.` });
    }

    updateSceneVideo.run(null, 'generating', nextScene.id);
    updateProjectStatus.run('generating_videos', project.id);

    // Return immediately, process in background
    res.json({ status: 'generating', scene_number: nextScene.scene_number });

    // Background processing
    (async () => {
      try {
        const voiceIds = project.voice_ids ? JSON.parse(project.voice_ids) : [];
        const filename = `${project.id}_scene${nextScene.scene_number}.mp4`;
        const videoPrompt = nextScene.video_prompt || 'gentle subtle animation, characters talking';

        const videoPath = await generateVideoKling(
          nextScene.image_path,
          videoPrompt,
          filename,
          undefined,
          { generateAudio: true, voiceIds }
        );
        updateSceneVideo.run(videoPath, 'done', nextScene.id);
        console.log(`[deluxe] Scene ${nextScene.scene_number} video done`);

        // Extract last frame
        const lastFrameFilename = `${project.id}_scene${nextScene.scene_number}_lastframe.png`;
        const lastFramePath = await extractLastFrame(videoPath, lastFrameFilename);
        updateSceneLastFrame.run(lastFramePath, nextScene.id);

        // If there's a next scene, set the last frame as its image
        const nextSceneNumber = nextScene.scene_number + 1;
        const followingScene = scenes.find(s => s.scene_number === nextSceneNumber);
        if (followingScene) {
          updateSceneImage.run(lastFramePath, 'done', followingScene.id);
          console.log(`[deluxe] Set last frame as image for scene ${nextSceneNumber}`);
        }

        // Check if all scenes are done
        const updatedScenes = getScenesByProject.all(project.id);
        const allDone = updatedScenes.every(s => s.video_status === 'done');
        updateProjectStatus.run(allDone ? 'videos_ready' : 'done', project.id);
      } catch (err) {
        console.error(`[deluxe] Error generating video for scene ${nextScene.scene_number}:`, err.message);
        try { updateSceneVideoError.run(err.message, nextScene.id); } catch {}
        try { updateProjectStatus.run('done', project.id); } catch {}
      }
    })();
  } catch (err) {
    console.error('Error in deluxe step:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Render final video (stitch clips + subtitles)
app.post('/api/projects/:id/render', async (req, res) => {
  try {
    const project = getProject.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const scenes = getScenesByProject.all(project.id);
    const allVideoDone = scenes.length > 0 && scenes.every(s => s.video_status === 'done');
    if (!allVideoDone) {
      return res.status(400).json({ error: 'All video clips must be generated first' });
    }

    updateProjectStatus.run('rendering', project.id);

    const clipPaths = scenes.map(s => s.video_path);
    const CLIP_DURATION = 5; // seconds per clip
    const crossfadeDuration = 0;

    // Split subtitle_text by "|" into multiple timed phrases per scene
    // Account for crossfade: each clip after the first loses crossfadeDuration from total
    const subtitles = [];
    let currentTime = 0;
    for (let i = 0; i < scenes.length; i++) {
      const sceneStart = currentTime;
      const sceneDuration = CLIP_DURATION - (i > 0 ? crossfadeDuration : 0);
      const sceneEnd = sceneStart + sceneDuration;

      const text = scenes[i].subtitle_text || '';
      const phrases = text.split('|').map(p => p.trim()).filter(Boolean);

      if (phrases.length === 0) {
        subtitles.push({ start: sceneStart, end: sceneEnd, text: '' });
      } else {
        const phraseDuration = sceneDuration / phrases.length;
        for (let j = 0; j < phrases.length; j++) {
          subtitles.push({
            start: sceneStart + j * phraseDuration,
            end: sceneStart + (j + 1) * phraseDuration,
            text: phrases[j],
          });
        }
      }

      currentTime = sceneEnd;
    }

    const keepAudio = project.mode === 'deluxe';
    const finalPath = await stitchVideo(clipPaths, subtitles, project.id, { crossfadeDuration, keepAudio });
    updateProjectVideo.run(finalPath, project.id);
    updateProjectStatus.run('rendered', project.id);

    res.json({ status: 'rendered', final_video_path: finalPath });
  } catch (err) {
    console.error('Error rendering video:', err);
    updateProjectStatus.run('videos_ready', req.params.id);
    res.status(500).json({ error: err.message });
  }
});

// Download final video
app.get('/api/projects/:id/download', (req, res) => {
  const project = getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.final_video_path) return res.status(404).json({ error: 'No final video available' });

  const absolutePath = path.join(__dirname, '..', project.final_video_path.replace(/^\//, ''));
  res.download(absolutePath, `animatai_${project.id.slice(0, 8)}.mp4`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AnimatAI service running on http://localhost:${PORT}`);
});
