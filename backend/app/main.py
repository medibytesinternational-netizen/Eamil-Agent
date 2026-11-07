import hashlib
import hmac
import json
import logging
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
from .alerts import in_quiet_hours, send_push
from .config import ROOT, settings
from .db import SessionLocal, init_db
from .events import publish, stream
from .google_auth import ReconnectRequired
from .models import Alert, Draft, Email, PushSubscription, Rule, User, VoiceSession
from .tools import chat_tools, dumps, instructions, realtime_tools, run_tool
from .triage import client as openai_client

logging.basicConfig(level=logging.INFO)
CHAT_MODEL = "gpt-5.4-mini"
COOKIE = "agent_session"
SESSION_TTL = 30 * 24 * 3600


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    sched = poller.start_scheduler()
    yield
    sched.shutdown(wait=False)


app = FastAPI(title="Personal Email Agent", lifespan=lifespan)


# ---------- auth (single user, app password) ----------

def _sign(ts: str) -> str:
    return hmac.new(settings.fernet_key.encode(), ts.encode(), hashlib.sha256).hexdigest()


def _valid_cookie(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    ts, sig = value.split(".", 1)
    return hmac.compare_digest(sig, _sign(ts)) and ts.isdigit() and time.time() - int(ts) < SESSION_TTL


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in ("/api/login", "/api/me"):
        if not _valid_cookie(request.cookies.get(COOKIE)):
            return JSONResponse({"detail": "login required"}, status_code=401)
    return await call_next(request)


class Login(BaseModel):
    password: str


@app.post("/api/login")
async def login(body: Login, response: Response):
    if not hmac.compare_digest(body.password, settings.app_password):
        raise HTTPException(401, "Wrong password")
    ts = str(int(time.time()))
    response.set_cookie(COOKIE, f"{ts}.{_sign(ts)}", httponly=True, samesite="strict", max_age=SESSION_TTL)
    return {"ok": True}


@app.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
async def me(request: Request):
    return {"logged_in": _valid_cookie(request.cookies.get(COOKIE)), "default_password": settings.app_password == "change-me"}


# ---------- status & dashboard ----------

async def _user() -> User | None:
    async with SessionLocal() as s:
        return (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one_or_none()


@app.get("/api/health")
async def health():
    user = await _user()
    return {
        "ok": True,
        "gmail_connected": bool(user and user.google_refresh_token and not user.needs_reconnect),
        "account": settings.gmail_account,
        "quiet_hours": user.quiet_hours if user else settings.quiet_hours,
        "quiet_now": in_quiet_hours(user.quiet_hours if user else settings.quiet_hours),
        "backfill": poller.state["backfill"],
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
        processed = await s.scalar(select(func.count()).select_from(Email).where(Email.received_at >= since))
        total = await s.scalar(select(func.count()).select_from(Email))
    return {
        "counts": {"urgent": len(alerts), "needs_reply": len(needs_reply), "drafts": len(drafts),
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
        user = (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one()
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
    n = await send_push({"title": "Inbox Agent", "body": "Test notification — alerts are working.", "url": "/"})
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
        {"role": "assistant" if h.get("role") in ("agent", "assistant") else "user", "content": str(h.get("text", ""))[:2000]}
        for h in body.history[-12:] if h.get("text")
    ]
    inputs: list = [*history, {"role": "user", "content": body.message}]
    user_text = " ".join(h["content"] for h in history if h["role"] == "user")[-3000:] + " " + body.message
    used: list[str] = []
    for _ in range(6):
        r = await openai_client().responses.create(
            model=CHAT_MODEL, instructions=instructions(), input=inputs, tools=chat_tools(),
        )
        calls = [o for o in r.output if o.type == "function_call"]
        if not calls:
            return {"reply": r.output_text, "tools": used}
        inputs += [o.model_dump(exclude_none=True) for o in r.output if o.type in ("function_call", "reasoning")]
        for c in calls:
            used.append(c.name)
            result = await tool(c.name, ToolCall(arguments=c.arguments, user_text=user_text))
            inputs.append({"type": "function_call_output", "call_id": c.call_id, "output": dumps(result)})
    return {"reply": "Sorry, that took too many steps. Could you rephrase?", "tools": used}


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
