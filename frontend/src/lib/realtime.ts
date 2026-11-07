// OpenAI Realtime over WebRTC. The browser only ever holds a short-lived client secret.
// Function calls are relayed to the backend, which runs the Gmail tools.

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

export type VoiceCallbacks = {
  onState: (s: VoiceState) => void
  onUserTranscript: (text: string) => void
  onAgentTranscript: (text: string, done: boolean) => void
  onTool: (name: string | null) => void
  onError: (msg: string) => void
  onEnded: () => void
  recentUserText: () => string
}

const IDLE_MS = 30_000

export class VoiceSession {
  private pc?: RTCPeerConnection
  private dc?: RTCDataChannel
  private mic?: MediaStream
  private audio = new Audio()
  private idleTimer?: number
  private started = 0
  private toolCalls = 0
  private sessionId?: number
  private agentText = ''
  private ended = false
  private cb: VoiceCallbacks

  constructor(cb: VoiceCallbacks) {
    this.cb = cb
    this.audio.autoplay = true
  }

  async start(history: { role: string; text: string }[]) {
    this.cb.onState('connecting')
    try {
      const r = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? 'Could not start voice session')
      const { client_secret, voice_session_id } = await r.json()
      this.sessionId = voice_session_id

      this.pc = new RTCPeerConnection()
      this.pc.ontrack = e => { this.audio.srcObject = e.streams[0] }
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      this.mic.getTracks().forEach(t => this.pc!.addTrack(t, this.mic!))
      this.dc = this.pc.createDataChannel('oai-events')
      this.dc.onmessage = e => this.onEvent(JSON.parse(e.data))
      this.dc.onopen = () => { this.started = Date.now(); this.cb.onState('listening'); this.bump() }

      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      const sdp = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST', body: offer.sdp,
        headers: { Authorization: `Bearer ${client_secret}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdp.ok) throw new Error(`Realtime connect failed (${sdp.status})`)
      await this.pc.setRemoteDescription({ type: 'answer', sdp: await sdp.text() })
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e))
      this.stop()
    }
  }

  sendText(text: string) {
    if (!this.dc || this.dc.readyState !== 'open') return false
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    this.send({ type: 'response.create' })
    this.bump()
    return true
  }

  get active() { return !!this.pc && !this.ended }

  stop() {
    if (this.ended) return
    this.ended = true
    window.clearTimeout(this.idleTimer)
    this.mic?.getTracks().forEach(t => t.stop())
    this.dc?.close()
    this.pc?.close()
    if (this.sessionId && this.started) {
      fetch(`/api/session/${this.sessionId}/end`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_s: (Date.now() - this.started) / 1000, tool_calls: this.toolCalls }),
      }).catch(() => {})
    }
    this.cb.onState('idle')
    this.cb.onEnded()
  }

  private send(ev: object) { this.dc?.send(JSON.stringify(ev)) }

  private bump() {
    window.clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => this.stop(), IDLE_MS)
  }

  private async onEvent(ev: any) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.cb.onState('listening'); this.bump(); break
      case 'input_audio_buffer.speech_stopped':
        this.cb.onState('thinking'); break
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) this.cb.onUserTranscript(ev.transcript.trim())
        break
      case 'response.output_audio_transcript.delta':
        this.agentText += ev.delta ?? ''
        this.cb.onState('speaking'); this.cb.onAgentTranscript(this.agentText, false); this.bump(); break
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
        this.cb.onAgentTranscript(ev.transcript ?? ev.text ?? this.agentText, true); this.agentText = ''; break
      case 'response.done': {
        const calls = (ev.response?.output ?? []).filter((o: any) => o.type === 'function_call')
        if (!calls.length) { this.cb.onState('listening'); this.bump(); break }
        for (const c of calls) await this.runTool(c)
        this.send({ type: 'response.create' })
        break
      }
      case 'error':
        this.cb.onError(ev.error?.message ?? 'Realtime error'); break
    }
  }

  private async runTool(c: { name: string; call_id: string; arguments: string }) {
    this.toolCalls++
    this.cb.onState('thinking'); this.cb.onTool(c.name); this.bump()
    let output: unknown
    try {
      const r = await fetch(`/api/tool/${c.name}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: c.arguments, user_text: this.cb.recentUserText() }),
      })
      output = await r.json()
    } catch (e) {
      output = { ok: false, error: String(e) }
    }
    this.cb.onTool(null)
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(output) } })
  }
}
