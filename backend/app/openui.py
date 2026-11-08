"""OpenUI generative UI for typed chat.

The system prompt is generated from frontend/src/lib/openui/library.tsx
(`npm run openui:prompt`) and is appended to the normal instructions for typed chat only.
"""
import re
from functools import lru_cache
from pathlib import Path

PROMPT_FILE = Path(__file__).with_name("openui_prompt.txt")
# Fenced (```openui-lang ... root = Reply(...)) or bare, with `root = Reply(` at the start of a line.
_FENCE = re.compile(r"```openui-lang\s*\n.*?\broot\s*=\s*Reply\(", re.S)
_BARE = re.compile(r"^root\s*=\s*Reply\(", re.M)


@lru_cache
def openui_prompt() -> str:
    return PROMPT_FILE.read_text(encoding="utf-8") if PROMPT_FILE.exists() else ""


def chat_instructions(base: str) -> str:
    extra = openui_prompt()
    return f"{base}\n\n# Rich answers (typed chat only)\n{extra}" if extra else base


def reply_format(text: str) -> str:
    """'openui' when the reply contains an OpenUI Lang block with a Reply root, else 'text'."""
    text = text or ""
    if _FENCE.search(text):
        return "openui"
    return "openui" if "```" not in text and _BARE.search(text) else "text"
