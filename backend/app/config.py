from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    openai_api_key: str = ""
    thesys_api_key: str = ""  # OpenUI AI Gateway, used for typed chat when set
    gmail_account: str
    google_client_secret_file: str = "../secrets/client_secret.json"
    database_url: str = "sqlite+aiosqlite:///./agent.db"
    realtime_model: str = "gpt-realtime-2.1-mini"
    timezone: str = "Asia/Kolkata"
    quiet_hours: str = "23:00-07:00"
    fernet_key: str
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""
    app_password: str = "change-me"

    @property
    def client_secret_path(self) -> Path:
        return (BACKEND / self.google_client_secret_file).resolve()

    @property
    def db_url(self) -> str:
        # Resolve relative sqlite paths against backend/ so cwd doesn't matter.
        prefix = "sqlite+aiosqlite:///./"
        if self.database_url.startswith(prefix):
            return f"sqlite+aiosqlite:///{(BACKEND / self.database_url[len(prefix):]).as_posix()}"
        return self.database_url


settings = Settings()

# Least privilege: no gmail.send, ever.
GOOGLE_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
]
GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1"
