"""Thin adapter over Google's Gmail MCP server (Preview) so the rest of the app doesn't depend on it directly."""

import json
from typing import Any

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .config import GMAIL_MCP_URL
from .google_auth import get_access_token

# Allowlist: read, search, draft, label. No send, trash or spam — even though the server offers some.
ALLOWED_TOOLS = {
    "search_threads", "get_thread", "get_message",
    "create_draft", "list_drafts", "get_draft",
    "list_labels", "create_label", "label_thread", "unlabel_thread",
}


async def _session_call(fn):
    token = await get_access_token()
    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=60) as http:
        async with streamable_http_client(GMAIL_MCP_URL, http_client=http) as (r, w), ClientSession(r, w) as session:
            await session.initialize()
            return await fn(session)


async def list_tools() -> list[str]:
    async def f(s: ClientSession):
        return [t.name for t in (await s.list_tools()).tools]

    return await _session_call(f)


async def call_tool(name: str, args: dict[str, Any]) -> Any:
    if name not in ALLOWED_TOOLS:
        raise PermissionError(f"Tool {name} is not allowed")

    async def f(s: ClientSession):
        res = await s.call_tool(name, args)
        if res.is_error:
            raise RuntimeError(" ".join(getattr(c, "text", "") for c in res.content))
        if res.structured_content is not None:
            return res.structured_content
        texts = [getattr(c, "text", "") for c in res.content]
        try:
            return json.loads(texts[0]) if len(texts) == 1 else texts
        except (json.JSONDecodeError, IndexError):
            return texts

    return await _session_call(f)
