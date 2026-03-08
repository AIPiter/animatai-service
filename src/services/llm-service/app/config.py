from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    rabbitmq_url: str
    redis_url: str = "redis://redis:6379"
    database_url: str

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
