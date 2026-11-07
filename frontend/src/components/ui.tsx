import { ArrowDownRight, ArrowUpRight, Mic, type LucideIcon } from 'lucide-react'
import type { VoiceState } from '../lib/realtime'

export function IconTile({ icon: Icon, tone = 'blue', size = 30 }: { icon: LucideIcon; tone?: string; size?: number }) {
  return (
    <span className={`icon-tile ${tone}`} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} aria-hidden />
    </span>
  )
}

export function Trend({ change }: { change: number | null | undefined }) {
  if (change === null || change === undefined) return null
  const up = change >= 0
  return (
    <span className={`trend ${up ? 'up' : 'down'}`}>
      {up ? <ArrowUpRight size={12} aria-hidden /> : <ArrowDownRight size={12} aria-hidden />}{Math.abs(change)}%
    </span>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

export function BarChart({ data }: { data: { label: string; count: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.count))
  const today = data.length - 1
  return (
    <div className="bars" role="img" aria-label={`Emails per day: ${data.map(d => `${d.label} ${d.count}`).join(', ')}`}>
      {data.map((d, i) => (
        <div key={d.label + i} className="bar-col">
          <span className="bar-val">{d.count}</span>
          <div className="bar-track"><div className={`bar-fill ${i === today ? 'today' : ''}`} style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }} /></div>
          <span className="bar-label">{i === today ? 'Today' : d.label}</span>
        </div>
      ))}
    </div>
  )
}

const VOICE_LABEL: Record<VoiceState, string> = {
  idle: 'Start voice', connecting: 'Connecting…', listening: 'Listening…',
  thinking: 'Thinking…', speaking: 'Speaking — talk to interrupt',
}
export const voiceLabel = (s: VoiceState) => VOICE_LABEL[s]

export function VoiceButton({ state, onClick }: { state: VoiceState; onClick: () => void }) {
  return (
    <button type="button" className={`voice-btn ${state}`} onClick={onClick}
      aria-label={state === 'idle' ? 'Start voice (Space)' : 'Stop voice'} title={VOICE_LABEL[state]}>
      {state === 'speaking' || state === 'listening'
        ? <span className="wave" aria-hidden><i /><i /><i /><i /></span>
        : <Mic size={18} aria-hidden />}
    </button>
  )
}

export function Skeleton({ lines = 2 }: { lines?: number }) {
  return <div className="skeleton" aria-hidden>{Array.from({ length: lines }, (_, i) => <span key={i} />)}</div>
}
