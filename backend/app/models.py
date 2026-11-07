from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True)
    google_refresh_token: Mapped[str | None] = mapped_column(Text)  # Fernet-encrypted
    last_history_id: Mapped[str | None] = mapped_column(String)
    quiet_hours: Mapped[str | None] = mapped_column(String)
    vip_senders: Mapped[list] = mapped_column(JSON, default=list)
    needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Email(Base):
    __tablename__ = "emails"
    gmail_id: Mapped[str] = mapped_column(String, primary_key=True)
    thread_id: Mapped[str] = mapped_column(String, index=True)
    sender: Mapped[str] = mapped_column(String)
    to: Mapped[str | None] = mapped_column(String)
    subject: Mapped[str | None] = mapped_column(String)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    category: Mapped[str | None] = mapped_column(String)
    urgency: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str | None] = mapped_column(Text)
    needs_reply: Mapped[bool] = mapped_column(Boolean, default=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    amount: Mapped[dict | None] = mapped_column(JSON)
    reason: Mapped[str | None] = mapped_column(Text)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    thread_id: Mapped[str] = mapped_column(String, unique=True)  # one alert per thread
    gmail_id: Mapped[str] = mapped_column(ForeignKey("emails.gmail_id"))
    reason: Mapped[str | None] = mapped_column(Text)
    channel: Mapped[str] = mapped_column(String, default="webpush")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String, default="sent")  # sent/opened/dismissed/handled
    user_feedback: Mapped[str | None] = mapped_column(String)


class Draft(Base):
    __tablename__ = "drafts"
    draft_id: Mapped[str] = mapped_column(String, primary_key=True)
    thread_id: Mapped[str | None] = mapped_column(String)
    to: Mapped[str | None] = mapped_column(String)
    subject: Mapped[str | None] = mapped_column(String)
    snippet: Mapped[str | None] = mapped_column(Text)
    intent: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String, default="awaiting_review")


class Rule(Base):
    __tablename__ = "rules"
    id: Mapped[int] = mapped_column(primary_key=True)
    pattern: Mapped[str] = mapped_column(String)  # sender / domain / keyword
    action: Mapped[str] = mapped_column(String)  # always_alert / never_alert / category:<x>
    created_from_feedback: Mapped[bool] = mapped_column(Boolean, default=False)


class VoiceSession(Base):
    __tablename__ = "voice_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    duration_s: Mapped[float | None] = mapped_column(Float)
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    cost_estimate: Mapped[float | None] = mapped_column(Float)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    endpoint: Mapped[str] = mapped_column(String, primary_key=True)
    keys: Mapped[dict] = mapped_column(JSON)
