"""Background loop: new-mail detection via history.list checkpoint, triage, alerts, draft sync."""

import asyncio
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from . import gmail_client as gmail
from .alerts import maybe_alert
from .config import settings
from .db import SessionLocal
from .events import publish
from .google_auth import ReconnectRequired
from .models import Draft, Email, Rule, User
from .triage import triage

log = logging.getLogger(__name__)
BACKFILL_QUERY = "in:inbox newer_than:7d"
BACKFILL_LIMIT = 150

_lock = asyncio.Lock()
_sem = asyncio.Semaphore(4)
state = {"backfill": None, "last_poll": None, "last_error": None}


async def _user() -> User | None:
    async with SessionLocal() as s:
        return (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one_or_none()


async def _rules() -> list[tuple[str, str]]:
    async with SessionLocal() as s:
        return [(r.pattern, r.action) for r in (await s.execute(select(Rule))).scalars()]


async def _known(ids: list[str]) -> set[str]:
    if not ids:
        return set()
    async with SessionLocal() as s:
        return set((await s.execute(select(Email.gmail_id).where(Email.gmail_id.in_(ids)))).scalars())


async def process_message(message_id: str, user: User, rules: list[tuple[str, str]], alert: bool = True) -> bool:
    """Fetch, triage, store and maybe alert. Returns True if newly processed. Idempotent."""
    async with _sem:
        if await _known([message_id]):
            return False
        msg = await gmail.get_message(message_id)
        if "INBOX" not in msg["label_ids"]:
            return False
        result = await triage(msg, user.vip_senders or [], rules)
        received = msg["received_at"] or datetime.fromtimestamp(msg["internal_ms"] / 1000, timezone.utc)
        email = Email(
            gmail_id=msg["id"], thread_id=msg["thread_id"], sender=msg["from"], to=msg["to"],
            subject=msg["subject"], received_at=received, category=result["category"], urgency=result["urgency"],
            summary=result["summary"], needs_reply=result["needs_reply"], due_date=result["due_date"],
            amount=result["amount"], reason=result["reason"],
        )
        async with SessionLocal() as s:
            if await s.get(Email, email.gmail_id):
                return False
            s.add(email)
            await s.commit()
    publish("email", {"gmail_id": email.gmail_id})
    if alert:
        await maybe_alert(email, user.quiet_hours)
    return True


async def _process_many(ids: list[str], user: User, alert: bool = True) -> int:
    rules = await _rules()
    results = await asyncio.gather(*(process_message(i, user, rules, alert) for i in ids), return_exceptions=True)
    for r in results:
        if isinstance(r, Exception) and not isinstance(r, ReconnectRequired):
            log.exception("processing failed", exc_info=r)
    return sum(1 for r in results if r is True)


async def poll_once() -> int:
    """history.list from the saved checkpoint; the checkpoint only advances after processing succeeds."""
    async with _lock:
        user = await _user()
        if not user or not user.google_refresh_token or user.needs_reconnect:
            return 0
        try:
            if not user.last_history_id:
                profile = await gmail.get_profile()
                await _save_history(profile["historyId"])
                asyncio.create_task(backfill())
                return 0
            try:
                ids, latest = await gmail.new_message_ids(user.last_history_id)
            except gmail.HistoryExpired:
                ids = await gmail.list_message_ids("in:inbox newer_than:2d", limit=100)
                latest = (await gmail.get_profile())["historyId"]
            n = await _process_many(ids, user)
            await _save_history(latest)
            state["last_poll"], state["last_error"] = datetime.now(timezone.utc).isoformat(), None
            return n
        except ReconnectRequired:
            state["last_error"] = "reconnect"
            publish("status", {})
            return 0
        except Exception as e:  # keep the scheduler alive
            state["last_error"] = str(e)[:200]
            log.exception("poll failed")
            return 0


async def _save_history(history_id: str) -> None:
    async with SessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == settings.gmail_account))).scalar_one()
        user.last_history_id = str(history_id)
        await s.commit()


async def fallback_poll() -> int:
    """Catch anything history.list missed."""
    user = await _user()
    if not user or user.needs_reconnect:
        return 0
    try:
        ids = await gmail.list_message_ids("in:inbox newer_than:1h", limit=50)
        unknown = [i for i in ids if i not in await _known(ids)]
        return await _process_many(unknown, user)
    except Exception:
        log.exception("fallback poll failed")
        return 0


async def backfill() -> None:
    user = await _user()
    if not user:
        return
    try:
        ids = await gmail.list_message_ids(BACKFILL_QUERY, limit=BACKFILL_LIMIT)
        todo = [i for i in ids if i not in await _known(ids)]
        state["backfill"] = {"done": 0, "total": len(todo)}
        publish("backfill", state["backfill"])
        for i in range(0, len(todo), 10):
            # Backfilled mail goes into the urgent list but doesn't fire push notifications.
            await _process_many(todo[i:i + 10], user, alert=False)
            await _alert_backfilled(todo[i:i + 10], user)
            state["backfill"]["done"] = min(i + 10, len(todo))
            publish("backfill", state["backfill"])
        state["backfill"] = None
        publish("backfill", {"done": len(todo), "total": len(todo), "finished": True})
    except Exception:
        log.exception("backfill failed")
        state["backfill"] = None


async def _alert_backfilled(ids: list[str], user: User) -> None:
    from .models import Alert

    async with SessionLocal() as s:
        emails = (await s.execute(select(Email).where(Email.gmail_id.in_(ids), Email.urgency >= 3))).scalars().all()
        for e in emails:
            if not (await s.execute(select(Alert).where(Alert.thread_id == e.thread_id))).scalar_one_or_none():
                s.add(Alert(thread_id=e.thread_id, gmail_id=e.gmail_id, reason=e.reason, channel="backfill"))
        await s.commit()
    if emails:
        publish("alert", {})


async def sync_drafts() -> None:
    """Drafts gone from Gmail were either sent or discarded by the user."""
    try:
        live = await gmail.draft_ids()
    except Exception:
        log.exception("draft sync failed")
        return
    async with SessionLocal() as s:
        pending = (await s.execute(select(Draft).where(Draft.status == "awaiting_review"))).scalars().all()
        changed = False
        for d in pending:
            if d.draft_id not in live:
                d.status = "sent_or_removed"
                changed = True
        await s.commit()
    if changed:
        publish("drafts", {})


def start_scheduler() -> AsyncIOScheduler:
    sched = AsyncIOScheduler()
    sched.add_job(poll_once, "interval", seconds=60, next_run_time=datetime.now(), max_instances=1, coalesce=True)
    sched.add_job(fallback_poll, "interval", minutes=15, max_instances=1, coalesce=True)
    sched.add_job(sync_drafts, "interval", minutes=10, max_instances=1, coalesce=True)
    sched.start()
    return sched
