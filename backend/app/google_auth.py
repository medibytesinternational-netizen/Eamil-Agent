"""Google OAuth for a Desktop (installed) client: loopback flow, encrypted refresh token."""

import asyncio

from cryptography.fernet import Fernet
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

from .config import GOOGLE_SCOPES, settings
from .db import SessionLocal
from .models import User
from .profile import get_user

_fernet = Fernet(settings.fernet_key.encode())
_cached: Credentials | None = None


class ReconnectRequired(Exception):
    """Refresh token missing, revoked, or expired (Testing-mode tokens last ~7 days)."""


def web_mode() -> bool:
    """Hosted deployments use a Web OAuth client with a redirect back to PUBLIC_URL."""
    return bool(settings.google_client_id and settings.google_client_secret and settings.public_url)


def redirect_uri() -> str:
    return settings.public_url.rstrip("/") + "/api/oauth/callback"


def _client_info() -> dict:
    import json

    if web_mode():
        return {"client_id": settings.google_client_id, "client_secret": settings.google_client_secret,
                "token_uri": "https://oauth2.googleapis.com/token"}
    return json.loads(settings.client_secret_path.read_text())["installed"]


def web_flow(state: str | None = None):
    from google_auth_oauthlib.flow import Flow

    cfg = {"web": {"client_id": settings.google_client_id, "client_secret": settings.google_client_secret,
                   "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                   "token_uri": "https://oauth2.googleapis.com/token", "redirect_uris": [redirect_uri()]}}
    return Flow.from_client_config(cfg, scopes=GOOGLE_SCOPES, state=state, redirect_uri=redirect_uri())


def reset_cache() -> None:
    """Forget the in-memory credentials (call when the active account changes)."""
    global _cached
    _cached = None


def use_credentials(creds: Credentials) -> None:
    global _cached
    _cached = creds


async def revoke(refresh_token: str) -> None:
    """Best-effort revoke at Google so the old account's access really ends."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post("https://oauth2.googleapis.com/revoke", data={"token": refresh_token})
    except Exception:  # noqa: BLE001 — revoking is best effort
        pass


def decrypt(token: str) -> str:
    return _fernet.decrypt(token.encode()).decode()


def run_consent_flow(login_hint: str | None = None) -> Credentials:
    """Opens the browser for consent. Blocking; run from the CLI or a thread."""
    flow = InstalledAppFlow.from_client_secrets_file(str(settings.client_secret_path), GOOGLE_SCOPES)
    return flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
        login_hint=login_hint or settings.gmail_account or None,
        open_browser=True,
    )


async def save_credentials(creds: Credentials, email: str | None = None) -> None:
    """Store the refresh token on the single owner row. `email` is the connected Gmail address."""
    async with SessionLocal() as s:
        user = await get_user(s)
        if user is None:
            user = User(email=email or settings.gmail_account, vip_senders=[], quiet_hours=settings.quiet_hours)
            s.add(user)
        elif email:
            user.email = email
        user.google_refresh_token = _fernet.encrypt(creds.refresh_token.encode()).decode()
        user.needs_reconnect = False
        await s.commit()
    global _cached
    _cached = creds


async def _mark_reconnect() -> None:
    async with SessionLocal() as s:
        user = await get_user(s)
        if user:
            user.needs_reconnect = True
            await s.commit()


async def get_credentials() -> Credentials:
    """Valid credentials with a fresh access token (refreshed when needed)."""
    global _cached
    if _cached is None:
        async with SessionLocal() as s:
            user = await get_user(s)
        if not user or not user.google_refresh_token:
            raise ReconnectRequired("Gmail not connected")
        info = _client_info()
        _cached = Credentials(
            token=None,
            refresh_token=_fernet.decrypt(user.google_refresh_token.encode()).decode(),
            token_uri=info["token_uri"],
            client_id=info["client_id"],
            client_secret=info["client_secret"],
            scopes=GOOGLE_SCOPES,
        )
    if not _cached.valid:
        try:
            await asyncio.to_thread(_cached.refresh, Request())
        except RefreshError as e:
            _cached = None
            await _mark_reconnect()
            raise ReconnectRequired(str(e)) from e
    return _cached


async def get_access_token() -> str:
    return (await get_credentials()).token
