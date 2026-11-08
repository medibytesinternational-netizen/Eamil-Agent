from app import tools
from app.openui import chat_instructions, openui_prompt, reply_format

UI = 'Here you go.\n```openui-lang\nroot = Reply([t])\nt = Text("hi")\n```'


def test_prompt_loads_and_is_appended():
    p = openui_prompt()
    assert "EmailList" in p and "DraftPreview" in p
    assert chat_instructions("BASE RULES").startswith("BASE RULES")


def test_reply_format_detection():
    assert reply_format(UI) == "openui"
    assert reply_format("You have 2 bills due.") == "text"
    assert reply_format("```python\nroot = Reply(\n```") == "text"
    assert reply_format("") == "text"
    assert reply_format('root = Reply([t])\nt = Text("hi")') == "openui"
    assert reply_format('Intro line\nroot = Reply([t])\nt = Text("hi")') == "openui"
    assert reply_format("Set root = Reply( in your code") == "text"


def test_no_send_tool_exposed():
    names = {t["name"] for t in tools.chat_tools()}
    assert names
    assert not any("send" in n or "delete" in n for n in names)
