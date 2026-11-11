"""First-run setup: profile (names + urgent/important rules), Gmail connect, 2-week backfill."""
import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from . import poller
from .db import SessionLocal
from .models import Profile, utcnow
from .profile import SUGGESTED_IMPORTANT, SUGGESTED_URGENT, get_profile, get_user, refresh_cache

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/onboarding")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def profile_json(p: Profile | None) -> dict | None:
    if not p:
        return None
    return {
        "user_name": p.user_name, "user_email": p.user_email, "agent_name": p.agent_name,
        "urgent_criteria": p.urgent_criteria, "important_criteria": p.important_criteria,
        "urgent_senders": p.urgent_senders or [], "important_senders": p.important_senders or [],
        "onboarded": p.onboarded_at is not None,
    }


def _clean_senders(v: list[str]) -> list[str]:
    out = []
    for x in v[:50]:
        x = x.strip().lower()[:120]
        if x and x not in out:
            out.append(x)
    return out


class ProfileIn(BaseModel):
    user_name: str = Field(min_length=1, max_length=80)
    user_email: str = Field(max_length=200)
    agent_name: str = Field(min_length=1, max_length=40)
    urgent_criteria: str = Field(default="", max_length=2000)
    important_criteria: str = Field(default="", max_length=2000)
    urgent_senders: list[str] = []
    important_senders: list[str] = []

    @field_validator("user_email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v

    @field_validator("user_name", "agent_name", "urgent_criteria", "important_criteria")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("urgent_senders", "important_senders")
    @classmethod
    def _senders(cls, v: list[str]) -> list[str]:
        return _clean_senders(v)


@router.get("/suggestions")
async def suggestions():
    return {"urgent_criteria": SUGGESTED_URGENT, "important_criteria": SUGGESTED_IMPORTANT}


@router.put("/profile")
async def put_profile(body: ProfileIn):
    async with SessionLocal() as s:
        p = await get_profile(s)
        if p is None:
            p = Profile()
            s.add(p)
        for k, v in body.model_dump().items():
            setattr(p, k, v)
        await s.commit()
        out = profile_json(p)
    await refresh_cache()
    return out


class BackfillIn(BaseModel):
    days: int = 14


@router.get("/estimate")
async def estimate(days: int = 14):
    """How many emails the backfill would read, and roughly how many need an AI review (cost)."""
    async with SessionLocal() as s:
        user = await get_user(s)
    if not user or not user.google_refresh_token:
        raise HTTPException(400, "Connect Gmail first")
    return await poller.estimate(days)


@router.post("/backfill")
async def start_backfill(body: BackfillIn | None = None):
    from .accounts import start_backfill as _start

    async with SessionLocal() as s:
        user = await get_user(s)
    if not user or not user.google_refresh_token:
        raise HTTPException(400, "Connect Gmail first")
    await _start((body.days if body else 14))
    return {"ok": True}


@router.get("/summary")
async def summary():
    from datetime import timedelta

    from sqlalchemy import func, select

    from .models import Email

    since = utcnow() - timedelta(days=14)
    async with SessionLocal() as s:
        total = await s.scalar(select(func.count()).select_from(Email).where(Email.received_at >= since))
        urgent = await s.scalar(select(func.count()).select_from(Email)
                                .where(Email.received_at >= since, Email.urgency >= 3))
        important = await s.scalar(select(func.count()).select_from(Email)
                                   .where(Email.received_at >= since, Email.important.is_(True)))
    return {"total": total or 0, "urgent": urgent or 0, "important": important or 0,
            "backfill": poller.state["backfill"]}


@router.post("/finish")
async def finish():
    async with SessionLocal() as s:
        p = await get_profile(s)
        if not p or not p.user_name:
            raise HTTPException(400, "Complete your profile first")
        p.onboarded_at = p.onboarded_at or utcnow()
        await s.commit()
        out = profile_json(p)
    await refresh_cache()
    return out
