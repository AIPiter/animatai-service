import asyncpg
from .config import settings

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(settings.database_url, min_size=2, max_size=10)
    return _pool


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


# ── Users ────────────────────────────────────────────────────────────────────

async def create_user(email: str, username: str, password_hash: str) -> dict:
    pool = await get_pool()
    row = await pool.fetchrow(
        "INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING *",
        email, username, password_hash,
    )
    return dict(row)


async def get_user_by_email(email: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT * FROM users WHERE email = $1", email)
    return dict(row) if row else None


async def get_user_by_id(user_id: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
    return dict(row) if row else None


# ── Refresh tokens ────────────────────────────────────────────────────────────

async def create_refresh_token(user_id: str, token_hash: str, expires_at) -> dict:
    pool = await get_pool()
    row = await pool.fetchrow(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING *",
        user_id, token_hash, expires_at,
    )
    return dict(row)


async def get_refresh_token(token_hash: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()",
        token_hash,
    )
    return dict(row) if row else None


async def delete_refresh_token(token_hash: str):
    pool = await get_pool()
    await pool.execute("DELETE FROM refresh_tokens WHERE token_hash = $1", token_hash)


async def delete_user_refresh_tokens(user_id: str):
    pool = await get_pool()
    await pool.execute("DELETE FROM refresh_tokens WHERE user_id = $1", user_id)


# ── Email verifications ───────────────────────────────────────────────────────

async def upsert_email_verification(email: str, username: str, password_hash: str, code: str, expires_at):
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO email_verifications (email, username, password_hash, code, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO UPDATE SET
          username      = EXCLUDED.username,
          password_hash = EXCLUDED.password_hash,
          code          = EXCLUDED.code,
          expires_at    = EXCLUDED.expires_at,
          attempts      = 0,
          created_at    = NOW()
        """,
        email, username, password_hash, code, expires_at,
    )


async def get_email_verification(email: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM email_verifications WHERE email = $1 AND expires_at > NOW()", email
    )
    return dict(row) if row else None


async def increment_verification_attempts(email: str):
    pool = await get_pool()
    await pool.execute(
        "UPDATE email_verifications SET attempts = attempts + 1 WHERE email = $1", email
    )


async def delete_email_verification(email: str):
    pool = await get_pool()
    await pool.execute("DELETE FROM email_verifications WHERE email = $1", email)


# ── Projects ──────────────────────────────────────────────────────────────────

async def create_project(
    project_id: str, user_id: str, scenario: str, duration: int,
    char_desc: str | None, status: str, style: str, mode: str, scene_count: int | None,
):
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO projects (id, user_id, scenario, duration, character_description,
                              status, style, mode, scene_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        project_id, user_id, scenario, duration, char_desc, status, style, mode, scene_count,
    )


async def get_project(project_id: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT * FROM projects WHERE id = $1", project_id)
    return dict(row) if row else None


async def list_projects(user_id: str) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC", user_id
    )
    return [dict(r) for r in rows]


async def update_project_status(status: str, project_id: str):
    pool = await get_pool()
    await pool.execute("UPDATE projects SET status = $1 WHERE id = $2", status, project_id)


async def update_project_name(name: str, project_id: str):
    pool = await get_pool()
    await pool.execute("UPDATE projects SET name = $1 WHERE id = $2", name, project_id)


async def update_project_video(final_path: str, project_id: str):
    pool = await get_pool()
    await pool.execute("UPDATE projects SET final_video_path = $1 WHERE id = $2", final_path, project_id)


async def delete_project(project_id: str):
    pool = await get_pool()
    await pool.execute("DELETE FROM projects WHERE id = $1", project_id)


# ── Scenes ────────────────────────────────────────────────────────────────────

async def create_scene(
    scene_id: str, project_id: str, scene_number: int, description: str,
    image_prompt: str | None, subtitle_text: str | None,
    video_prompt: str | None, scene_type: str,
):
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO scenes (id, project_id, scene_number, description, image_prompt,
                            subtitle_text, video_prompt, scene_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        scene_id, project_id, scene_number, description,
        image_prompt, subtitle_text, video_prompt, scene_type,
    )


async def get_scenes_by_project(project_id: str) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT * FROM scenes WHERE project_id = $1 ORDER BY scene_number", project_id
    )
    return [dict(r) for r in rows]


async def get_scene(scene_id: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT * FROM scenes WHERE id = $1", scene_id)
    return dict(row) if row else None


async def update_scene_status(status: str, scene_id: str):
    pool = await get_pool()
    await pool.execute("UPDATE scenes SET status = $1 WHERE id = $2", status, scene_id)


async def update_scene_prompt(prompt: str, scene_id: str):
    pool = await get_pool()
    await pool.execute("UPDATE scenes SET image_prompt = $1 WHERE id = $2", prompt, scene_id)


async def update_scene_video_prompt(video_prompt: str, scene_id: str):
    pool = await get_pool()
    await pool.execute("UPDATE scenes SET video_prompt = $1 WHERE id = $2", video_prompt, scene_id)


async def get_scene_history(scene_id: str, type_filter: str | None = None) -> list[dict]:
    pool = await get_pool()
    if type_filter:
        rows = await pool.fetch(
            "SELECT * FROM scene_history WHERE scene_id = $1 AND type = $2 ORDER BY created_at DESC",
            scene_id, type_filter,
        )
    else:
        rows = await pool.fetch(
            "SELECT * FROM scene_history WHERE scene_id = $1 ORDER BY created_at DESC", scene_id
        )
    return [dict(r) for r in rows]
