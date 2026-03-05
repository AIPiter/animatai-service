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
  createUser,
  getUserByEmail,
  createRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  updateProjectName,
} from './db.js';
import {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  requireAuth,
} from './auth.js';
import fs from 'fs';
import { splitScenario, splitScenarioPro, splitScenarioDeluxe, splitScenarioFreeTrial } from './services/scenario.js';
import { generateImage } from './services/imageGen.js';
import { generateVideo, generateVideoKling, extractLastFrame } from './services/videoGen.js';
import { stitchVideo } from './services/stitcher.js';
import { generateImageFlux } from './services/imageGenFal.js';
import { generateLoopVideo } from './services/videoGenKling3.js';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/storage', express.static(path.join(__dirname, '..', 'storage')));

// --- Auth Routes ---

// Register: create user directly (no email verification)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username и password обязательны' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email уже зарегистрирован' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(email, username, passwordHash);

    const accessToken = generateAccessToken(user.id);
    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createRefreshToken(user.id, hashToken(rawRefreshToken), expiresAt);

    res.status(201).json({
      user: { id: user.id, email: user.email, username: user.username },
      accessToken,
      refreshToken: rawRefreshToken,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = generateAccessToken(user.id);
    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createRefreshToken(user.id, hashToken(rawRefreshToken), expiresAt);

    res.json({
      user: { id: user.id, email: user.email, username: user.username },
      accessToken,
      refreshToken: rawRefreshToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    const tokenRecord = await getRefreshToken(hashToken(refreshToken));
    if (!tokenRecord) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    await deleteRefreshToken(hashToken(refreshToken));

    const accessToken = generateAccessToken(tokenRecord.user_id);
    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createRefreshToken(tokenRecord.user_id, hashToken(rawRefreshToken), expiresAt);

    res.json({ accessToken, refreshToken: rawRefreshToken });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await deleteRefreshToken(hashToken(refreshToken));
    }
    res.status(204).end();
  } catch {
    res.status(204).end();
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, username: req.user.username } });
});

// --- Project Routes (all protected) ---

// List projects for authenticated user
app.get('/api/projects', requireAuth, async (req, res) => {
  const projects = await listProjects(req.user.id);
  res.json(projects);
});

// Delete project with all files
app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  const storageRoot = path.join(__dirname, '..');

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

  if (project.final_video_path) {
    try { fs.unlinkSync(path.join(storageRoot, project.final_video_path.replace(/^\//, ''))); } catch {}
  }
  const outputDir = path.join(storageRoot, 'storage', 'output');
  try { fs.unlinkSync(path.join(outputDir, `${project.id}.ass`)); } catch {}
  try { fs.unlinkSync(path.join(outputDir, `${project.id}.srt`)); } catch {}

  await deleteScenesByProject(project.id);
  await deleteProject(project.id);

  res.json({ ok: true });
});

// Get project with scenes
app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  res.json({ ...project, scenes });
});

// Rename project
app.patch('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (name !== undefined) await updateProjectName(name.trim() || null, project.id);

  res.json(await getProject(project.id));
});

// Create project + split scenario into scenes
app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    const openrouterKey = req.headers['x-openrouter-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required (X-Fal-Key header)' });
    if (!openrouterKey) return res.status(400).json({ error: 'OpenRouter API key required (X-Openrouter-Key header)' });

    const { scenario, duration, style, mode, voice_ids } = req.body;
    const projectMode = ['pro', 'deluxe', 'freetrial'].includes(mode) ? mode : 'standard';

    if (!scenario) {
      return res.status(400).json({ error: 'scenario is required' });
    }

    if (projectMode === 'standard') {
      if (!duration || ![30, 60, 120].includes(duration)) {
        return res.status(400).json({ error: 'duration must be 30, 60, or 120' });
      }
    }

    const projectStyle = ['anime', 'cartoon', 'pixar'].includes(style) ? style : 'anime';
    const projectDuration = projectMode === 'pro' ? 25 : projectMode === 'deluxe' ? 15 : projectMode === 'freetrial' ? 10 : duration;
    const projectId = uuidv4();
    await createProject(projectId, req.user.id, scenario, projectDuration, null, 'created', projectStyle, projectMode);

    if (projectMode === 'deluxe' && voice_ids) {
      await updateProjectVoiceIds(JSON.stringify(voice_ids), projectId);
    }

    let characterDescription, scenes;
    if (projectMode === 'deluxe') {
      const result = await splitScenarioDeluxe(scenario, projectStyle, openrouterKey);
      characterDescription = result.characterDescription;
      scenes = result.scenes;
    } else if (projectMode === 'pro') {
      ({ characterDescription, scenes } = await splitScenarioPro(scenario, projectStyle, openrouterKey));
    } else if (projectMode === 'freetrial') {
      ({ characterDescription, scenes } = await splitScenarioFreeTrial(scenario, projectStyle, openrouterKey));
    } else {
      ({ characterDescription, scenes } = await splitScenario(scenario, projectDuration, projectStyle, openrouterKey));
    }

    if (characterDescription) {
      await updateProjectCharDesc(characterDescription, projectId);
    }

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = uuidv4();
      await createScene(
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

    await updateProjectStatus('scenes_ready', projectId);

    const project = await getProject(projectId);
    const savedScenes = await getScenesByProject(projectId);
    res.json({ ...project, scenes: savedScenes });
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get scenes for a project
app.get('/api/projects/:id/scenes', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  res.json(scenes);
});

// Generate images for all pending scenes
app.post('/api/projects/:id/generate', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    const openrouterKey = req.headers['x-openrouter-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required (X-Fal-Key header)' });
    if (!openrouterKey) return res.status(400).json({ error: 'OpenRouter API key required (X-Openrouter-Key header)' });

    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scenes = await getScenesByProject(project.id);
    if (scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes found. Create project first.' });
    }

    await updateProjectStatus('generating', project.id);

    for (const scene of scenes) {
      if (scene.status === 'approved') continue;
      if (scene.scene_type === 'transition') continue;
      if (project.mode === 'deluxe' && !scene.image_prompt) continue;

      try {
        const filename = `${project.id}_scene${scene.scene_number}.png`;
        let imagePath;
        if (project.mode === 'deluxe' || project.mode === 'freetrial') {
          imagePath = await generateImageFlux(scene.image_prompt, filename, falKey);
        } else {
          imagePath = await generateImage(scene.image_prompt, filename, openrouterKey);
        }
        await updateSceneImage(imagePath, 'done', scene.id);
      } catch (err) {
        console.error(`Error generating image for scene ${scene.scene_number}:`, err);
        const errorMsg = (err.message.includes('Moderated') || err.message.includes('Derivative'))
          ? 'Заблокировано фильтром контента. Отредактируйте промпт — уберите упоминания конкретных персонажей/брендов.'
          : err.message;
        await updateSceneError(errorMsg, scene.id);
      }
    }

    await updateProjectStatus('done', project.id);

    const updatedScenes = await getScenesByProject(project.id);
    res.json({ status: 'done', scenes: updatedScenes });
  } catch (err) {
    console.error('Error generating images:', err);
    res.status(500).json({ error: err.message });
  }
});

// Regenerate image for a single scene
app.post('/api/projects/:id/scenes/:sceneId/regenerate', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    const openrouterKey = req.headers['x-openrouter-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required' });
    if (!openrouterKey) return res.status(400).json({ error: 'OpenRouter API key required' });

    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scene = await getScene(req.params.sceneId);
    if (!scene || scene.project_id !== project.id) {
      return res.status(404).json({ error: 'Scene not found' });
    }

    const { image_prompt } = req.body || {};
    if (image_prompt) {
      await updateScenePrompt(image_prompt, scene.id);
    }

    const prompt = image_prompt || scene.image_prompt;
    const filename = `${project.id}_scene${scene.scene_number}.png`;
    const useFlux = project.mode === 'deluxe' || project.mode === 'freetrial';
    const imagePath = useFlux
      ? await generateImageFlux(prompt, filename, falKey)
      : await generateImage(prompt, filename, openrouterKey);
    await updateSceneImage(imagePath, 'done', scene.id);

    const updatedScene = await getScene(scene.id);
    res.json(updatedScene);
  } catch (err) {
    console.error('Error regenerating image:', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve a scene or update video_prompt
app.patch('/api/projects/:id/scenes/:sceneId', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scene = await getScene(req.params.sceneId);
  if (!scene || scene.project_id !== project.id) {
    return res.status(404).json({ error: 'Scene not found' });
  }

  const { status, video_prompt } = req.body;
  if (status && ['pending', 'done', 'approved'].includes(status)) {
    await updateSceneImage(scene.image_path, status, scene.id);
  }
  if (video_prompt !== undefined) {
    await updateSceneVideoPrompt(video_prompt, scene.id);
  }

  const updatedScene = await getScene(scene.id);
  res.json(updatedScene);
});

// Reset stuck video generation
app.post('/api/projects/:id/video/reset', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  await resetSceneVideos(project.id);
  await updateProjectStatus('done', project.id);

  const scenes = await getScenesByProject(project.id);
  const updatedProject = await getProject(project.id);
  res.json({ ...updatedProject, scenes });
});

// Generate video clips from approved frames
app.post('/api/projects/:id/video', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required (X-Fal-Key header)' });

    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    if (project.status === 'generating_videos') {
      return res.status(409).json({ error: 'Video generation already in progress' });
    }

    const scenes = await getScenesByProject(project.id);
    const mainScenes = scenes.filter(s => s.scene_type !== 'transition');
    const allMainApproved = mainScenes.length > 0 && mainScenes.every(s => s.status === 'approved');
    if (!allMainApproved) {
      return res.status(400).json({ error: 'All main scenes must be approved before generating video' });
    }

    await updateProjectStatus('generating_videos', project.id);

    res.json({ status: 'generating_videos', message: 'Video generation started' });

    const processor = project.mode === 'pro'
      ? processProVideoGeneration(project.id, scenes, falKey)
      : processVideoGeneration(project.id, scenes, falKey);

    processor.catch(async err => {
      console.error(`[video] Fatal error for project ${project.id}:`, err);
      try { await updateProjectStatus('done', project.id); } catch {}
    });
  } catch (err) {
    console.error('Error starting video generation:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

async function processVideoGeneration(projectId, scenes, falKey) {
  const pending = scenes.filter(s => s.video_status !== 'done');
  const CONCURRENCY = 2;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (scene) => {
      try {
        await updateSceneVideo(null, 'generating', scene.id);
        const filename = `${projectId}_scene${scene.scene_number}.mp4`;
        const videoPrompt = scene.video_prompt || 'gentle subtle animation, slight movement, soft breathing motion';
        const videoPath = await generateVideo(scene.image_path, videoPrompt, filename, falKey);
        await updateSceneVideo(videoPath, 'done', scene.id);
        console.log(`[video] Scene ${scene.scene_number} done`);
      } catch (err) {
        console.error(`[video] Error scene ${scene.scene_number}:`, err.message);
        try { await updateSceneVideoError(err.message, scene.id); } catch {}
      }
    }));
  }

  const updated = await getScenesByProject(projectId);
  const allDone = updated.filter(s => s.scene_type !== 'transition').every(s => s.video_status === 'done');
  await updateProjectStatus(allDone ? 'videos_ready' : 'done', projectId);
  console.log(`[video] Project ${projectId} finished. All done: ${allDone}`);
}

async function processProVideoGeneration(projectId, scenes, falKey) {
  const mainScenes = scenes.filter(s => s.scene_type === 'main');
  const transitionScenes = scenes.filter(s => s.scene_type === 'transition');

  for (const scene of mainScenes) {
    if (scene.video_status === 'done' && scene.video_path) continue;

    try {
      await updateSceneVideo(null, 'generating', scene.id);
      const filename = `${projectId}_scene${scene.scene_number}.mp4`;
      const videoPrompt = scene.video_prompt || 'gentle subtle animation, slight movement, soft breathing motion';
      const videoPath = await generateVideoKling(scene.image_path, videoPrompt, filename, undefined, {}, falKey);
      await updateSceneVideo(videoPath, 'done', scene.id);
      console.log(`[video-pro] Main scene ${scene.scene_number} done`);

      const lastFrameFilename = `${projectId}_scene${scene.scene_number}_lastframe.png`;
      const lastFramePath = await extractLastFrame(videoPath, lastFrameFilename);
      await updateSceneLastFrame(lastFramePath, scene.id);
      console.log(`[video-pro] Extracted last frame for scene ${scene.scene_number}`);
    } catch (err) {
      console.error(`[video-pro] Error main scene ${scene.scene_number}:`, err.message);
      try { await updateSceneVideoError(err.message, scene.id); } catch {}
    }
  }

  const updatedScenes = await getScenesByProject(projectId);
  const updatedMain = updatedScenes.filter(s => s.scene_type === 'main');

  for (const transition of transitionScenes) {
    if (transition.video_status === 'done' && transition.video_path) continue;

    try {
      const prevMain = updatedMain.find(s => s.scene_number === transition.scene_number - 1);
      const nextMain = updatedMain.find(s => s.scene_number === transition.scene_number + 1);

      if (!prevMain?.last_frame_path || !nextMain?.image_path) {
        console.error(`[video-pro] Missing images for transition ${transition.scene_number}`);
        await updateSceneVideoError('Missing start/end images for transition', transition.id);
        continue;
      }

      await updateSceneVideo(null, 'generating', transition.id);
      const filename = `${projectId}_scene${transition.scene_number}_transition.mp4`;
      const videoPrompt = transition.video_prompt || 'smooth camera transition, gentle morph';

      const videoPath = await generateVideoKling(
        prevMain.last_frame_path,
        videoPrompt,
        filename,
        nextMain.image_path,
        {},
        falKey
      );
      await updateSceneVideo(videoPath, 'done', transition.id);
      console.log(`[video-pro] Transition ${transition.scene_number} done`);
    } catch (err) {
      console.error(`[video-pro] Error transition ${transition.scene_number}:`, err.message);
      try { await updateSceneVideoError(err.message, transition.id); } catch {}
    }
  }

  const finalScenes = await getScenesByProject(projectId);
  const allDone = finalScenes.every(s => s.video_status === 'done');
  await updateProjectStatus(allDone ? 'videos_ready' : 'done', projectId);
  console.log(`[video-pro] Project ${projectId} finished. All done: ${allDone}`);
}

// Deluxe: step-by-step video generation
app.post('/api/projects/:id/step', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required (X-Fal-Key header)' });

    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (project.mode !== 'deluxe') return res.status(400).json({ error: 'Step endpoint is only for deluxe mode' });

    const scenes = await getScenesByProject(project.id);

    const nextScene = scenes.find(s => s.status === 'approved' && s.video_status === 'pending');
    if (!nextScene) {
      return res.status(400).json({ error: 'No approved scene with pending video found' });
    }

    if (!nextScene.image_path) {
      return res.status(400).json({ error: `Scene ${nextScene.scene_number} has no image. Previous clip must be generated first.` });
    }

    await updateSceneVideo(null, 'generating', nextScene.id);
    await updateProjectStatus('generating_videos', project.id);

    res.json({ status: 'generating', scene_number: nextScene.scene_number });

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
          { generateAudio: true, voiceIds },
          falKey
        );
        await updateSceneVideo(videoPath, 'done', nextScene.id);
        console.log(`[deluxe] Scene ${nextScene.scene_number} video done`);

        const lastFrameFilename = `${project.id}_scene${nextScene.scene_number}_lastframe.png`;
        const lastFramePath = await extractLastFrame(videoPath, lastFrameFilename);
        await updateSceneLastFrame(lastFramePath, nextScene.id);

        const nextSceneNumber = nextScene.scene_number + 1;
        const followingScene = scenes.find(s => s.scene_number === nextSceneNumber);
        if (followingScene) {
          await updateSceneImage(lastFramePath, 'done', followingScene.id);
          console.log(`[deluxe] Set last frame as image for scene ${nextSceneNumber}`);
        }

        const updatedScenes = await getScenesByProject(project.id);
        const allDone = updatedScenes.every(s => s.video_status === 'done');
        await updateProjectStatus(allDone ? 'videos_ready' : 'done', project.id);
      } catch (err) {
        console.error(`[deluxe] Error generating video for scene ${nextScene.scene_number}:`, err.message);
        try { await updateSceneVideoError(err.message, nextScene.id); } catch {}
        try { await updateProjectStatus('done', project.id); } catch {}
      }
    })();
  } catch (err) {
    console.error('Error in deluxe step:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Render final video (stitch clips + subtitles)
app.post('/api/projects/:id/render', requireAuth, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scenes = await getScenesByProject(project.id);
    const allVideoDone = scenes.length > 0 && scenes.every(s => s.video_status === 'done');
    if (!allVideoDone) {
      return res.status(400).json({ error: 'All video clips must be generated first' });
    }

    await updateProjectStatus('rendering', project.id);

    const clipPaths = scenes.map(s => s.video_path);
    const CLIP_DURATION = 5;
    const crossfadeDuration = 0;

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
    await updateProjectVideo(finalPath, project.id);
    await updateProjectStatus('rendered', project.id);

    res.json({ status: 'rendered', final_video_path: finalPath });
  } catch (err) {
    console.error('Error rendering video:', err);
    await updateProjectStatus('videos_ready', req.params.id);
    res.status(500).json({ error: err.message });
  }
});

// Download final video
app.get('/api/projects/:id/download', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.final_video_path) return res.status(404).json({ error: 'No final video available' });

  const absolutePath = path.join(__dirname, '..', project.final_video_path.replace(/^\//, ''));
  res.download(absolutePath, `animatai_${project.id.slice(0, 8)}.mp4`);
});

// --- Loop Video Generation ---

app.post('/api/generate-video', requireAuth, upload.fields([
  { name: 'first_frame', maxCount: 1 },
  { name: 'last_frame', maxCount: 1 },
]), async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required (X-Fal-Key header)' });

    const firstFrame = req.files?.first_frame?.[0];
    const lastFrame = req.files?.last_frame?.[0];
    const { prompt, duration } = req.body;

    if (!firstFrame) return res.status(400).json({ error: 'first_frame is required' });
    if (!lastFrame) return res.status(400).json({ error: 'last_frame is required' });
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'prompt is required' });

    const dur = parseInt(duration, 10) || 5;
    if (dur < 3 || dur > 15) return res.status(400).json({ error: 'duration must be between 3 and 15' });

    const videoPath = await generateLoopVideo({
      firstFrameBuffer: firstFrame.buffer,
      firstFrameName: firstFrame.originalname,
      lastFrameBuffer: lastFrame.buffer,
      lastFrameName: lastFrame.originalname,
      prompt: prompt.trim(),
      duration: dur,
      falKey,
    });

    res.json({ video_url: videoPath });
  } catch (err) {
    console.error('[/api/generate-video] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AnimatAI service running on http://localhost:${PORT}`);
});
