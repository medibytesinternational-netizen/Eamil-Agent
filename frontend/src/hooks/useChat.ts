import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { VoiceSession, type VoiceState } from '../lib/realtime'

export type Msg = { role: 'user' | 'agent'; text: string; pending?: boolean; format?: 'openui' | 'text' }

export const TOOL_LABEL: Record<string, string> = {
  search_emails: 'Searching Gmail…', read_thread: 'Reading the email…', get_urgent_items: 'Checking urgent items…',
  mark_handled: 'Updating…', list_pending_drafts: 'Checking drafts…', create_draft: 'Saving draft…',
}

export function useChat(onError: (e: unknown) => void, onDataChanged: () => void) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const [toolChip, setToolChip] = useState<string | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const voice = useRef<VoiceSession | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const recentUserText = () => messagesRef.current.filter(m => m.role === 'user').slice(-6).map(m => m.text).join(' ')
  const history = () => messagesRef.current.filter(m => !m.pending).slice(-12).map(m => ({ role: m.role, text: m.text }))

  const ask = useCallback(async (text: string) => {
    setMessages(m => [...m, { role: 'user', text }])
    if (voice.current?.active && voice.current.sendText(text)) return
    setBusy(true)
    setToolChip('Thinking…')
    try {
      const r = await api<{ reply: string; tools: string[]; format?: 'openui' | 'text' }>('/api/chat', { json: { message: text, history: history() } })
      setMessages(m => [...m, { role: 'agent', text: r.reply, format: r.format }])
      if (r.tools.length) onDataChanged()
    } catch (e) {
      onError(e)
      setMessages(m => [...m, { role: 'agent', text: 'Sorry — something went wrong. Please try again.' }])
    } finally { setBusy(false); setToolChip(null) }
  }, [onError, onDataChanged])

  const toggleVoice = useCallback(() => {
    if (voice.current?.active) { voice.current.stop(); return }
    const v = new VoiceSession({
      onState: setVoiceState,
      onUserTranscript: text => setMessages(m => [...m, { role: 'user', text }]),
      onAgentTranscript: (text, done) => setMessages(m => {
        const last = m[m.length - 1]
        const next = last?.role === 'agent' && last.pending ? m.slice(0, -1) : m
        return [...next, { role: 'agent', text, pending: !done }]
      }),
      onTool: name => { setToolChip(name ? TOOL_LABEL[name] ?? 'Working…' : null); if (!name) onDataChanged() },
      onError: msg => onError(new Error(msg)),
      onEnded: () => { voice.current = null; setToolChip(null) },
      recentUserText,
      onStream: setMicStream,
    })
    voice.current = v
    v.start(history())
  }, [onError, onDataChanged])

  useEffect(() => () => voice.current?.stop(), [])

  return { messages, busy, toolChip, voiceState, micStream, ask, toggleVoice, clear: () => setMessages([]) }
}
