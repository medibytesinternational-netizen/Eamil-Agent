import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { Component, useState, type ReactNode } from 'react'
import { gmailLink, isThreadId, library } from '../lib/openui/library'

// OpenUI rendering is on by default; ?openui=0 turns it off (remembered), ?openui=1 back on.
export const openuiEnabled = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('openui')
    if (q === '1' || q === '0') localStorage.setItem('openui', q)
    return localStorage.getItem('openui') !== '0'
  } catch { return new URLSearchParams(window.location.search).get('openui') !== '0' }
})()

// **bold** and "- " bullets only; React escapes everything else.
export function Rich({ text }: { text: string }) {
  const parts = text.replace(/^\s*[-*] /gm, '• ').split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((p, i) => p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p)}</>
}

const FENCE = /```openui-lang\s*\n([\s\S]*?)(?:```|$)/g
const FATAL = new Set(['no-root', 'unknown-component'])

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function UIBlock({ code, onAsk }: { code: string; onAsk: (q: string) => void }) {
  const [broken, setBroken] = useState(false)
  const fallback = <Rich text={code} />
  if (broken) return fallback
  const onAction = (e: ActionEvent) => {
    if (e.type === 'continue_conversation') {
      const q = typeof e.params.prompt === 'string' ? e.params.prompt : e.humanFriendlyMessage
      if (q) onAsk(q)
    } else if (e.type === 'open_thread' && isThreadId(e.params.threadId)) {
      window.open(gmailLink(e.params.threadId), '_blank', 'noopener,noreferrer')
    }
    // Anything else (e.g. open_url with a model-supplied URL) is ignored on purpose.
  }
  const onError = (errs: OpenUIError[]) => { if (errs.some(x => FATAL.has(x.code))) setBroken(true) }
  return (
    <Boundary fallback={fallback}>
      <Renderer response={code} library={library} isStreaming={false} onAction={onAction} onError={onError} />
    </Boundary>
  )
}

export function AgentMessage({ text, format, onAsk }: { text: string; format?: 'openui' | 'text'; onAsk: (q: string) => void }) {
  if (format !== 'openui' || !openuiEnabled) return <Rich text={text} />
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(FENCE)) {
    const before = text.slice(last, m.index).trim()
    if (before) out.push(<Rich key={`t${last}`} text={before} />)
    out.push(<UIBlock key={`u${m.index}`} code={m[1]} onAsk={onAsk} />)
    last = (m.index ?? 0) + m[0].length
  }
  if (!out.length) {
    // Bare OpenUI Lang (no fence): prose before the first `root = Reply(` line, UI from there on.
    const at = text.search(/^root\s*=\s*Reply\(/m)
    if (at < 0) return <Rich text={text} />
    const before = text.slice(0, at).trim()
    return <div className="oui-msg">{before && <Rich text={before} />}<UIBlock code={text.slice(at)} onAsk={onAsk} /></div>
  }
  const after = text.slice(last).trim()
  if (after) out.push(<Rich key="end" text={after} />)
  return <div className="oui-msg">{out}</div>
}
