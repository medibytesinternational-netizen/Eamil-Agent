"""Gmail API adapter (used because Gmail MCP tool calls need Workspace Developer Preview enrollment).

All calls are blocking google-api-python-client calls, wrapped with asyncio.to_thread.
There is deliberately no send / trash / delete-message function here.
"""

import asyncio
import base64
import re
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime
from html import unescape
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from .google_auth import get_credentials

BODY_CAP = 4000


async def _svc():
    creds = await get_credentials()
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


async def _run(fn):
    svc = await _svc()
    return await asyncio.to_thread(fn, svc.users())


# ---------- parsing ----------

def _headers(payload: dict) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


def _decode(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


def _find_body(payload: dict) -> tuple[str, list[str]]:
    plain, html, files = [], [], []

    def walk(p):
        mime = p.get("mimeType", "")
        if p.get("filename"):
            files.append(p["filename"])
        data = p.get("body", {}).get("data")
        if data and mime == "text/plain":
            plain.append(_decode(data))
        elif data and mime == "text/html":
            html.append(_decode(data))
        for part in p.get("parts", []) or []:
            walk(part)

    walk(payload)
    if plain:
        return "\n".join(plain), files
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", "\n".join(html), flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>|</p>|</div>", "\n", text, flags=re.I)
    return unescape(re.sub(r"<[^>]+>", " ", text)), files


def clean_body(text: str) -> str:
    """Drop quoted replies and signatures, collapse whitespace, cap length."""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith(">"):
            continue
        if re.match(r"^On .+wrote:$", s) or s in ("-- ", "--") or s.startswith("-----Original Message"):
            break
        out.append(s)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out))
    text = re.sub(r"[ \t]{2,}", " ", text).strip()
    return text[:BODY_CAP]


def parse_message(msg: dict) -> dict[str, Any]:
    payload = msg.get("payload", {})
    h = _headers(payload)
    body, files = _find_body(payload)
    try:
        received = parsedate_to_datetime(h.get("date", ""))
    except (TypeError, ValueError):
        received = None
    return {
        "id": msg["id"],
        "thread_id": msg["threadId"],
        "label_ids": msg.get("labelIds", []),
        "from": h.get("from", ""),
        "to": h.get("to", ""),
        "cc": h.get("cc", ""),
        "subject": h.get("subject", ""),
        "date": h.get("date", ""),
        "received_at": received,
        "internal_ms": int(msg.get("internalDate", 0)),
        "message_id": h.get("message-id", ""),
        "references": h.get("references", ""),
        "list_unsubscribe": bool(h.get("list-unsubscribe")),
        "attachments": files,
        "snippet": unescape(msg.get("snippet", "")),
        "body": clean_body(body),
    }


# ---------- reads ----------

async def get_profile() -> dict:
    return await _run(lambda u: u.getProfile(userId="me").execute())


class HistoryExpired(Exception):
    pass


async def new_message_ids(start_history_id: str) -> tuple[list[str], str]:
    """IDs of messages added to INBOX since start_history_id, plus the new checkpoint."""

    def f(u):
        ids, page, latest = [], None, start_history_id
        while True:
            try:
                r = u.history().list(
                    userId="me", startHistoryId=start_history_id, historyTypes=["messageAdded"],
                    labelId="INBOX", pageToken=page,
                ).execute()
            except HttpError as e:
                if e.resp.status == 404:
                    raise HistoryExpired() from e
                raise
            for h in r.get("history", []):
                for m in h.get("messagesAdded", []):
                    if "INBOX" in m["message"].get("labelIds", []) and m["message"]["id"] not in ids:
                        ids.append(m["message"]["id"])
            latest = r.get("historyId", latest)
            page = r.get("nextPageToken")
            if not page:
                return ids, latest

    return await _run(f)


async def list_message_ids(query: str, limit: int = 200) -> list[str]:
    def f(u):
        ids, page = [], None
        while len(ids) < limit:
            r = u.messages().list(userId="me", q=query, maxResults=min(100, limit - len(ids)), pageToken=page).execute()
            ids += [m["id"] for m in r.get("messages", [])]
            page = r.get("nextPageToken")
            if not page:
                break
        return ids

    return await _run(f)


async def get_message(message_id: str) -> dict:
    return parse_message(await _run(lambda u: u.messages().get(userId="me", id=message_id, format="full").execute()))


async def search_threads(query: str, limit: int = 5) -> list[dict]:
    """Thread list with sender/date/subject of the latest message — what the agent reads aloud."""

    def f(u):
        r = u.threads().list(userId="me", q=query, maxResults=limit).execute()
        out = []
        for t in r.get("threads", []):
            th = u.threads().get(userId="me", id=t["id"], format="metadata",
                                 metadataHeaders=["From", "Subject", "Date"]).execute()
            last = th["messages"][-1]
            h = _headers(last.get("payload", {}))
            out.append({
                "thread_id": t["id"], "from": h.get("from", ""), "subject": h.get("subject", ""),
                "date": h.get("date", ""), "snippet": unescape(last.get("snippet", "")),
                "messages": len(th["messages"]),
            })
        return out

    return await _run(f)


async def get_thread(thread_id: str, max_messages: int = 5) -> dict:
    th = await _run(lambda u: u.threads().get(userId="me", id=thread_id, format="full").execute())
    msgs = [parse_message(m) for m in th["messages"]][-max_messages:]
    for m in msgs:
        m["body"] = m["body"][:2000]
        m.pop("received_at", None)
    return {"thread_id": thread_id, "messages": msgs}


# ---------- drafts (the only write besides labels) ----------

async def create_draft(to: str, subject: str, body: str, thread_id: str | None = None) -> dict:
    in_reply_to = references = None
    if thread_id:
        th = await get_thread(thread_id, max_messages=1)
        last = th["messages"][-1]
        in_reply_to = last["message_id"]
        references = (last["references"] + " " + last["message_id"]).strip()
        if not subject:
            subject = last["subject"]
        if not subject.lower().startswith("re:"):
            subject = "Re: " + subject
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = references
    msg.set_content(body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    payload: dict[str, Any] = {"message": {"raw": raw}}
    if thread_id:
        payload["message"]["threadId"] = thread_id
    d = await _run(lambda u: u.drafts().create(userId="me", body=payload).execute())
    return {"draft_id": d["id"], "message_id": d["message"]["id"], "thread_id": d["message"].get("threadId"),
            "to": to, "subject": subject}


async def draft_ids() -> set[str]:
    def f(u):
        ids, page = set(), None
        while True:
            r = u.drafts().list(userId="me", pageToken=page, maxResults=500).execute()
            ids |= {d["id"] for d in r.get("drafts", [])}
            page = r.get("nextPageToken")
            if not page:
                return ids

    return await _run(f)


async def delete_draft(draft_id: str) -> None:
    await _run(lambda u: u.drafts().delete(userId="me", id=draft_id).execute())


async def sent_to(address: str, limit: int = 3) -> list[str]:
    """Bodies of the user's recent sent replies to this address (tone samples)."""
    ids = await list_message_ids(f"in:sent to:{address}", limit=limit)
    return [(await get_message(i))["body"][:800] for i in ids]


def addresses(*headers: str) -> list[str]:
    return [a.lower() for _, a in getaddresses([h for h in headers if h]) if a]
