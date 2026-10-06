import { useState } from 'react'
import { Activity, ArrowLeft, ArrowRight, Orbit, ShieldAlert } from 'lucide-react'
import LiveSignalCanvas, { type SignalPoint } from './LiveSignalCanvas'

type MissionAsset = {
  id: string
  name: string
  communication: string
  health_score: number
  health_state: string
  health_factors: Record<string, number>
  anomaly_score: number
  security: string
  security_checks: Array<{ evidence_id: string; check: string; status: string; timestamp: string; reason: string; source: string }>
  latitude: number
  longitude: number
  estimated_latitude: number
  estimated_longitude: number
  altitude_km: number
  speed_km_s: number
  last_known_message: {
    message_id: string
    timestamp: string
    latitude: number
    longitude: number
    telemetry: Record<string, number>
    source: string
  }
  ground_station: { id: string; location: string; visible: boolean; active: boolean; signal_strength: number | null; last_contact: string }
  reconnection: { downtime_seconds: number; assessment: string; before: { telemetry: Record<string, number>; latitude: number; longitude: number }; after: { telemetry: Record<string, number>; latitude: number; longitude: number } } | null
}
type MissionEvent = Record<string, string>
type MissionIncident = { id: string; title: string; severity: string; status: string; subsystem: string; summary: string; created_at?: string }
type MissionEvidence = { id: string; title: string; type: string; content: string; timestamp?: string; source?: string }
type MissionAudit = { id: number; timestamp: string; action: string; details: string }
type Answer = { evidence_sufficiency: string; observed_facts: string[]; hypothesis: string; recommendation: string; missing_evidence: string[]; sources: MissionEvidence[] }
type MissionSample = { timestamp: string; values: Record<string, number> }
type Tab = 'overview' | 'telemetry' | 'incidents' | 'communication' | 'security' | 'evidence' | 'audit'

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'communication', label: 'Communication' },
  { id: 'security', label: 'Security' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'audit', label: 'Audit' },
]
const metrics = [
  ['battery_voltage', 'Battery voltage', 'V'],
  ['solar_power', 'Solar power', 'W'],
  ['battery_temperature', 'Temperature', '°C'],
  ['communication_signal', 'Communication signal', 'dBm'],
  ['attitude_error', 'Attitude error', '°'],
  ['cpu_usage', 'CPU', '%'],
  ['memory_usage', 'Memory', '%'],
  ['altitude', 'Altitude', 'km'],
  ['velocity', 'Velocity', 'km/s'],
  ['anomaly_score', 'Anomaly score', '/100'],
] as const

async function postQuestion(question: string, spacecraftId: string): Promise<Answer> {
  const response = await fetch('/api/investigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, spacecraft_id: spacecraftId }),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}))
    throw new Error(failure.detail ?? `Copilot request failed (${response.status})`)
  }
  return response.json() as Promise<Answer>
}

function time(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC'
}

export default function MissionWorkspace({
  asset,
  fleet,
  tab,
  events,
  incidents,
  evidence,
  audit,
  history,
  missionTime,
  socketConnected,
  onNavigate,
  onDemoAction,
}: {
  asset: MissionAsset
  fleet: MissionAsset[]
  tab: Tab
  events: MissionEvent[]
  incidents: MissionIncident[]
  evidence: MissionEvidence[]
  audit: MissionAudit[]
  history: MissionSample[]
  missionTime: string
  socketConnected: boolean
  onNavigate: (path: string) => void
  onDemoAction: (path: string, spacecraftId: string) => Promise<void>
}) {
  const [metric, setMetric] = useState<(typeof metrics)[number][0]>('battery_voltage')
  const [windowSeconds, setWindowSeconds] = useState(30)
  const [question, setQuestion] = useState(`Why is ${asset.id} anomalous?`)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [compare, setCompare] = useState(false)
  const selectedMetric = metrics.find(([id]) => id === metric) ?? metrics[0]
  const telemetry = asset.last_known_message.telemetry
  const values: Record<string, number> = {
    ...telemetry,
    altitude: asset.altitude_km,
    velocity: asset.speed_km_s,
    anomaly_score: asset.anomaly_score,
  }
  const latestValue = values[metric] ?? 0
  const metricHistory: SignalPoint[] = history.flatMap((sample) => {
    const value = sample.values[metric]
    return typeof value === 'number' ? [{ timestamp: sample.timestamp, value }] : []
  })
  const scopedEvents = events.filter((event) => event.spacecraft_id === asset.id)
  const scopedAudits = audit.filter((entry) => entry.details.toUpperCase().includes(asset.id))
  const scopedEvidence = evidence.filter((item) => item.id.startsWith(`SEC-${asset.id.slice(-2)}`) || item.type === 'procedure' || item.type === 'historical_incident')
  const scopedIncidents = asset.id === 'ORBIT-X1' ? incidents : []

  const ask = async () => {
    if (!question.trim()) return
    setBusy(true)
    setError('')
    try {
      setAnswer(await postQuestion(question, asset.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Copilot is unavailable.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mission-workspace min-h-[calc(100vh-60px)] px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-[1500px]">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-blue-400/20 bg-blue-500/10 text-sky-300"><Orbit size={22} /></div>
            <div><div className="text-[9px] font-semibold uppercase tracking-[.28em] text-sky-300">SIMULATED MISSION ENVIRONMENT</div><h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{asset.id} <span className="text-slate-400">MISSION CONTROL</span></h1></div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[9px] font-semibold uppercase tracking-widest">
            <span className={socketConnected ? 'text-emerald-300' : 'text-amber-300'}>{socketConnected ? '● WebSocket connected' : '○ reconnecting'}</span>
            <span className="text-slate-500">{missionTime.slice(11, 19)} UTC</span>
            <button onClick={() => onNavigate('/')} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-2 text-slate-300 hover:text-white"><ArrowLeft size={12} /> Home</button>
          </div>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {fleet.map((item) => <button key={item.id} onClick={() => onNavigate(`/mission/${item.id.toLowerCase()}`)} className={`flex items-center justify-between rounded-xl border p-4 text-left transition-colors duration-200 ${item.id === asset.id ? 'border-sky-400/60 bg-sky-400/[.08]' : 'border-slate-800 bg-[#07111F] hover:border-slate-600'}`}>
            <div className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${item.id === asset.id ? 'bg-sky-300 shadow-[0_0_12px_#39b7ff]' : 'bg-slate-600'}`} /><div><div className="text-sm font-semibold text-white">{item.id}</div><div className="mt-1 text-[9px] uppercase tracking-widest text-slate-500">{item.health_state} · {item.altitude_km} km · {item.communication}</div></div></div>
            <div className="text-right"><div className="text-sm font-semibold text-slate-200">{item.health_score}%</div><div className="text-[8px] uppercase tracking-widest text-slate-500">Health</div></div>
          </button>)}
        </div>

        <nav aria-label={`${asset.id} mission sections`} className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-800 pb-2">
          {tabs.map((item) => <button key={item.id} onClick={() => onNavigate(`/mission/${asset.id.toLowerCase()}/${item.id}`)} aria-current={tab === item.id ? 'page' : undefined} className={`shrink-0 rounded-lg px-3 py-2 text-[9px] font-bold uppercase tracking-widest transition-colors ${tab === item.id ? 'bg-blue-500/15 text-sky-200' : 'text-slate-500 hover:text-white'}`}>{item.label}</button>)}
        </nav>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['MISSION STATUS', asset.health_state, asset.health_state === 'NOMINAL' ? 'text-emerald-300' : 'text-amber-300'],
            ['COMMUNICATION', asset.communication, asset.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-red-300'],
            ['HEALTH', `${asset.health_score}%`, 'text-white'],
            ['SECURITY', asset.security, asset.security.includes('POTENTIAL') ? 'text-amber-300' : 'text-slate-200'],
          ].map(([label, value, className]) => <div key={label} className="rounded-xl border border-slate-800 bg-[#07111F] p-4"><div className="text-[8px] font-semibold tracking-[.2em] text-slate-500">{label}</div><div className={`mt-2 truncate text-sm font-semibold ${className}`}>{value}</div></div>)}
        </div>

        {tab === 'overview' && <div className="grid gap-4 xl:grid-cols-[1fr_1.25fr_1fr]">
          <section className="mission-panel p-5">
            <div className="text-[9px] uppercase tracking-[.25em] text-slate-500">Spacecraft overview · simulation</div>
            <h2 className="mt-2 text-xl font-semibold text-white">{asset.id}</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {[
                ['Altitude', `${asset.altitude_km.toFixed(1)} km`],
                ['Velocity', `${asset.speed_km_s.toFixed(2)} km/s`],
                ['Latitude', `${asset.latitude.toFixed(2)}°`],
                ['Longitude', `${asset.longitude.toFixed(2)}°`],
                ['Battery', `${telemetry.battery_voltage?.toFixed(2) ?? '—'} V`],
                ['Temperature', `${telemetry.battery_temperature?.toFixed(1) ?? '—'} °C`],
                ['Solar generation', `${telemetry.solar_power?.toFixed(0) ?? '—'} W`],
                ['Anomaly score', `${asset.anomaly_score}/100`],
              ].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-800 bg-black/20 p-3"><div className="text-[8px] uppercase tracking-widest text-slate-500">{label}</div><div className="mt-1 text-xs font-semibold text-slate-100">{value}</div></div>)}
            </div>
            <div className="mt-4 rounded-lg border border-slate-800 p-3 text-[9px] leading-5 text-slate-400">Position state: <strong className={asset.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-amber-200'}>{asset.communication === 'CONNECTED' ? 'CURRENT SIMULATED TELEMETRY' : 'LAST CONFIRMED POSITION · ESTIMATE SHOWN SEPARATELY'}</strong></div>
          </section>

          <section className="mission-panel flex min-h-[360px] flex-col items-center justify-center overflow-hidden p-5">
            <div className="relative flex h-64 w-full items-center justify-center">
              <div className="earth-horizon absolute bottom-2 h-36 w-[140%] rounded-[50%] border-t border-sky-300/50" />
              <div className="earth-core" />
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 300" aria-label={`${asset.id} simulated orbit visualization`}>
                <ellipse cx="300" cy="145" rx="245" ry="105" fill="none" stroke="#28496a" strokeDasharray="5 7" />
                <circle cx="300" cy="40" r="7" fill="#48c6ff" className="mission-orbit-dot" />
                <circle cx="300" cy="40" r="15" fill="#48c6ff" opacity=".12" />
              </svg>
              <div className="absolute bottom-4 rounded-lg border border-slate-700 bg-[#07111F]/80 px-3 py-2 text-center text-[9px] uppercase tracking-widest text-slate-300">{asset.id} · SIMULATED ORBIT MODEL</div>
            </div>
            <div className="w-full border-t border-slate-800 pt-3 text-[9px] text-slate-400">{asset.ground_station.visible ? `Ground station ${asset.ground_station.id} · ${asset.ground_station.location} · ${asset.ground_station.signal_strength} dBm` : 'COMMUNICATION WINDOW CLOSED · estimated orbit only'}</div>
          </section>

          <section className="mission-panel p-5">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-white"><Activity size={14} className="text-sky-300" /> Copilot · current spacecraft {asset.id}</div>
            <input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void ask() }} className="w-full rounded-lg border border-slate-700 bg-[#05070b] px-3 py-2.5 text-xs text-white outline-none focus:border-sky-400" aria-label="Mission copilot question" />
            <button disabled={busy} onClick={() => void ask()} className="mt-3 w-full rounded-lg bg-blue-600 px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-white disabled:opacity-60">{busy ? 'Retrieving evidence…' : `Ask about ${asset.id}`}</button>
            {error && <p role="alert" className="mt-3 text-xs text-amber-200">{error}</p>}
            {answer && <div className="mt-4 space-y-3 border-t border-slate-800 pt-3 text-[10px] leading-5"><div className="font-bold uppercase tracking-widest text-sky-200">{answer.evidence_sufficiency} · {asset.id}</div>{answer.observed_facts.map((fact) => <p key={fact} className="text-slate-300">{fact}</p>)}<p className="text-amber-100">Hypothesis: {answer.hypothesis}</p><p className="text-slate-400">Next: {answer.recommendation}</p><div className="flex flex-wrap gap-1">{answer.sources.map((source) => <span key={source.id} className="rounded border border-blue-500/20 px-2 py-1 text-[8px] text-blue-200">{source.id}</span>)}</div></div>}
          </section>

          <section className="mission-panel p-5 xl:col-span-3">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xs font-semibold uppercase tracking-widest text-white">Recent spacecraft events</h2><button onClick={() => setCompare((value) => !value)} className="rounded-lg border border-slate-700 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-sky-200">{compare ? 'Hide comparison' : 'Compare satellites'}</button></div>
            {compare && <div className="mt-3 grid gap-2 sm:grid-cols-2">{fleet.map((item) => <div key={item.id} className="rounded-lg border border-slate-800 bg-black/20 p-3 text-[10px] leading-5 text-slate-300">{item.id} · Battery {item.last_known_message.telemetry.battery_voltage.toFixed(2)} V · Temperature {item.last_known_message.telemetry.battery_temperature.toFixed(1)} °C · Solar {item.last_known_message.telemetry.solar_power.toFixed(0)} W · Altitude {item.altitude_km} km · Health {item.health_score} · Anomaly {item.anomaly_score} · {item.security}</div>)}</div>}
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">{scopedEvents.slice(0, 8).map((event) => <div key={event.id} className="rounded-lg border border-slate-800 bg-black/20 p-3"><div className="text-[8px] font-bold tracking-widest text-sky-300">{event.id} · {event.event_type}</div><div className="mt-2 text-[10px] text-slate-300">{event.description}</div></div>)}</div>
            {scopedEvents.length === 0 && <p className="mt-3 text-[10px] text-slate-500">No recent events attributed to this spacecraft.</p>}
          </section>
        </div>}

        {tab === 'telemetry' && <section className="mission-panel p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><div className="text-[9px] uppercase tracking-widest text-sky-300">HIGH-FREQUENCY SIGNAL · SIMULATED</div><h2 className="mt-1 text-lg font-semibold text-white">{selectedMetric[1]} <span className="text-slate-400">{latestValue.toFixed(2)} {selectedMetric[2]}</span></h2></div>
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="mission-metric">Telemetry metric</label><select id="mission-metric" value={metric} onChange={(event) => setMetric(event.target.value as typeof metric)} className="rounded-lg border border-slate-700 bg-[#07111F] px-2 py-2 text-[9px] text-white">{metrics.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
              <label className="sr-only" htmlFor="mission-range">Graph visible time window</label><select id="mission-range" value={windowSeconds} onChange={(event) => setWindowSeconds(Number(event.target.value))} className="rounded-lg border border-slate-700 bg-[#07111F] px-2 py-2 text-[9px] text-white"><option value={15}>15 sec</option><option value={30}>30 sec</option><option value={60}>60 sec</option><option value={300}>5 min</option></select>
            </div>
          </div>
          <div className="h-[300px] overflow-hidden rounded-lg border border-slate-800"><LiveSignalCanvas points={metricHistory} latestValue={asset.communication === 'CONNECTED' ? latestValue : null} unit={selectedMetric[2]} windowSeconds={windowSeconds} status={!socketConnected ? 'paused' : asset.communication === 'CONNECTED' ? 'connected' : 'gap'} label={selectedMetric[1]} /></div>
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-[8px] uppercase tracking-widest text-slate-500"><span>{socketConnected ? 'WebSocket · 5 Hz simulated sampling · canvas interpolated at display refresh' : 'WebSocket reconnecting'}</span><span>{asset.communication === 'CONNECTED' ? `Last packet ${asset.last_known_message.message_id} · ${time(asset.last_known_message.timestamp)}` : `No new packets · last message ${asset.last_known_message.message_id} · ${time(asset.last_known_message.timestamp)}`}</span></div>
          <div className="mt-4 flex flex-wrap gap-2">{metrics.map(([id, label, unit]) => <button key={id} onClick={() => setMetric(id)} className={`rounded-lg border px-2.5 py-2 text-[8px] font-semibold uppercase tracking-wider ${metric === id ? 'border-sky-400/50 bg-sky-400/10 text-sky-200' : 'border-slate-800 text-slate-400'}`}>{label} · {values[id]?.toFixed(1) ?? '—'} {unit}</button>)}</div>
        </section>}

        {tab === 'incidents' && <section className="mission-panel p-5"><h2 className="text-lg font-semibold text-white">Incidents · {asset.id}</h2><p className="mt-1 text-[10px] text-slate-500">Incident records retain their existing mission-wide schema. Only the replay-linked active incident is attributed to ORBIT-X1.</p><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{scopedIncidents.map((item) => <article key={item.id} className="rounded-xl border border-slate-800 bg-black/20 p-4"><div className="flex justify-between text-[9px] font-bold uppercase tracking-widest text-sky-300">{item.id}<span className="text-amber-200">{item.severity} · {item.status}</span></div><h3 className="mt-3 text-sm font-semibold text-white">{item.title}</h3><p className="mt-2 text-[10px] leading-5 text-slate-400">{item.summary}</p></article>)}</div>{scopedIncidents.length === 0 && <p className="mt-5 rounded-lg border border-slate-800 p-4 text-xs text-slate-400">No incident has been attributed to {asset.id} in the current records.</p>}</section>}

        {tab === 'communication' && <section className="mission-panel p-5">
          <h2 className={`text-xl font-bold tracking-widest ${asset.communication === 'CONNECTED' ? 'text-emerald-200' : 'text-red-300'}`}>{asset.communication === 'CONNECTED' ? 'LINK CONNECTED' : 'COMMUNICATION LOST'}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[['Last contact', time(asset.last_known_message.timestamp)], ['Packet age', asset.communication === 'CONNECTED' ? 'under 1 second' : 'increasing · no packets received'], ['Signal strength', asset.ground_station.signal_strength === null ? 'Unavailable' : `${asset.ground_station.signal_strength} dBm`], ['Ground station', asset.ground_station.visible ? `${asset.ground_station.id} · ${asset.ground_station.location}` : 'COMMUNICATION WINDOW CLOSED']].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-800 bg-black/20 p-3"><div className="text-[8px] uppercase tracking-widest text-slate-500">{label}</div><div className="mt-2 text-xs text-white">{value}</div></div>)}
          </div>
          <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4"><div className="text-[9px] font-bold uppercase tracking-widest text-amber-200">Last confirmed state · {asset.last_known_message.message_id}</div><div className="mt-3 grid grid-cols-2 gap-3 text-[10px] text-slate-300 sm:grid-cols-4"><span>{asset.last_known_message.latitude.toFixed(2)}°, {asset.last_known_message.longitude.toFixed(2)}°</span><span>{telemetry.battery_voltage?.toFixed(2)} V battery</span><span>{telemetry.battery_temperature?.toFixed(1)} °C thermal</span><span>{telemetry.solar_power?.toFixed(0)} W solar</span></div><p className="mt-3 text-[9px] text-amber-100">Estimated position {asset.estimated_latitude.toFixed(2)}°, {asset.estimated_longitude.toFixed(2)}° is a model estimate, not telemetry confirmed. State during the link gap cannot be verified.</p></div>
          <div className="mt-4 flex gap-2">{asset.communication === 'CONNECTED' ? <button onClick={() => void onDemoAction('/api/demo/communication-loss', asset.id)} className="rounded-lg border border-red-500/30 px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-red-200">Simulate communication loss</button> : <button onClick={() => void onDemoAction('/api/demo/reconnect', asset.id)} className="rounded-lg border border-emerald-500/30 px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-emerald-200">Restore communication</button>}</div>
          {asset.reconnection && <div className="mt-4 rounded-lg border border-emerald-500/20 p-4 text-[10px] leading-5 text-emerald-100">Reconnected. Downtime {Math.floor(asset.reconnection.downtime_seconds / 60)}m {asset.reconnection.downtime_seconds % 60}s. Battery {asset.reconnection.before.telemetry.battery_voltage.toFixed(2)} → {asset.reconnection.after.telemetry.battery_voltage.toFixed(2)} V; temperature {asset.reconnection.before.telemetry.battery_temperature.toFixed(1)} → {asset.reconnection.after.telemetry.battery_temperature.toFixed(1)} °C. {asset.reconnection.assessment}</div>}
        </section>}

        {tab === 'security' && <section className="mission-panel p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">Security evidence · {asset.id}</h2><p className="mt-1 text-[10px] text-slate-500">Simulated checks only. A warning is not proof of compromise.</p></div><ShieldAlert className="text-amber-300" size={20} /></div><div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{asset.security_checks.map((item) => <div key={item.evidence_id} className="rounded-lg border border-slate-800 bg-black/20 p-3"><div className="flex justify-between gap-2 text-xs text-slate-200">{item.check}<strong className={item.status === 'VERIFIED' ? 'text-emerald-300' : 'text-amber-300'}>{item.status}</strong></div><div className="mt-2 text-[8px] text-sky-300">{item.evidence_id} · {time(item.timestamp)}</div><p className="mt-1 text-[9px] leading-4 text-slate-500">{item.reason}</p></div>)}</div><button onClick={() => void onDemoAction('/api/demo/security-event', asset.id)} className="mt-4 rounded-lg border border-amber-500/30 px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-amber-200">Simulate security event</button></section>}

        {tab === 'evidence' && <section className="mission-panel p-5"><h2 className="text-lg font-semibold text-white">Evidence · {asset.id}</h2><div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{[...scopedEvidence, { id: asset.last_known_message.message_id, title: 'Last received telemetry packet', type: 'telemetry', content: JSON.stringify(asset.last_known_message.telemetry), timestamp: asset.last_known_message.timestamp, source: asset.last_known_message.source }].map((item) => <article key={item.id} className="rounded-lg border border-slate-800 bg-black/20 p-3"><div className="flex justify-between gap-2 text-[8px] uppercase tracking-widest text-sky-300"><span>{item.type}</span><span>{item.id}</span></div><h3 className="mt-2 text-xs font-semibold text-white">{item.title}</h3><p className="mt-2 text-[9px] leading-4 text-slate-400">{item.content}</p><div className="mt-2 text-[8px] text-slate-600">{item.source ?? 'DEMO KNOWLEDGE BASE'} · {item.timestamp ? time(item.timestamp) : 'reference'}</div></article>)}</div></section>}

        {tab === 'audit' && <section className="mission-panel p-5"><h2 className="text-lg font-semibold text-white">Audit trail · {asset.id}</h2><div className="mt-4 space-y-2">{scopedAudits.map((item) => <article key={item.id} className="flex flex-wrap justify-between gap-3 rounded-lg border border-slate-800 bg-black/20 p-3"><span className="text-[9px] font-bold uppercase tracking-widest text-sky-300">{item.action}</span><span className="text-[9px] text-slate-400">{time(item.timestamp)}</span><p className="w-full text-[9px] text-slate-400">{item.details}</p></article>)}</div>{scopedAudits.length === 0 && <p className="mt-4 text-xs text-slate-500">No audit records currently identify this spacecraft.</p>}</section>}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[8px] uppercase tracking-widest text-slate-600"><span>SIMULATED MISSION DATA · NO REAL SPACECRAFT CONNECTION</span><button onClick={() => onNavigate('/#mission')} className="inline-flex items-center gap-2 text-slate-400 hover:text-white">Mission overview <ArrowRight size={11} /></button></div>
      </div>
    </section>
  )
}
