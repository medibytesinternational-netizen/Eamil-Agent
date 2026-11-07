from datetime import datetime, timezone

import pytest

from app import gmail_client, tools
from app.alerts import in_quiet_hours
from app.db import SessionLocal, init_db
from app.models import Email
from app.triage import apply_rules, finalize


def msg(**kw):
    base = {"from": "Someone <a@b.com>", "to": "me@x.com", "cc": "", "subject": "", "body": "", "snippet": "",
            "label_ids": ["INBOX"], "list_unsubscribe": False, "attachments": [], "date": ""}
    base.update(kw)
    return base


def test_otp_is_silent():
    r = apply_rules(msg(subject="Your OTP is 123456"), [], [])
    assert r["category"] == "otp" and r["urgency"] == 0 and "123456" not in r["summary"]


def test_newsletter_silent_but_payment_list_mail_goes_to_llm():
    assert apply_rules(msg(list_unsubscribe=True, subject="Weekly digest"), [], [])["category"] == "newsletter"
    assert apply_rules(msg(list_unsubscribe=True, subject="Your bill is due on 10 Nov"), [], []) is None


def test_never_alert_rule():
    r = apply_rules(msg(**{"from": "Promo <deals@shop.com>"}), [], [("deals@shop.com", "never_alert")])
    assert r["urgency"] == 1


def test_security_floor_and_vip_and_otp_override():
    base = {"category": "other", "urgency": 0, "summary": "s", "needs_reply": False, "due_date": None,
            "amount": None, "reason": "r"}
    assert finalize(dict(base), msg(subject="New sign-in to your account"), [], [])["urgency"] == 3
    vip = finalize(dict(base, needs_reply=True), msg(**{"from": "Boss <boss@corp.com>"}), ["boss@corp.com"], [])
    assert vip["urgency"] == 3
    assert finalize(dict(base, category="otp", urgency=3), msg(), [], [("a@b.com", "always_alert")])["urgency"] == 0
    assert finalize(dict(base, due_date="not-a-date"), msg(), [], [])["due_date"] is None


def test_quiet_hours_wraps_midnight():
    d = lambda h, m=0: datetime(2026, 11, 7, h, m)  # noqa: E731
    assert in_quiet_hours("23:00-07:00", d(23, 30)) and in_quiet_hours("23:00-07:00", d(3))
    assert not in_quiet_hours("23:00-07:00", d(12))
    assert in_quiet_hours("13:00-14:00", d(13, 30)) and not in_quiet_hours(None, d(1))


def test_clean_body_strips_quotes_and_signature():
    out = gmail_client.clean_body("Hi\n> quoted\nThanks\n-- \nSig line\nOn Mon, X wrote:")
    assert out == "Hi\nThanks"


@pytest.fixture
async def db():
    await init_db()
    async with SessionLocal() as s:
        await s.merge(Email(gmail_id="m1", thread_id="t1", sender="Priya Sharma <priya@corp.com>", subject="lease",
                            received_at=datetime.now(timezone.utc)))
        await s.commit()


async def test_recipient_guard(db, monkeypatch):
    async def fake_thread(tid, max_messages=5):
        return {"messages": [{"from": "Landlord <land@lord.com>", "to": "me@x.com", "cc": ""}]}

    monkeypatch.setattr(gmail_client, "get_thread", fake_thread)
    # Named by the user (by name, matched via known sender) -> allowed
    assert (await tools.recipient_allowed("priya@corp.com", None, "reply to Priya I'll join Monday"))[0]
    # Literal address typed -> allowed
    assert (await tools.recipient_allowed("new@person.org", None, "email new@person.org about it"))[0]
    # Thread participant -> allowed
    assert (await tools.recipient_allowed("land@lord.com", "t9", "reply saying ok"))[0]
    # Injection: address only appears inside an email, user never named it -> blocked
    ok, why = await tools.recipient_allowed("attacker@evil.com", "t9", "reply saying ok")
    assert not ok and "attacker@evil.com" in why


async def test_create_draft_blocked_without_calling_gmail(db, monkeypatch):
    called = False

    async def boom(*a, **k):
        nonlocal called
        called = True

    monkeypatch.setattr(gmail_client, "create_draft", boom)
    r = await tools.run_tool("create_draft", {"to": "x@evil.com", "body": "hi"}, "summarise my inbox")
    assert r["ok"] is False and not called


def test_no_send_tools_exposed():
    names = {t["name"] for t in tools.TOOLS}
    assert not any(n.startswith(("send", "delete", "trash", "forward")) for n in names)
    assert not hasattr(gmail_client, "send_message")


def test_pct_change_and_daily_counts():
    from datetime import date, datetime
    from zoneinfo import ZoneInfo

    from app.insights import daily_counts, pct_change

    assert pct_change(12, 10) == 20 and pct_change(0, 0) is None and pct_change(5, 0) is None and pct_change(5, 10) == -50
    tz = ZoneInfo("Asia/Kolkata")
    days = daily_counts([datetime(2026, 11, 7, 9, tzinfo=tz), datetime(2026, 11, 7, 23, tzinfo=tz),
                         datetime(2026, 11, 1, 8, tzinfo=tz), datetime(2026, 10, 20, tzinfo=tz)], date(2026, 11, 7))
    assert len(days) == 7 and days[-1]["count"] == 2 and days[0]["date"] == "2026-11-01" and days[0]["count"] == 1
