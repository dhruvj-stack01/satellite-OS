import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, AlertTriangle, ArrowUp, BrainCircuit, CheckCircle2, Database, Radio, ShieldAlert, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type Source = { id: string; title: string; type: string; timestamp?: string; source?: string }
type ChatMessage = { id?: number; role: 'user' | 'assistant'; content: string; sources: Source[]; created_at?: string }
type WorkflowRun = {
  id: number
  timestamp: string
  spacecraft_id: string
  status: string
  summary: string
  details: { steps?: string[]; findings?: Array<{ severity: string; title: string; message: string }>; actions_taken?: string[] }
}
type AIAlert = { id: number; spacecraft_id: string; severity: string; category: string; title: string; message: string; created_at: string }
type WorkflowStatus = {
  enabled: boolean
  mode: string
  interval_seconds: number
  latest_runs: WorkflowRun[]
  active_alerts: AIAlert[]
  commands_sent: number
  source: string
}
type SystemStatus = { llm_provider: string; model_name: string; llm_configured: boolean }

const panel = 'rounded-2xl border border-slate-800/90 bg-[linear-gradient(180deg,rgba(7,17,31,.94),rgba(7,17,31,.72))]'
const sessionStorageKey = 'mission-ops-ai-conversation'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function utcTime(value: string) {
  return new Date(value).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC'
}

export default function MissionAIConsole({ spacecraftId }: { spacecraftId: string }) {
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [workflow, setWorkflow] = useState<WorkflowStatus | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const refreshWorkflow = useCallback(async () => {
    const [workflowState, systemState] = await Promise.all([
      request<WorkflowStatus>('/api/ai/workflow'),
      request<SystemStatus>('/api/system'),
    ])
    setWorkflow(workflowState)
    setSystem(systemState)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        let conversation: { id: string; messages: ChatMessage[] }
        const storedId = window.localStorage.getItem(sessionStorageKey)
        if (storedId) {
          try {
            conversation = await request<{ id: string; messages: ChatMessage[] }>(`/api/ai/conversations/${encodeURIComponent(storedId)}`)
          } catch {
            conversation = await request<{ id: string; messages: ChatMessage[] }>('/api/ai/conversations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ spacecraft_id: spacecraftId }),
            })
          }
        } else {
          conversation = await request<{ id: string; messages: ChatMessage[] }>('/api/ai/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spacecraft_id: spacecraftId }),
          })
        }
        if (cancelled) return
        window.localStorage.setItem(sessionStorageKey, conversation.id)
        setConversationId(conversation.id)
        setMessages(conversation.messages)
        await refreshWorkflow()
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load the AI console.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => {
      void refreshWorkflow().catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not refresh automated workflow status.')
      })
    }, 8000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [spacecraftId, refreshWorkflow])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || !conversationId || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await request<{ answer: string; mode: string; timestamp: string; sources: Source[] }>('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, spacecraft_id: spacecraftId, message }),
      })
      setMessages((current) => [
        ...current,
        { role: 'user', content: message, sources: [], created_at: result.timestamp },
        { role: 'assistant', content: result.answer, sources: result.sources, created_at: result.timestamp },
      ])
      setDraft('')
      await refreshWorkflow()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI analysis failed.')
    } finally {
      setBusy(false)
    }
  }

  const activeRuns = workflow?.latest_runs ?? []
  const visibleRuns = activeRuns.filter((run) => run.spacecraft_id === spacecraftId).slice(0, 8)
  const activeAlerts = workflow?.active_alerts ?? []

  return (
    <div className="mb-10 grid items-start gap-5 2xl:grid-cols-[minmax(0,1.5fr)_minmax(350px,.8fr)]">
      <section className={`${panel} flex min-h-[680px] flex-col overflow-hidden`} aria-label="Satellite AI chat">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="rounded-xl border border-sky-400/20 bg-sky-400/10 p-2 text-sky-200"><BrainCircuit size={19} /></span>
            <div><h3 className="text-sm font-semibold text-white">Mission AI · {spacecraftId}</h3><p className="mt-1 text-[9px] uppercase tracking-[.16em] text-slate-500">Telemetry analysis · RAG evidence · persistent chat</p></div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-widest text-slate-300">
            <span className={`h-1.5 w-1.5 rounded-full ${system?.llm_configured ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {system ? `${system.llm_provider} · ${system.llm_configured ? 'ready' : 'needs config'}` : 'Connecting'}
          </div>
        </header>

        <div className="mission-ai-messages flex-1 space-y-4 overflow-y-auto p-4 sm:p-5" aria-live="polite">
          {loading && <div className="py-16 text-center text-xs text-slate-500">Loading saved conversation and workflow…</div>}
          {!loading && messages.length === 0 && <div className="flex min-h-[420px] flex-col items-center justify-center px-4 text-center">
            <div className="mb-4 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 text-sky-200"><Sparkles size={25} /></div>
            <h4 className="text-base font-semibold text-white">Ask about the mission data</h4>
            <p className="mt-2 max-w-md text-xs leading-5 text-slate-400">The assistant retrieves mission procedures and recent telemetry before answering. Try: “Analyze {spacecraftId} telemetry and report any concerns.”</p>
            <button type="button" onClick={() => setDraft(`Analyze ${spacecraftId} telemetry and report any concerns.`)} className="mt-5 rounded-lg border border-slate-700 px-3 py-2 text-[10px] text-sky-200 hover:border-sky-400/40">Analyze current telemetry</button>
          </div>}
          {messages.map((message, index) => <article key={message.id ?? `${message.role}-${index}`} className={`max-w-[95%] rounded-2xl border p-4 ${message.role === 'user' ? 'ml-auto border-sky-500/20 bg-sky-500/[.08]' : 'mr-auto border-slate-800 bg-black/25'}`}>
            <div className="mb-2 flex items-center justify-between gap-3 text-[9px] font-semibold uppercase tracking-widest text-slate-500">
              <span className="flex items-center gap-2">{message.role === 'assistant' ? <BrainCircuit size={12} className="text-sky-300" /> : null}{message.role === 'assistant' ? 'Mission AI' : 'You'}</span>
              {message.created_at && <time>{utcTime(message.created_at)}</time>}
            </div>
            <p className="mission-ai-message-content text-xs leading-6 text-slate-200">{message.content}</p>
            {message.role === 'assistant' && message.sources.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-800 pt-3">
              {message.sources.map((source) => <span key={`${source.id}-${source.type}`} title={`${source.type} · ${source.source ?? 'mission source'}`} className="rounded-md border border-sky-500/15 bg-sky-500/[.04] px-2 py-1 text-[8px] text-sky-200">{source.id} · {source.title}</span>)}
            </div>}
          </article>)}
          {busy && <div className="mr-auto flex items-center gap-2 rounded-xl border border-slate-800 bg-black/20 px-4 py-3 text-[10px] text-slate-400"><Activity size={13} className="animate-pulse text-sky-300" />Retrieving telemetry and evidence, then generating analysis…</div>}
          <div ref={endRef} />
        </div>

        {error && <div role="alert" className="mx-4 mb-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-200">{error}</div>}
        <form onSubmit={(event) => void sendMessage(event)} className="border-t border-slate-800 p-4">
          <label htmlFor="mission-ai-prompt" className="sr-only">Ask the satellite mission AI</label>
          <div className="flex items-end gap-2 rounded-xl border border-slate-700 bg-[#050b14] p-2 focus-within:border-sky-400/50">
            <textarea id="mission-ai-prompt" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }} rows={2} maxLength={2000} placeholder={`Ask about ${spacecraftId}, telemetry, security, or incidents…`} className="max-h-32 min-h-12 flex-1 resize-y bg-transparent px-2 py-2 text-xs leading-5 text-white outline-none placeholder:text-slate-600" />
            <button type="submit" disabled={busy || loading || !draft.trim()} aria-label="Send message" className="mb-0.5 rounded-lg bg-blue-600 p-2.5 text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"><ArrowUp size={16} /></button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[8px] uppercase tracking-wider text-slate-600"><span>Enter to send · Shift+Enter for new line</span><span>AI recommendations only · no spacecraft commands</span></div>
        </form>
      </section>

      <aside className="space-y-5" aria-label="Automated AI workflow">
        <section className={`${panel} overflow-hidden`}>
          <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-4">
            <div className="flex items-center gap-2"><span className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2 text-emerald-300"><Activity size={16} /></span><div><h3 className="text-xs font-semibold text-white">Autonomous analysis workflow</h3><p className="mt-1 text-[8px] uppercase tracking-widest text-slate-500">Read-only · every {workflow?.interval_seconds ?? 15}s</p></div></div>
            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-[8px] font-bold uppercase tracking-widest text-emerald-200">{workflow?.enabled ? 'Running' : 'Starting'}</span>
          </header>
          <div className="grid grid-cols-2 gap-2 p-4">
            {([
              ['Telemetry', 'Trend and health checks', Activity],
              ['Security', 'Integrity indicators', ShieldAlert],
              ['RAG', 'Procedures and incidents', Database],
              ['Alerts', 'Persistent in-app notices', Radio],
            ] as const).map(([title, subtitle, Icon]: readonly [string, string, LucideIcon]) => <div key={title} className="rounded-lg border border-slate-800 bg-black/20 p-3"><Icon size={14} className="mb-2 text-sky-300" /><div className="text-[9px] font-semibold text-slate-200">{title}</div><div className="mt-1 text-[8px] text-slate-500">{subtitle}</div></div>)}
          </div>
          <div className="border-t border-slate-800 px-4 py-3 text-[9px] leading-4 text-slate-500">Monitors both demo spacecraft continuously. Records findings and creates alerts; it never sends commands or changes spacecraft state.</div>
        </section>

        <section className={`${panel} overflow-hidden`}>
          <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3"><div className="flex items-center gap-2 text-xs font-semibold text-white"><AlertTriangle size={14} className={activeAlerts.length ? 'text-amber-300' : 'text-emerald-300'} />Active AI alerts</div><span className="rounded-full bg-slate-800 px-2 py-1 text-[8px] text-slate-300">{activeAlerts.length}</span></header>
          <div className="max-h-64 space-y-2 overflow-y-auto p-3">
            {activeAlerts.length === 0 && <div className="flex items-center gap-2 rounded-lg border border-emerald-500/15 bg-emerald-500/[.03] p-3 text-[10px] text-emerald-200"><CheckCircle2 size={13} />No active findings in the latest simulated checks.</div>}
            {activeAlerts.map((alert) => <article key={alert.id} className={`rounded-lg border p-3 ${alert.severity === 'CRITICAL' ? 'border-red-500/25 bg-red-500/[.05]' : alert.severity === 'HIGH' ? 'border-amber-500/25 bg-amber-500/[.04]' : 'border-slate-800 bg-black/20'}`}>
              <div className="flex items-start justify-between gap-2"><div className="text-[10px] font-semibold text-white">{alert.title}</div><span className={`shrink-0 text-[8px] font-bold uppercase tracking-widest ${alert.severity === 'CRITICAL' ? 'text-red-300' : 'text-amber-300'}`}>{alert.severity}</span></div>
              <p className="mt-1 text-[9px] leading-4 text-slate-400">{alert.message}</p><div className="mt-2 text-[8px] uppercase tracking-wider text-slate-600">{alert.spacecraft_id} · {alert.category} · {utcTime(alert.created_at)}</div>
            </article>)}
          </div>
        </section>

        <section className={`${panel} overflow-hidden`}>
          <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3"><div className="text-xs font-semibold text-white">What the AI is doing</div><span className="text-[8px] uppercase tracking-widest text-slate-500">{workflow?.source ?? 'Connecting'}</span></header>
          <div className="max-h-72 divide-y divide-slate-800/70 overflow-y-auto">
            {visibleRuns.length === 0 && <div className="p-4 text-[10px] leading-5 text-slate-500">Waiting for the first scheduled scan of {spacecraftId}.</div>}
            {visibleRuns.map((run) => <article key={run.id} className="p-3">
              <div className="flex items-center justify-between gap-2"><div className="text-[9px] font-semibold text-slate-200">{utcTime(run.timestamp)}</div><span className={`text-[8px] font-bold uppercase tracking-wider ${run.status === 'ALERT' ? 'text-amber-300' : 'text-emerald-300'}`}>{run.status}</span></div>
              <p className="mt-1 text-[9px] leading-4 text-slate-400">{run.summary}</p>
              {run.details.steps && <div className="mt-2 flex flex-wrap gap-1">{run.details.steps.map((step) => <span key={step} className="rounded bg-slate-800/70 px-1.5 py-1 text-[7px] text-slate-500">{step}</span>)}</div>}
            </article>)}
          </div>
        </section>
        <div className="rounded-xl border border-amber-500/15 bg-amber-500/[.03] p-3 text-[9px] leading-4 text-amber-100/70">Security checks are simulated indicators only. An alert requests review; it does not confirm hacking. All AI actions are analysis, storage, and notifications—not spacecraft control.</div>
      </aside>
    </div>
  )
}
