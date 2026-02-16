import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'animatai.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    scenario TEXT NOT NULL,
    duration INTEGER NOT NULL,
    character_description TEXT,
    status TEXT DEFAULT 'created',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    scene_number INTEGER NOT NULL,
    description TEXT,
    image_prompt TEXT,
    subtitle_text TEXT,
    image_path TEXT,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for existing databases
try { db.exec('ALTER TABLE projects ADD COLUMN character_description TEXT'); } catch {}
try { db.exec('ALTER TABLE scenes ADD COLUMN error_message TEXT'); } catch {}
try { db.exec('ALTER TABLE scenes ADD COLUMN video_path TEXT'); } catch {}
try { db.exec("ALTER TABLE scenes ADD COLUMN video_status TEXT DEFAULT 'pending'"); } catch {}
try { db.exec('ALTER TABLE scenes ADD COLUMN video_error TEXT'); } catch {}
try { db.exec('ALTER TABLE projects ADD COLUMN final_video_path TEXT'); } catch {}
try { db.exec('ALTER TABLE scenes ADD COLUMN video_prompt TEXT'); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN style TEXT DEFAULT 'anime'"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN mode TEXT DEFAULT 'standard'"); } catch {}
try { db.exec("ALTER TABLE scenes ADD COLUMN scene_type TEXT DEFAULT 'main'"); } catch {}
try { db.exec("ALTER TABLE scenes ADD COLUMN last_frame_path TEXT"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN voice_ids TEXT"); } catch {}

export const createProject = db.prepare(`
  INSERT INTO projects (id, scenario, duration, character_description, status, style, mode) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export const getProject = db.prepare(`
  SELECT * FROM projects WHERE id = ?
`);

export const listProjects = db.prepare(`
  SELECT * FROM projects ORDER BY created_at DESC
`);

export const updateProjectStatus = db.prepare(`
  UPDATE projects SET status = ? WHERE id = ?
`);

export const updateProjectCharDesc = db.prepare(`
  UPDATE projects SET character_description = ? WHERE id = ?
`);

export const createScene = db.prepare(`
  INSERT INTO scenes (id, project_id, scene_number, description, image_prompt, subtitle_text, video_prompt, scene_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export const getScenesByProject = db.prepare(`
  SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number
`);

export const getScene = db.prepare(`
  SELECT * FROM scenes WHERE id = ?
`);

export const updateSceneImage = db.prepare(`
  UPDATE scenes SET image_path = ?, status = ?, error_message = NULL WHERE id = ?
`);

export const updateSceneError = db.prepare(`
  UPDATE scenes SET status = 'error', error_message = ? WHERE id = ?
`);

export const updateSceneStatus = db.prepare(`
  UPDATE scenes SET status = ? WHERE id = ?
`);

export const updateScenePrompt = db.prepare(`
  UPDATE scenes SET image_prompt = ? WHERE id = ?
`);

export const updateSceneVideoPrompt = db.prepare(`
  UPDATE scenes SET video_prompt = ? WHERE id = ?
`);

export const updateSceneVideo = db.prepare(`
  UPDATE scenes SET video_path = ?, video_status = ?, video_error = NULL WHERE id = ?
`);

export const updateSceneVideoError = db.prepare(`
  UPDATE scenes SET video_status = 'error', video_error = ? WHERE id = ?
`);

export const updateProjectVideo = db.prepare(`
  UPDATE projects SET final_video_path = ? WHERE id = ?
`);

export const updateSceneLastFrame = db.prepare(`
  UPDATE scenes SET last_frame_path = ? WHERE id = ?
`);

export const updateProjectVoiceIds = db.prepare(`
  UPDATE projects SET voice_ids = ? WHERE id = ?
`);

export const resetSceneVideos = db.prepare(`
  UPDATE scenes SET video_path = NULL, video_status = 'pending', video_error = NULL WHERE project_id = ? AND video_status != 'done'
`);

export const deleteScenesByProject = db.prepare(`
  DELETE FROM scenes WHERE project_id = ?
`);

export const deleteProject = db.prepare(`
  DELETE FROM projects WHERE id = ?
`);

export default db;
