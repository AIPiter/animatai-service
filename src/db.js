import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ===== Migrations =====

export async function runMigrations() {
  try { await pool.query('ALTER TABLE projects ADD COLUMN scene_count INTEGER'); } catch {}
  try { await pool.query('ALTER TABLE scenes ADD COLUMN clip_duration INTEGER DEFAULT 5'); } catch {}
  try { await pool.query('ALTER TABLE scenes ADD COLUMN fal_video_request_id TEXT'); } catch {}
  try { await pool.query('ALTER TABLE scenes ADD COLUMN fal_video_model TEXT'); } catch {}
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scene_history (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scene_id   UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        type       VARCHAR(10) NOT NULL CHECK (type IN ('image', 'video')),
        path       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_scene_history_scene_id ON scene_history(scene_id)');
  } catch {}
}

export async function resetOrphanedGeneratingScenes() {
  await pool.query(
    "UPDATE scenes SET video_status = 'pending' WHERE video_status IN ('generating', 'queued') AND fal_video_request_id IS NULL"
  );
}

// ===== Users =====

export async function createUser(email, username, passwordHash) {
  const result = await pool.query(
    'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING *',
    [email, username, passwordHash]
  );
  return result.rows[0];
}

export async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

export async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// ===== Refresh tokens =====

export async function createRefreshToken(userId, tokenHash, expiresAt) {
  const result = await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING *',
    [userId, tokenHash, expiresAt]
  );
  return result.rows[0];
}

export async function getRefreshToken(tokenHash) {
  const result = await pool.query(
    'SELECT * FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()',
    [tokenHash]
  );
  return result.rows[0] || null;
}

export async function deleteRefreshToken(tokenHash) {
  await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
}

export async function deleteUserRefreshTokens(userId) {
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}

// ===== Email verifications =====

export async function upsertEmailVerification(email, username, passwordHash, code, expiresAt) {
  await pool.query(
    `INSERT INTO email_verifications (email, username, password_hash, code, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       username      = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       code          = EXCLUDED.code,
       expires_at    = EXCLUDED.expires_at,
       attempts      = 0,
       created_at    = NOW()`,
    [email, username, passwordHash, code, expiresAt]
  );
}

export async function getEmailVerification(email) {
  const result = await pool.query(
    'SELECT * FROM email_verifications WHERE email = $1 AND expires_at > NOW()',
    [email]
  );
  return result.rows[0] || null;
}

export async function incrementVerificationAttempts(email) {
  await pool.query(
    'UPDATE email_verifications SET attempts = attempts + 1 WHERE email = $1',
    [email]
  );
}

export async function deleteEmailVerification(email) {
  await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);
}

// ===== Projects =====

export async function createProject(id, userId, scenario, duration, characterDescription, status, style, mode, sceneCount) {
  await pool.query(
    'INSERT INTO projects (id, user_id, scenario, duration, character_description, status, style, mode, scene_count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, userId, scenario, duration, characterDescription, status, style, mode, sceneCount || null]
  );
}

export async function getProject(id) {
  const result = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function listProjects(userId) {
  const result = await pool.query(
    'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

export async function getProjectsByModes(modes) {
  const placeholders = modes.map((_, i) => `$${i + 1}`).join(', ');
  const result = await pool.query(
    `SELECT * FROM projects WHERE mode IN (${placeholders})`,
    modes
  );
  return result.rows;
}

export async function updateProjectName(name, id) {
  await pool.query('UPDATE projects SET name = $1 WHERE id = $2', [name, id]);
}

export async function updateProjectStatus(status, id) {
  await pool.query('UPDATE projects SET status = $1 WHERE id = $2', [status, id]);
}

export async function updateProjectCharDesc(charDesc, id) {
  await pool.query('UPDATE projects SET character_description = $1 WHERE id = $2', [charDesc, id]);
}

export async function updateProjectVideo(finalPath, id) {
  await pool.query('UPDATE projects SET final_video_path = $1 WHERE id = $2', [finalPath, id]);
}

export async function updateProjectVoiceIds(voiceIds, id) {
  await pool.query('UPDATE projects SET voice_ids = $1 WHERE id = $2', [voiceIds, id]);
}

export async function deleteProject(id) {
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}

// ===== Scenes =====

export async function createScene(id, projectId, sceneNumber, description, imagePrompt, subtitleText, videoPrompt, sceneType) {
  await pool.query(
    'INSERT INTO scenes (id, project_id, scene_number, description, image_prompt, subtitle_text, video_prompt, scene_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, projectId, sceneNumber, description, imagePrompt, subtitleText, videoPrompt, sceneType]
  );
}

export async function getScenesByProject(projectId) {
  const result = await pool.query(
    'SELECT * FROM scenes WHERE project_id = $1 ORDER BY scene_number',
    [projectId]
  );
  return result.rows;
}

export async function getScene(id) {
  const result = await pool.query('SELECT * FROM scenes WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function updateSceneImage(imagePath, status, id) {
  await pool.query(
    'UPDATE scenes SET image_path = $1, status = $2, error_message = NULL WHERE id = $3',
    [imagePath, status, id]
  );
}

export async function updateSceneError(errorMsg, id) {
  await pool.query(
    "UPDATE scenes SET status = 'error', error_message = $1 WHERE id = $2",
    [errorMsg, id]
  );
}

export async function updateSceneStatus(status, id) {
  await pool.query('UPDATE scenes SET status = $1 WHERE id = $2', [status, id]);
}

export async function updateScenePrompt(prompt, id) {
  await pool.query('UPDATE scenes SET image_prompt = $1 WHERE id = $2', [prompt, id]);
}

export async function updateSceneVideoPrompt(videoPrompt, id) {
  await pool.query('UPDATE scenes SET video_prompt = $1 WHERE id = $2', [videoPrompt, id]);
}

export async function updateSceneVideo(videoPath, videoStatus, id) {
  await pool.query(
    'UPDATE scenes SET video_path = $1, video_status = $2, video_error = NULL WHERE id = $3',
    [videoPath, videoStatus, id]
  );
}

export async function updateSceneVideoError(errorMsg, id) {
  await pool.query(
    "UPDATE scenes SET video_status = 'error', video_error = $1 WHERE id = $2",
    [errorMsg, id]
  );
}

export async function updateSceneVideoStatus(status, id) {
  await pool.query('UPDATE scenes SET video_status = $1 WHERE id = $2', [status, id]);
}

export async function updateSceneLastFrame(lastFramePath, id) {
  await pool.query('UPDATE scenes SET last_frame_path = $1 WHERE id = $2', [lastFramePath, id]);
}

export async function updateSceneClipDuration(duration, id) {
  await pool.query('UPDATE scenes SET clip_duration = $1 WHERE id = $2', [duration, id]);
}

export async function setSceneFalRequest(requestId, model, id) {
  await pool.query(
    'UPDATE scenes SET fal_video_request_id = $1, fal_video_model = $2 WHERE id = $3',
    [requestId, model, id]
  );
}

export async function clearSceneFalRequest(id) {
  await pool.query(
    'UPDATE scenes SET fal_video_request_id = NULL, fal_video_model = NULL WHERE id = $1',
    [id]
  );
}

export async function getScenesPendingRecovery() {
  const result = await pool.query(
    "SELECT * FROM scenes WHERE video_status IN ('generating', 'queued') AND fal_video_request_id IS NOT NULL"
  );
  return result.rows;
}

export async function deleteScenesByProject(projectId) {
  await pool.query('DELETE FROM scenes WHERE project_id = $1', [projectId]);
}

// ===== Scene History =====

export async function addSceneHistory(sceneId, type, filePath) {
  await pool.query(
    'INSERT INTO scene_history (scene_id, type, path) VALUES ($1, $2, $3)',
    [sceneId, type, filePath]
  );
}

export async function getSceneHistory(sceneId, type) {
  if (type) {
    const result = await pool.query(
      'SELECT * FROM scene_history WHERE scene_id = $1 AND type = $2 ORDER BY created_at DESC',
      [sceneId, type]
    );
    return result.rows;
  }
  const result = await pool.query(
    'SELECT * FROM scene_history WHERE scene_id = $1 ORDER BY created_at DESC',
    [sceneId]
  );
  return result.rows;
}

export async function pruneSceneHistory(sceneId, type, maxKeep = 2) {
  const result = await pool.query(
    'SELECT id, path FROM scene_history WHERE scene_id = $1 AND type = $2 ORDER BY created_at DESC',
    [sceneId, type]
  );
  const rows = result.rows;
  if (rows.length <= maxKeep) return [];
  const toDelete = rows.slice(maxKeep);
  const ids = toDelete.map(r => r.id);
  await pool.query('DELETE FROM scene_history WHERE id = ANY($1)', [ids]);
  return toDelete.map(r => r.path);
}

export async function getSceneHistoryItem(historyId) {
  const result = await pool.query('SELECT * FROM scene_history WHERE id = $1', [historyId]);
  return result.rows[0] || null;
}

export async function deleteSceneHistory(sceneId) {
  const result = await pool.query(
    'DELETE FROM scene_history WHERE scene_id = $1 RETURNING path',
    [sceneId]
  );
  return result.rows.map(r => r.path);
}

export async function deleteProjectSceneHistory(projectId) {
  const result = await pool.query(
    'DELETE FROM scene_history WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = $1) RETURNING path',
    [projectId]
  );
  return result.rows.map(r => r.path);
}

export async function deleteHistoryItem(historyId) {
  await pool.query('DELETE FROM scene_history WHERE id = $1', [historyId]);
}

export default pool;
