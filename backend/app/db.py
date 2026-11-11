"""Local SQLite storage: one database file per Gmail account, plus a small registry.

DATA_DIR/
  accounts.db           registry: which accounts exist and which one is active
  acct-<hash>.db        everything for one Gmail account (token, profile, emails, alerts, ...)
  acct-pending.db       used before any Gmail is connected (onboarding answers live here)
  backups/              automatic copies taken before a schema migration

`SessionLocal()` always opens a session on the ACTIVE account's database, so callers don't change.
"""
import hashlib
import logging
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from .config import BACKEND, settings
from .models import Base

log = logging.getLogger(__name__)
PENDING = "acct-pending.db"


class _Active:
    email: str | None = None
    file: str = PENDING
    engine: AsyncEngine | None = None
    maker: async_sessionmaker | None = None


_active = _Active()


def data_dir() -> Path:
    d = settings.data_path
    (d / "backups").mkdir(parents=True, exist_ok=True)
    return d


def store_file(email: str) -> str:
    """Hashed file name so the folder listing doesn't reveal addresses."""
    return f"acct-{hashlib.sha256(email.strip().lower().encode()).hexdigest()[:12]}.db"


# ---------- registry (tiny, synchronous) ----------

def _reg() -> sqlite3.Connection:
    c = sqlite3.connect(data_dir() / "accounts.db")
    c.execute("CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, db_file TEXT NOT NULL, "
              "created_at TEXT NOT NULL, last_used TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
    return c


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def list_accounts() -> list[dict]:
    with _reg() as c:
        rows = c.execute("SELECT email, created_at, last_used FROM accounts ORDER BY last_used DESC").fetchall()
    return [{"email": e, "created_at": ca, "last_used": lu, "active": e == _active.email} for e, ca, lu in rows]


def active_email() -> str | None:
    return _active.email


def _registered_active() -> str | None:
    with _reg() as c:
        row = c.execute("SELECT v FROM meta WHERE k='active'").fetchone()
    return row[0] if row and row[0] else None


def _set_registered_active(email: str | None) -> None:
    with _reg() as c:
        c.execute("INSERT INTO meta (k, v) VALUES ('active', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                  (email or "",))
        if email:
            c.execute("INSERT INTO accounts (email, db_file, created_at, last_used) VALUES (?, ?, ?, ?) "
                      "ON CONFLICT(email) DO UPDATE SET last_used=excluded.last_used",
                      (email, store_file(email), _now(), _now()))


def account_exists(email: str) -> bool:
    with _reg() as c:
        return c.execute("SELECT 1 FROM accounts WHERE email=?", (email.lower(),)).fetchone() is not None


# ---------- engines ----------

async def _open(file: str) -> None:
    path = data_dir() / file
    if _active.engine is not None:
        await _active.engine.dispose()
    _active.engine = create_async_engine(f"sqlite+aiosqlite:///{path.as_posix()}")
    _active.maker = async_sessionmaker(_active.engine, expire_on_commit=False)
    _active.file = file
    async with _active.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate(conn, path)


def SessionLocal() -> AsyncSession:  # noqa: N802 — kept for existing `async with SessionLocal()` callers
    if _active.maker is None:
        raise RuntimeError("database not initialised; call init_db() first")
    return _active.maker()


def get_engine() -> AsyncEngine:
    assert _active.engine is not None
    return _active.engine


async def switch_account(email: str | None) -> None:
    """Make `email`'s store active (created on first use). None → the pending store (no Gmail connected)."""
    email = email.strip().lower() if email else None
    await _open(store_file(email) if email else PENDING)
    _active.email = email
    _set_registered_active(email)
    log.info("active store: %s (%s)", _active.file, "connected account" if email else "no account")


def delete_account(email: str) -> bool:
    """Permanently delete an inactive account's local data."""
    email = email.strip().lower()
    if email == _active.email:
        raise ValueError("Disconnect this account before deleting its data")
    with _reg() as c:
        row = c.execute("SELECT db_file FROM accounts WHERE email=?", (email,)).fetchone()
        if not row:
            return False
        c.execute("DELETE FROM accounts WHERE email=?", (email,))
    for suffix in ("", "-wal", "-shm", "-journal"):
        (data_dir() / f"{row[0]}{suffix}").unlink(missing_ok=True)
    return True


async def reset_pending() -> None:
    """Fresh, empty pending store (used after a disconnect so the next setup starts clean)."""
    if _active.file == PENDING and _active.engine is not None:
        await _active.engine.dispose()
        _active.engine = None
    for suffix in ("", "-wal", "-shm", "-journal"):
        (data_dir() / f"{PENDING}{suffix}").unlink(missing_ok=True)


# ---------- legacy single-file DB ----------

def _import_legacy() -> str | None:
    """Move the pre-multi-account backend/agent.db into its account's store (once). Keeps the original."""
    url = settings.db_url
    prefix = "sqlite+aiosqlite:///"
    legacy = Path(url[len(prefix):]) if url.startswith(prefix) else BACKEND / "agent.db"
    if not legacy.exists() or _registered_active() or list_accounts():
        return None
    try:
        with sqlite3.connect(legacy) as c:
            row = c.execute("SELECT email FROM users WHERE email != '' ORDER BY id LIMIT 1").fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    email = row[0].strip().lower()
    dest = data_dir() / store_file(email)
    if not dest.exists():
        shutil.copy2(legacy, dest)
    _set_registered_active(email)
    log.info("imported legacy agent.db into the store for its account")
    return email


async def init_db() -> None:
    _import_legacy()
    await switch_account(_registered_active())


# ---------- schema migrations (create_all never adds columns to existing tables) ----------

_NEW_COLUMNS = {"emails": [("important", "BOOLEAN DEFAULT 0")]}


async def _migrate(conn, path: Path) -> None:
    if conn.dialect.name != "sqlite":
        return
    todo = []
    for table, cols in _NEW_COLUMNS.items():
        have = {r[1] for r in (await conn.execute(text(f"PRAGMA table_info({table})"))).fetchall()}
        todo += [(table, n, ddl) for n, ddl in cols if n not in have]
    if not todo:
        return
    if path.exists() and path.stat().st_size > 0:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, data_dir() / "backups" / f"{path.stem}-{stamp}.db")
    for table, name, ddl in todo:
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
        log.info("migration: added %s.%s in %s", table, name, path.name)
