import asyncio
import json
import logging
from datetime import datetime, time
from zoneinfo import ZoneInfo

from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select

from .profile import cached_names
from .config import settings
from .db import SessionLocal
from .events import publish
from .models import Alert, Email, PushSubscription, utcnow

log = logging.getLogger(__name__)


def in_quiet_hours(spec: str | None, now: datetime | None = None) -> bool:
    if not spec or "-" not in spec:
        return False
    start_s, end_s = spec.split("-")
    start, end = time.fromisoformat(start_s), time.fromisoformat(end_s)
    t = (now or datetime.now(ZoneInfo(settings.timezone))).time()
    return start <= t < end if start < end else (t >= start or t < end)


def format_alert(email: Email) -> str:
    label = {"payment": "Payment due", "security": "Security", "reply_needed": "Reply needed",
             "deadline": "Deadline"}.get(email.category or "", "Urgent")
    return f"⚠ {label} — {email.summary}"


async def maybe_alert(email: Email, quiet_hours: str | None) -> Alert | None:
    if email.urgency < 3:
        return None
    async with SessionLocal() as s:
        existing = (await s.execute(select(Alert).where(Alert.thread_id == email.thread_id))).scalar_one_or_none()
        if existing and existing.status in ("handled", "dismissed"):
            return None  # user already dealt with this thread
        if existing:
            existing.gmail_id, existing.reason, existing.status = email.gmail_id, email.reason, "sent"
            alert = existing
        else:
            alert = Alert(thread_id=email.thread_id, gmail_id=email.gmail_id, reason=email.reason)
            s.add(alert)
        quiet = in_quiet_hours(quiet_hours) and email.category != "security"
        if not quiet:
            alert.sent_at = utcnow()
        await s.commit()
        alert_id = alert.id
    publish("alert", {"id": alert_id})
    if not quiet:
        await send_push({"title": cached_names()[0], "body": format_alert(email),
                         "url": f"https://mail.google.com/mail/u/0/#inbox/{email.thread_id}"})
    return alert


async def send_push(payload: dict) -> int:
    if not settings.vapid_private_key:
        return 0
    async with SessionLocal() as s:
        subs = (await s.execute(select(PushSubscription))).scalars().all()
    sent, dead = 0, []
    for sub in subs:
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info={"endpoint": sub.endpoint, "keys": sub.keys},
                data=json.dumps(payload),
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
            )
            sent += 1
        except WebPushException as e:
            if e.response is not None and e.response.status_code in (404, 410):
                dead.append(sub.endpoint)
            else:
                log.warning("push failed: %s", e)
    if dead:
        async with SessionLocal() as s:
            await s.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
            await s.commit()
    return sent
