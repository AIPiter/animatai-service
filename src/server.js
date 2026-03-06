import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import {
  runMigrations,
  resetOrphanedGeneratingScenes,
  createProject,
  getProject,
  listProjects,
  updateProjectStatus,
  updateProjectCharDesc,
  updateProjectVideo,
  updateProjectVoiceIds,
  updateProjectName,
  deleteProject,
  getProjectsByModes,
  createScene,
  getScenesByProject,
  getScene,
  updateSceneImage,
  updateSceneError,
  updateScenePrompt,
  updateSceneVideo,
  updateSceneVideoError,
  updateSceneVideoStatus,
  updateSceneVideoPrompt,
  updateSceneLastFrame,
  updateSceneClipDuration,
  setSceneFalRequest,
  clearSceneFalRequest,
  getScenesPendingRecovery,
  deleteScenesByProject,
  addSceneHistory,
  getSceneHistory,
  pruneSceneHistory,
  getSceneHistoryItem,
  deleteProjectSceneHistory,
  deleteHistoryItem,
  createUser,
  getUserByEmail,
  createRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
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
import { splitScenario, splitScenarioDeluxe } from './services/scenario.js';
import { generateImage } from './services/imageGen.js';
import { submitVideoMinimax, submitVideoKling, pollVideo, extractLastFrame } from './services/videoGen.js';
import { stitchVideo } from './services/stitcher.js';
import { generateImageFlux } from './services/imageGenFal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/storage', express.static(path.join(__dirname, '..', 'storage')));

// ===== Global Video Queue =====

const videoQueue = [];
let activeVideoJobs = 0;
const MAX_CONCURRENT = 2;

function enqueueVideo(sceneId, projectId, falKey) {
  updateSceneVideoStatus('queued', sceneId).catch(console.error);
  videoQueue.push({ sceneId, projectId, falKey });
  drainQueue();
}

function drainQueue() {
  while (activeVideoJobs < MAX_CONCURRENT && videoQueue.length > 0) {
    const job = videoQueue.shift();
    activeVideoJobs++;
    processVideoJob(job).finally(() => {
      activeVideoJobs--;
      drainQueue();
    });
  }
}

async function processVideoJob({ sceneId, projectId, falKey }) {
  try {
    await updateSceneVideoStatus('generating', sceneId);

    const scene = await getScene(sceneId);
    const project = await getProject(projectId);

    if (!scene || !project) {
      throw new Error(`Scene or project not found: sceneId=${sceneId}`);
    }

    let requestId, model;

    if (scene.fal_video_request_id) {
      // Recovery: already submitted, just poll
      requestId = scene.fal_video_request_id;
      model = scene.fal_video_model;
      console.log(`[queue] Recovering poll for scene ${scene.scene_number}, request_id: ${requestId}`);
    } else {
      // New submission
      if (!scene.image_path) {
        throw new Error(`Scene ${scene.scene_number} has no image`);
      }

      const clipDuration = project.mode === 'standard' ? 6 : (scene.clip_duration || 5);
      const videoPrompt = scene.video_prompt || 'gentle subtle animation, slight movement';

      if (project.mode === 'deluxe') {
        const voiceIds = project.voice_ids ? JSON.parse(project.voice_ids) : [];
        const result = await submitVideoKling(scene.image_path, videoPrompt, clipDuration, falKey, {
          generateAudio: true,
          voiceIds,
        });
        requestId = result.request_id;
        model = result.model;
      } else {
        const result = await submitVideoMinimax(scene.image_path, videoPrompt, clipDuration, falKey);
        requestId = result.request_id;
        model = result.model;
      }

      await setSceneFalRequest(requestId, model, sceneId);
    }

    const filename = `${projectId}_scene${scene.scene_number}.mp4`;
    const videoPath = await pollVideo(model, requestId, filename, falKey);

    // Save old video to history before overwriting
    const freshScene = await getScene(sceneId);
    if (freshScene.video_path) {
      await addSceneHistory(sceneId, 'video', freshScene.video_path);
      const oldPaths = await pruneSceneHistory(sceneId, 'video', 2);
      deleteFiles(oldPaths);
    }

    await updateSceneVideo(videoPath, 'done', sceneId);
    await clearSceneFalRequest(sceneId);
    console.log(`[queue] Scene ${scene.scene_number} video done`);

    // Deluxe: extract last frame, set as next scene's image
    if (project.mode === 'deluxe') {
      const lastFrameFilename = `${projectId}_scene${scene.scene_number}_lastframe.png`;
      const lastFramePath = await extractLastFrame(videoPath, lastFrameFilename);
      await updateSceneLastFrame(lastFramePath, sceneId);

      const allScenes = await getScenesByProject(projectId);
      const nextScene = allScenes.find(s => s.scene_number === scene.scene_number + 1);
      if (nextScene && !nextScene.image_path) {
        await updateSceneImage(lastFramePath, 'done', nextScene.id);
        console.log(`[queue] Set last frame as image for deluxe scene ${nextScene.scene_number}`);
      }
    }

    // Check if all videos done → update project status
    const updatedScenes = await getScenesByProject(projectId);
    const allDone = updatedScenes.every(s => s.video_status === 'done');
    if (allDone) {
      await updateProjectStatus('videos_ready', projectId);
    }
  } catch (err) {
    console.error(`[queue] Job failed sceneId=${sceneId}:`, err.message);
    try { await updateSceneVideoError(err.message, sceneId); } catch {}
    try { await clearSceneFalRequest(sceneId); } catch {}
  }
}

async function recoverVideoQueue() {
  try {
    const scenes = await getScenesPendingRecovery();
    if (scenes.length > 0) {
      console.log(`[startup] Recovering ${scenes.length} pending video jobs`);
      for (const s of scenes) {
        videoQueue.push({ sceneId: s.id, projectId: s.project_id, falKey: null });
      }
      drainQueue();
    }
  } catch (err) {
    console.error('[startup] Video queue recovery failed:', err.message);
  }
}

async function deleteObsoleteProjects() {
  try {
    const obsolete = await getProjectsByModes(['pro', 'freetrial']);
    if (obsolete.length === 0) return;
    console.log(`[startup] Deleting ${obsolete.length} obsolete pro/freetrial projects`);
    const storageRoot = path.join(__dirname, '..');
    for (const project of obsolete) {
      const scenes = await getScenesByProject(project.id);
      for (const scene of scenes) {
        deleteFiles([scene.image_path, scene.video_path, scene.last_frame_path].filter(Boolean));
      }
      if (project.final_video_path) deleteFiles([project.final_video_path]);
      await deleteScenesByProject(project.id);
      await deleteProject(project.id);
    }
  } catch (err) {
    console.error('[startup] deleteObsoleteProjects failed:', err.message);
  }
}

function deleteFiles(paths) {
  const storageRoot = path.join(__dirname, '..');
  for (const p of paths) {
    if (!p) continue;
    try { fs.unlinkSync(path.join(storageRoot, p.replace(/^\//, ''))); } catch {}
  }
}

// ===== Startup =====

async function startup() {
  await runMigrations();
  await deleteObsoleteProjects();
  await resetOrphanedGeneratingScenes();
  await recoverVideoQueue();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`AnimatAI service running on http://localhost:${PORT}`);
  });
}

// ===== Auth Routes =====

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
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

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
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

    const tokenRecord = await getRefreshToken(hashToken(refreshToken));
    if (!tokenRecord) return res.status(401).json({ error: 'Invalid or expired refresh token' });

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
    if (refreshToken) await deleteRefreshToken(hashToken(refreshToken));
  } catch {}
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, username: req.user.username } });
});

// ===== Project Routes =====

app.get('/api/projects', requireAuth, async (req, res) => {
  const projects = await listProjects(req.user.id);
  res.json(projects);
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  const historyPaths = await deleteProjectSceneHistory(project.id);
  deleteFiles(historyPaths);

  for (const scene of scenes) {
    deleteFiles([scene.image_path, scene.video_path, scene.last_frame_path].filter(Boolean));
  }

  if (project.final_video_path) deleteFiles([project.final_video_path]);

  const outputDir = path.join(__dirname, '..', 'storage', 'output');
  try { fs.unlinkSync(path.join(outputDir, `${project.id}.ass`)); } catch {}
  try { fs.unlinkSync(path.join(outputDir, `${project.id}.srt`)); } catch {}

  await deleteScenesByProject(project.id);
  await deleteProject(project.id);

  res.json({ ok: true });
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  res.json({ ...project, scenes });
});

app.patch('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (name !== undefined) await updateProjectName(name.trim() || null, project.id);

  res.json(await getProject(project.id));
});

// Create project + split scenario
app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    const openrouterKey = req.headers['x-openrouter-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required (X-Fal-Key header)' });
    if (!openrouterKey) return res.status(400).json({ error: 'OpenRouter API key required (X-Openrouter-Key header)' });

    const { scenario, scene_count, style, mode, voice_ids } = req.body;
    if (!scenario) return res.status(400).json({ error: 'scenario is required' });

    const projectMode = mode === 'deluxe' ? 'deluxe' : 'standard';
    const projectStyle = ['anime', 'cartoon', 'pixar'].includes(style) ? style : 'anime';

    let sceneCount, duration;
    if (projectMode === 'deluxe') {
      sceneCount = 3;
      duration = 15;
    } else {
      sceneCount = Math.max(1, Math.min(12, parseInt(scene_count) || 5));
      duration = sceneCount * 5;
    }

    const projectId = uuidv4();
    await createProject(projectId, req.user.id, scenario, duration, null, 'created', projectStyle, projectMode, sceneCount);

    if (projectMode === 'deluxe' && voice_ids) {
      await updateProjectVoiceIds(JSON.stringify(voice_ids), projectId);
    }

    let characterDescription, scenes;
    if (projectMode === 'deluxe') {
      const result = await splitScenarioDeluxe(scenario, projectStyle, openrouterKey);
      characterDescription = result.characterDescription;
      scenes = result.scenes;
    } else {
      ({ characterDescription, scenes } = await splitScenario(scenario, sceneCount, projectStyle, openrouterKey));
    }

    if (characterDescription) {
      await updateProjectCharDesc(characterDescription, projectId);
    }

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      await createScene(
        uuidv4(),
        projectId,
        i + 1,
        scene.description,
        scene.image_prompt || null,
        scene.subtitle_text,
        scene.video_prompt || null,
        'main'
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

// Generate images for all scenes without images
app.post('/api/projects/:id/generate', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    const openrouterKey = req.headers['x-openrouter-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required' });
    if (!openrouterKey) return res.status(400).json({ error: 'OpenRouter API key required' });

    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scenes = await getScenesByProject(project.id);
    if (scenes.length === 0) return res.status(400).json({ error: 'No scenes found' });

    await updateProjectStatus('generating', project.id);

    for (const scene of scenes) {
      if (scene.image_path) continue; // skip already generated
      if (project.mode === 'deluxe' && !scene.image_prompt) continue;

      try {
        const filename = `${project.id}_scene${scene.scene_number}.png`;
        let imagePath;
        if (project.mode === 'deluxe') {
          imagePath = await generateImageFlux(scene.image_prompt, filename, falKey);
        } else {
          imagePath = await generateImage(scene.image_prompt, filename, openrouterKey);
        }
        await updateSceneImage(imagePath, 'done', scene.id);
      } catch (err) {
        console.error(`Error generating image for scene ${scene.scene_number}:`, err);
        const errorMsg = (err.message.includes('Moderated') || err.message.includes('Derivative'))
          ? 'Заблокировано фильтром контента. Отредактируйте промпт.'
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

// Generate image for a single scene (per-card button)
app.post('/api/projects/:id/scenes/:sceneId/generate-image', requireAuth, async (req, res) => {
  try {
    const falKey = req.headers['x-fal-key'];
    const openrouterKey = req.headers['x-openrouter-key'];
    if (!falKey) return res.status(400).json({ error: 'fal.ai API key required' });
    if (!openrouterKey) return res.status(400).json({ error: 'OpenRouter API key required' });

    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scene = await getScene(req.params.sceneId);
    if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

    const { image_prompt } = req.body || {};
    if (image_prompt) await updateScenePrompt(image_prompt, scene.id);
    const prompt = image_prompt || scene.image_prompt;

    // Save old image to history before overwriting
    if (scene.image_path) {
      await addSceneHistory(scene.id, 'image', scene.image_path);
      const oldPaths = await pruneSceneHistory(scene.id, 'image', 2);
      deleteFiles(oldPaths);
    }

    const filename = `${project.id}_scene${scene.scene_number}_${Date.now()}.png`;
    let imagePath;
    if (project.mode === 'deluxe') {
      imagePath = await generateImageFlux(prompt, filename, falKey);
    } else {
      imagePath = await generateImage(prompt, filename, openrouterKey);
    }
    await updateSceneImage(imagePath, 'done', scene.id);

    res.json(await getScene(scene.id));
  } catch (err) {
    console.error('Error generating scene image:', err);
    res.status(500).json({ error: err.message });
  }
});

// Regenerate image for a single scene (regen icon)
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
    if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

    const { image_prompt } = req.body || {};
    if (image_prompt) await updateScenePrompt(image_prompt, scene.id);
    const prompt = image_prompt || scene.image_prompt;

    // Save old image to history
    if (scene.image_path) {
      await addSceneHistory(scene.id, 'image', scene.image_path);
      const oldPaths = await pruneSceneHistory(scene.id, 'image', 2);
      deleteFiles(oldPaths);
    }

    const filename = `${project.id}_scene${scene.scene_number}_${Date.now()}.png`;
    const useFlux = project.mode === 'deluxe';
    const imagePath = useFlux
      ? await generateImageFlux(prompt, filename, falKey)
      : await generateImage(prompt, filename, openrouterKey);
    await updateSceneImage(imagePath, 'done', scene.id);

    res.json(await getScene(scene.id));
  } catch (err) {
    console.error('Error regenerating image:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update scene video_prompt or image_prompt
app.patch('/api/projects/:id/scenes/:sceneId', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scene = await getScene(req.params.sceneId);
  if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

  const { video_prompt, image_prompt } = req.body;
  if (video_prompt !== undefined) await updateSceneVideoPrompt(video_prompt, scene.id);
  if (image_prompt !== undefined) await updateScenePrompt(image_prompt, scene.id);

  res.json(await getScene(scene.id));
});

// Update clip duration for a scene
app.patch('/api/projects/:id/scenes/:sceneId/clip-duration', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scene = await getScene(req.params.sceneId);
  if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

  const { duration } = req.body;
  const allowed = project.mode === 'deluxe' ? [5, 10] : [6];
  if (!allowed.includes(duration)) return res.status(400).json({ error: `duration must be one of: ${allowed.join(', ')}` });
  if (scene.video_status === 'generating' || scene.video_status === 'queued') {
    return res.status(409).json({ error: 'Cannot change duration while video is generating' });
  }

  await updateSceneClipDuration(duration, scene.id);
  res.json(await getScene(scene.id));
});

// Queue video for a single scene
app.post('/api/projects/:id/scenes/:sceneId/video', requireAuth, async (req, res) => {
  const falKey = req.headers['x-fal-key'];
  if (!falKey) return res.status(400).json({ error: 'fal.ai API key required' });

  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scene = await getScene(req.params.sceneId);
  if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

  if (!scene.image_path) {
    return res.status(400).json({ error: 'Scene has no image. Generate image first.' });
  }
  if (scene.video_status === 'generating' || scene.video_status === 'queued') {
    return res.status(409).json({ error: 'Video already in progress' });
  }

  // For deluxe: previous scene's video must be done (so last_frame is available)
  if (project.mode === 'deluxe' && scene.scene_number > 1) {
    const allScenes = await getScenesByProject(project.id);
    const prevScene = allScenes.find(s => s.scene_number === scene.scene_number - 1);
    if (!prevScene || prevScene.video_status !== 'done') {
      return res.status(400).json({ error: 'Previous scene video must be done first (deluxe mode)' });
    }
  }

  enqueueVideo(scene.id, project.id, falKey);
  res.json({ status: 'queued' });
});

// Queue video for all scenes with images
app.post('/api/projects/:id/video', requireAuth, async (req, res) => {
  const falKey = req.headers['x-fal-key'];
  if (!falKey) return res.status(400).json({ error: 'fal.ai API key required' });

  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  const withImage = scenes.filter(s => s.image_path);

  if (withImage.length === 0) {
    return res.status(400).json({ error: 'No scenes with images found' });
  }

  const allHaveImage = scenes.every(s => s.image_path);
  if (!allHaveImage) {
    return res.status(400).json({ error: 'All scenes must have images before animating all' });
  }

  const pending = scenes.filter(s => s.video_status !== 'done' && s.video_status !== 'queued' && s.video_status !== 'generating');
  for (const scene of pending) {
    enqueueVideo(scene.id, project.id, falKey);
  }

  res.json({ status: 'queued', count: pending.length });
});

// Get scene history
app.get('/api/projects/:id/scenes/:sceneId/history', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scene = await getScene(req.params.sceneId);
  if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

  const [images, videos] = await Promise.all([
    getSceneHistory(scene.id, 'image'),
    getSceneHistory(scene.id, 'video'),
  ]);

  res.json({ images, videos });
});

// Restore history item
app.post('/api/projects/:id/scenes/:sceneId/history/:historyId/restore', requireAuth, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const scene = await getScene(req.params.sceneId);
    if (!scene || scene.project_id !== project.id) return res.status(404).json({ error: 'Scene not found' });

    const histItem = await getSceneHistoryItem(req.params.historyId);
    if (!histItem || histItem.scene_id !== scene.id) return res.status(404).json({ error: 'History item not found' });

    if (histItem.type === 'image') {
      if (scene.image_path) {
        await addSceneHistory(scene.id, 'image', scene.image_path);
      }
      await updateSceneImage(histItem.path, 'done', scene.id);
    } else {
      if (scene.video_path) {
        await addSceneHistory(scene.id, 'video', scene.video_path);
      }
      await updateSceneVideo(histItem.path, 'done', scene.id);
    }

    // Remove the restored item from history and prune
    await deleteHistoryItem(histItem.id);
    const oldPaths = await pruneSceneHistory(scene.id, histItem.type, 2);
    deleteFiles(oldPaths);

    res.json(await getScene(scene.id));
  } catch (err) {
    console.error('Error restoring history:', err);
    res.status(500).json({ error: err.message });
  }
});

// Render final video (stitch + subtitles)
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

    const subtitles = [];
    let currentTime = 0;
    for (const scene of scenes) {
      const clipDuration = project.mode === 'standard' ? 6 : (scene.clip_duration || 5);
      const sceneEnd = currentTime + clipDuration;

      const text = scene.subtitle_text || '';
      const phrases = text.split('|').map(p => p.trim()).filter(Boolean);

      if (phrases.length === 0) {
        subtitles.push({ start: currentTime, end: sceneEnd, text: '' });
      } else {
        const phraseDuration = clipDuration / phrases.length;
        for (let j = 0; j < phrases.length; j++) {
          subtitles.push({
            start: currentTime + j * phraseDuration,
            end: currentTime + (j + 1) * phraseDuration,
            text: phrases[j],
          });
        }
      }

      currentTime = sceneEnd;
    }

    const keepAudio = project.mode === 'deluxe';
    const finalPath = await stitchVideo(clipPaths, subtitles, project.id, { crossfadeDuration: 0, keepAudio });
    await updateProjectVideo(finalPath, project.id);
    await updateProjectStatus('rendered', project.id);

    // Delete all scene history after render
    const historyPaths = await deleteProjectSceneHistory(project.id);
    deleteFiles(historyPaths);

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

// Get scenes for a project
app.get('/api/projects/:id/scenes', requireAuth, async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const scenes = await getScenesByProject(project.id);
  res.json(scenes);
});

startup().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
