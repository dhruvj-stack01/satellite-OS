# Mission Operations Copilot

**Application version: 1.1.0**

Evidence-grounded spacecraft health decision support demo. The application combines a React dashboard, a FastAPI service, persistent local telemetry/event/audit data, anomaly scoring, document retrieval, a deterministic investigation fallback, and a simulated WebSocket telemetry stream.

> **Safety:** This prototype is not connected to a real spacecraft. All generated telemetry is marked `SIMULATED LIVE DATA`. Uploaded records are labeled `PUBLIC HISTORICAL DATA` by default. The application cannot issue spacecraft commands or control a vehicle.

## Implemented experience

- Full-screen home mission scene with a rotating, sun-lit 3D Earth, soft atmosphere, subtle procedural cloud and night-side city-light layers, star field, spacecraft markers, and simulated ground-station link.
- Draggable/zoomable Earth camera with a visible mouse reticle and drag-to-rotate cursor; clicking either spacecraft opens its mission workspace, and the ground-station marker opens a compact details panel.
- NASA Blue Marble Next Generation Earth imagery bundled locally and mapped onto the 3D globe (`public/earth-blue-marble.jpg`; source: NASA/GSFC).
- Dedicated spacecraft workspaces at `/mission/orbit-x1` and `/mission/orbit-x2`, with spacecraft selector, telemetry, incidents, communication, security, evidence, and audit views.
- Persistent upper-left spacecraft selector for direct access to either mission workspace.
- Live telemetry dashboard with selectable parameters, time-windowed canvas graph, warning threshold, current/min/max/average values, anomaly counts, and start/stop controls.
- Bundled 24,000-record two-spacecraft CSV is imported idempotently into SQLite as `SIMULATED REPLAY DATA`; use the telemetry graph replay controls to play its timestamped trace at 1×, 4×, or 16× without presenting the old samples as current live telemetry.
- Emergency audio is opt-in and sounds only for a live CRITICAL telemetry/health state; warnings, historical replay, and non-critical security review states stay silent.
- 3D home scene uses a slow rotating, brighter Earth without a moving specular flash; each spacecraft model independently rotates in 3D and carries its backend-driven name and status.
- Cached WebSocket telemetry frames delivered at approximately 5 Hz; the canvas redraws with `requestAnimationFrame`, and SQLite telemetry persistence is throttled to about once every 5 seconds rather than written for every stream frame.
- Persistent telemetry analysis API for both spacecraft with selectable 1-minute to 1-hour windows, distribution statistics, linear trend, status/anomaly counts, telemetry-gap counts, and battery/solar correlation. Analysis refreshes at 5-second intervals and survives frontend reloads.
- Backend-owned simplified orbit model for ORBIT-X1 and ORBIT-X2 with schematic positions, deterministic health factors, ground-station visibility, and simulated message IDs.
- Simulation controls for a correlated power anomaly, communication loss/recovery, security-check event, and reset. During a simulated outage, spacecraft telemetry is withheld and the UI distinguishes the frozen last-confirmed message from the changing orbit estimate.
- Reconnection comparison of retained pre-loss and newly received simulated telemetry, with the communication-gap state explicitly marked unverifiable.
- Security evidence records for simulated authentication, signature, sequence, source, checksum, replay, and encryption checks. A failed simulated check is labeled a potential security event, never a confirmed hack.
- Mission fleet, per-spacecraft position/last-message/communication/security/health/events/telemetry APIs and mission/per-spacecraft WebSocket routes.
- Deterministic `INC-024` replay with telemetry changes, generated mission events, anomaly scoring, and incident timeline.
- Incident catalogue and similar-incident context.
- Dedicated Mission AI chat with saved SQLite conversations, spacecraft selection, current telemetry/security context, RAG-retrieved procedures/events, and cited source chips.
- Optional server-side OpenAI-compatible chat completions integration; API keys remain in the backend environment and are never sent to the browser. Local RAG reasoning remains available when `LLM_PROVIDER=LOCAL`.
- An automatic 15-second read-only workflow scans both simulated spacecraft for telemetry thresholds, health, communication interruptions, and security-check anomalies; it stores execution reports, retrieves relevant procedures, resolves cleared alerts, and raises persistent in-app alerts.
- Local AI investigation interface with observed facts, correlated events, historical context, hypotheses, recommendations, validation, confidence, evidence sufficiency, and missing evidence.
- Unsupported hardware/security claims abstain with `INSUFFICIENT EVIDENCE`.
- End-of-page analysis section with five-minute descriptive telemetry statistics, early-versus-recent trend comparison, anomaly-score counts, battery/solar correlation, and a two-spacecraft status comparison.
- BM25 plus TF-IDF cosine hybrid retrieval over seeded procedures and incident documents.
- Evidence explorer with source filters and a detail dialog.
- Persistent audit trail and validated contact form.
- CSV/JSON telemetry ingestion with input validation, a 5 MB request limit, and source labels.
- Safety, architecture, provenance, and data-ingestion sections.

## Stack and current demo limitations

- Frontend: React, TypeScript, Vite, Tailwind CSS, React Three Fiber/Three.js 3D scene, canvas-based telemetry visualization, Framer Motion, Lucide.
- API: FastAPI, Pydantic, WebSocket.
- Local persistence: SQLite (`backend/mission_ops.db`, configurable via `DATABASE_PATH`).
- ML: scikit-learn Isolation Forest over recent retained telemetry.
- Retrieval: rank-bm25 plus TF-IDF cosine similarity and title-aware ranking.
- Reasoning: local evidence-grounded fallback by default; optionally configure an OpenAI-compatible chat-completions endpoint through backend environment variables.

The homepage 3D Earth maps NASA/GSFC Blue Marble Next Generation imagery (`https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74218/world.200412.3x5400x2700.jpg`) onto a rotating sphere; atmosphere/cloud shading and night-side city lights are visual effects, not live imagery. The bundled `backend/data/mission_live_telemetry_24000.csv` is a simulated trace from 2026-10-06 00:00:00Z through 00:49:59.750Z, not a live spacecraft feed. It is imported once per file checksum and replayed against a separate graph clock, preserving the recorded sample timestamps in the replay status. The mission-orbit, ground-station, telemetry, and security-check features are deterministic simulation, not precision astrodynamics or real communication/security verification. The RAG store uses SQLite mission documents/events and local BM25 plus TF-IDF retrieval. To enable generated chat completions, configure `LLM_PROVIDER=OPENAI_COMPATIBLE`, `MODEL_NAME`, `LLM_BASE_URL` (defaults to the OpenAI API base), and `LLM_API_KEY` in the backend environment; never put the key in frontend variables. The external LLM receives the selected spacecraft's simulated telemetry, security checks, retrieved evidence, and recent events. Local deterministic reasoning works without an external provider. The automatic workflow is read-only and only analyzes, stores reports, and raises in-app alerts; it never sends commands. There is no verified live-device connection, and security status cannot verify a real satellite. Emergency audio must be explicitly armed and is limited to live critical states; it does not sound for a warning or historical replay. Communication loss preserves the last confirmed message and marks the position estimate and outage period as unverified; a simulated security warning is not proof of compromise. Analysis is descriptive of generated samples; correlation is not causation or a physical diagnosis. The UI discloses these limitations rather than claiming those integrations exist.

## Run locally

Requirements: Node.js/npm and Python 3.12 (a workspace `.venv` may already exist).

```powershell
npm install
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
npm run dev
```

Open <http://localhost:5173>. FastAPI documentation is at <http://localhost:8000/docs>.

The `dev` script starts Vite and Uvicorn together. API requests and `/ws/telemetry` are proxied through Vite.

## API overview

- `GET /api/health`, `/api/system`, `/api/spacecraft`
- `GET /api/mission/fleet`, `/api/mission/ground-stations`, `/api/mission/{spacecraft_id}` and per-spacecraft `/position`, `/last-message`, `/communication`, `/security`, `/health`, `/events`, and `/telemetry`
- `POST /api/demo/anomaly`, `/api/demo/communication-loss`, `/api/demo/reconnect`, `/api/demo/security-event`, `/api/demo/reset`
- `GET /api/telemetry/latest`, `/api/telemetry/history`, `/api/telemetry/analysis?spacecraft_id=ORBIT-X1&parameter=battery_voltage&window_seconds=300`
- `POST /api/telemetry/ingest` (CSV/JSON body; source query parameter)
- `GET /api/events`, `POST /api/events/ingest`
- `GET /api/incidents`, `GET /api/incidents/{id}`
- `POST /api/investigate`, `POST /api/incidents/{id}/investigate`
- `POST /api/ai/conversations`, `GET /api/ai/conversations/{conversation_id}`, `POST /api/ai/chat`
- `GET /api/ai/workflow`, `GET /api/ai/alerts`
- `POST /api/rag/search`, `GET /api/evidence-library`, `GET /api/evidence/{source_id}`
- `GET /api/audit`, `GET /api/similar-incidents/{id}`
- `POST /api/simulation/start`, `/api/simulation/stop`, `/api/simulation/replay-incident`
- `GET /api/simulation/status`, `POST /api/contact`
- WebSockets `/ws/telemetry`, `/ws/telemetry/{spacecraft_id}`, and `/ws/mission`

## Telemetry upload format

CSV columns: `timestamp,spacecraft_id,parameter,value,unit`. JSON may be a list of these objects or `{"records":[...]}`. Supported parameter keys are `battery_voltage`, `solar_power`, `battery_temperature`, `communication_signal`, `attitude_error`, `cpu_usage`, `memory_usage`, and `reaction_wheel_speed`.

## Configuration

The API reads `DATABASE_PATH`, `CORS_ORIGINS`, `LLM_PROVIDER`, `MODEL_NAME`, `LLM_BASE_URL`, and `LLM_API_KEY` from its environment. Defaults are local SQLite, Vite localhost CORS origins, and local RAG reasoning. The optional OpenAI-compatible provider requires a backend-only API key; no key is required in local mode.
