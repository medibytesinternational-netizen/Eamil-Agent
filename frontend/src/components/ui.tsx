import { ArrowUpRight, Mic, type LucideIcon } from 'lucide-react'
import type { VoiceState } from '../lib/realtime'

export function IconTile({ icon: Icon, tone = 'green', size = 34 }: { icon: LucideIcon; tone?: string; size?: number }) {
  return (
    <span className={`icon-tile ${tone}`} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.5)} strokeWidth={2.2} aria-hidden />
    </span>
  )
}

export function ArrowBtn({ onClick, label, light }: { onClick?: () => void; label: string; light?: boolean }) {
  return (
    <button className={`arrow-btn ${light ? 'light' : ''}`} onClick={onClick} aria-label={label}>
      <ArrowUpRight size={16} strokeWidth={2.2} />
    </button>
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

/** Pill bars like the reference: tallest = dark green, today = light green with % chip, above-average = green, rest = hatched. */
export function PillChart({ data }: { data: { label: string; count: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.count))
  const avg = data.reduce((s, d) => s + d.count, 0) / Math.max(1, data.length)
  const peak = data.reduce((b, d, i) => (d.count > data[b].count ? i : b), 0)
  const today = data.length - 1
  const total = data.reduce((s, d) => s + d.count, 0) || 1
  return (
    <div className="pills" role="img" aria-label={`Emails per day: ${data.map(d => `${d.label} ${d.count}`).join(', ')}`}>
      {data.map((d, i) => {
        const kind = i === peak ? 'peak' : i === today ? 'today' : d.count >= avg ? 'solid' : 'hatch'
        return (
          <div key={i} className="pill-col">
            <div className="pill-track">
              <div className={`pill ${kind}`} style={{ height: `${Math.max(34, (d.count / max) * 100)}%` }}>
                {i === today && <span className="pill-chip">{Math.round((d.count / total) * 100)}%</span>}
              </div>
            </div>
            <span className="pill-label">{d.label.charAt(0)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Semicircle gauge split into segments (last segment hatched). */
export function Gauge({ segments, center, caption }: { segments: { value: number; className: string }[]; center: string; caption: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  const R = 80, C = Math.PI * R
  let offset = 0
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 110" aria-hidden>
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--hatch-bg)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch)" strokeWidth="2.4" />
          </pattern>
        </defs>
        {segments.map((s, i) => {
          const len = (s.value / total) * C
          const el = (
            <path key={i} d="M20 100 A80 80 0 0 1 180 100" fill="none" strokeWidth="34" className={s.className}
              strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-offset} />
          )
          offset += len
          return el
        })}
      </svg>
      <div className="gauge-center"><strong>{center}</strong><span>{caption}</span></div>
    </div>
  )
}

const VOICE_LABEL: Record<VoiceState, string> = {
  idle: 'Ready', connecting: 'Connecting…', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…',
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

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const clean = name.replace(/<.*>/, '').replace(/"/g, '').trim() || name
  const initials = clean.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  const hue = [...clean].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 70% 86%)`, color: `hsl(${hue} 45% 30%)` }} aria-hidden>
      {initials}
    </span>
  )
}

export function Skeleton({ lines = 2 }: { lines?: number }) {
  return <div className="skeleton" aria-hidden>{Array.from({ length: lines }, (_, i) => <span key={i} />)}</div>
}
