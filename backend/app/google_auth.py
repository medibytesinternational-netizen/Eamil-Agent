"""Google OAuth for a Desktop (installed) client: loopback flow, encrypted refresh token."""

import asyncio

from cryptography.fernet import Fernet
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from sqlalchemy import select

from .config import GOOGLE_SCOPES, settings
from .db import SessionLocal
from .models import User

_fernet = Fernet(settings.fernet_key.encode())
_cached: Credentials | None = None


class ReconnectRequired(Exception):
    """Refresh token missing, revoked, or expired (Testing-mode tokens last ~7 days)."""


def _client_info() -> dict:
    import json

    return json.loads(settings.client_secret_path.read_text())["installed"]


def run_consent_flow() -> Credentials:
    """Opens the browser for consent. Blocking; run from the CLI or a thread."""
    flow = InstalledAppFlow.from_client_secrets_file(str(settings.client_secret_path), GOOGLE_SCOPES)
    return flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
        login_hint=settings.gmail_account,
        open_browser=True,
    )


async def save_credentials(creds: Credentials) -> None:
    async with SessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one_or_none()
        if user is None:
            user = User(email=settings.gmail_account, vip_senders=[], quiet_hours=settings.quiet_hours)
            s.add(user)
        user.google_refresh_token = _fernet.encrypt(creds.refresh_token.encode()).decode()
        user.needs_reconnect = False
        await s.commit()
    global _cached
    _cached = creds


async def _mark_reconnect() -> None:
    async with SessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one_or_none()
        if user:
            user.needs_reconnect = True
            await s.commit()


async def get_credentials() -> Credentials:
    """Valid credentials with a fresh access token (refreshed when needed)."""
    global _cached
    if _cached is None:
        async with SessionLocal() as s:
            user = (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one_or_none()
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
