import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { motion } from 'framer-motion'
import {
  Activity, AlertTriangle, ArrowRight, ArrowUpRight, BrainCircuit, Check, Database, FileSearch,
  ChevronDown, Menu, Orbit, Play, Search, Send, ShieldCheck, ShieldAlert, Square, X, Satellite,
} from 'lucide-react'
import './App.css'
import LiveSignalCanvas from './LiveSignalCanvas'
import MissionWorkspace from './MissionWorkspace'
const SpaceMissionScene = lazy(() => import('./SpaceMissionScene'))

type Parameter = 'battery_voltage' | 'solar_power' | 'battery_temperature' | 'communication_signal' | 'attitude_error' | 'cpu_usage' | 'memory_usage' | 'reaction_wheel_speed'
type MetricMeta = { label: string; unit: string; min: number; max: number; warning: number; critical: number }
type LiveMessage = { type: string; timestamp: string; source: string; values?: Record<Parameter, number>; anomalies?: Record<string, { anomaly_score: number; status: string; value: number }>; events?: Array<Record<string, string>>; mission_fleet?: FleetAsset[]; running?: boolean; replay_step?: number }
type Incident = { id: string; title: string; severity: string; status: string; subsystem: string; summary: string; created_at?: string }
type Evidence = { id: string; title: string; type: string; content: string; score?: number; timestamp?: string; value?: number; unit?: string; source?: string }
type Investigation = { mode: string; question: string; evidence_sufficiency: string; observed_facts: string[]; correlated_events: Array<Record<string, string>>; historical_context: Evidence[]; hypothesis: string; recommendation: string; confidence: string; validation: Array<{ claim: string; status: string; sources: string[] }>; missing_evidence: string[]; sources: Evidence[] }
type AuditItem = { id: number; timestamp: string; action: string; details: string }
type LiveState = { timestamp: string; values: Record<Parameter, number>; anomalies: Record<string, { anomaly_score: number; status: string; value: number }>; running: boolean; replay_step: number }
type MissionSample = { timestamp: string; values: Record<string, number> }
type TelemetryAnalysis = {
  spacecraft_id: string
  parameter: Parameter
  label: string
  unit: string
  window_seconds: number
  source: string[]
  communication: string
  latest_age_seconds: number | null
  sample_count: number
  statistics: { mean: number | null; minimum: number | null; maximum: number | null; standard_deviation: number | null }
  trend: { direction: string; delta: number | null; slope_per_minute: number | null }
  status_counts: Record<'NORMAL' | 'WARNING' | 'CRITICAL', number>
  anomaly_count: number
  gap_count: number
  battery_solar_correlation: number | null
  correlation_sample_count: number
  samples: Array<{ timestamp: string; parameter: string; value: number; unit: string; source: string; anomaly_score: number; status: string }>
  analysis_source: string
  interpretation: string
}
type FleetAsset = {
  id: string; name: string; mission: string; source: string; latitude: number; longitude: number;
  estimated_latitude: number; estimated_longitude: number; altitude_km: number; speed_km_s: number;
  communication: string; position_status: string; safety: string; security: string;
  health_score: number; health_state: string; health_factors: Record<string, number>; anomaly_score: number;
  last_known_message: { message_id: string; timestamp: string; latitude: number; longitude: number; source: string; telemetry: Record<string, number>; safety_assessment: string; security_state: string };
  security_checks: Array<{ evidence_id: string; check: string; status: string; timestamp: string; reason: string; source: string }>;
  ground_station: { id: string; location: string; state: string; visible: boolean; active: boolean; signal_strength: number | null; last_contact: string };
  reconnection: { restored_at: string; downtime_seconds: number; before: FleetAsset['last_known_message']; after: FleetAsset['last_known_message']; gap_state_verifiable: boolean; assessment: string } | null;
  communication_lost_at: string | null;
}
type GroundStation = { id: string; location: string; latitude: number; longitude: number; state: string; visible_spacecraft: string[] }

const APP_VERSION = '1.1.0'
const PARAMS: Array<{ id: Parameter; label: string; unit: string }> = [
  { id: 'battery_voltage', label: 'Battery voltage', unit: 'V' },
  { id: 'solar_power', label: 'Solar power', unit: 'W' },
  { id: 'battery_temperature', label: 'Temperature', unit: '°C' },
  { id: 'communication_signal', label: 'Communication', unit: 'dBm' },
  { id: 'attitude_error', label: 'Attitude error', unit: '°' },
  { id: 'cpu_usage', label: 'CPU usage', unit: '%' },
  { id: 'memory_usage', label: 'Memory', unit: '%' },
  { id: 'reaction_wheel_speed', label: 'Reaction wheel', unit: 'RPM' },
]
const NAV = [
  ['Mission', 'mission'], ['Telemetry', 'telemetry'], ['Incidents', 'incidents'], ['AI Copilot', 'copilot'],
  ['Security', 'security'], ['Evidence', 'evidence'], ['Audit', 'audit'], ['Safety', 'safety'], ['Architecture', 'architecture'],
  ['Ingestion', 'data'], ['Analysis', 'analysis'],
]
const featureHref = (id: string) => `/#${id}`
const fmtTime = (value?: string) => value ? new Date(value).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC' : '--:--:-- UTC'
const card = 'panel-surface rounded-2xl border border-slate-800/90'
const chip = 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function SectionTitle({ eyebrow, title, summary }: { eyebrow: string; title: string; summary: string }) {
  return <div className="mb-7 max-w-3xl"><div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.35em] text-[#00A8FF]">{eyebrow}</div><h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">{title}</h2><p className="mt-3 text-sm leading-6 text-slate-400">{summary}</p></div>
}

function App() {
  const [live, setLive] = useState<LiveState | null>(null)
  const [metrics, setMetrics] = useState<Record<string, MetricMeta>>({})
  const [parameter, setParameter] = useState<Parameter>('battery_voltage')
  const [events, setEvents] = useState<Array<Record<string, string>>>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [documents, setDocuments] = useState<Evidence[]>([])
  const [audit, setAudit] = useState<AuditItem[]>([])
  const [fleet, setFleet] = useState<FleetAsset[]>([])
  const [groundStations, setGroundStations] = useState<GroundStation[]>([])
  const [missionHistory, setMissionHistory] = useState<Record<string, MissionSample[]>>({})
  const [selectedSatellite, setSelectedSatellite] = useState(() => window.location.pathname.match(/^\/mission\/(orbit-x[12])(?:\/|$)/i)?.[1].toUpperCase() ?? 'ORBIT-X1')
  const [routePath, setRoutePath] = useState(window.location.pathname)
  const [simulationRunning, setSimulationRunning] = useState(true)
  const [socketConnected, setSocketConnected] = useState(false)
  const [error, setError] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [query, setQuery] = useState('Why did battery voltage decrease?')
  const [answer, setAnswer] = useState<Investigation | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('All')
  const [incidentFilter, setIncidentFilter] = useState('All')
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null)
  const [contactState, setContactState] = useState('')
  const [ingestState, setIngestState] = useState('')
  const [chartWindowSeconds, setChartWindowSeconds] = useState(30)
  const [analysisWindowSeconds, setAnalysisWindowSeconds] = useState(300)
  const [analysisResult, setAnalysisResult] = useState<{ key: string; data?: TelemetryAnalysis; error?: string } | null>(null)
  const [timeNow, setTimeNow] = useState(() => new Date())
  const [incidentAlert, setIncidentAlert] = useState(false)
  const refreshDataRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const missionHistoryRef = useRef<Record<string, MissionSample[]>>({})
  const packetStreamRef = useRef<Record<string, FleetAsset['last_known_message'][]>>({})

  const navigateTo = useCallback((path: string) => {
    window.history.pushState({}, '', path)
    setRoutePath(window.location.pathname)
    const match = window.location.pathname.match(/^\/mission\/(orbit-x[12])(?:\/|$)/i)
    if (match) setSelectedSatellite(match[1].toUpperCase())
  }, [])

  useEffect(() => {
    const onPopState = () => {
      setRoutePath(window.location.pathname)
      const match = window.location.pathname.match(/^\/mission\/(orbit-x[12])(?:\/|$)/i)
      if (match) setSelectedSatellite(match[1].toUpperCase())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (/^\/mission\/orbit-x[12](\/|$)/i.test(window.location.pathname)) return
    const pathToSection: Record<string, string> = {
      '/dashboard': 'telemetry', '/mission': 'mission', '/telemetry': 'telemetry',
      '/investigation': 'incidents', '/incidents': 'incidents', '/copilot': 'copilot',
      '/evidence': 'evidence', '/security': 'security', '/audit': 'audit',
      '/knowledge': 'evidence', '/settings': 'architecture', '/safety': 'safety',
      '/architecture': 'architecture', '/ingestion': 'data',
    }
    const section = pathToSection[window.location.pathname]
    if (section) window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [])

  const refreshData = useCallback(async () => {
    try {
      const [dashboard, eventRows, incidentRows, docs, auditRows, spacecraftRows, groundStationRows] = await Promise.all([
        api<{ timestamp: string; values: Record<Parameter, { value: number; label: string; unit: string; min: number; max: number; warning: number; critical: number; status: string }>; running: boolean; replay_step: number }>('/api/telemetry/latest'),
        api<Array<Record<string, string>>>('/api/events'),
        api<Incident[]>('/api/incidents'),
        api<Evidence[]>('/api/evidence-library').catch(() => []),
        api<AuditItem[]>('/api/audit'),
        api<FleetAsset[]>('/api/spacecraft'),
        api<GroundStation[]>('/api/mission/ground-stations'),
      ])
      const values = Object.fromEntries(Object.entries(dashboard.values).map(([key, value]) => [key, value.value])) as Record<Parameter, number>
      const anomalies = Object.fromEntries(Object.entries(dashboard.values).map(([key, value]) => [key, { value: value.value, status: value.status, anomaly_score: Number((value as typeof value & { anomaly_score?: number }).anomaly_score ?? 0) }]))
      setLive({ timestamp: dashboard.timestamp, values, anomalies, running: dashboard.running, replay_step: dashboard.replay_step })
      setSimulationRunning(dashboard.running)
      setMetrics(Object.fromEntries(Object.entries(dashboard.values).map(([key, value]) => [key, value])))
      setEvents(eventRows)
      setIncidents(incidentRows)
      setDocuments(docs)
      setAudit(auditRows)
      setFleet(spacecraftRows)
      setGroundStations(groundStationRows)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load mission data. Check that the backend is running.')
    }
  }, [])
  useEffect(() => {
    refreshDataRef.current = refreshData
  }, [refreshData])

  useEffect(() => {
    void refreshData()
    const timer = window.setInterval(() => setTimeNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [refreshData])

  useEffect(() => {
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let stopped = false
    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${window.location.host}/ws/telemetry`)
      socket.onopen = () => setSocketConnected(true)
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as LiveMessage
        if (message.mission_fleet) {
          setFleet(message.mission_fleet)
          const nextSamples: Record<string, MissionSample[]> = {}
          const nextPackets: Record<string, FleetAsset['last_known_message'][]> = {}
          for (const asset of message.mission_fleet) {
            const oldSamples = missionHistoryRef.current[asset.id] ?? []
            const previousPackets = packetStreamRef.current[asset.id] ?? []
            const packetChanged = previousPackets[previousPackets.length - 1]?.message_id !== asset.last_known_message.message_id
            const packetTimestamp = asset.last_known_message.timestamp
            const sampleValues = {
              ...asset.last_known_message.telemetry,
              altitude: asset.altitude_km,
              velocity: asset.speed_km_s,
              anomaly_score: asset.anomaly_score,
            }
            nextSamples[asset.id] = asset.communication === 'CONNECTED' && packetChanged
              ? [...oldSamples, { timestamp: packetTimestamp, values: sampleValues }].slice(-1500)
              : oldSamples
            nextPackets[asset.id] = asset.communication === 'CONNECTED' && packetChanged
              ? [...previousPackets, asset.last_known_message].slice(-12)
              : previousPackets
          }
          missionHistoryRef.current = { ...missionHistoryRef.current, ...nextSamples }
          packetStreamRef.current = { ...packetStreamRef.current, ...nextPackets }
          setMissionHistory((previous) => ({ ...previous, ...nextSamples }))
        }
        if (message.events) setEvents(message.events)
        if (!message.values) return
        const next: LiveState = {
          timestamp: message.timestamp,
          values: message.values,
          anomalies: message.anomalies ?? {},
          running: Boolean(message.running),
          replay_step: message.replay_step ?? -1,
        }
        setLive(next)
        setSimulationRunning(next.running)
        if (message.replay_step === 18) {
          setIncidentAlert(true)
          void refreshDataRef.current()
        }
      }
      socket.onclose = () => {
        setSocketConnected(false)
        if (!stopped) retryTimer = window.setTimeout(connect, 2500)
      }
      socket.onerror = () => socket?.close()
    }
    connect()
    return () => {
      stopped = true
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  const analysisRequestKey = `${selectedSatellite}:${parameter}:${analysisWindowSeconds}`
  useEffect(() => {
    let cancelled = false
    let requestInFlight = false
    const refreshAnalysis = async () => {
      if (requestInFlight) return
      requestInFlight = true
      try {
        const result = await api<TelemetryAnalysis>(
          `/api/telemetry/analysis?spacecraft_id=${encodeURIComponent(selectedSatellite)}&parameter=${parameter}&window_seconds=${analysisWindowSeconds}`,
        )
        if (!cancelled) setAnalysisResult({ key: analysisRequestKey, data: result })
      } catch (cause) {
        if (!cancelled) setAnalysisResult({ key: analysisRequestKey, error: cause instanceof Error ? cause.message : 'Telemetry analysis is unavailable.' })
      } finally {
        requestInFlight = false
      }
    }
    void refreshAnalysis()
    const timer = window.setInterval(() => void refreshAnalysis(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [analysisRequestKey, selectedSatellite, parameter, analysisWindowSeconds])

  const analysisEntry = analysisResult?.key === analysisRequestKey ? analysisResult : null
  const analysis = analysisEntry?.data ?? null
  const analysisError = analysisEntry?.error ?? ''
  const analysisLoading = !analysis && !analysisError
  const selectedMetric = metrics[parameter]
  const primaryAsset = fleet.find((asset) => asset.id === 'ORBIT-X1')
  const routeMatch = routePath.match(/^\/mission\/(orbit-x[12])(?:\/(overview|telemetry|incidents|communication|security|evidence|audit))?\/?$/i)
  const missionRoute = routeMatch !== null
  const missionAssetId = routeMatch?.[1].toUpperCase() ?? selectedSatellite
  const missionTab = (routeMatch?.[2]?.toLowerCase() ?? 'overview') as 'overview' | 'telemetry' | 'incidents' | 'communication' | 'security' | 'evidence' | 'audit'
  const missionAsset = fleet.find((asset) => asset.id === missionAssetId)
  const activeAsset = fleet.find((asset) => asset.id === selectedSatellite) ?? primaryAsset
  const latestValue = activeAsset?.last_known_message.telemetry[parameter] ?? live?.values[parameter]
  const anomaly = activeAsset?.id === 'ORBIT-X1' ? live?.anomalies[parameter] : undefined
  const missionSamples = missionHistory[missionAssetId] ?? []
  const missionChartPoints = missionSamples.flatMap((sample) => {
    const value = sample.values[parameter]
    return typeof value === 'number' ? [{ timestamp: sample.timestamp, value, status: (missionAsset?.anomaly_score ?? 0) >= 60 ? 'WARNING' : 'NORMAL' }] : []
  })
  const visibleChartPoints = missionChartPoints.filter((point) => Date.parse(point.timestamp) >= timeNow.getTime() - chartWindowSeconds * 1000)
  const chartStatus = !socketConnected ? 'paused' : activeAsset?.communication === 'CONNECTED' ? 'connected' : 'gap'
  const chartStats = useMemo(() => {
    const values = visibleChartPoints.map((point) => point.value)
    return { min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0, average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0, anomalies: visibleChartPoints.filter((point) => point.status && point.status !== 'NORMAL').length }
  }, [visibleChartPoints])
  const analysisSamples = analysis?.samples ?? []
  const analysisMetricPoints = analysisSamples.map((sample) => sample.value)
  const analysisMean = analysis?.statistics.mean ?? null
  const analysisMin = analysis?.statistics.minimum ?? null
  const analysisMax = analysis?.statistics.maximum ?? null
  const analysisDelta = analysis?.trend.delta ?? null
  const analysisUnit = PARAMS.find((item) => item.id === parameter)?.unit ?? ''
  const analysisTrend = analysis?.trend.direction ?? (analysisLoading ? 'ANALYZING' : 'INSUFFICIENT SAMPLES')
  const batterySolarCorrelation = analysis?.battery_solar_correlation ?? null
  const anomalousSamples = analysis?.anomaly_count ?? 0
  const filteredIncidents = incidents.filter((item) => incidentFilter === 'All' || item.status.toLowerCase() === incidentFilter.toLowerCase() || item.severity.toLowerCase() === incidentFilter.toLowerCase())
  const alarmCount = Object.values(live?.anomalies ?? {}).filter((item) => item.status !== 'NORMAL').length

  const postAction = async (path: string) => {
    try {
      await api(path, { method: 'POST' })
      if (path.endsWith('/replay-incident')) setIncidentAlert(false)
      await refreshData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation action failed')
    }
  }

  const runDemoAction = async (path: string, spacecraftId: string) => {
    try {
      await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spacecraft_id: spacecraftId }),
      })
      await refreshData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation scenario failed')
    }
  }

  const resetMissionDemo = async () => {
    try {
      await api('/api/demo/reset', { method: 'POST' })
      await refreshData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation reset failed')
    }
  }

  const askCopilot = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    try {
      const result = await api<Investigation>('/api/investigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: query, incident_id: 'INC-024' }) })
      setAnswer(result)
      const rows = await api<AuditItem[]>('/api/audit')
      setAudit(rows)
      document.getElementById('copilot-answer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Investigation failed')
    } finally {
      setBusy(false)
    }
  }

  const submitContact = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      const result = await api<{ message: string }>('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) })
      setContactState(result.message)
      event.currentTarget.reset()
    } catch (e) {
      setContactState(e instanceof Error ? e.message : 'Message could not be sent.')
    }
  }

  const uploadFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('telemetry-file') as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      const contentType = file.name.toLowerCase().endsWith('.json') ? 'application/json' : 'text/csv'
      const result = await api<{ stored: number; source: string }>('/api/telemetry/ingest?source=PUBLIC%20HISTORICAL%20DATA', { method: 'POST', headers: { 'Content-Type': contentType }, body: await file.text() })
      setIngestState(`${result.stored} validated records added as ${result.source}.`)
      event.currentTarget.reset()
      await refreshData()
    } catch (e) {
      setIngestState(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  const retrieveEvidence = async (item: Evidence) => {
    try {
      const full = await api<Evidence>(`/api/evidence/${encodeURIComponent(item.id)}`)
      setSelectedEvidence(full)
    } catch {
      setSelectedEvidence(item)
    }
  }

  return (
    <div className="min-h-screen bg-[#05070B] text-slate-100">
      <nav className="sticky top-0 z-40 border-b border-white/10 bg-[#05070B]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-3 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <a href="#home" className="flex shrink-0 items-center gap-2.5" aria-label="Mission Operations Copilot home">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/15 text-[#00A8FF]"><Orbit size={19} /></div>
              <span className="text-xs font-bold tracking-[0.15em] text-white">MISSION <span className="text-[#00A8FF]">OPS</span><span className="ml-1.5 text-[8px] font-medium tracking-wider text-slate-500">v{APP_VERSION}</span></span>
            </a>
            <label className="spacecraft-picker flex items-center gap-2 rounded-xl border border-sky-400/25 bg-sky-400/[.06] px-2.5 py-1.5">
              <Satellite size={14} className="shrink-0 text-sky-300" />
              <span className="hidden text-[8px] font-bold uppercase tracking-[.15em] text-slate-500 sm:inline">Spacecraft</span>
              <select
                aria-label="Select spacecraft"
                value={selectedSatellite}
                onChange={(event) => {
                  const spacecraftId = event.target.value
                  setSelectedSatellite(spacecraftId)
                  navigateTo(`/mission/${spacecraftId.toLowerCase()}`)
                }}
                className="max-w-[116px] cursor-pointer bg-transparent text-[10px] font-bold tracking-wider text-sky-100 outline-none"
              >
                <option value="ORBIT-X1">ORBIT-X1</option>
                <option value="ORBIT-X2">ORBIT-X2</option>
              </select>
            </label>
          </div>
          <div className="hidden items-center gap-5 xl:flex">
            <details className="group relative">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300 transition hover:text-white">
                Features <ChevronDown size={13} className="transition group-open:rotate-180" />
              </summary>
              <div className="absolute right-0 top-full z-50 mt-3 grid min-w-48 gap-1 rounded-xl border border-slate-700 bg-[#07111F] p-2 shadow-2xl">
                {NAV.map(([label, id]) => <a key={id} href={featureHref(id)} target="_blank" rel="noopener noreferrer" className="rounded-lg px-3 py-2 text-[10px] uppercase tracking-widest text-slate-300 transition hover:bg-slate-800 hover:text-white">{label}</a>)}
              </div>
            </details>
            <a href="#contact" className="rounded-lg bg-blue-600 px-4 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-white transition hover:bg-blue-500">Start demo</a>
          </div>
          <button onClick={() => setMobileMenu((open) => !open)} className="rounded-lg border border-slate-700 p-2 text-slate-200 xl:hidden" aria-label="Toggle navigation">{mobileMenu ? <X size={18} /> : <Menu size={18} />}</button>
        </div>
        {mobileMenu && <div className="border-t border-slate-800 bg-[#07111F] p-4 xl:hidden">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-200">
              Features <ChevronDown size={15} className="transition group-open:rotate-180" />
            </summary>
            <div className="mt-1 grid gap-1 border-l border-slate-700 pl-3">
              {NAV.map(([label, id]) => <a onClick={() => setMobileMenu(false)} key={id} href={featureHref(id)} target="_blank" rel="noopener noreferrer" className="rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-slate-300 hover:bg-slate-800">{label}</a>)}
            </div>
          </details>
          <a href="#contact" className="mt-2 block rounded-lg bg-blue-600 px-3 py-2 text-xs uppercase tracking-widest">Start demo</a>
        </div>}
      </nav>

      {error && <div role="alert" className="fixed right-4 top-20 z-50 max-w-lg rounded-xl border border-amber-500/30 bg-[#121821] p-4 text-sm text-amber-100 shadow-2xl"><div className="flex items-center justify-between gap-4"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div></div>}
      {incidentAlert && <div role="alert" className="fixed right-4 top-20 z-40 max-w-md rounded-xl border border-red-500/35 bg-[#160b10]/95 p-4 shadow-2xl backdrop-blur"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-red-200"><AlertTriangle size={14} /> High severity · INC-024</div><p className="mt-2 text-sm font-semibold text-white">Battery Voltage Degradation</p><button onClick={() => { setQuery('What happened in INC-024?'); setIncidentAlert(false); document.getElementById('copilot')?.scrollIntoView({ behavior: 'smooth' }) }} className="mt-3 text-[10px] font-bold uppercase tracking-widest text-red-200 underline underline-offset-4">Investigate</button></div><button onClick={() => setIncidentAlert(false)} aria-label="Dismiss incident alert" className="text-slate-400 hover:text-white"><X size={15} /></button></div></div>}

      {missionRoute && missionAsset && <MissionWorkspace
        key={`${missionAsset.id}-${missionTab}`}
        asset={missionAsset}
        fleet={fleet}
        tab={missionTab}
        events={events}
        incidents={incidents}
        evidence={documents}
        audit={audit}
        history={missionSamples}
        missionTime={timeNow.toISOString()}
        socketConnected={socketConnected}
        onNavigate={navigateTo}
        onDemoAction={runDemoAction}
      />}

      {!missionRoute && <main>
        <Suspense fallback={<section id="home" className="flex h-[calc(100svh-61px)] items-center justify-center bg-[#020712] text-xs font-semibold uppercase tracking-widest text-sky-200">Loading 3D simulated mission view…</section>}>
          <SpaceMissionScene
            fleet={fleet}
            groundStations={groundStations}
            socketConnected={socketConnected}
            onSelectSpacecraft={(spacecraftId) => {
              setSelectedSatellite(spacecraftId)
              navigateTo(`/mission/${spacecraftId.toLowerCase()}`)
            }}
          />
        </Suspense>

        <section className="border-y border-slate-800/70 bg-[#07111F]/70 px-5 py-5 lg:px-10">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${socketConnected ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} /><span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-slate-200">{socketConnected ? 'Simulation stream connected' : 'Connecting to simulation stream'}</span></div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[10px] uppercase tracking-[0.16em] text-slate-400"><span>UTC {timeNow.toISOString().slice(11, 19)}</span><span>Mission ORBIT-X1</span><span>Mode deterministic demo</span><span>API {error ? 'degraded' : 'online'}</span></div>
          </div>
        </section>

        <section id="mission-preview" className="scroll-mt-20 border-b border-slate-800 bg-[#060b12] px-5 py-12 lg:px-10">
          <div className="mx-auto max-w-[1440px]">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
              <div><div className="text-[9px] font-semibold uppercase tracking-[.28em] text-sky-300">LIVE MISSION PREVIEW · SHARED BACKEND STATE</div><h2 className="mt-2 text-2xl font-semibold text-white">Select your spacecraft</h2><p className="mt-2 text-xs text-slate-400">SIMULATED MISSION DATA · refreshed over the mission WebSocket</p></div>
              <a href="#telemetry" className="text-[9px] font-bold uppercase tracking-widest text-sky-200 hover:text-white">Explore live mission <ArrowRight className="ml-1 inline" size={12} /></a>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {fleet.map((asset) => <button key={asset.id} onClick={() => navigateTo(`/mission/${asset.id.toLowerCase()}`)} className={`mission-preview-card rounded-xl border p-4 text-left transition ${selectedSatellite === asset.id ? 'border-sky-400/50 bg-sky-400/[.06]' : 'border-slate-800 bg-[#07111F] hover:border-slate-600'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold text-white"><Satellite size={15} className="text-sky-300" />{asset.id}</div><span className={`text-[8px] font-bold uppercase tracking-widest ${asset.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-red-300'}`}>● {asset.health_state} · {asset.communication}</span></div>
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[9px] sm:grid-cols-3">
                  {[
                    ['ALTITUDE', `${asset.altitude_km.toFixed(1)} km`],
                    ['VELOCITY', `${asset.speed_km_s.toFixed(2)} km/s`],
                    ['BATTERY', `${asset.last_known_message.telemetry.battery_voltage.toFixed(2)} V`],
                    ['TEMPERATURE', `${asset.last_known_message.telemetry.battery_temperature.toFixed(1)} °C`],
                    ['COMMUNICATION', asset.communication],
                    ['ANOMALY SCORE', `${asset.anomaly_score}/100`],
                  ].map(([label, value]) => <div key={label}><div className="text-slate-500">{label}</div><div className="mt-1 font-semibold text-slate-200">{value}</div></div>)}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3 text-[9px] uppercase tracking-widest text-sky-200"><span>Open {asset.id} mission control</span><ArrowRight size={13} /></div>
              </button>)}
              {fleet.length === 0 && <div className="rounded-xl border border-slate-800 p-5 text-xs text-slate-400">Waiting for backend mission telemetry…</div>}
            </div>
          </div>
        </section>

        <section id="mission" className="scroll-mt-20 px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="01 / HOW IT WORKS" title="From telemetry to traceable decisions." summary="The workflow detects unusual signals, correlates nearby events, retrieves procedures and incident history, validates claims, and leaves the final decision with the operator." />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {[
                [Database, '01 / INGEST', 'Validate telemetry', 'Normalize and label every datum with its source and timestamp.'],
                [Activity, '02 / DETECT', 'Find deviations', 'Compare the stream with its baseline and score unusual behavior.'],
                [FileSearch, '03 / INVESTIGATE', 'Retrieve evidence', 'Search procedure and incident documents before generating an explanation.'],
                [ShieldCheck, '04 / VALIDATE', 'Keep a human in control', 'Separate facts, hypotheses, recommendations, unknowns and audit records.'],
              ].map(([Icon, step, title, text]: any, index) => <motion.article key={step} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.08 }} className={`${card} p-5`}><Icon className="mb-5 h-5 w-5 text-[#00A8FF]" /><div className="text-[9px] font-semibold tracking-[0.25em] text-slate-500">{step}</div><h3 className="mt-2 text-lg font-semibold text-white">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{text}</p></motion.article>)}
            </div>
          </div>
        </section>

        <section id="telemetry" className="scroll-mt-20 border-y border-slate-800/70 bg-[#060B12] px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
              <SectionTitle eyebrow="02 / LIVE MISSION DASHBOARD" title="Telemetry intelligence." summary="A continuously refreshed simulation stream—not a live spacecraft connection. Values, history, and anomaly assessments come from the FastAPI backend." />
              <div className="mb-7 flex flex-wrap gap-2">
                <button onClick={() => void postAction(simulationRunning ? '/api/simulation/stop' : '/api/simulation/start')} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest hover:border-blue-400">{simulationRunning ? <Square size={13} /> : <Play size={13} />}{simulationRunning ? 'Stop simulation' : 'Start simulation'}</button>
                <button onClick={() => void postAction('/api/simulation/replay-incident')} className="inline-flex items-center gap-2 rounded-lg bg-red-500/15 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-red-200 ring-1 ring-red-500/30 hover:bg-red-500/25"><Activity size={13} /> Replay critical incident</button>
              </div>
            </div>

            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              {fleet.map((asset) => <button key={asset.id} onClick={() => { setSelectedSatellite(asset.id); navigateTo(`/mission/${asset.id.toLowerCase()}`) }} aria-pressed={selectedSatellite === asset.id} className={`flex items-center justify-between rounded-xl border p-4 text-left transition-colors duration-200 ${selectedSatellite === asset.id ? 'border-sky-400/60 bg-sky-400/[.07]' : 'border-slate-800 bg-[#07111F] hover:border-slate-600'}`}>
                <span><span className="flex items-center gap-2 text-xs font-bold text-white"><Satellite size={14} className="text-sky-300" />{asset.id}</span><span className="mt-1 block text-[8px] uppercase tracking-widest text-slate-500">{asset.health_state} · {asset.communication}</span></span>
                <span className="text-right"><span className="block text-xs font-semibold text-slate-200">{asset.health_score}%</span><span className="text-[8px] uppercase tracking-widest text-slate-500">health</span></span>
              </button>)}
            </div>

            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
              <div className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${socketConnected && simulationRunning ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} /><span className="text-xs font-semibold uppercase tracking-[0.18em] text-white">SIMULATED LIVE TELEMETRY</span><span className="text-[10px] text-slate-400">NO LIVE SPACECRAFT CONNECTION</span></div>
              <span className="text-[10px] text-slate-400">Last frame {fmtTime(live?.timestamp)}</span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {PARAMS.map((item) => {
                const value = live?.values[item.id]
                const status = live?.anomalies[item.id]?.status ?? 'NORMAL'
                return <button key={item.id} onClick={() => setParameter(item.id)} className={`${card} metric-card p-4 text-left ${parameter === item.id ? 'border-blue-400/60 bg-blue-500/5' : ''}`}>
                  <div className="flex items-start justify-between"><span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{item.label}</span><span className={`rounded-full px-2 py-0.5 text-[8px] font-bold tracking-widest ${status === 'NORMAL' ? 'bg-emerald-500/10 text-emerald-300' : status === 'WARNING' ? 'bg-amber-500/10 text-amber-300' : 'bg-red-500/10 text-red-300'}`}>{status}</span></div>
                  <div className="mt-4 text-3xl font-semibold tracking-tight text-white">{value === undefined ? '—' : value.toFixed(item.id === 'attitude_error' ? 3 : 1)}<span className="ml-1 text-sm font-normal text-slate-400">{item.unit}</span></div>
                  <div className="mt-2 text-[9px] uppercase tracking-widest text-slate-500">Source · SIMULATED LIVE DATA</div>
                </button>
              })}
            </div>

            <div className={`${card} mt-5 p-5`}>
              <div className="mb-4 flex items-center justify-between gap-3"><div><div className="text-[10px] uppercase tracking-[0.25em] text-blue-300">Fleet tracking</div><h3 className="mt-1 text-lg font-semibold text-white">Two demo satellites · backend-owned orbit model</h3></div><span className={`${chip} border-amber-500/20 bg-amber-500/5 text-amber-200`}>SIMULATED ORBIT MODEL</span></div>
              <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <svg viewBox="0 0 600 230" role="img" aria-label="Schematic orbital tracking view of two simulated satellites" className="h-[230px] w-full rounded-xl border border-slate-800 bg-[#050b14]">
                  <ellipse cx="300" cy="115" rx="240" ry="80" fill="none" stroke="#1e3a5f" strokeDasharray="5 7" />
                  <ellipse cx="300" cy="115" rx="175" ry="55" fill="none" stroke="#1e3a5f" strokeDasharray="3 8" />
                  <circle cx="300" cy="115" r="43" fill="#0b1a2e" stroke="#1677FF" strokeOpacity=".45" />
                  <text x="300" y="119" textAnchor="middle" fill="#94A3B8" fontSize="11">EARTH · SCHEMATIC</text>
                  {fleet.map((asset, index) => {
                    const x = 300 + 240 * (asset.longitude / 180)
                    const y = 115 + 80 * (asset.latitude / 52)
                    const lastX = 300 + 240 * (asset.last_known_message.longitude / 180)
                    const lastY = 115 + 80 * (asset.last_known_message.latitude / 52)
                    return <g key={asset.id}>{asset.communication !== 'CONNECTED' && <><circle cx={lastX} cy={lastY} r="8" fill="none" stroke="#FBBF24" strokeWidth="2" /><text x={lastX + 10} y={lastY + 16} fill="#FBBF24" fontSize="8">LAST CONFIRMED</text></>}<circle cx={x} cy={y} r="6" fill={index === 0 ? '#00A8FF' : '#FF304F'} /><circle cx={x} cy={y} r="13" fill={index === 0 ? '#00A8FF' : '#FF304F'} opacity=".16" /><text x={x + 12} y={y - 10} fill="#E2E8F0" fontSize="10">{asset.id}{asset.communication !== 'CONNECTED' ? ' · EST' : ''}</text></g>
                  })}
                </svg>
                <div className="grid gap-3 sm:grid-cols-2">
                  {fleet.map((asset) => <article key={asset.id} className="rounded-xl border border-slate-800 bg-black/20 p-4">
                    <div className="flex items-center justify-between gap-2"><div className="text-xs font-semibold text-white">{asset.id} · {asset.name}</div><span className={`text-[9px] font-bold uppercase tracking-widest ${asset.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-red-300'}`}>{asset.communication}</span></div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><div className="text-[8px] uppercase tracking-widest text-slate-500">{asset.communication === 'CONNECTED' ? 'Telemetry position' : 'Orbit estimate · unconfirmed'}</div><div className="mt-1 text-slate-200">{asset.latitude.toFixed(2)}°, {asset.longitude.toFixed(2)}°</div></div><div><div className="text-[8px] uppercase tracking-widest text-slate-500">Model altitude / velocity</div><div className="mt-1 text-slate-200">{asset.altitude_km} km · {asset.speed_km_s} km/s</div></div></div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><div className="text-slate-400">HEALTH <strong className="text-white">{asset.health_score}/100 · {asset.health_state}</strong></div><div className="text-slate-400">ANOMALY <strong className="text-amber-200">{asset.anomaly_score}/100</strong></div></div>
                    {asset.communication === 'CONNECTED'
                      ? <div className="mt-3 border-t border-slate-800 pt-2 text-[9px] leading-4 text-emerald-200">Telemetry-confirmed simulated position · last message {asset.last_known_message.message_id} at {fmtTime(asset.last_known_message.timestamp)}</div>
                      : <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-800 pt-2 text-[9px]"><div><div className="font-bold uppercase tracking-wider text-amber-300">Last confirmed</div><div className="mt-1 text-slate-300">{asset.last_known_message.latitude.toFixed(2)}°, {asset.last_known_message.longitude.toFixed(2)}°</div><div className="text-slate-500">{fmtTime(asset.last_known_message.timestamp)}</div></div><div><div className="font-bold uppercase tracking-wider text-red-300">Orbit estimate</div><div className="mt-1 text-slate-300">{asset.estimated_latitude.toFixed(2)}°, {asset.estimated_longitude.toFixed(2)}°</div><div className="text-slate-500">Not telemetry confirmed</div></div><p className="col-span-2 text-amber-200">Communication lost · telemetry is frozen at {asset.last_known_message.message_id}. Current safety state is {asset.safety}; last-message assessment: {asset.last_known_message.safety_assessment}. Last confirmed battery {asset.last_known_message.telemetry.battery_voltage.toFixed(2)} V and temperature {asset.last_known_message.telemetry.battery_temperature.toFixed(1)} °C.</p></div>}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[8px] uppercase tracking-wider text-slate-500"><span>{asset.security}</span><span>{asset.ground_station.visible ? `LINK ${asset.ground_station.id} · ${asset.ground_station.signal_strength} dBm` : 'NO VISIBLE GROUND STATION'}</span></div>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-800 pt-3">
                      <button onClick={() => void runDemoAction('/api/demo/anomaly', asset.id)} className="rounded-md border border-amber-500/25 px-2 py-2 text-[8px] font-bold uppercase tracking-wider text-amber-200 hover:bg-amber-500/10">Trigger power anomaly</button>
                      {asset.communication === 'CONNECTED'
                        ? <button onClick={() => void runDemoAction('/api/demo/communication-loss', asset.id)} className="rounded-md border border-red-500/25 px-2 py-2 text-[8px] font-bold uppercase tracking-wider text-red-200 hover:bg-red-500/10">Simulate link loss</button>
                        : <button onClick={() => void runDemoAction('/api/demo/reconnect', asset.id)} className="rounded-md border border-emerald-500/25 px-2 py-2 text-[8px] font-bold uppercase tracking-wider text-emerald-200 hover:bg-emerald-500/10">Restore communication</button>}
                      <button onClick={() => void runDemoAction('/api/demo/security-event', asset.id)} className="rounded-md border border-violet-500/25 px-2 py-2 text-[8px] font-bold uppercase tracking-wider text-violet-200 hover:bg-violet-500/10">Simulate security event</button>
                      <button onClick={() => { setQuery(`Was ${asset.id} hacked?`); document.getElementById('copilot')?.scrollIntoView({ behavior: 'smooth' }) }} className="rounded-md border border-slate-700 px-2 py-2 text-[8px] font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-800">Investigate security</button>
                    </div>
                  </article>)}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                <span className="text-[9px] uppercase tracking-[0.18em] text-slate-500">All scenario controls are simulation-only; no spacecraft commands are sent.</span>
                <button onClick={() => void resetMissionDemo()} className="rounded-lg border border-slate-700 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-slate-300 hover:border-slate-500">Reset mission demo</button>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {groundStations.map((station) => <div key={station.id} className="rounded-lg border border-slate-800 bg-black/20 p-3"><div className="flex justify-between text-[9px] font-bold uppercase tracking-widest text-white"><span>{station.id} · {station.location}</span><span className="text-emerald-300">{station.state}</span></div><div className="mt-2 text-[9px] text-slate-400">{station.latitude.toFixed(1)}°, {station.longitude.toFixed(1)}° · {station.visible_spacecraft.length ? `Visible: ${station.visible_spacecraft.join(', ')}` : 'No spacecraft in simulated visibility'}</div></div>)}
              </div>
            </div>

            <div className={`${card} mt-5 p-5`}>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                <div><div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-blue-300">HIGH-FREQUENCY SIGNAL · {selectedSatellite} · <span className="signal-live">LIVE ●</span></div><h3 className="mt-1 text-xl font-semibold text-white">{PARAMS.find((item) => item.id === parameter)?.label} trend</h3></div>
                <div className="flex flex-wrap gap-2">
                  <label className="sr-only" htmlFor="metric-select">Select telemetry parameter</label>
                  <select id="metric-select" value={parameter} onChange={(event) => setParameter(event.target.value as Parameter)} className="rounded-lg border border-slate-700 bg-[#07111F] px-3 py-2 text-xs text-white">{PARAMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <label className="sr-only" htmlFor="range-select">Select telemetry visible time range</label>
                  <select id="range-select" value={chartWindowSeconds} onChange={(event) => setChartWindowSeconds(Number(event.target.value))} className="rounded-lg border border-slate-700 bg-[#07111F] px-3 py-2 text-xs text-white"><option value={15}>15 sec</option><option value={30}>30 sec</option><option value={60}>60 sec</option><option value={300}>5 min</option></select>
                </div>
              </div>
              <div className="h-[300px] w-full overflow-hidden rounded-xl border border-slate-800">
                <LiveSignalCanvas points={visibleChartPoints} latestValue={activeAsset?.communication === 'CONNECTED' ? latestValue ?? null : null} unit={PARAMS.find((item) => item.id === parameter)?.unit ?? ''} windowSeconds={chartWindowSeconds} status={chartStatus} label={PARAMS.find((item) => item.id === parameter)?.label ?? parameter} warningValue={selectedMetric?.warning} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800 pt-4 md:grid-cols-4">
                {[['CURRENT', latestValue], ['MINIMUM', chartStats.min], ['MAXIMUM', chartStats.max], ['AVERAGE', chartStats.average]].map(([label, value]) => <div key={label as string}><div className="text-[9px] tracking-[0.2em] text-slate-500">{label}</div><div className="mt-1 text-sm font-semibold text-slate-100">{typeof value === 'number' ? `${value.toFixed(2)} ${PARAMS.find((item) => item.id === parameter)?.unit}` : '—'}</div></div>)}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4 text-[10px] uppercase tracking-widest text-slate-400"><span>Anomaly count in view: <strong className="text-amber-300">{chartStats.anomalies}</strong></span><span>Isolation Forest score: <strong className="text-white">{activeAsset?.anomaly_score ?? anomaly?.anomaly_score?.toFixed(2) ?? '—'}</strong></span><span className={simulationRunning && activeAsset?.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-amber-300'}>{!simulationRunning ? '■ PAUSED' : activeAsset?.communication !== 'CONNECTED' ? '■ TELEMETRY HELD · LINK LOST' : '● STREAMING · 5 HZ SAMPLES / 60 FPS DISPLAY'}</span></div>
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_0.85fr]">
              <div className={`${card} p-5`}>
                <div className="mb-4 flex items-center justify-between"><div><div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Correlated telemetry</div><h3 className="mt-1 text-lg font-semibold text-white">Signal + mission events</h3></div><span className={`${chip} border-amber-500/20 bg-amber-500/5 text-amber-200`}>Temporal correlation ≠ causation</span></div>
                <div className="grid gap-2 md:grid-cols-3">{events.slice(0, 3).map((event) => <div key={event.id} className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-widest text-blue-300">{event.id} · {event.event_type}</div><p className="mt-2 text-xs leading-5 text-slate-300">{event.description}</p><div className="mt-2 text-[9px] text-slate-500">{fmtTime(event.timestamp)}</div></div>)}</div>
              </div>
              <div className={`${card} p-5`}>
                <div className="flex items-center gap-2"><AlertTriangle className={`h-4 w-4 ${alarmCount ? 'text-amber-300' : 'text-emerald-300'}`} /><h3 className="text-lg font-semibold text-white">Mission status</h3></div>
                <p className="mt-3 text-sm text-slate-300">{alarmCount ? `${alarmCount} parameter(s) are outside nominal thresholds. Review the trend and event context.` : 'Nominal indicators. Monitoring continues in simulation mode.'}</p>
                <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-red-200">Decision support only · no command execution</div>
              </div>
            </div>
          </div>
        </section>

        <section id="security" className="scroll-mt-20 border-y border-slate-800/70 bg-[#060B12] px-5 py-20 lg:px-10 lg:py-24">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="03 / SECURITY & LINK CONTINUITY" title="Verify signals. Preserve what is known." summary="Security indicators and reconnection comparisons are simulated evidence for operator review. A potential security event is not proof of compromise; position and telemetry are explicitly separated from orbit estimates during an outage." />
            <div className="grid gap-5 xl:grid-cols-2">
              {fleet.map((asset) => <article key={asset.id} className={`${card} p-5`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">{asset.id} · security checks</div><h3 className="mt-1 text-lg font-semibold text-white">{asset.security}</h3></div>
                  <span className={`${chip} ${asset.security === 'POTENTIAL SECURITY EVENT' ? 'border-amber-500/30 bg-amber-500/5 text-amber-200' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200'}`}>{asset.security === 'POTENTIAL SECURITY EVENT' ? 'NOT CONFIRMED COMPROMISED' : 'SIMULATED CHECKS ONLY'}</span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {asset.security_checks.map((check) => <div key={check.evidence_id} className="rounded-lg border border-slate-800 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-200">{check.check}</span><strong className={`text-[9px] uppercase tracking-widest ${check.status === 'VERIFIED' ? 'text-emerald-300' : check.status === 'FAILED' ? 'text-red-300' : 'text-amber-300'}`}>{check.status}</strong></div>
                    <div className="mt-1 text-[9px] text-blue-300">{check.evidence_id} · {fmtTime(check.timestamp)}</div>
                    <p className="mt-1 text-[9px] leading-4 text-slate-500">{check.reason}</p>
                  </div>)}
                </div>
                <div className="mt-4 border-t border-slate-800 pt-3 text-[10px] leading-5 text-slate-400">
                  Deterministic health: <strong className="text-white">{asset.health_score}/100 · {asset.health_state}</strong>.
                  Weighted factors: power 25%, thermal 20%, communication 20%, attitude 15%, compute 10%, security 10%.
                </div>
                {asset.reconnection && <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-[10px] font-bold uppercase tracking-widest text-emerald-200">Communication restored · before / after</div><div className="text-[9px] text-slate-400">Downtime {Math.floor(asset.reconnection.downtime_seconds / 60)}m {asset.reconnection.downtime_seconds % 60}s</div></div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-[9px]">
                    <div className="text-slate-500">METRIC</div><div className="text-slate-500">BEFORE LOSS</div><div className="text-slate-500">AFTER RESTORE</div>
                    {[
                      ['Battery', 'battery_voltage', ' V'],
                      ['Temperature', 'battery_temperature', ' °C'],
                      ['Solar power', 'solar_power', ' W'],
                    ].map(([label, key, unit]) => <Fragment key={key}>
                      <div className="text-slate-300">{label}</div>
                      <div className="text-amber-200">{asset.reconnection?.before.telemetry[key]?.toFixed(2) ?? '—'}{unit}</div>
                      <div className="text-emerald-200">{asset.reconnection?.after.telemetry[key]?.toFixed(2) ?? '—'}{unit}</div>
                    </Fragment>)}
                    <div className="text-slate-300">Position</div><div className="text-amber-200">{asset.reconnection.before.latitude.toFixed(2)}°, {asset.reconnection.before.longitude.toFixed(2)}°</div><div className="text-emerald-200">{asset.reconnection.after.latitude.toFixed(2)}°, {asset.reconnection.after.longitude.toFixed(2)}°</div>
                  </div>
                  <p className="mt-3 text-[10px] leading-5 text-amber-100">{asset.reconnection.assessment}</p>
                </div>}
              </article>)}
            </div>
            <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-[10px] leading-5 text-amber-100">
              SIMULATION ONLY · These checks do not validate real packet signatures, encryption, or spacecraft security. A security warning means investigate; it does not establish that a satellite was hacked.
            </div>
          </div>
        </section>

        <section id="incidents" className="scroll-mt-20 px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="03 / INCIDENT INVESTIGATION" title="Investigate what changed." summary="Replay a deterministic critical event, track the timeline, find similar historical cases, and inspect the evidence before drawing conclusions." />
            <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap gap-2">{['All', 'Active', 'Resolved', 'Critical', 'High', 'Medium', 'Low'].map((filter) => <button key={filter} onClick={() => setIncidentFilter(filter)} className={`rounded-full border px-3 py-1.5 text-[9px] uppercase tracking-widest ${incidentFilter === filter ? 'border-blue-400 bg-blue-500/15 text-blue-100' : 'border-slate-800 text-slate-400 hover:text-white'}`}>{filter}</button>)}</div>
              <button onClick={() => void postAction('/api/simulation/replay-incident')} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-red-200"><Play size={13} /> Replay INC-024</button>
            </div>
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {filteredIncidents.map((item) => <article key={item.id} className={`${card} p-5`}>
                <div className="flex items-center justify-between gap-3"><span className="text-[10px] font-bold tracking-[0.2em] text-blue-300">{item.id}</span><span className={`rounded-full px-2 py-1 text-[9px] font-bold tracking-widest ${item.status === 'ACTIVE' ? 'bg-red-500/10 text-red-200' : 'bg-slate-700/50 text-slate-300'}`}>{item.severity} · {item.status}</span></div>
                <h3 className="mt-4 text-base font-semibold text-white">{item.title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{item.summary}</p>
                <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3 text-[9px] uppercase tracking-widest text-slate-500"><span>{item.subsystem}</span><button onClick={() => { setQuery(`What happened in ${item.id}?`); document.getElementById('copilot')?.scrollIntoView({ behavior: 'smooth' }) }} className="inline-flex items-center gap-1 text-blue-300 hover:text-white">Investigate <ArrowUpRight size={12} /></button></div>
              </article>)}
            </div>
            <div className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
              <div className={`${card} p-5`}>
                <div className="mb-5 flex items-center justify-between"><div><div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Replay timeline</div><h3 className="mt-1 text-lg font-semibold text-white">INC-024 · battery voltage degradation</h3></div><span className={`${chip} border-red-500/25 bg-red-500/5 text-red-200`}>HIGH · ACTIVE</span></div>
                <div className="space-y-0 border-l border-slate-700 pl-5">{[
                  ['T+00', 'NORMAL', 'Battery 28.5 V · baseline stable'],
                  ['T+05', 'EVENT', 'EV-204 · Power configuration changed'],
                  ['T+08', 'WARNING', 'Battery voltage trends to 26.9 V'],
                  ['T+11', 'ANOMALY', 'Voltage reaches 24.8 V · anomaly score rises'],
                  ['T+13', 'LINK', 'Communication degrades in the simulated pass'],
                  ['T+18', 'INCIDENT', 'Incident record and audit evidence updated'],
                ].map(([time, type, desc], index) => <div key={time} className="timeline-item relative pb-5"><span className="absolute -left-[1.63rem] top-1 h-2 w-2 rounded-full bg-[#00A8FF] ring-4 ring-[#07111F]" /><div className="flex items-center gap-2 text-[9px] font-semibold tracking-widest text-slate-500"><span>{time}</span><span className={type === 'ANOMALY' || type === 'INCIDENT' ? 'text-red-300' : 'text-blue-300'}>{type}</span></div><p className="mt-1 text-xs text-slate-300">{desc}</p>{index === 1 && <div className="mt-2 text-[9px] text-slate-600">Source: SIMULATED LIVE DATA · event sequence is a demonstration</div>}</div>)}</div>
              </div>
              <div className={`${card} p-5`}>
                <div className="flex items-center justify-between gap-3"><div><div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Historical context</div><h3 className="mt-1 text-lg font-semibold text-white">Find similar incidents</h3></div><button onClick={() => void api<{ results: Incident[] }>('/api/similar-incidents/INC-024').then((result) => setIncidents((items) => [...items.filter((item) => item.id === 'INC-024'), ...result.results])).catch((e) => setError(e.message))} className="rounded-lg border border-slate-700 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-blue-200 hover:border-blue-400">Find similar</button></div>
                <div className="mt-4 space-y-3">{incidents.filter((item) => item.status === 'RESOLVED').slice(0, 4).map((item, index) => <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-slate-800 bg-black/20 p-3"><div><div className="text-xs font-semibold text-white">{item.id} · {item.title}</div><div className="mt-1 text-[10px] text-slate-500">Shared subsystem: {item.subsystem} · shared telemetry/events in source evidence</div></div><span className="text-sm font-semibold text-[#00A8FF]">{[91, 76, 63, 48][index] ?? 40}%</span></div>)}</div>
              </div>
            </div>
          </div>
        </section>

        <section id="copilot" className="scroll-mt-20 border-y border-slate-800/70 bg-[#060B12] px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="04 / AI INVESTIGATION" title="Ask. Retrieve. Validate. Abstain." summary="Local deterministic reasoning retrieves stored evidence before responding. Claims are separated from hypotheses, and unsupported questions return insufficient evidence rather than a guess." />
            <div className="grid gap-5 xl:grid-cols-[0.7fr_1.3fr]">
              <div className={`${card} p-5`}>
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white"><BrainCircuit className="h-4 w-4 text-[#00A8FF]" /> Evidence-grounded copilot</div>
                <div className={`${chip} border-violet-500/25 bg-violet-500/5 text-violet-200`}>AI MODE · LOCAL DEMO REASONING</div>
                <form onSubmit={(event) => void askCopilot(event)} className="mt-5">
                  <label htmlFor="copilot-question" className="mb-2 block text-[10px] uppercase tracking-widest text-slate-400">Operator question</label>
                  <textarea id="copilot-question" value={query} onChange={(event) => setQuery(event.target.value)} rows={4} maxLength={1000} className="w-full resize-y rounded-xl border border-slate-700 bg-[#05070B] p-3 text-sm text-white outline-none focus:border-blue-400" placeholder="Ask what happened or what evidence supports it." />
                  <button disabled={busy} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-3 text-xs font-bold uppercase tracking-widest text-white hover:bg-blue-500 disabled:opacity-50">{busy ? 'Retrieving evidence…' : 'Investigate'} <Send size={14} /></button>
                </form>
                <div className="mt-5 text-[9px] uppercase tracking-[0.2em] text-slate-500">Try a question</div>
                <div className="mt-2 flex flex-wrap gap-2">{['What happened?', 'Why did battery voltage decrease?', 'What evidence supports this?', 'Did the solar array physically break?'].map((item) => <button key={item} onClick={() => setQuery(item)} className="rounded-lg border border-slate-800 px-2.5 py-2 text-left text-[10px] text-slate-300 hover:border-slate-600">{item}</button>)}</div>
              </div>
              <div id="copilot-answer" className={`${card} min-h-[400px] p-5`}>
                {answer ? <div>
                  <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Investigation result</div><h3 className="mt-1 text-lg font-semibold text-white">{answer.evidence_sufficiency}</h3></div><span className={`${chip} ${answer.evidence_sufficiency === 'INSUFFICIENT EVIDENCE' ? 'border-amber-500/25 bg-amber-500/5 text-amber-200' : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-200'}`}>Confidence · {answer.confidence}</span></div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <AnswerBlock title="Observed facts" items={answer.observed_facts} />
                    <AnswerBlock title="Correlated events" items={answer.correlated_events.map((event) => `${event.id}: ${event.description}`)} />
                    <AnswerBlock title="Historical context" items={answer.historical_context.map((item) => `${item.id}: ${item.title}`)} />
                    <AnswerBlock title="Hypothesis" items={[answer.hypothesis]} />
                    <AnswerBlock title="Recommendation · not a command" items={[answer.recommendation]} />
                    <AnswerBlock title="Missing evidence" items={answer.missing_evidence} />
                  </div>
                  <div className="mt-4 rounded-xl border border-slate-800 bg-black/20 p-4"><div className="text-[9px] uppercase tracking-widest text-slate-500">Claim validation</div>{answer.validation.map((item, index) => <div key={index} className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-slate-300">{item.claim}</span><span className={item.status === 'SUPPORTED' ? 'text-emerald-300' : 'text-amber-300'}>{item.status}</span></div>)}</div>
                  <div className="mt-4"><div className="text-[9px] uppercase tracking-widest text-slate-500">Sources retrieved first</div><div className="mt-2 flex flex-wrap gap-2">{answer.sources.map((source) => <button key={source.id} onClick={() => void retrieveEvidence(source)} className="rounded-md border border-blue-500/20 bg-blue-500/5 px-2 py-1 text-[10px] text-blue-200">{source.id} · {source.title}</button>)}</div></div>
                  <p className="mt-4 text-[10px] text-slate-500">Temporal correlation does not prove causation. No commands are generated.</p>
                </div> : <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center"><div className="mb-4 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-blue-300"><FileSearch size={24} /></div><h3 className="text-lg font-semibold text-white">Evidence package awaits a question</h3><p className="mt-2 max-w-md text-sm leading-6 text-slate-400">The copilot searches available procedures and incident evidence before forming a response. Unsupported claims are explicitly rejected.</p></div>}
              </div>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className={`${card} p-5`}><div className="text-[9px] font-bold uppercase tracking-widest text-red-300">Generic AI · unsourced</div><p className="mt-3 text-sm text-slate-300">“The power change caused the failure.”</p><div className="mt-3 text-[10px] font-bold uppercase tracking-widest text-red-300">No source · unsafe certainty</div></div>
              <div className={`${card} border-blue-500/20 p-5`}><div className="text-[9px] font-bold uppercase tracking-widest text-blue-300">Mission Ops Copilot · evidence-grounded</div><p className="mt-3 text-sm text-slate-300">“Voltage decreased after a configuration event. Timing is observed; causation is not established.”</p><div className="mt-3 text-[10px] font-bold uppercase tracking-widest text-emerald-300">Sources · confidence · abstention · audit</div></div>
            </div>
          </div>
        </section>

        <section id="evidence" className="scroll-mt-20 px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="05 / EVIDENCE EXPLORER" title="Every conclusion has a trace." summary="Explore telemetry, events, procedures, historical incidents, and safety guidance as source-labelled evidence. Open any item to inspect the retained content." />
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">{['All', 'telemetry', 'event', 'procedure', 'historical_incident', 'security_check', 'safety_manual'].map((filter) => <button key={filter} onClick={() => setSourceFilter(filter)} className={`rounded-full border px-3 py-1.5 text-[9px] uppercase tracking-widest ${sourceFilter === filter ? 'border-blue-400 bg-blue-500/15 text-blue-100' : 'border-slate-800 text-slate-400'}`}>{filter.replace('_', ' ')}</button>)}</div>
              <div className="relative"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" /><input onChange={(event) => setSourceFilter(event.target.value)} placeholder="Filter documents..." className="rounded-lg border border-slate-800 bg-[#07111F] py-2 pl-9 pr-3 text-xs outline-none focus:border-blue-500" /></div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Array.from(new Map([
                { id: 'TEL-1032', title: 'Battery voltage telemetry', type: 'telemetry', content: `Most recent recorded battery voltage: ${live?.values.battery_voltage?.toFixed(2) ?? '—'} V · SIMULATED LIVE DATA`, timestamp: live?.timestamp },
                ...events.slice(0, 3).map((event) => ({ id: event.id, title: event.event_type, type: 'event', content: event.description, timestamp: event.timestamp })),
                ...documents,
              ].map((item) => [`${item.id}-${item.type}`, item] as const)).values()).filter((item) => sourceFilter === 'All' || item.type.toLowerCase().includes(sourceFilter.toLowerCase()) || item.title.toLowerCase().includes(sourceFilter.toLowerCase()) || item.id.toLowerCase().includes(sourceFilter.toLowerCase())).map((item) => <button onClick={() => void retrieveEvidence(item)} key={`${item.id}-${item.type}`} className={`${card} evidence-card p-4 text-left transition hover:border-blue-500/40`}>
                <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-bold uppercase tracking-widest text-blue-300">{item.type.replace('_', ' ')}</span><span className="text-[9px] text-slate-500">{item.id}</span></div>
                <h3 className="mt-3 text-sm font-semibold text-white">{item.title}</h3><p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-400">{item.content}</p><div className="mt-3 flex items-center justify-between text-[9px] uppercase tracking-widest text-slate-600"><span>{item.source ?? 'Evidence catalog'}</span><span>{fmtTime(item.timestamp)}</span></div>
              </button>)}
            </div>
            <div className={`${card} mt-6 overflow-hidden p-5`}>
              <div className="mb-4 text-[10px] font-semibold uppercase tracking-[0.25em] text-blue-300">Evidence trace · example</div>
              <div className="grid gap-3 md:grid-cols-5">{[['AI CLAIM', 'Voltage decreased'], ['TELEMETRY', 'TEL-1032'], ['VALUE', `${live?.values.battery_voltage?.toFixed(2) ?? '—'} V`], ['EVENT', 'EV-204'], ['CONTEXT', 'P-017 · INC-008']].map(([title, value], index) => <div key={title} className="relative rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[8px] font-semibold tracking-widest text-slate-500">{title}</div><div className="mt-2 text-xs font-medium text-white">{value}</div>{index < 4 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-blue-400 md:block" />}</div>)}</div>
            </div>
          </div>
        </section>

        <section id="audit" className="scroll-mt-20 border-y border-slate-800/70 bg-[#060B12] px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="06 / AUDIT TRAIL" title="An investigation that can be reviewed." summary="Questions, retrieved sources, simulation actions, validation, and recommendations are persisted in the local database. This prototype records no spacecraft commands." />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{audit.length ? audit.map((item) => {
              let details: Record<string, any> = {}
              try { details = JSON.parse(item.details) } catch { details = { details: item.details } }
              return <article key={item.id} className={`${card} p-4`}><div className="flex items-center justify-between gap-2"><span className="text-[9px] font-bold uppercase tracking-widest text-blue-300">{item.action}</span><span className="text-[9px] text-slate-500">{fmtTime(item.timestamp)}</span></div><p className="mt-3 text-xs leading-5 text-slate-300">{details.question ?? details.source ?? details.incident_id ?? JSON.stringify(details)}</p><div className="mt-3 border-t border-slate-800 pt-2 text-[9px] uppercase tracking-widest text-slate-500">Command · <strong className="text-emerald-300">{details.command ?? 'NONE'}</strong></div></article>
            }) : <div className={`${card} col-span-full p-8 text-center text-sm text-slate-400`}>No audit actions recorded yet. Run an investigation or replay the demo to create a trace.</div>}</div>
          </div>
        </section>

        <section id="architecture" className="scroll-mt-20 px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle eyebrow="07 / SYSTEM ARCHITECTURE" title="A visible path from signal to decision." summary="The current local demo is connected end-to-end through React, FastAPI, a persistent SQLite store, Isolation Forest scoring, evidence retrieval, deterministic reasoning, and WebSocket streaming." />
            <div className={`${card} p-5 md:p-8`}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">{['DATA SOURCE', 'INGESTION', 'DATABASE', 'TELEMETRY', 'ISOLATION FOREST', 'EVENT CORRELATION', 'HYBRID RETRIEVAL', 'LOCAL REASONING', 'VALIDATION', 'OPERATOR', 'AUDIT'].map((label, index) => <div key={label} className="architecture-node relative flex min-h-24 flex-col justify-center rounded-xl border border-slate-700 bg-[#07111F] p-3 text-center"><span className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-blue-500/10 text-[9px] text-blue-200">{String(index + 1).padStart(2, '0')}</span><span className="text-[9px] font-semibold tracking-widest text-slate-200">{label}</span>{index < 10 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-[#00A8FF] xl:block" />}</div>)}</div>
              <div className="mt-5 flex flex-wrap gap-2 text-[9px] uppercase tracking-widest text-slate-500"><span className={`${chip} border-blue-500/20 bg-blue-500/5 text-blue-200`}><span className="h-1.5 w-1.5 rounded-full bg-blue-400" />Data flow</span><span className={`${chip} border-red-500/20 bg-red-500/5 text-red-200`}><span className="h-1.5 w-1.5 rounded-full bg-red-400" />Anomaly path</span><span className={`${chip} border-amber-500/20 bg-amber-500/5 text-amber-200`}><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />Human review required</span></div>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">{[['Frontend', 'React + TypeScript · Vite · Tailwind · Recharts · Framer Motion'], ['Backend', 'FastAPI · WebSocket stream · Pydantic validation · REST endpoints'], ['Persistence and intelligence', 'SQLite local demo store · scikit-learn Isolation Forest · local hybrid keyword/token retrieval']].map(([title, description]) => <div key={title} className={`${card} p-4`}><div className="text-[9px] uppercase tracking-widest text-blue-300">{title}</div><p className="mt-2 text-xs leading-5 text-slate-400">{description}</p></div>)}</div>
          </div>
        </section>

        <section id="safety" className="scroll-mt-20 border-y border-slate-800/70 bg-[#060B12] px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto grid max-w-[1440px] gap-8 xl:grid-cols-[0.85fr_1.15fr]">
            <div><SectionTitle eyebrow="08 / SAFETY & GOVERNANCE" title="Evidence before assumption." summary="The system is designed to support a human operator, not replace one. It cannot send commands or control spacecraft." /><div className="rounded-2xl border border-red-500/30 bg-red-500/[0.06] p-5"><div className="flex items-center gap-3 text-red-200"><ShieldAlert /><div className="text-sm font-bold tracking-[0.15em]">DECISION SUPPORT ONLY</div></div><div className="mt-3 text-xs font-semibold uppercase tracking-widest text-red-300">NO SPACECRAFT COMMAND EXECUTION</div></div></div>
            <div className={`${card} p-5`}><div className="grid gap-3 sm:grid-cols-2">{['Human in the loop', 'Evidence-grounded response', 'Facts separate from hypotheses', 'Claim validation status', 'Confidence and evidence sufficiency', 'Abstention when evidence is missing', 'Persistent investigation audit', 'No autonomous commands', 'No spacecraft control', 'No claimed real spacecraft connection'].map((item) => <div key={item} className="flex items-center gap-3 rounded-lg border border-slate-800 bg-black/20 p-3 text-xs text-slate-300"><Check size={14} className="shrink-0 text-emerald-300" />{item}</div>)}</div><p className="mt-5 border-t border-slate-800 pt-4 text-xs leading-5 text-slate-500">Security status applies to simulated signals only. The demo cannot verify a real satellite or determine that any real vehicle has been hacked.</p></div>
          </div>
        </section>

        <section id="data" className="scroll-mt-20 px-5 py-20 lg:px-10 lg:py-24">
          <div className="mx-auto grid max-w-[1440px] gap-6 xl:grid-cols-2">
            <div><SectionTitle eyebrow="09 / DATA INGESTION" title="Bring in a telemetry file." summary="Upload CSV or JSON telemetry rows. The backend validates timestamps, known parameters, finite numeric values, and record limits, then stores them with an explicit public/historical source label." />
              <div className={`${card} p-5`}><form onSubmit={(event) => void uploadFile(event)}><label htmlFor="telemetry-file" className="mb-2 block text-[10px] uppercase tracking-widest text-slate-400">CSV or JSON telemetry</label><input id="telemetry-file" name="telemetry-file" type="file" accept=".csv,.json,text/csv,application/json" required className="w-full rounded-lg border border-slate-700 bg-[#07111F] p-3 text-xs text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white" /><p className="mt-3 text-[10px] leading-5 text-slate-500">CSV fields: timestamp, spacecraft_id, parameter, value, unit. Maximum file size 5 MB. Imported data is never labelled as live spacecraft data.</p><button className="mt-4 rounded-lg bg-blue-600 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white">Validate & import</button></form>{ingestState && <p role="status" className="mt-4 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-100">{ingestState}</p>}</div>
            </div>
            <div><SectionTitle eyebrow="10 / DATA SOURCE" title="Clear provenance, always." summary="Distinguish simulation, imported public/historical records, observed values, hypotheses, recommendations, and unknowns." /><div className={`${card} grid gap-3 p-5 sm:grid-cols-2`}>{[['SIMULATED LIVE DATA', 'Demo generator stream'], ['PUBLIC HISTORICAL DATA', 'Uploaded retrospective records'], ['OBSERVED FACTS', 'Values directly present in telemetry'], ['HYPOTHESES', 'Interpretations requiring operator review'], ['RECOMMENDATIONS', 'Advisory only, never actions'], ['UNKNOWN / INSUFFICIENT EVIDENCE', 'Claims the evidence cannot establish']].map(([label, description]) => <div key={label} className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] font-bold tracking-widest text-blue-200">{label}</div><div className="mt-2 text-xs text-slate-400">{description}</div></div>)}</div></div>
          </div>
        </section>

        <section id="contact" className="scroll-mt-20 border-t border-slate-800/70 bg-gradient-to-br from-[#07111F] to-[#05070B] px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto grid max-w-[1200px] gap-10 lg:grid-cols-[0.85fr_1.15fr]">
            <div><SectionTitle eyebrow="11 / CONTACT" title="Build safer mission intelligence." summary="Have a question, collaboration idea, research opportunity, or feedback? Send a message to the demo app." /><div className="space-y-3 text-xs text-slate-400"><p>Mission Operations Copilot</p><p>AI + Human-Machine Interaction</p><p>Spacecraft Health</p></div></div>
            <form onSubmit={(event) => void submitContact(event)} className={`${card} grid gap-4 p-5 sm:grid-cols-2`}>
              <label className="text-[10px] uppercase tracking-widest text-slate-400">Name<input name="name" required maxLength={120} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#05070B] px-3 py-2.5 text-sm normal-case tracking-normal text-white outline-none focus:border-blue-400" /></label>
              <label className="text-[10px] uppercase tracking-widest text-slate-400">Email<input name="email" type="email" required maxLength={254} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#05070B] px-3 py-2.5 text-sm normal-case tracking-normal text-white outline-none focus:border-blue-400" /></label>
              <label className="text-[10px] uppercase tracking-widest text-slate-400 sm:col-span-2">Organization<input name="organization" maxLength={160} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#05070B] px-3 py-2.5 text-sm normal-case tracking-normal text-white outline-none focus:border-blue-400" /></label>
              <label className="text-[10px] uppercase tracking-widest text-slate-400 sm:col-span-2">Message<textarea name="message" required minLength={5} maxLength={3000} rows={4} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#05070B] px-3 py-2.5 text-sm normal-case tracking-normal text-white outline-none focus:border-blue-400" /></label>
              <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2"><button className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-blue-500">Send message <Send size={13} /></button><span role="status" className="text-xs text-emerald-300">{contactState}</span></div>
            </form>
          </div>
        </section>

        <section id="analysis" className="scroll-mt-20 border-t border-slate-800/70 bg-[#060b12] px-5 py-20 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1440px]">
            <SectionTitle
              eyebrow="12 / MISSION DATA ANALYSIS"
              title="Analyze persisted telemetry. Keep uncertainty visible."
              summary="Backend analysis over persisted, timestamped samples for the spacecraft selected in the upper-left. Statistics survive page reloads; when communications stop, no samples are fabricated."
            />
            <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
              <article className={`${card} p-5`}>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-[.25em] text-sky-300">SELECTED SPACECRAFT · {activeAsset?.id ?? selectedSatellite}</div>
                    <h3 className="mt-1 text-lg font-semibold text-white">{PARAMS.find((item) => item.id === parameter)?.label ?? parameter} · persisted window</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="text-[9px] uppercase tracking-widest text-slate-500" htmlFor="analysis-metric">Metric
                      <select id="analysis-metric" value={parameter} onChange={(event) => setParameter(event.target.value as Parameter)} className="ml-2 rounded-lg border border-slate-700 bg-[#07111F] px-3 py-2 text-xs normal-case tracking-normal text-white">
                        {PARAMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                      </select>
                    </label>
                    <label className="text-[9px] uppercase tracking-widest text-slate-500" htmlFor="analysis-window">Window
                      <select id="analysis-window" value={analysisWindowSeconds} onChange={(event) => setAnalysisWindowSeconds(Number(event.target.value))} className="ml-2 rounded-lg border border-slate-700 bg-[#07111F] px-3 py-2 text-xs normal-case tracking-normal text-white">
                        <option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option>
                      </select>
                    </label>
                  </div>
                </div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[8px] uppercase tracking-widest text-slate-500">
                  <span>{analysis?.analysis_source ?? 'Loading persisted telemetry analysis…'}</span>
                  <span>{analysis?.latest_age_seconds === null || analysis?.latest_age_seconds === undefined ? 'No persisted sample' : `Latest sample ${analysis.latest_age_seconds.toFixed(0)}s ago`}</span>
                </div>
                <div className="h-[260px] overflow-hidden rounded-xl border border-slate-800">
                  {analysis && <LiveSignalCanvas
                    points={analysisSamples.map((sample) => ({ timestamp: sample.timestamp, value: sample.value, status: sample.status }))}
                    latestValue={analysis.communication === 'CONNECTED' ? analysisMetricPoints.at(-1) ?? null : null}
                    unit={analysis.unit}
                    windowSeconds={analysisWindowSeconds}
                    status={!socketConnected ? 'paused' : analysis.communication === 'CONNECTED' ? 'connected' : 'gap'}
                    label={analysis.label}
                    warningValue={selectedMetric?.warning}
                  />}
                  {!analysis && !analysisLoading && <div className="flex h-full items-center justify-center px-6 text-center text-xs text-slate-500">No persisted samples are available for this spacecraft and metric yet.</div>}
                </div>
                {analysisError && <p role="alert" className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[.06] p-3 text-[10px] text-amber-100">Analysis request failed: {analysisError}</p>}
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800 pt-4 sm:grid-cols-5">
                  {[
                    ['SAMPLES', String(analysis?.sample_count ?? 0)],
                    ['AVERAGE', analysisMean === null ? '—' : `${analysisMean.toFixed(2)} ${analysisUnit}`],
                    ['MIN / MAX', analysisMin === null || analysisMax === null ? '—' : `${analysisMin.toFixed(2)} / ${analysisMax.toFixed(2)}`],
                    ['STD. DEV.', analysis?.statistics.standard_deviation === null || analysis?.statistics.standard_deviation === undefined ? '—' : `${analysis.statistics.standard_deviation.toFixed(2)} ${analysisUnit}`],
                    ['EARLY → RECENT', analysisDelta === null ? '—' : `${analysisDelta > 0 ? '+' : ''}${analysisDelta.toFixed(2)} ${analysisUnit}`],
                  ].map(([label, value]) => <div key={label}><div className="text-[8px] font-semibold tracking-widest text-slate-500">{label}</div><div className="mt-1 text-xs font-semibold text-slate-100">{value}</div></div>)}
                </div>
              </article>

              <div className="grid gap-5">
                <article className={`${card} p-5`}>
                  <div className="text-[9px] font-semibold uppercase tracking-[.25em] text-slate-500">Computed observations · simulation</div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-800 bg-black/20 p-4"><div className="text-[8px] uppercase tracking-widest text-slate-500">Trend · per minute</div><div className={`mt-2 text-sm font-bold ${analysisTrend === 'TRENDING DOWN' ? 'text-amber-200' : 'text-sky-200'}`}>{analysisTrend}</div><p className="mt-2 text-[9px] leading-4 text-slate-500">{analysis?.trend.slope_per_minute === null || analysis?.trend.slope_per_minute === undefined ? 'Need at least two timestamps.' : `${analysis.trend.slope_per_minute.toFixed(3)} ${analysisUnit}/min linear-fit slope; end-to-end change ${analysisDelta?.toFixed(2) ?? '—'} ${analysisUnit}.`}</p></div>
                    <div className="rounded-xl border border-slate-800 bg-black/20 p-4"><div className="text-[8px] uppercase tracking-widest text-slate-500">Threshold alerts</div><div className="mt-2 text-sm font-bold text-amber-200">{anomalousSamples} flagged</div><p className="mt-2 text-[9px] leading-4 text-slate-500">Normal {analysis?.status_counts.NORMAL ?? 0} · warning {analysis?.status_counts.WARNING ?? 0} · critical {analysis?.status_counts.CRITICAL ?? 0}.</p></div>
                    <div className="rounded-xl border border-slate-800 bg-black/20 p-4"><div className="text-[8px] uppercase tracking-widest text-slate-500">Battery / solar correlation</div><div className="mt-2 text-sm font-bold text-slate-100">{batterySolarCorrelation === null ? 'INSUFFICIENT SAMPLES' : `r = ${batterySolarCorrelation.toFixed(2)}`}</div><p className="mt-2 text-[9px] leading-4 text-slate-500">{analysis?.correlation_sample_count ?? 0} paired persisted samples · correlation is not causation.</p></div>
                    <div className="rounded-xl border border-slate-800 bg-black/20 p-4"><div className="text-[8px] uppercase tracking-widest text-slate-500">Link / data continuity</div><div className={`mt-2 text-sm font-bold ${analysis?.communication === 'CONNECTED' ? 'text-emerald-200' : 'text-amber-200'}`}>{analysis?.communication === 'CONNECTED' ? 'LINK CONNECTED' : 'GAP · POSITION UNVERIFIED'}</div><p className="mt-2 text-[9px] leading-4 text-slate-500">{analysis?.gap_count ?? 0} telemetry gaps over 15 seconds in the analysis window.</p></div>
                  </div>
                </article>
                <article className={`${card} p-5`}>
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-[9px] font-semibold uppercase tracking-[.25em] text-slate-500">Fleet comparison</div><h3 className="mt-1 text-sm font-semibold text-white">Current spacecraft health & telemetry</h3></div><span className="text-[8px] uppercase tracking-widest text-slate-500">Backend snapshot</span></div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {fleet.map((asset) => <button key={asset.id} onClick={() => { setSelectedSatellite(asset.id); navigateTo(`/mission/${asset.id.toLowerCase()}`) }} className={`rounded-xl border p-4 text-left transition hover:border-sky-400/40 ${asset.id === selectedSatellite ? 'border-sky-400/35 bg-sky-400/[.05]' : 'border-slate-800 bg-black/20'}`}>
                      <div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-white">{asset.id}</span><span className={`text-[8px] font-bold uppercase tracking-widest ${asset.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-amber-300'}`}>{asset.communication}</span></div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-[9px]"><span className="text-slate-500">HEALTH <strong className="ml-1 text-slate-200">{asset.health_score}%</strong></span><span className="text-slate-500">ANOMALY <strong className="ml-1 text-slate-200">{asset.anomaly_score}/100</strong></span><span className="text-slate-500">BATTERY <strong className="ml-1 text-slate-200">{asset.last_known_message.telemetry.battery_voltage.toFixed(2)} V</strong></span><span className="text-slate-500">ALTITUDE <strong className="ml-1 text-slate-200">{asset.altitude_km} km</strong></span></div>
                    </button>)}
                    {fleet.length === 0 && <p className="text-xs text-slate-500">Waiting for spacecraft telemetry.</p>}
                  </div>
                </article>
              </div>
            </div>
            <p className="mt-4 text-[9px] leading-5 text-slate-500">Statistics are calculated by the API from persisted samples, refreshed every 5 seconds, and do not depend on the browser session’s in-memory history. A missing link creates no substitute data. Trend and correlation are descriptive operator aids, not diagnoses, causation, or proof of physical failure.</p>
          </div>
        </section>
      </main>}

      <footer className="border-t border-slate-800 px-5 py-8 lg:px-10">
        <div className="mx-auto flex max-w-[1440px] flex-col justify-between gap-5 md:flex-row md:items-center"><div><div className="text-xs font-bold tracking-[0.2em] text-white">MISSION OPERATIONS COPILOT</div><div className="mt-1 text-[10px] text-slate-500">Evidence before assumption.</div></div><div className="flex flex-wrap gap-4">{[['Mission', 'mission'], ['Telemetry', 'telemetry'], ['Incidents', 'incidents'], ['AI Copilot', 'copilot'], ['Evidence', 'evidence'], ['Safety', 'safety'], ['Architecture', 'architecture'], ['Contact', 'contact']].map(([label, id]) => <a key={id} href={`#${id}`} className="text-[9px] uppercase tracking-widest text-slate-500 hover:text-white">{label}</a>)}</div><p className="max-w-sm text-[9px] leading-4 text-slate-600">Prototype for decision-support research and demonstration. Not connected to live spacecraft control systems.</p></div>
      </footer>

      {selectedEvidence && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="evidence-title" onClick={() => setSelectedEvidence(null)}><div className={`${card} max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6`} onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><div className="text-[10px] uppercase tracking-widest text-blue-300">{selectedEvidence.type} · {selectedEvidence.id}</div><h2 id="evidence-title" className="mt-2 text-xl font-semibold text-white">{selectedEvidence.title}</h2></div><button onClick={() => setSelectedEvidence(null)} className="rounded-lg border border-slate-700 p-2 text-slate-300" aria-label="Close evidence"><X size={16} /></button></div><p className="mt-5 whitespace-pre-wrap text-sm leading-7 text-slate-300">{selectedEvidence.content ?? `${selectedEvidence.value ?? ''} ${selectedEvidence.unit ?? ''}`}</p><div className="mt-5 text-[10px] uppercase tracking-widest text-slate-500">Source · {selectedEvidence.source ?? 'Evidence catalog'} · {fmtTime(selectedEvidence.timestamp)}</div></div></div>}
    </div>
  )
}

function AnswerBlock({ title, items }: { title: string; items: string[] }) {
  return <div className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{title}</div>{items.length ? items.map((item, index) => <p key={index} className="mt-2 text-xs leading-5 text-slate-300">{item}</p>) : <p className="mt-2 text-xs text-slate-600">No supporting records found.</p>}</div>
}

export default App
