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
  updateProjectVideo,
} from './db.js';
import { splitScenario } from './services/scenario.js';
import { generateImage } from './services/imageGen.js';
import { generateVideo } from './services/videoGen.js';
import { stitchVideo } from './services/stitcher.js';

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
    const { scenario, duration } = req.body;

    if (!scenario || !duration) {
      return res.status(400).json({ error: 'scenario and duration are required' });
    }

    if (![30, 60, 120].includes(duration)) {
      return res.status(400).json({ error: 'duration must be 30, 60, or 120' });
    }

    const projectId = uuidv4();
    createProject.run(projectId, scenario, duration, null, 'created');

    // Split scenario via LLM
    const { characterDescription, scenes } = await splitScenario(scenario, duration);

    // Save character description to project
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
        scene.image_prompt,
        scene.subtitle_text,
        scene.video_prompt || null
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

      try {
        const filename = `${project.id}_scene${scene.scene_number}.png`;
        const imagePath = await generateImage(scene.image_prompt, filename);
        updateSceneImage.run(imagePath, 'done', scene.id);
      } catch (err) {
        console.error(`Error generating image for scene ${scene.scene_number}:`, err);
        const errorMsg = err.message.includes('Content Moderated')
          ? 'Content moderated by safety filter. Try editing the prompt.'
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

// Generate video clips from approved frames
app.post('/api/projects/:id/video', async (req, res) => {
  try {
    const project = getProject.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const scenes = getScenesByProject.all(project.id);
    const allApproved = scenes.length > 0 && scenes.every(s => s.status === 'approved');
    if (!allApproved) {
      return res.status(400).json({ error: 'All scenes must be approved before generating video' });
    }

    updateProjectStatus.run('generating_videos', project.id);

    for (const scene of scenes) {
      if (scene.video_status === 'done') continue;

      try {
        updateSceneVideo.run(null, 'generating', scene.id);
        const filename = `${project.id}_scene${scene.scene_number}.mp4`;
        // Use video_prompt (motion-focused) if available, otherwise fall back to a generic gentle animation prompt
        const videoPrompt = scene.video_prompt || 'gentle subtle animation, slight movement, soft breathing motion';
        const videoPath = await generateVideo(scene.image_path, videoPrompt, filename);
        updateSceneVideo.run(videoPath, 'done', scene.id);
      } catch (err) {
        console.error(`Error generating video for scene ${scene.scene_number}:`, err);
        updateSceneVideoError.run(err.message, scene.id);
      }
    }

    updateProjectStatus.run('videos_ready', project.id);

    const updatedScenes = getScenesByProject.all(project.id);
    res.json({ status: 'videos_ready', scenes: updatedScenes });
  } catch (err) {
    console.error('Error generating videos:', err);
    res.status(500).json({ error: err.message });
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
    const subtitles = scenes.map((s, i) => ({
      start: i * 5,
      end: (i + 1) * 5,
      text: s.subtitle_text || '',
    }));

    const finalPath = await stitchVideo(clipPaths, subtitles, project.id);
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
