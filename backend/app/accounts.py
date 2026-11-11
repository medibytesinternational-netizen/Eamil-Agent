"""Gmail accounts: connect into a per-account local store, disconnect, switch, delete.

Each Gmail account has its own SQLite file (see db.py). Connecting picks the store by the address Google
actually returns, so data from different accounts never mixes.
"""
import asyncio
import logging
import secrets
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from google.oauth2.credentials import Credentials
from pydantic import BaseModel

from . import db
from . import gmail_client as gmail
from . import poller
from .db import SessionLocal
from .google_auth import (decrypt, reset_cache, revoke, run_consent_flow, save_credentials, use_credentials,
                          web_flow, web_mode)
from .models import Profile
from .profile import get_profile, get_user, refresh_cache

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")
_connecting = asyncio.Lock()
_oauth_states: dict[str, float] = {}  # state -> created (CSRF protection for the web flow)
last_connect: dict = {}  # result of the most recent web-flow connect, read by the wizard


def _profile_fields(p: Profile | None) -> dict:
    keys = ("user_name", "user_email", "agent_name", "urgent_criteria", "important_criteria",
            "urgent_senders", "important_senders")
    return {k: getattr(p, k) for k in keys} if p else {}


async def reset_runtime() -> None:
    """Clear everything cached for the previous account."""
    reset_cache()
    poller.reset_state()
    from . import insights

    insights._cache.update(at=0.0, data=None)
    await refresh_cache()


async def complete_connect(creds: Credentials) -> dict:
    """After Google consent: open (or create) the store for the real Gmail address and save the token there."""
    if not creds.refresh_token:
        raise HTTPException(400, "Google didn't return a refresh token. Remove the app at "
                                 "myaccount.google.com/permissions and try again.")
    use_credentials(creds)
    email = ((await gmail.get_profile()).get("emailAddress") or "").strip().lower()
    if not email:
        raise HTTPException(400, "Couldn't read the Gmail address for this account")

    # Answers typed during setup live in the current (usually pending) store.
    async with SessionLocal() as s:
        typed = _profile_fields(await get_profile(s))
    existed = db.account_exists(email)

    await db.switch_account(email)
    async with SessionLocal() as s:
        p = await get_profile(s)
        if p is None and typed:
            s.add(Profile(**typed))
            await s.commit()
    await save_credentials(creds, email)
    await reset_runtime()
    use_credentials(creds)

    async with SessionLocal() as s:
        p = await get_profile(s)
        onboarded = bool(p and p.onboarded_at)
    typed_email = (typed.get("user_email") or "").lower()
    # Save the Gmail checkpoint now so the poller doesn't start a backfill on its own;
    # the wizard starts it after the user picks how much history to read (cost control).
    async with SessionLocal() as s:
        user = await get_user(s)
        if user and not user.last_history_id:
            user.last_history_id = str((await gmail.get_profile())["historyId"])
            await s.commit()
    return {"ok": True, "account": email, "returning": existed, "onboarded": onboarded,
            "typed_email": typed_email, "mismatch": bool(typed_email and typed_email != email)}


async def start_backfill(days: int = 14) -> None:
    async with SessionLocal() as s:
        user = await get_user(s)
        if user and not user.last_history_id:
            user.last_history_id = str((await gmail.get_profile())["historyId"])
            await s.commit()
    asyncio.create_task(poller.backfill(days=days))


# ---------- connect ----------

@router.get("/oauth/mode")
async def oauth_mode():
    return {"mode": "web" if web_mode() else "desktop"}


@router.post("/onboarding/connect")
async def connect_desktop():
    """Local runs: Google consent opens in a browser on this machine (installed-app loopback flow)."""
    if web_mode():
        raise HTTPException(400, "Use /api/oauth/start on hosted deployments")
    if _connecting.locked():
        raise HTTPException(409, "A Google sign-in window is already open")
    async with _connecting:
        async with SessionLocal() as s:
            p = await get_profile(s)
        try:
            creds = await asyncio.wait_for(
                asyncio.to_thread(run_consent_flow, p.user_email if p else None), timeout=300)
        except asyncio.TimeoutError:
            raise HTTPException(408, "Google sign-in timed out — try again")
        return await complete_connect(creds)


@router.get("/oauth/start")
async def oauth_start():
    """Hosted runs: redirect to Google; Google sends the user back to /api/oauth/callback."""
    if not web_mode():
        raise HTTPException(400, "Web OAuth isn't configured (GOOGLE_CLIENT_ID / SECRET / PUBLIC_URL)")
    now = time.time()
    for k, t in list(_oauth_states.items()):
        if now - t > 600:
            _oauth_states.pop(k, None)
    state = secrets.token_urlsafe(24)
    _oauth_states[state] = now
    async with SessionLocal() as s:
        p = await get_profile(s)
    url, _ = web_flow(state).authorization_url(
        access_type="offline", prompt="consent", include_granted_scopes="true",
        login_hint=(p.user_email if p and p.user_email else None))
    return RedirectResponse(url)


@router.get("/oauth/callback")
async def oauth_callback(request: Request, state: str = "", code: str = "", error: str = ""):
    last_connect.clear()
    if error or not code or _oauth_states.pop(state, None) is None:
        last_connect.update(ok=False, error=error or "Sign-in was cancelled or expired — try again")
        return RedirectResponse("/?connect=error")
    try:
        flow = web_flow(state)
        await asyncio.to_thread(flow.fetch_token, code=code)
        last_connect.update(await complete_connect(flow.credentials))
    except HTTPException as e:
        last_connect.update(ok=False, error=e.detail)
    except Exception as e:  # noqa: BLE001
        log.exception("oauth callback failed")
        last_connect.update(ok=False, error=f"Google sign-in failed: {type(e).__name__}")
    return RedirectResponse("/?connect=" + ("ok" if last_connect.get("ok") else "error"))


@router.get("/oauth/result")
async def oauth_result():
    return last_connect or {"ok": False, "error": "No sign-in in progress"}


# ---------- manage accounts ----------

@router.get("/accounts")
async def accounts():
    return {"active": db.active_email(), "accounts": db.list_accounts()}


@router.post("/account/disconnect")
async def disconnect():
    """Revoke Google access and stop using this account. Its local data is kept for later."""
    email = db.active_email()
    if email:
        async with SessionLocal() as s:
            user = await get_user(s)
            if user and user.google_refresh_token:
                try:
                    await revoke(decrypt(user.google_refresh_token))
                except Exception:  # noqa: BLE001 — still clear locally
                    pass
                user.google_refresh_token = None
                user.last_history_id = None
                await s.commit()
    await db.reset_pending()
    await db.switch_account(None)
    await reset_runtime()
    return {"ok": True, "disconnected": email}


class SwitchIn(BaseModel):
    email: str


@router.post("/account/switch")
async def switch(body: SwitchIn):
    """Open another stored account. If its Google access was revoked, the user reconnects it."""
    email = body.email.strip().lower()
    if not db.account_exists(email):
        raise HTTPException(404, "No local data for that account")
    await db.switch_account(email)
    await reset_runtime()
    async with SessionLocal() as s:
        user = await get_user(s)
    return {"ok": True, "account": email, "needs_connect": not (user and user.google_refresh_token)}


class DeleteIn(BaseModel):
    confirm: str


@router.delete("/account/{email}")
async def delete(email: str, body: DeleteIn):
    """Permanently delete an account's local data. The address must be typed again to confirm."""
    email = email.strip().lower()
    if body.confirm.strip().lower() != email:
        raise HTTPException(400, "Type the email address exactly to confirm")
    try:
        if not db.delete_account(email):
            raise HTTPException(404, "No local data for that account")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}
