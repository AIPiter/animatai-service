from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    rabbitmq_url: str
    redis_url: str = "redis://redis:6379"
    database_url: str
    minio_url: str = "minio:9000"
    minio_user: str = "animatai"
    minio_pass: str = "animatai_secret"
    minio_bucket: str = "animatai"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
