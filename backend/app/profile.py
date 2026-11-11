"""The single owner: their User row (Gmail tokens) and Profile (onboarding answers)."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import SessionLocal
from .models import Profile, User

DEFAULT_AGENT = "Inbox Agent"
SUGGESTED_URGENT = (
    "Needs an immediate reply: a real person asks me something time-sensitive, client or manager escalations, "
    "failed payments, security alerts, deadlines within 24 hours."
)
SUGGESTED_IMPORTANT = (
    "Must read, even if no reply is needed: bank statements, bills due, school or official notices, contracts, "
    "travel bookings, delivery problems."
)


async def get_user(s: AsyncSession) -> User | None:
    return (await s.execute(select(User).order_by(User.id).limit(1))).scalar_one_or_none()


async def get_profile(s: AsyncSession) -> Profile | None:
    return (await s.execute(select(Profile).order_by(Profile.id).limit(1))).scalar_one_or_none()


async def load_profile() -> Profile | None:
    async with SessionLocal() as s:
        return await get_profile(s)


async def account_email() -> str:
    """The connected Gmail address, else the onboarding email, else the .env fallback."""
    async with SessionLocal() as s:
        user = await get_user(s)
        if user:
            return user.email
        p = await get_profile(s)
    return (p.user_email if p else "") or settings.gmail_account


def names(p: Profile | None, account: str = "") -> tuple[str, str]:
    """(agent_name, user_name) with sensible fallbacks."""
    agent = (p.agent_name if p else "") or DEFAULT_AGENT
    user = (p.user_name if p else "") or (account.split("@")[0] if account else "the user")
    return agent, user


# In-memory copy for sync callers (prompt builders, push titles). Refresh after any change.
_cache: dict = {"profile": None, "account": settings.gmail_account}


async def refresh_cache() -> None:
    async with SessionLocal() as s:
        _cache["profile"] = await get_profile(s)
    _cache["account"] = await account_email()


def cached() -> tuple[Profile | None, str]:
    return _cache["profile"], _cache["account"]


def cached_names() -> tuple[str, str]:
    p, account = cached()
    return names(p, account)
