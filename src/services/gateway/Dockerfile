FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# Install dependencies (cached layer)
COPY pyproject.toml ./
RUN uv sync --no-dev

# Copy application code
COPY app/ ./app/

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
