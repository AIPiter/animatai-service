CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id                    UUID PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT,
  scenario              TEXT NOT NULL,
  duration              INTEGER NOT NULL,
  scene_count           INTEGER,
  character_description TEXT,
  status                TEXT DEFAULT 'created',
  style                 TEXT DEFAULT 'anime',
  mode                  TEXT DEFAULT 'standard',
  voice_ids             TEXT,
  final_video_path      TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scenes (
  id                   UUID PRIMARY KEY,
  project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_number         INTEGER NOT NULL,
  description          TEXT,
  image_prompt         TEXT,
  subtitle_text        TEXT,
  image_path           TEXT,
  video_path           TEXT,
  last_frame_path      TEXT,
  status               TEXT DEFAULT 'pending',
  video_status         TEXT DEFAULT 'pending',
  error_message        TEXT,
  video_error          TEXT,
  video_prompt         TEXT,
  scene_type           TEXT DEFAULT 'main',
  clip_duration        INTEGER DEFAULT 5,
  fal_video_request_id TEXT,
  fal_video_model      TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scene_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id   UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  type       VARCHAR(10) NOT NULL CHECK (type IN ('image', 'video')),
  path       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code          TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_scenes_project_id ON scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_scene_history_scene_id ON scene_history(scene_id);
