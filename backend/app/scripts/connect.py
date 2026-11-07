"""Connect Gmail: `uv run python -m app.scripts.connect` — opens the browser for Google consent."""

import asyncio

from ..db import init_db
from ..google_auth import run_consent_flow, save_credentials


async def main() -> None:
    await init_db()
    creds = await asyncio.to_thread(run_consent_flow)
    if not creds.refresh_token:
        raise SystemExit("No refresh token returned — revoke the app at myaccount.google.com/permissions and retry.")
    await save_credentials(creds)
    print("Gmail connected; refresh token stored encrypted.")


if __name__ == "__main__":
    asyncio.run(main())
