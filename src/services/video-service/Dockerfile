FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# ffmpeg required for last-frame extraction and stitching
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN uv sync --no-dev

COPY app/ ./app/

ENV PYTHONUNBUFFERED=1
CMD ["uv", "run", "python", "-m", "app.main"]
