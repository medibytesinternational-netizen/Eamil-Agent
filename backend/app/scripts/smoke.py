"""Phase 1 exit test: `uv run python -m app.scripts.smoke`."""

import asyncio
import json

from .. import mcp_client
from ..db import init_db


async def main() -> None:
    await init_db()
    tools = await mcp_client.list_tools()
    print("Gmail MCP tools:", ", ".join(tools))
    res = await mcp_client.call_tool("search_threads", {"query": "newer_than:7d", "pageSize": 3})
    print("search_threads sample:", json.dumps(res, default=str)[:800])


if __name__ == "__main__":
    asyncio.run(main())
