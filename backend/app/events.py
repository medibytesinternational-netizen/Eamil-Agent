"""In-process pub/sub for Server-Sent Events to the dashboard."""

import asyncio
import json

_subscribers: set[asyncio.Queue] = set()


def publish(event: str, data: dict | None = None) -> None:
    msg = {"event": event, "data": json.dumps(data or {})}
    for q in list(_subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


async def stream():
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    try:
        yield {"event": "hello", "data": "{}"}
        while True:
            try:
                yield await asyncio.wait_for(q.get(), timeout=25)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "{}"}
    finally:
        _subscribers.discard(q)
