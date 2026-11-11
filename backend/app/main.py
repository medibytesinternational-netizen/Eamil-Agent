from pathlib import Path
import asyncio
import hashlib
import hmac
import json
import logging

from openai import APIError
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import func, select
from sse_starlette.sse import EventSourceResponse

from . import poller
from .accounts import router as accounts_router
from .db import active_email
from .google_auth import web_mode
from .onboarding import profile_json, router as onboarding_router
from .profile import cached, cached_names, get_user, refresh_cache
from .openui import chat_instructions, reply_format
from .alerts import in_quiet_hours, send_push
from .config import ROOT, settings
from .db import SessionLocal, init_db
from .events import publish, stream
from .google_auth import ReconnectRequired
from .models import Alert, Draft, Email, PushSubscription, Rule, User, VoiceSession
from .tools import chat_tools, dumps, instructions, realtime_tools, run_tool
from .triage import chat_client, client as openai_client

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("agent.chat")
CHAT_MODEL = "gpt-5.4-mini"
GATEWAY_CHAT_MODEL = "openai/gpt-5.4-mini"  # gateway ids are {author}/{model}
COOKIE = "agent_session"
SESSION_TTL = 30 * 24 * 3600


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.login_required and settings.app_password in ("", "change-me"):
        raise RuntimeError("Set APP_PASSWORD before hosting this app: it has access to your email.")
    _check_data_dir()
    await init_db()
    await refresh_cache()
    sched = poller.start_scheduler()
    yield
    sched.shutdown(wait=False)


app = FastAPI(title="Personal Email Agent", lifespan=lifespan)
app.include_router(onboarding_router)
app.include_router(accounts_router)


def _check_data_dir() -> None:
    d = settings.data_path
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / ".write-test").write_text("ok")
        (d / ".write-test").unlink()
    except OSError as e:
        raise RuntimeError(f"DATA_DIR {d} is not writable: {e}") from e
    if settings.railway_environment and not str(d).startswith("/data"):
        log.warning("DATA_DIR=%s is not a Railway Volume path; data will be LOST on every deploy. "
                    "Attach a Volume at /data and set DATA_DIR=/data.", d)


# ---------- auth (single user, app password) ----------

def _sign(ts: str) -> str:
    return hmac.new(settings.fernet_key.encode(), ts.encode(), hashlib.sha256).hexdigest()


def _valid_cookie(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    ts, sig = value.split(".", 1)
    return hmac.compare_digest(sig, _sign(ts)) and ts.isdigit() and time.time() - int(ts) < SESSION_TTL


# Login is required when hosted (Railway) or REQUIRE_LOGIN=true. Locally it stays off by choice.
_OPEN = {"/api/login", "/api/me", "/api/logout"}
_fails: dict[str, list[float]] = {}


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if settings.login_required and path.startswith("/api/") and path not in _OPEN:
        if not _valid_cookie(request.cookies.get(COOKIE)):
            return JSONResponse({"detail": "login required"}, status_code=401)
    return await call_next(request)


class Login(BaseModel):
    password: str


@app.post("/api/login")
async def login(body: Login, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    recent = [t for t in _fails.get(ip, []) if time.time() - t < 600]
    if len(recent) >= 5:
        raise HTTPException(429, "Too many attempts — wait 10 minutes")
    if not hmac.compare_digest(body.password.encode(), settings.app_password.encode()):
        _fails[ip] = recent + [time.time()]
        raise HTTPException(401, "Wrong password")
    _fails.pop(ip, None)
    ts = str(int(time.time()))
    # Lax (not Strict) so the cookie survives the redirect back from Google sign-in.
    response.set_cookie(COOKIE, f"{ts}.{_sign(ts)}", httponly=True, samesite="lax", max_age=SESSION_TTL,
                        secure=request.url.scheme == "https" or bool(settings.railway_environment))
    return {"ok": True}


@app.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
async def me(request: Request):
    logged_in = not settings.login_required or _valid_cookie(request.cookies.get(COOKIE))
    if not logged_in:
        return {"logged_in": False, "login_required": True, "onboarded": False, "profile": None}
    p, _ = cached()
    user = await _user()
    connected = bool(user and user.google_refresh_token and not user.needs_reconnect)
    return {"logged_in": True, "login_required": settings.login_required, "onboarded": bool(p and p.onboarded_at),
            "connected": connected,
            "profile": profile_json(p), "account": active_email(), "oauth_mode": "web" if web_mode() else "desktop"}


def final_text(r) -> str:
    """The model's last message only. `output_text` joins every message item, which can repeat a reply."""
    msgs = [o for o in r.output if getattr(o, "type", "") == "message"]
    if not msgs:
        return r.output_text
    parts = [c.text for c in (msgs[-1].content or []) if getattr(c, "type", "") == "output_text"]
    return "".join(parts) or r.output_text


class RecheckIn(BaseModel):
    days: int = 14


@app.post("/api/recheck")
async def recheck(body: RecheckIn | None = None):
    """Re-classify stored mail from the last N days with the current urgent/important rules."""
    user = await _user()
    if not user or not user.google_refresh_token:
        raise HTTPException(400, "Connect Gmail first")
    if poller.state.get("recheck"):
        raise HTTPException(409, "A re-check is already running")
    asyncio.create_task(poller.recheck(max(1, min(body.days if body else 14, 14))))
    return {"ok": True}


# ---------- status & dashboard ----------

async def _user() -> User | None:
    async with SessionLocal() as s:
        return await get_user(s)


@app.get("/api/health")
async def health():
    user = await _user()
    return {
        "ok": True,
        "gmail_connected": bool(user and user.google_refresh_token and not user.needs_reconnect),
        "account": user.email if user else cached()[1],
        "agent_name": cached_names()[0],
        "user_name": cached_names()[1],
        "quiet_hours": user.quiet_hours if user else settings.quiet_hours,
        "quiet_now": in_quiet_hours(user.quiet_hours if user else settings.quiet_hours),
        "backfill": poller.state["backfill"],
        "recheck": poller.state.get("recheck"),
        "last_poll": poller.state["last_poll"],
        "last_error": poller.state["last_error"],
        "vapid_public_key": settings.vapid_public_key,
    }


@app.get("/api/dashboard")
async def dashboard():
    since = datetime.now(timezone.utc) - timedelta(days=1)
    async with SessionLocal() as s:
        alerts = (await s.execute(
            select(Alert, Email).join(Email, Alert.gmail_id == Email.gmail_id)
            .where(Alert.status.in_(["sent", "opened"])).order_by(Email.received_at.desc())
        )).all()
        drafts = (await s.execute(
            select(Draft).where(Draft.status == "awaiting_review").order_by(Draft.created_at.desc())
        )).scalars().all()
        needs_reply = (await s.execute(
            select(Email).where(Email.needs_reply.is_(True), Email.received_at >= since - timedelta(days=6))
            .order_by(Email.received_at.desc()).limit(20)
        )).scalars().all()
        important = (await s.execute(
            select(Email).where(Email.important.is_(True), Email.received_at >= since - timedelta(days=13))
            .order_by(Email.received_at.desc()).limit(20)
        )).scalars().all()
        processed = await s.scalar(select(func.count()).select_from(Email).where(Email.received_at >= since))
        total = await s.scalar(select(func.count()).select_from(Email))
    return {
        "counts": {"urgent": len(alerts), "needs_reply": len(needs_reply), "important": len(important), "drafts": len(drafts),
                   "processed_today": processed or 0, "total": total or 0},
        "urgent": [{
            "id": a.id, "thread_id": a.thread_id, "category": e.category, "sender": e.sender,
            "summary": e.summary or e.subject, "reason": a.reason, "received_at": e.received_at.isoformat(),
            "due_date": e.due_date.isoformat() if e.due_date else None, "amount": e.amount,
        } for a, e in alerts],
        "needs_reply": [{
            "thread_id": e.thread_id, "sender": e.sender, "summary": e.summary or e.subject,
            "received_at": e.received_at.isoformat(),
        } for e in needs_reply],
        "important": [{
            "thread_id": e.thread_id, "sender": e.sender, "summary": e.summary or e.subject,
            "category": e.category, "received_at": e.received_at.isoformat(),
        } for e in important],
        "drafts": [{"draft_id": d.draft_id, "thread_id": d.thread_id, "to": d.to, "subject": d.subject,
                    "snippet": d.snippet} for d in drafts],
    }


@app.get("/api/stats")
async def get_stats(range: str = "7d"):
    from .insights import stats

    return await stats("today" if range == "today" else "7d")


@app.get("/api/insight")
async def get_insight(refresh: bool = False):
    from .insights import insight

    return await insight(force=refresh)


@app.get("/api/events")
async def events():
    return EventSourceResponse(stream())


@app.post("/api/poll")
async def poll_now():
    return {"new": await poller.poll_once()}


# ---------- alerts feedback & drafts ----------

class Feedback(BaseModel):
    action: str  # handled | not_urgent | always_alert


def _sender_addr(sender: str) -> str:
    from email.utils import parseaddr
    return parseaddr(sender)[1].lower() or sender.lower()


@app.post("/api/alerts/{alert_id}/feedback")
async def alert_feedback(alert_id: int, body: Feedback):
    if body.action not in ("handled", "not_urgent", "always_alert"):
        raise HTTPException(400, "bad action")
    async with SessionLocal() as s:
        alert = await s.get(Alert, alert_id)
        if not alert:
            raise HTTPException(404)
        email = await s.get(Email, alert.gmail_id)
        alert.user_feedback = body.action
        if body.action == "handled":
            alert.status = "handled"
        elif body.action == "not_urgent":
            alert.status = "dismissed"
            s.add(Rule(pattern=_sender_addr(email.sender), action="never_alert", created_from_feedback=True))
        else:
            s.add(Rule(pattern=_sender_addr(email.sender), action="always_alert", created_from_feedback=True))
        await s.commit()
    publish("alert", {})
    return {"ok": True}


@app.post("/api/drafts/{draft_id}/discard")
async def discard_draft(draft_id: str):
    from . import gmail_client as gmail
    from googleapiclient.errors import HttpError

    try:
        await gmail.delete_draft(draft_id)
    except HttpError as e:
        if e.resp.status != 404:
            raise
    async with SessionLocal() as s:
        d = await s.get(Draft, draft_id)
        if d:
            d.status = "discarded"
            await s.commit()
    publish("drafts", {})
    return {"ok": True}


# ---------- settings ----------

class SettingsIn(BaseModel):
    quiet_hours: str | None = None
    vip_senders: list[str] | None = None


@app.get("/api/settings")
async def get_settings():
    user = await _user()
    async with SessionLocal() as s:
        rules = (await s.execute(select(Rule))).scalars().all()
    return {"quiet_hours": user.quiet_hours if user else None, "vip_senders": user.vip_senders if user else [],
            "rules": [{"id": r.id, "pattern": r.pattern, "action": r.action} for r in rules]}


@app.put("/api/settings")
async def put_settings(body: SettingsIn):
    async with SessionLocal() as s:
        user = await get_user(s)
        if user is None:
            raise HTTPException(400, "Connect Gmail first")
        if body.quiet_hours is not None:
            in_quiet_hours(body.quiet_hours)  # validates format
            user.quiet_hours = body.quiet_hours
        if body.vip_senders is not None:
            user.vip_senders = [v.strip().lower() for v in body.vip_senders if v.strip()]
        await s.commit()
    return await get_settings()


@app.delete("/api/rules/{rule_id}")
async def delete_rule(rule_id: int):
    async with SessionLocal() as s:
        r = await s.get(Rule, rule_id)
        if r:
            await s.delete(r)
            await s.commit()
    return {"ok": True}


# ---------- web push ----------

class PushSub(BaseModel):
    endpoint: str
    keys: dict


@app.post("/api/push/subscribe")
async def push_subscribe(sub: PushSub):
    async with SessionLocal() as s:
        await s.merge(PushSubscription(endpoint=sub.endpoint, keys=sub.keys))
        await s.commit()
    return {"ok": True}


@app.post("/api/push/test")
async def push_test():
    n = await send_push({"title": cached_names()[0], "body": "Test notification — alerts are working.", "url": "/"})
    return {"sent": n}


# ---------- tools, chat, voice ----------

class ToolCall(BaseModel):
    arguments: dict | str = {}
    user_text: str = ""


@app.post("/api/tool/{name}")
async def tool(name: str, body: ToolCall):
    args = json.loads(body.arguments) if isinstance(body.arguments, str) else body.arguments
    try:
        return await run_tool(name, args or {}, body.user_text)
    except ReconnectRequired:
        return {"ok": False, "error": "Gmail needs reconnecting"}
    except Exception as e:
        logging.exception("tool %s failed", name)
        return {"ok": False, "error": str(e)[:300]}


class ChatIn(BaseModel):
    message: str
    history: list[dict] = []  # [{role: user|assistant, text}] from the shared thread (voice + typed)


@app.post("/api/chat")
async def chat(body: ChatIn):
    history = [
        {"role": "assistant" if h.get("role") in ("agent", "assistant") else "user", "content": str(h.get("text", ""))[:4000]}
        for h in body.history[-12:] if h.get("text")
    ]
    inputs: list = [*history, {"role": "user", "content": body.message}]
    user_text = " ".join(h["content"] for h in history if h["role"] == "user")[-3000:] + " " + body.message
    used: list[str] = []
    llm, via_gateway = chat_client()
    model = GATEWAY_CHAT_MODEL if via_gateway else CHAT_MODEL
    for _ in range(6):
        try:
            r = await llm.responses.create(
                model=model, instructions=chat_instructions(instructions()), input=inputs, tools=chat_tools(),
            )
        except APIError as e:
            if not via_gateway:
                raise
            # Gateway unavailable (e.g. no balance): fall back to OpenAI directly for the rest of this chat.
            log.warning("gateway failed (%s); falling back to OpenAI", getattr(e, "status_code", type(e).__name__))
            llm, via_gateway, model = openai_client(), False, CHAT_MODEL
            r = await llm.responses.create(
                model=model, instructions=chat_instructions(instructions()), input=inputs, tools=chat_tools(),
            )
        log.info("chat turn via %s model=%s response=%s", "gateway" if via_gateway else "openai", model, r.id)
        calls = [o for o in r.output if o.type == "function_call"]
        if not calls:
            text = final_text(r)
            return {"reply": text, "tools": used, "format": reply_format(text)}
        inputs += [o.model_dump(exclude_none=True) for o in r.output if o.type in ("function_call", "reasoning")]
        for c in calls:
            used.append(c.name)
            result = await tool(c.name, ToolCall(arguments=c.arguments, user_text=user_text))
            inputs.append({"type": "function_call_output", "call_id": c.call_id, "output": dumps(result)})
    return {"reply": "Sorry, that took too many steps. Could you rephrase?", "tools": used, "format": "text"}


class SessionIn(BaseModel):
    history: list[dict] = []


@app.post("/api/session")
async def realtime_session(body: SessionIn):
    recent = "\n".join(f"{h.get('role')}: {str(h.get('text', ''))[:300]}" for h in body.history[-8:])
    instr = instructions() + ("\n\nRecent conversation in the app (for context):\n" + recent if recent else "")
    session = {
        "type": "realtime",
        "model": settings.realtime_model,
        "instructions": instr,
        "audio": {
            "input": {
                "transcription": {"model": "gpt-4o-mini-transcribe"},
                "turn_detection": {"type": "server_vad", "silence_duration_ms": 600},
            },
            "output": {"voice": "marin"},
        },
        "tools": realtime_tools(),
        "tool_choice": "auto",
    }
    async with httpx.AsyncClient(timeout=20) as h:
        r = await h.post(
            "https://api.openai.com/v1/realtime/client_secrets",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json={"session": session},
        )
    if r.status_code >= 400:
        raise HTTPException(502, f"OpenAI: {r.text[:300]}")
    async with SessionLocal() as s:
        vs = VoiceSession()
        s.add(vs)
        await s.commit()
        vid = vs.id
    return {"client_secret": r.json()["value"], "voice_session_id": vid, "model": settings.realtime_model}


class VoiceEnd(BaseModel):
    duration_s: float
    tool_calls: int = 0
    cost_estimate: float | None = None


@app.post("/api/session/{vid}/end")
async def end_session(vid: int, body: VoiceEnd):
    async with SessionLocal() as s:
        vs = await s.get(VoiceSession, vid)
        if vs:
            vs.duration_s, vs.tool_calls, vs.cost_estimate = body.duration_s, body.tool_calls, body.cost_estimate
            await s.commit()
    return {"ok": True}


@app.get("/api/usage")
async def usage():
    since = datetime.now(timezone.utc) - timedelta(days=30)
    async with SessionLocal() as s:
        mins = await s.scalar(select(func.sum(VoiceSession.duration_s)).where(VoiceSession.started_at >= since))
        cost = await s.scalar(select(func.sum(VoiceSession.cost_estimate)).where(VoiceSession.started_at >= since))
        n = await s.scalar(select(func.count()).select_from(VoiceSession).where(VoiceSession.started_at >= since))
    return {"voice_sessions_30d": n or 0, "voice_minutes_30d": round((mins or 0) / 60, 1),
            "voice_cost_usd_30d": round(cost or 0, 2)}


# ---------- serve built frontend (production) ----------

DIST = ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
