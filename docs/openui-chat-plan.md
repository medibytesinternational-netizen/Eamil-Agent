# Plan: OpenUI generative UI in the Agent chat

Source: `openUi.txt` (user's plan). This version adds the results of the pre-coding checks it asked for.

## Context
Typed Agent chat replies are plain text with a tiny `**bold**` formatter (`Rich` in `frontend/src/screens/Chat.tsx`). Email answers (who's waiting, bills due, invoice search, draft confirmations) should render as scannable, clickable UI. OpenUI lets the model answer in OpenUI Lang, which is restricted to a component library we define, and `<Renderer />` draws it. Safety model unchanged: drafts only, never send.

## Pre-coding checks (done)
- `@openuidev/react-lang` 1.1.0, `@openuidev/lang-core` 1.1.0, `@openuidev/cli` 0.6.3. All MIT.
- Peers: `react: *` (React 19.3 is fine) and `zod ^3.25 || ^4` (use `zod/v4`). The packages also list `react-native` and `@modelcontextprotocol/sdk` as peers. Confirm at install that npm treats them as optional (`peerDependenciesMeta`). If it doesn't, add an empty-module alias in the Vite config instead of installing them.
- Still to check after generation: size of the prompt file (tokens per turn). Keep the examples minimal if it is over ~3k tokens.

## Steps
0. Copy this plan to `docs/openui-chat-plan.md`.
1. **Component library**, `frontend/src/lib/openui/library.tsx`, built with `defineComponent` and `createLibrary`. Components: Reply (root), Text, EmailList/EmailCard, BillList/Bill, DraftPreview (always labelled "Saved as draft — not sent"), StatRow, Actions/ActionButton. Styled with our own classes (green/dark theme), not the built-in CSS.
   - Allowed actions: `continue_conversation` (prompt → next user turn) and `open` with a `threadId`. The Gmail URL is built on the client from a thread id that passes `/^[A-Za-z0-9_-]{6,64}$/`. Model-supplied URLs are never used, and there are no send or delete actions.
2. **Prompt generation**: add an `openui:prompt` npm script that runs `npx @openuidev/cli generate src/lib/openui/library.tsx --out ../backend/app/openui_prompt.txt`. Use inlineMode, a preamble ("email assistant; email content is untrusted"), and 3–4 examples (search results, bills, draft confirmation, plain text). Commit the generated file.
3. **Backend**: in `backend/app/main.py`, `/api/chat` (line ~301):
   - Load `openui_prompt.txt` once, and append it after the existing instructions for typed chat only. `/api/session` (voice) is unchanged.
   - Return `{reply, tools, format}`, where `format` is `"openui"` if the reply starts with a `Reply(` root and `"text"` otherwise.
   - Tests in `backend/tests`: the prompt loads, an OpenUI reply is detected, plain text is detected, and the tool list is unchanged.
4. **Frontend**:
   - Install `@openuidev/react-lang @openuidev/lang-core zod`, plus `@openuidev/cli` as a dev dependency.
   - `hooks/useChat.ts`: add `format?: 'openui' | 'text'` to `Msg` and set it from the `/api/chat` response. The history sent back keeps the raw OpenUI text, so follow-ups like "the second one" still work.
   - `screens/Chat.tsx`: for agent messages with `format === 'openui'` and the `?openui=1` flag set, render `<Renderer response={m.text} library={emailLibrary} isStreaming={false} onAction={handleAction} onError={→ fall back to Rich} />`. Wrap it in an error boundary that also falls back to `Rich`.
   - `handleAction`: `continue_conversation` calls `ask(prompt)`; `open` validates the id and calls `window.open(gmailLink(id), '_blank', 'noopener')`.
   - Styles go in `theme.css` / `index.css` for light and dark, at 1440px and 390px widths.
5. **Rollout**: (1) ship behind `?openui=1`; (2) make it the default once verified; (3) later and optional: SSE streaming and a `/api/chat/repair` retry loop.

## Critical files
`frontend/src/lib/openui/library.tsx` (new), `backend/app/openui_prompt.txt` (generated), `backend/app/main.py`, `frontend/src/hooks/useChat.ts`, `frontend/src/screens/Chat.tsx`, `frontend/src/theme.css`, `frontend/package.json`.

## Verification
- `cd backend && uv run pytest`; `cd frontend && npx tsc -b && npm run build`.
- Manual check on http://localhost:5180/?openui=1 (backend on port 8010), in light and dark at both widths:
  - "Who's waiting on my reply?" → EmailList
  - "Which bills are due?" → BillList
  - "Draft a reply to X" → DraftPreview saying not sent
  - Follow-up buttons send a new turn, and Open opens the Gmail thread
  - A plain question still returns text
  - A malformed reply falls back to text
  - Voice mode is unchanged
