FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

COPY pyproject.toml ./
RUN uv sync --no-dev

COPY app/ ./app/

ENV PYTHONUNBUFFERED=1
CMD ["uv", "run", "python", "-m", "app.main"]
