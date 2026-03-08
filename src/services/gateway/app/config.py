from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    rabbitmq_url: str
    redis_url: str = "redis://redis:6379"
    jwt_secret: str
    jwt_access_ttl: int = 15 * 60          # 15 minutes
    jwt_refresh_ttl: int = 30 * 24 * 3600  # 30 days
    resend_api_key: str = ""
    from_email: str = "noreply@animatai.app"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
