import os
import tempfile

# Isolated database for tests (must be set before app modules import settings).
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db").replace("\\", "/")
