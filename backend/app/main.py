from __future__ import annotations

import asyncio
import csv
import io
import json
import math
import os
import re
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from rank_bm25 import BM25Okapi
from dotenv import load_dotenv
from sklearn.ensemble import IsolationForest
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from app.orbit_simulator import MissionSimulator

APP_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(APP_ROOT.parent / ".env")
configured_database_path = Path(os.getenv("DATABASE_PATH", APP_ROOT / "mission_ops.db"))
DB_PATH = configured_database_path if configured_database_path.is_absolute() else APP_ROOT.parent / configured_database_path
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
DB_LOCK = threading.Lock()

app = FastAPI(title="Mission Operations Copilot API", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

SIMULATION = {"running": True, "replay_step": -1, "tick": 0, "latest": {}}
MISSION_SIMULATOR = MissionSimulator()
ANOMALY_MODELS: dict[str, IsolationForest] = {}
STREAM_LOCK = asyncio.Lock()
STREAM_FRAME: dict[str, Any] | None = None
STREAM_FRAME_AT = 0.0
STREAM_SCORES: dict[str, dict[str, Any]] = {}

DOCUMENTS: list[dict[str, str]] = [
    {"id": "P-017", "title": "Low Voltage Investigation Procedure", "type": "procedure", "content": "For a sustained battery bus voltage decline, verify telemetry quality, review the recent power configuration and solar power trend, compare battery voltage with load current, and assess the battery thermal profile. A recent configuration event is temporal context and does not by itself establish the cause."},
    {"id": "P-021", "title": "Communication Degradation Procedure", "type": "procedure", "content": "For communication degradation, review link margin, antenna pointing telemetry, ground-station handover timing, packet integrity, and the last validated message. Preserve the last-known message and mark current spacecraft state unknown until verified telemetry resumes."},
    {"id": "P-031", "title": "Power Configuration Review Procedure", "type": "procedure", "content": "Review configuration-change records alongside bus voltage, solar power, and load telemetry. Compare pre-event and post-event windows. Do not infer causation from sequence alone; corroborate with independent telemetry and operator-reviewed evidence."},
    {"id": "INC-008", "title": "Historical Battery Voltage Anomaly", "type": "historical_incident", "content": "Historical case: battery voltage decreased after a power configuration event while solar power remained near baseline. The event was investigated against bus load and battery temperature; a temporal relationship was observed, but configuration change alone was not proof of cause."},
    {"id": "INC-013", "title": "Historical Power Subsystem Incident", "type": "historical_incident", "content": "Historical power subsystem case with correlated bus voltage decline and increased electrical load. Shared indicators included battery voltage and power configuration events. Operators reviewed the load profile and power procedure."},
    {"id": "INC-021", "title": "Historical Communication Degradation", "type": "historical_incident", "content": "Historical communications case involving reduced link quality and delayed telemetry. The last validated message was retained; state was treated as unknown until fresh telemetry and packet integrity checks were available."},
    {"id": "SAFE-001", "title": "Mission Operations Safety Manual", "type": "safety_manual", "content": "This application is decision support only. A human operator remains responsible for assessment. The system does not transmit commands, control a spacecraft, or assert real spacecraft connection. Label simulated and historical sources explicitly."},
]

HISTORICAL_INCIDENTS = [
    {"id": "INC-008", "severity": "MEDIUM", "status": "RESOLVED", "title": "Battery voltage decline following power configuration event", "subsystem": "POWER", "similarity": 0.91},
    {"id": "INC-013", "severity": "HIGH", "status": "RESOLVED", "title": "Power subsystem load excursion", "subsystem": "POWER", "similarity": 0.76},
    {"id": "INC-021", "severity": "HIGH", "status": "RESOLVED", "title": "Communication degradation during telemetry pass", "subsystem": "COMMUNICATION", "similarity": 0.63},
    {"id": "INC-015", "severity": "LOW", "status": "RESOLVED", "title": "Thermal sensor drift investigation", "subsystem": "THERMAL", "similarity": 0.48},
    {"id": "INC-019", "severity": "MEDIUM", "status": "RESOLVED", "title": "Reaction wheel speed variance", "subsystem": "ATTITUDE", "similarity": 0.32},
]

PARAMETERS: dict[str, dict[str, Any]] = {
    "battery_voltage": {"label": "Battery voltage", "unit": "V", "min": 27.5, "max": 29.0, "warning": 27.2, "critical": 25.5, "base": 28.5},
    "solar_power": {"label": "Solar power", "unit": "W", "min": 450, "max": 600, "warning": 420, "critical": 350, "base": 520},
    "battery_temperature": {"label": "Battery temperature", "unit": "°C", "min": 35, "max": 50, "warning": 52, "critical": 60, "base": 43},
    "communication_signal": {"label": "Communication", "unit": "dBm", "min": -60, "max": -45, "warning": -63, "critical": -70, "base": -51},
    "attitude_error": {"label": "Attitude error", "unit": "°", "min": 0.05, "max": 0.3, "warning": 0.4, "critical": 0.8, "base": 0.18},
    "cpu_usage": {"label": "CPU", "unit": "%", "min": 20, "max": 60, "warning": 75, "critical": 90, "base": 38},
    "memory_usage": {"label": "Memory", "unit": "%", "min": 30, "max": 70, "warning": 80, "critical": 90, "base": 51},
    "reaction_wheel_speed": {"label": "Reaction wheel", "unit": "RPM", "min": 1000, "max": 5000, "warning": 5500, "critical": 6500, "base": 2800},
}

class InvestigationRequest(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    incident_id: str = Field(default="INC-024", max_length=40)
    spacecraft_id: str = Field(default="ORBIT-X1", min_length=1, max_length=60)

class IngestEvent(BaseModel):
    timestamp: datetime
    spacecraft_id: str = Field(min_length=1, max_length=60)
    subsystem: str = Field(min_length=1, max_length=40)
    event_type: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=1000)
    severity: str = Field(default="INFO", max_length=20)
    source: str = Field(default="PUBLIC HISTORICAL DATA", max_length=40)

class ContactRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    organization: str = Field(default="", max_length=160)
    message: str = Field(min_length=5, max_length=3000)

class DemoAction(BaseModel):
    spacecraft_id: str = Field(default="ORBIT-X1", min_length=1, max_length=60)

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def iso(value: datetime | None = None) -> str:
    return (value or now_utc()).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def db_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    return connection

def execute(sql: str, params: tuple[Any, ...] = ()) -> None:
    with DB_LOCK, closing(db_connection()) as connection:
        connection.execute(sql, params)
        connection.commit()

def query_all(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with DB_LOCK, closing(db_connection()) as connection:
        return [dict(row) for row in connection.execute(sql, params).fetchall()]

def initialize_database() -> None:
    with DB_LOCK, closing(db_connection()) as connection:
        connection.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS spacecraft(id TEXT PRIMARY KEY, name TEXT NOT NULL, mission TEXT NOT NULL, source TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS telemetry(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, spacecraft_id TEXT NOT NULL, parameter TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, source TEXT NOT NULL, anomaly_score REAL DEFAULT 0, status TEXT DEFAULT 'NORMAL');
            CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry(timestamp);
            CREATE INDEX IF NOT EXISTS idx_telemetry_parameter ON telemetry(parameter, timestamp);
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, spacecraft_id TEXT NOT NULL, subsystem TEXT NOT NULL, event_type TEXT NOT NULL, description TEXT NOT NULL, severity TEXT NOT NULL, source TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, title TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, subsystem TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS contact_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, organization TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS simulation_state(id INTEGER PRIMARY KEY CHECK (id=1), running INTEGER NOT NULL, replay_step INTEGER NOT NULL, tick INTEGER NOT NULL);
        """)
        connection.execute("INSERT OR IGNORE INTO spacecraft VALUES ('ORBIT-X1','ORBIT-X1','Earth observation demo','SIMULATED LIVE DATA')")
        connection.execute("INSERT OR IGNORE INTO spacecraft VALUES ('ORBIT-X2','ORBIT-X2','Communications demo','SIMULATED LIVE DATA')")
        for document in DOCUMENTS:
            connection.execute("INSERT OR IGNORE INTO documents VALUES (?,?,?,?)", (document["id"], document["title"], document["type"], document["content"]))
        incidents = [
            ("INC-024", "Battery Voltage Degradation Following Power Configuration Event", "HIGH", "ACTIVE", "POWER", "Voltage decline temporally followed a power configuration event; causality is not established.", iso()),
            *[(item["id"], item["title"], item["severity"], item["status"], item["subsystem"], item["title"], iso(now_utc() - timedelta(days=index + 1))) for index, item in enumerate(HISTORICAL_INCIDENTS)],
        ]
        for incident in incidents:
            connection.execute("INSERT OR IGNORE INTO incidents VALUES (?,?,?,?,?,?,?)", incident)
        events = [
            ("EV-204", iso(now_utc() - timedelta(minutes=4)), "ORBIT-X1", "POWER", "CONFIGURATION_CHANGE", "Power configuration changed.", "WARNING", "SIMULATED LIVE DATA"),
            ("EV-205", iso(now_utc() - timedelta(minutes=3)), "ORBIT-X1", "POWER", "VOLTAGE_DECLINE", "Battery bus voltage moved below the expected operating band.", "HIGH", "SIMULATED LIVE DATA"),
            ("EV-206", iso(now_utc() - timedelta(minutes=2)), "ORBIT-X1", "COMMUNICATION", "LINK_DEGRADED", "Communication link quality degraded during the simulated pass.", "WARNING", "SIMULATED LIVE DATA"),
        ]
        for event in events:
            connection.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?)", event)
        row = connection.execute("SELECT COUNT(*) FROM telemetry").fetchone()
        if row[0] < 500:
            for index in range(500):
                timestamp = now_utc() - timedelta(minutes=20) + timedelta(seconds=2.4 * index)
                voltage = 28.5 + 0.12 * math.sin(index / 19) + 0.03 * math.sin(index / 4)
                solar = 520 + 24 * math.sin(index / 29)
                temp = 43 + 1.7 * math.sin(index / 37) + 0.3 * math.sin(index / 7)
                signal = -51 + 2.5 * math.sin(index / 23)
                values = {
                    "battery_voltage": voltage, "solar_power": solar, "battery_temperature": temp,
                    "communication_signal": signal, "attitude_error": 0.18 + 0.035 * math.sin(index / 17),
                    "cpu_usage": 38 + 8 * math.sin(index / 27), "memory_usage": 51 + 6 * math.sin(index / 41),
                    "reaction_wheel_speed": 2800 + 260 * math.sin(index / 21),
                }
                for parameter, value in values.items():
                    meta = PARAMETERS[parameter]
                    connection.execute("INSERT INTO telemetry(timestamp,spacecraft_id,parameter,value,unit,source) VALUES (?,?,?,?,?,?)",
                                       (iso(timestamp), "ORBIT-X1", parameter, round(value, 3), meta["unit"], "SIMULATED LIVE DATA"))
        connection.execute("INSERT OR IGNORE INTO simulation_state VALUES (1,1,-1,0)")
        state = connection.execute("SELECT running,replay_step,tick FROM simulation_state WHERE id=1").fetchone()
        SIMULATION.update(running=bool(state["running"]), replay_step=state["replay_step"], tick=state["tick"])
        connection.commit()

def update_sim_state() -> None:
    execute("UPDATE simulation_state SET running=?, replay_step=?, tick=? WHERE id=1",
            (int(SIMULATION["running"]), SIMULATION["replay_step"], SIMULATION["tick"]))

def telemetry_latest() -> dict[str, Any]:
    latest: dict[str, Any] = {}
    for parameter, meta in PARAMETERS.items():
        rows = query_all("SELECT value,timestamp,anomaly_score,status FROM telemetry WHERE parameter=? ORDER BY id DESC LIMIT 1", (parameter,))
        if rows:
            latest[parameter] = {**meta, **rows[0]}
    return latest

def generate_values(replay_step: int = -1) -> dict[str, float]:
    tick = SIMULATION["tick"]
    t = tick / 5
    values = {
        "battery_voltage": 28.5 + 0.12 * math.sin(t / 3) + 0.03 * math.sin(t),
        "solar_power": 520 + 24 * math.sin(t / 5),
        "battery_temperature": 43 + 1.7 * math.sin(t / 6),
        "communication_signal": -51 + 2.5 * math.sin(t / 4),
        "attitude_error": 0.18 + 0.035 * math.sin(t / 4),
        "cpu_usage": 38 + 8 * math.sin(t / 7),
        "memory_usage": 51 + 6 * math.sin(t / 9),
        "reaction_wheel_speed": 2800 + 260 * math.sin(t / 5),
    }
    if replay_step >= 0:
        if replay_step >= 2:
            values["battery_voltage"] = 28.5
        if replay_step >= 4:
            values["battery_voltage"] = 26.9
        if replay_step >= 6:
            values["battery_voltage"] = 24.8
        if replay_step >= 8:
            values["communication_signal"] = -66
        if replay_step >= 10:
            values["battery_temperature"] = 56
    elif tick > 0 and tick % 90 >= 64 and tick % 90 <= 75:
        values["battery_voltage"] -= min(3.3, (tick % 90 - 63) * 0.35)
        values["communication_signal"] -= 8
    if MISSION_SIMULATOR.get("ORBIT-X1").power_anomaly:
        values["solar_power"] *= 0.69
        values["battery_voltage"] -= min(2.0, tick * 0.002)
        values["battery_temperature"] += min(5.0, tick * 0.005)
    return {key: round(float(value), 3) for key, value in values.items()}

def classify(parameter: str, value: float) -> str:
    meta = PARAMETERS[parameter]
    if parameter in ("communication_signal",):
        return "CRITICAL" if value <= meta["critical"] else "WARNING" if value <= meta["warning"] else "NORMAL"
    if parameter in ("battery_temperature", "attitude_error", "cpu_usage", "memory_usage", "reaction_wheel_speed"):
        return "CRITICAL" if value >= meta["critical"] else "WARNING" if value >= meta["warning"] else "NORMAL"
    return "CRITICAL" if value <= meta["critical"] else "WARNING" if value <= meta["warning"] else "NORMAL"

def score_anomalies(values: dict[str, float]) -> dict[str, dict[str, Any]]:
    result = {}
    for parameter, value in values.items():
        rows = query_all("SELECT value FROM telemetry WHERE parameter=? ORDER BY id DESC LIMIT 120", (parameter,))
        baseline = np.array([row["value"] for row in rows], dtype=float)
        if len(baseline) >= 20:
            model = ANOMALY_MODELS.get(parameter)
            if model is None or SIMULATION["tick"] % 120 == 1:
                features = np.column_stack((baseline, np.gradient(baseline), np.full(len(baseline), np.mean(baseline))))
                model = IsolationForest(n_estimators=32, contamination=0.04, random_state=7, n_jobs=1)
                model.fit(features)
                ANOMALY_MODELS[parameter] = model
            latest_features = np.array([[value, value - baseline[-1], float(baseline.mean())]])
            anomaly_score = float(np.clip((0.5 - model.score_samples(latest_features)[0]) * 2, 0, 1))
        else:
            anomaly_score = 0.0
        status = classify(parameter, value)
        if status != "NORMAL":
            anomaly_score = max(anomaly_score, 0.65 if status == "WARNING" else 0.9)
        result[parameter] = {"parameter": parameter, "value": value, "timestamp": iso(), "anomaly_score": round(anomaly_score, 3), "status": status}
    return result

def persist_tick(values: dict[str, float], scores: dict[str, dict[str, Any]]) -> None:
    timestamp = iso()
    with DB_LOCK, closing(db_connection()) as connection:
        for satellite_id in ("ORBIT-X1", "ORBIT-X2"):
            satellite = MISSION_SIMULATOR.get(satellite_id)
            if satellite.communication_state != "CONNECTED":
                continue
            spacecraft_telemetry = (
                values
                if satellite_id == "ORBIT-X1"
                else satellite.last_message["telemetry"]
            )
            for parameter, value in spacecraft_telemetry.items():
                if parameter not in PARAMETERS:
                    continue
                if satellite_id == "ORBIT-X1":
                    anomaly_score = scores[parameter]["anomaly_score"]
                    status = scores[parameter]["status"]
                else:
                    status = classify(parameter, value)
                    anomaly_score = 0.9 if status == "CRITICAL" else 0.65 if status == "WARNING" else 0.0
                connection.execute(
                    "INSERT INTO telemetry(timestamp,spacecraft_id,parameter,value,unit,source,anomaly_score,status) VALUES (?,?,?,?,?,?,?,?)",
                    (timestamp, satellite_id, parameter, value, PARAMETERS[parameter]["unit"], "SIMULATED LIVE DATA", anomaly_score, status),
                )
        connection.commit()

def get_history(parameter: str = "battery_voltage", limit: int = 160) -> list[dict[str, Any]]:
    if parameter not in PARAMETERS:
        raise HTTPException(status_code=400, detail="Unknown telemetry parameter")
    return query_all("SELECT timestamp,parameter,value,unit,source,anomaly_score,status FROM telemetry WHERE parameter=? ORDER BY id DESC LIMIT ?", (parameter, max(1, min(limit, 1000))))[::-1]

def knowledge_search(query: str, limit: int = 6) -> list[dict[str, Any]]:
    docs = query_all("SELECT id,title,type,content FROM documents")
    if not docs:
        return []
    corpus = [f"{doc['title']} {doc['content']}" for doc in docs]
    query_terms = re.findall(r"[a-z0-9]+", query.lower())
    tokenized = [re.findall(r"[a-z0-9]+", text.lower()) for text in corpus]
    bm25_scores = np.asarray(BM25Okapi(tokenized).get_scores(query_terms), dtype=float)
    bm25_max = float(bm25_scores.max()) if len(bm25_scores) else 0
    bm25_normalized = bm25_scores / bm25_max if bm25_max > 0 else bm25_scores
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), stop_words="english")
    matrix = vectorizer.fit_transform(corpus + [query])
    vector_scores = cosine_similarity(matrix[-1], matrix[:-1]).ravel()
    query_word_set = set(query_terms)
    ranked = []
    for index, doc in enumerate(docs):
        title_terms = set(re.findall(r"[a-z0-9]+", doc["title"].lower()))
        title_match = len(query_word_set & title_terms) / max(len(query_word_set), 1)
        score = 0.45 * bm25_normalized[index] + 0.4 * vector_scores[index] + 0.15 * title_match
        ranked.append({**doc, "score": round(float(score), 3), "bm25_score": round(float(bm25_normalized[index]), 3), "vector_score": round(float(vector_scores[index]), 3)})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return [item for item in ranked if item["score"] > 0][:limit]

def correlated_events(timestamp: str, window_seconds: int = 300) -> list[dict[str, Any]]:
    target = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    matches = []
    for event in query_all("SELECT id,timestamp,spacecraft_id,subsystem,event_type,description,severity,source FROM events"):
        event_time = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
        delta = abs((event_time - target).total_seconds())
        if delta <= window_seconds and event["subsystem"] in ("POWER", "THERMAL", "COMMUNICATION", "ATTITUDE", "ML", "INCIDENT"):
            matches.append({**event, "delta_seconds": round(delta)})
    return sorted(matches, key=lambda item: item["delta_seconds"])

def append_audit(action: str, details: dict[str, Any]) -> None:
    execute("INSERT INTO audit_logs(timestamp,action,details) VALUES (?,?,?)", (iso(), action, json.dumps(details)))

def make_incident_result(question: str, incident_id: str = "INC-024", spacecraft_id: str = "ORBIT-X1") -> dict[str, Any]:
    evidence = knowledge_search(question + " battery voltage power configuration", 5)
    telemetry = get_history("battery_voltage", 30)
    latest_timestamp = telemetry[-1]["timestamp"] if telemetry else iso()
    relevant_events = correlated_events(latest_timestamp)
    lowered_question = question.lower()
    security_question = any(term in lowered_question for term in ("hacked", "compromised", "intrusion", "security event"))
    location_question = any(term in lowered_question for term in ("where is", "current position", "location of"))
    safety_question = any(term in lowered_question for term in ("is it safe", "safe to", "safety status"))
    unsupported = any(term in lowered_question for term in ("physically break", "broken", "solar array broke", "array broken")) or security_question
    evidence_ids = [item["id"] for item in evidence]
    if unsupported:
        security_evidence = []
        if security_question:
            satellite_id = _question_spacecraft(question, spacecraft_id)
            satellite = MISSION_SIMULATOR.get(satellite_id)
            for check in satellite.security_checks:
                if check["status"] != "VERIFIED":
                    security_evidence.append({
                        "id": check["evidence_id"],
                        "title": check["check"],
                        "type": "security_check",
                        "content": f"{check['status']}: {check['reason']}",
                        "timestamp": check["timestamp"],
                        "source": check["source"],
                    })
            evidence_ids.extend(item["id"] for item in security_evidence)
        observed_facts = [
            f"Simulated check indication: {item['title']} ({item['content']})."
            for item in security_evidence
        ]
        if not observed_facts:
            observed_facts = ["No verified security-forensics evidence or independent inspection evidence is available for this claim."]
        result = {
            "mode": "LOCAL DEMO REASONING",
            "question": question,
            "evidence_sufficiency": "INSUFFICIENT EVIDENCE",
            "observed_facts": observed_facts,
            "correlated_events": [],
            "historical_context": [],
            "hypothesis": "No conclusion is supported by the available evidence. A simulated warning does not establish a real intrusion or compromise.",
            "recommendation": "Review authenticated packet and signature logs and validate any alert with an independent source. No directly matching security procedure is available in the demo knowledge base.",
            "confidence": "LOW",
            "validation": [{"claim": question, "status": "UNSUPPORTED", "sources": [item["id"] for item in security_evidence]}],
            "missing_evidence": ["Authenticated packet/signature logs from a verified source", "Independent forensic analysis", "A validated security procedure"],
            "sources": security_evidence,
        }
    elif location_question or safety_question:
        satellite_id = _question_spacecraft(question, spacecraft_id)
        satellite = MISSION_SIMULATOR.get(satellite_id)
        snapshot = satellite.snapshot()
        message = snapshot["last_known_message"]
        source = {
            "id": message["message_id"],
            "title": f"{satellite_id} last received telemetry",
            "type": "telemetry",
            "content": json.dumps(message, sort_keys=True),
            "timestamp": message["timestamp"],
            "source": message["source"],
        }
        if location_question:
            if satellite.communication_state == "CONNECTED":
                facts = [f"{satellite_id} simulated position: {satellite.latitude:.3f}°, {satellite.longitude:.3f}°, altitude {satellite.altitude:.1f} km. Source: SIMULATED ORBIT MODEL."]
                sufficiency = "PARTIAL"
                hypothesis = "This position is generated by the demo orbit model and is not a real spacecraft position."
            else:
                facts = [
                    f"Last telemetry-confirmed position for {satellite_id}: {message['latitude']:.3f}°, {message['longitude']:.3f}° at {message['timestamp']}.",
                    f"Model estimate: {satellite.latitude:.3f}°, {satellite.longitude:.3f}°; this is not telemetry confirmed.",
                ]
                sufficiency = "INSUFFICIENT EVIDENCE"
                hypothesis = "Current spacecraft position is unknown during the communication gap; only the last received position and a simulated estimate are available."
            recommendation = "Use a verified telemetry or ephemeris source before making an operational location assessment."
        else:
            facts = [
                f"Demo health assessment: {snapshot['health_score']}/100 ({snapshot['health_state']}); source is simulated.",
                f"Communication: {snapshot['communication']}; security indicator: {snapshot['security']}.",
                "These demo indicators do not establish real spacecraft safety.",
            ]
            sufficiency = "INSUFFICIENT EVIDENCE"
            hypothesis = "Real spacecraft safety cannot be verified from this simulated environment."
            recommendation = "Review verified telemetry, communication integrity, and mission-specific safety criteria with a human operator."
        result = {
            "mode": "LOCAL DEMO REASONING",
            "question": question,
            "evidence_sufficiency": sufficiency,
            "observed_facts": facts,
            "correlated_events": [],
            "historical_context": [],
            "hypothesis": hypothesis,
            "recommendation": recommendation,
            "confidence": "LOW",
            "validation": [{"claim": facts[0], "status": "SUPPORTED WITHIN SIMULATION ONLY", "sources": [source["id"]]}],
            "missing_evidence": ["Verified spacecraft telemetry or ephemeris", "Mission-approved safety limits", "Independent source authentication"],
            "sources": [source],
        }
        evidence_ids.append(source["id"])
    else:
        recent_values = [float(item["value"]) for item in telemetry]
        latest = recent_values[-1] if recent_values else 28.5
        initial = recent_values[0] if recent_values else 28.5
        matching_events = [event for event in relevant_events if event["subsystem"] in ("POWER", "COMMUNICATION")]
        fact = f"Battery voltage telemetry spans {initial:.2f} V to {latest:.2f} V in the retained window. Source: SIMULATED LIVE DATA."
        result = {
            "mode": "LOCAL DEMO REASONING",
            "question": question,
            "evidence_sufficiency": "PARTIAL",
            "observed_facts": [fact],
            "correlated_events": matching_events[:3],
            "historical_context": [item for item in evidence if item["type"] == "historical_incident"][:2],
            "hypothesis": "A power configuration event is temporally associated with the simulated voltage change; available evidence does not establish causation.",
            "recommendation": "Review the pre/post-event voltage, solar power and load records against P-017 and P-031. This is an operator recommendation, not a spacecraft command.",
            "confidence": "MEDIUM",
            "validation": [{"claim": fact, "status": "SUPPORTED", "sources": ["SIMULATED LIVE TELEMETRY"]}, {"claim": "Configuration change caused the voltage decline.", "status": "UNSUPPORTED / NOT ESTABLISHED", "sources": ["EV-204"]}],
            "missing_evidence": ["Independent power-load telemetry", "Verified solar-array output records"],
            "sources": evidence,
        }
    append_audit("INVESTIGATION", {"question": question, "incident_id": incident_id, "evidence": evidence_ids, "result": result, "command": "NONE"})
    return result

def _question_spacecraft(question: str, selected_spacecraft_id: str) -> str:
    lowered_question = question.lower()
    if "orbit-x1" in lowered_question:
        return "ORBIT-X1"
    if "orbit-x2" in lowered_question:
        return "ORBIT-X2"
    try:
        return MISSION_SIMULATOR.get(selected_spacecraft_id).satellite_id
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Spacecraft not found") from error

@app.on_event("startup")
def startup() -> None:
    initialize_database()
    latest = telemetry_latest()
    SIMULATION["latest"] = {key: float(item["value"]) for key, item in latest.items()}

@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "mission-operations-copilot", "database": "sqlite-persistent-demo", "mode": "SIMULATED LIVE DATA"}

@app.get("/api/system")
def system() -> dict[str, Any]:
    return {"llm_provider": os.getenv("LLM_PROVIDER", "LOCAL"), "model_name": os.getenv("MODEL_NAME", "deterministic-evidence-engine"), "mode": "SIMULATED LIVE DATA", "live_spacecraft_connection": False}

@app.get("/api/spacecraft")
def spacecraft() -> list[dict[str, Any]]:
    return MISSION_SIMULATOR.fleet()

@app.get("/api/mission/fleet")
def mission_fleet() -> dict[str, Any]:
    return {"source": "SIMULATED MISSION DATA", "orbit_model": "SIMULATED ORBIT MODEL", "spacecraft": MISSION_SIMULATOR.fleet()}

@app.get("/api/mission/ground-stations")
def mission_ground_stations() -> list[dict[str, Any]]:
    return [
        {
            **station,
            "visible_spacecraft": [
                satellite.satellite_id
                for satellite in MISSION_SIMULATOR.satellites.values()
                if MISSION_SIMULATOR.nearest_station(satellite)["id"] == station["id"]
                and MISSION_SIMULATOR.nearest_station(satellite)["visible"]
            ],
        }
        for station in MISSION_SIMULATOR.ground_stations
    ]

@app.get("/api/mission/{spacecraft_id}")
def mission_detail(spacecraft_id: str) -> dict[str, Any]:
    try:
        satellite = MISSION_SIMULATOR.get(spacecraft_id)
        return {**satellite.snapshot(), "ground_station": MISSION_SIMULATOR.nearest_station(satellite)}
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Spacecraft not found") from error

@app.get("/api/mission/{spacecraft_id}/position")
def mission_position(spacecraft_id: str) -> dict[str, Any]:
    item = mission_detail(spacecraft_id)
    return {
        "spacecraft_id": item["id"],
        "position_status": item["position_status"],
        "last_confirmed": item["last_known_message"],
        "estimated": {"latitude": item["estimated_latitude"], "longitude": item["estimated_longitude"]},
        "source": "SIMULATED ORBIT MODEL",
    }

@app.get("/api/mission/{spacecraft_id}/last-message")
def mission_last_message(spacecraft_id: str) -> dict[str, Any]:
    return mission_detail(spacecraft_id)["last_known_message"]

@app.get("/api/mission/{spacecraft_id}/communication")
def mission_communication(spacecraft_id: str) -> dict[str, Any]:
    item = mission_detail(spacecraft_id)
    return {
        "spacecraft_id": item["id"],
        "state": item["communication"],
        "lost_at": item["communication_lost_at"],
        "last_message": item["last_known_message"],
        "ground_station": item["ground_station"],
        "reconnection": item["reconnection"],
    }

@app.get("/api/mission/{spacecraft_id}/security")
def mission_security(spacecraft_id: str) -> dict[str, Any]:
    item = mission_detail(spacecraft_id)
    return {"spacecraft_id": item["id"], "state": item["security"], "compromise_confirmed": False, "checks": item["security_checks"], "source": "SIMULATED SECURITY CHECKS"}

@app.get("/api/mission/{spacecraft_id}/health")
def mission_health(spacecraft_id: str) -> dict[str, Any]:
    item = mission_detail(spacecraft_id)
    return {"spacecraft_id": item["id"], "score": item["health_score"], "state": item["health_state"], "factors": item["health_factors"], "weights": {"power": 25, "thermal": 20, "communication": 20, "attitude": 15, "compute": 10, "security": 10}}

@app.get("/api/mission/{spacecraft_id}/events")
def mission_events(spacecraft_id: str) -> list[dict[str, Any]]:
    mission_detail(spacecraft_id)
    return query_all("SELECT id,timestamp,spacecraft_id,subsystem,event_type,description,severity,source FROM events WHERE spacecraft_id=? ORDER BY timestamp DESC LIMIT 100", (spacecraft_id.upper(),))

@app.get("/api/mission/{spacecraft_id}/telemetry")
def mission_telemetry(spacecraft_id: str) -> dict[str, Any]:
    satellite = mission_detail(spacecraft_id)
    connected = satellite["communication"] == "CONNECTED"
    return {
        "spacecraft_id": satellite["id"],
        "available": connected,
        "source": "SIMULATED MISSION DATA",
        "data": satellite["last_known_message"]["telemetry"] if connected else None,
        "last_confirmed": satellite["last_known_message"] if not connected else None,
    }

def record_demo_event(spacecraft_id: str, subsystem: str, event_type: str, description: str, severity: str) -> str:
    event_id = f"EV-{int(now_utc().timestamp() * 1000)}"
    execute(
        "INSERT INTO events VALUES (?,?,?,?,?,?,?,?)",
        (event_id, iso(), spacecraft_id, subsystem, event_type, description, severity, "SIMULATED MISSION DATA"),
    )
    return event_id

@app.post("/api/demo/anomaly")
def demo_anomaly(payload: DemoAction = DemoAction()) -> dict[str, Any]:
    try:
        satellite = MISSION_SIMULATOR.get(payload.spacecraft_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Spacecraft not found") from error
    satellite.simulate_anomaly()
    event_id = record_demo_event(satellite.satellite_id, "POWER", "POWER_ANOMALY", "Simulated solar generation reduction with correlated battery-voltage decline.", "WARNING")
    append_audit("DEMO_POWER_ANOMALY", {"spacecraft_id": satellite.satellite_id, "event_id": event_id, "command": "NONE"})
    return {"status": "SIMULATED ANOMALY", "event_id": event_id, "spacecraft": satellite.snapshot()}

@app.post("/api/demo/communication-loss")
def demo_communication_loss(payload: DemoAction = DemoAction()) -> dict[str, Any]:
    try:
        satellite = MISSION_SIMULATOR.get(payload.spacecraft_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Spacecraft not found") from error
    changed = satellite.simulate_communication_loss()
    if changed:
        event_id = record_demo_event(satellite.satellite_id, "COMMUNICATION", "LINK_LOST", "Simulated communication interruption; telemetry is frozen at the last confirmed message.", "HIGH")
        append_audit("DEMO_COMMUNICATION_LOST", {"spacecraft_id": satellite.satellite_id, "event_id": event_id, "last_message_id": satellite.last_message["message_id"], "command": "NONE"})
    return {"status": satellite.communication_state, "spacecraft": satellite.snapshot()}

@app.post("/api/demo/reconnect")
def demo_reconnect(payload: DemoAction = DemoAction()) -> dict[str, Any]:
    try:
        satellite = MISSION_SIMULATOR.get(payload.spacecraft_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Spacecraft not found") from error
    comparison = satellite.restore_communication()
    if comparison:
        event_id = record_demo_event(satellite.satellite_id, "COMMUNICATION", "LINK_RESTORED", "Simulated link restored; new telemetry compared with the last confirmed message.", "INFO")
        append_audit("DEMO_COMMUNICATION_RESTORED", {"spacecraft_id": satellite.satellite_id, "event_id": event_id, "downtime_seconds": comparison["downtime_seconds"], "command": "NONE"})
    return {"status": satellite.communication_state, "reconnection": comparison, "spacecraft": satellite.snapshot()}

@app.post("/api/demo/security-event")
def demo_security_event(payload: DemoAction = DemoAction()) -> dict[str, Any]:
    try:
        satellite = MISSION_SIMULATOR.get(payload.spacecraft_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Spacecraft not found") from error
    satellite.simulate_security_event()
    event_id = record_demo_event(satellite.satellite_id, "SECURITY", "POTENTIAL_SECURITY_EVENT", "Simulated signature failure and sequence warning. No compromise is confirmed.", "HIGH")
    append_audit("DEMO_SECURITY_EVENT", {"spacecraft_id": satellite.satellite_id, "event_id": event_id, "evidence_ids": [check["evidence_id"] for check in satellite.security_checks if check["status"] != "VERIFIED"], "command": "NONE"})
    return {"status": satellite.security_state, "compromise_confirmed": False, "spacecraft": satellite.snapshot()}

@app.post("/api/demo/reset")
def demo_reset() -> dict[str, Any]:
    global STREAM_FRAME, STREAM_FRAME_AT
    MISSION_SIMULATOR.reset()
    SIMULATION.update(running=True, replay_step=-1, tick=0, latest={})
    ANOMALY_MODELS.clear()
    update_sim_state()
    STREAM_FRAME = None
    STREAM_FRAME_AT = 0.0
    append_audit("DEMO_RESET", {"source": "SIMULATED MISSION DATA", "command": "NONE"})
    return {"status": "RESET", "spacecraft": MISSION_SIMULATOR.fleet()}

@app.get("/api/simulation/status")
def simulation_status() -> dict[str, Any]:
    return {"running": SIMULATION["running"], "replay_step": SIMULATION["replay_step"], "tick": SIMULATION["tick"], "source": "SIMULATED LIVE DATA"}

@app.post("/api/simulation/start")
def simulation_start() -> dict[str, Any]:
    SIMULATION["running"] = True
    update_sim_state()
    append_audit("SIMULATION_STARTED", {"source": "SIMULATED LIVE DATA"})
    return simulation_status()

@app.post("/api/simulation/stop")
def simulation_stop() -> dict[str, Any]:
    SIMULATION["running"] = False
    update_sim_state()
    append_audit("SIMULATION_STOPPED", {"source": "SIMULATED LIVE DATA"})
    return simulation_status()

@app.post("/api/simulation/replay-incident")
def replay_incident() -> dict[str, Any]:
    SIMULATION["running"] = True
    SIMULATION["replay_step"] = 0
    SIMULATION["tick"] = 0
    execute("UPDATE simulation_state SET running=1,replay_step=0,tick=0 WHERE id=1")
    append_audit("INCIDENT_REPLAY_STARTED", {"incident_id": "INC-024", "command": "NONE"})
    return {"status": "REPLAYING", "incident_id": "INC-024", "source": "SIMULATED LIVE DATA"}

@app.get("/api/telemetry/latest")
def latest_telemetry() -> dict[str, Any]:
    values = telemetry_latest()
    timestamp = values.get("battery_voltage", {}).get("timestamp", iso())
    return {
        "timestamp": timestamp,
        "spacecraft_id": "ORBIT-X1",
        "communication": MISSION_SIMULATOR.get("ORBIT-X1").communication_state,
        "source": "SIMULATED LIVE DATA",
        "values": values,
    }

@app.get("/api/telemetry/history")
def telemetry_history(parameter: str = "battery_voltage", limit: int = 160) -> dict[str, Any]:
    return {"parameter": parameter, "data": get_history(parameter, limit), "source": "SIMULATED LIVE DATA"}

@app.get("/api/telemetry/analysis")
def telemetry_analysis(
    spacecraft_id: str = "ORBIT-X1",
    parameter: str = "battery_voltage",
    window_seconds: int = 300,
) -> dict[str, Any]:
    if spacecraft_id not in MISSION_SIMULATOR.satellites:
        raise HTTPException(status_code=400, detail="Unknown spacecraft")
    if parameter not in PARAMETERS:
        raise HTTPException(status_code=400, detail="Unknown telemetry parameter")
    if not 30 <= window_seconds <= 3600:
        raise HTTPException(status_code=400, detail="window_seconds must be between 30 and 3600")

    now = now_utc()
    cutoff = iso(now - timedelta(seconds=window_seconds))
    rows = query_all(
        "SELECT timestamp,parameter,value,unit,source,anomaly_score,status "
        "FROM telemetry WHERE spacecraft_id=? AND timestamp>=? "
        "ORDER BY timestamp ASC, parameter ASC",
        (spacecraft_id, cutoff),
    )
    selected = [row for row in rows if row["parameter"] == parameter]
    values = np.asarray([float(row["value"]) for row in selected], dtype=float)
    sample_count = int(values.size)
    mean = float(values.mean()) if sample_count else None
    standard_deviation = float(values.std()) if sample_count else None
    minimum = float(values.min()) if sample_count else None
    maximum = float(values.max()) if sample_count else None

    trend_slope = None
    trend_delta = None
    trend_direction = "INSUFFICIENT SAMPLES"
    if sample_count >= 2:
        elapsed_minutes = np.asarray([
            (datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")) -
             datetime.fromisoformat(selected[0]["timestamp"].replace("Z", "+00:00"))).total_seconds() / 60
            for row in selected
        ], dtype=float)
        trend_slope = float(np.polyfit(elapsed_minutes, values, 1)[0]) if np.ptp(elapsed_minutes) else 0.0
        trend_delta = float(values[-1] - values[0])
        tolerance = max(abs(mean or 0.0) * 0.005, 0.01)
        trend_direction = "STABLE" if abs(trend_delta) <= tolerance else "TRENDING UP" if trend_delta > 0 else "TRENDING DOWN"

    frames: dict[str, dict[str, float]] = {}
    sources: set[str] = set()
    for row in rows:
        frames.setdefault(row["timestamp"], {})[row["parameter"]] = float(row["value"])
        sources.add(row["source"])
    paired = [
        (frame["battery_voltage"], frame["solar_power"])
        for frame in frames.values()
        if "battery_voltage" in frame and "solar_power" in frame
    ]
    correlation = None
    if len(paired) >= 2:
        paired_values = np.asarray(paired, dtype=float)
        if np.ptp(paired_values[:, 0]) > 0 and np.ptp(paired_values[:, 1]) > 0:
            correlation = float(np.corrcoef(paired_values[:, 0], paired_values[:, 1])[0, 1])

    timestamps = [datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")) for row in selected]
    gap_count = sum(
        (later - earlier).total_seconds() > 15
        for earlier, later in zip(timestamps, timestamps[1:])
    )
    latest_age_seconds = (now - timestamps[-1]).total_seconds() if timestamps else None
    statuses = {
        state: sum(row["status"] == state for row in selected)
        for state in ("NORMAL", "WARNING", "CRITICAL")
    }
    return {
        "spacecraft_id": spacecraft_id,
        "parameter": parameter,
        "label": PARAMETERS[parameter]["label"],
        "unit": PARAMETERS[parameter]["unit"],
        "window_seconds": window_seconds,
        "source": sorted(sources),
        "communication": MISSION_SIMULATOR.get(spacecraft_id).communication_state,
        "latest_age_seconds": round(latest_age_seconds, 2) if latest_age_seconds is not None else None,
        "sample_count": sample_count,
        "statistics": {
            "mean": mean,
            "minimum": minimum,
            "maximum": maximum,
            "standard_deviation": standard_deviation,
        },
        "trend": {
            "direction": trend_direction,
            "delta": trend_delta,
            "slope_per_minute": trend_slope,
        },
        "status_counts": statuses,
        "anomaly_count": sum(float(row["anomaly_score"] or 0) >= 0.6 for row in selected),
        "gap_count": gap_count,
        "battery_solar_correlation": correlation,
        "correlation_sample_count": len(paired),
        "samples": selected,
        "analysis_source": "PERSISTED TELEMETRY · SIMULATED DEMO",
        "interpretation": "Descriptive statistics only; temporal association does not establish causation.",
    }

@app.post("/api/telemetry/ingest")
async def ingest_telemetry(request: Request) -> dict[str, Any]:
    body = await request.body()
    if len(body) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Upload exceeds 5 MB")
    source = request.query_params.get("source", "PUBLIC HISTORICAL DATA")
    if source not in ("PUBLIC HISTORICAL DATA", "SIMULATED LIVE DATA"):
        raise HTTPException(status_code=400, detail="Source must be PUBLIC HISTORICAL DATA or SIMULATED LIVE DATA")
    content_type = request.headers.get("content-type", "")
    try:
        if "json" in content_type:
            payload = json.loads(body)
            records = payload if isinstance(payload, list) else payload.get("records", [])
        elif "text/csv" in content_type or "multipart/form-data" in content_type:
            text = body.decode("utf-8-sig")
            records = list(csv.DictReader(io.StringIO(text)))
        else:
            raise HTTPException(status_code=415, detail="Upload CSV or JSON telemetry")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid upload: {error}") from error
    if not isinstance(records, list) or not records or len(records) > 20000:
        raise HTTPException(status_code=400, detail="Upload must contain 1 to 20,000 telemetry records")
    normalized = []
    for row in records:
        try:
            timestamp = datetime.fromisoformat(str(row["timestamp"]).replace("Z", "+00:00")).astimezone(timezone.utc)
            parameter = str(row["parameter"]).strip().lower()
            if parameter not in PARAMETERS:
                raise ValueError(f"unknown parameter {parameter}")
            value = float(row["value"])
            if not math.isfinite(value):
                raise ValueError("value must be finite")
            spacecraft_id = str(row.get("spacecraft_id", "ORBIT-X1"))[:60]
            unit = str(row.get("unit", PARAMETERS[parameter]["unit"]))[:20]
            normalized.append((iso(timestamp), spacecraft_id, parameter, value, unit, source))
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=f"Invalid telemetry row: {error}") from error
    with DB_LOCK, closing(db_connection()) as connection:
        connection.executemany("INSERT INTO telemetry(timestamp,spacecraft_id,parameter,value,unit,source) VALUES (?,?,?,?,?,?)", normalized)
        connection.commit()
    anomaly_count = 0
    for parameter in {record[2] for record in normalized}:
        rows = query_all("SELECT id,value FROM telemetry WHERE parameter=? ORDER BY id DESC LIMIT 120", (parameter,))
        if len(rows) >= 20:
            data = np.asarray([item["value"] for item in rows], dtype=float)
            features = np.column_stack((data, np.gradient(data), np.full(len(data), data.mean())))
            model = IsolationForest(n_estimators=80, contamination=0.04, random_state=7)
            model.fit(features)
            latest_features = features[:len(normalized)]
            scores = np.clip((0.5 - model.score_samples(latest_features)) * 2, 0, 1)
            with DB_LOCK, closing(db_connection()) as connection:
                for row, score in zip(rows[:len(scores)], scores):
                    status = classify(parameter, float(row["value"]))
                    connection.execute("UPDATE telemetry SET anomaly_score=?,status=? WHERE id=?", (float(score), status, row["id"]))
                    anomaly_count += int(float(score) > 0.6)
                connection.commit()
    append_audit("TELEMETRY_INGESTED", {"count": len(normalized), "source": source})
    return {"stored": len(normalized), "source": source, "validated": True, "anomaly_count": anomaly_count}

@app.get("/api/events")
def events() -> list[dict[str, Any]]:
    return query_all("SELECT id,timestamp,spacecraft_id,subsystem,event_type,description,severity,source FROM events ORDER BY timestamp DESC LIMIT 100")

@app.post("/api/events/ingest")
def ingest_event(payload: IngestEvent) -> dict[str, Any]:
    event_id = f"EV-{int(now_utc().timestamp() * 1000)}"
    execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)", (event_id, iso(payload.timestamp), payload.spacecraft_id, payload.subsystem.upper(), payload.event_type.upper(), payload.description, payload.severity.upper(), payload.source))
    append_audit("EVENT_INGESTED", {"event_id": event_id})
    return {"id": event_id, "stored": True}

@app.get("/api/incidents")
def incidents() -> list[dict[str, Any]]:
    return query_all("SELECT id,title,severity,status,subsystem,summary,created_at FROM incidents ORDER BY created_at DESC")

@app.get("/api/incidents/{incident_id}")
def incident_detail(incident_id: str) -> dict[str, Any]:
    rows = query_all("SELECT * FROM incidents WHERE id=?", (incident_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Incident not found")
    return rows[0]

@app.post("/api/incidents/{incident_id}/investigate")
def investigate_incident(incident_id: str, payload: InvestigationRequest) -> dict[str, Any]:
    incident_detail(incident_id)
    return make_incident_result(payload.question, incident_id, payload.spacecraft_id)

@app.post("/api/investigate")
def investigate(payload: InvestigationRequest) -> dict[str, Any]:
    return make_incident_result(payload.question, payload.incident_id, payload.spacecraft_id)

@app.post("/api/rag/search")
def rag_search(payload: InvestigationRequest) -> dict[str, Any]:
    results = knowledge_search(payload.question)
    append_audit("EVIDENCE_SEARCH", {"query": payload.question, "sources": [item["id"] for item in results]})
    return {"query": payload.question, "results": results, "retrieval": "BM25 + TF-IDF cosine hybrid ranking with title-aware reranking", "external_embeddings": False}

@app.get("/api/evidence-library")
def evidence_library() -> list[dict[str, Any]]:
    library: list[dict[str, Any]] = query_all("SELECT id,title,type,content FROM documents ORDER BY type,id")
    for event in query_all("SELECT id,timestamp,event_type,description,severity,source FROM events ORDER BY timestamp DESC LIMIT 20"):
        library.append({"id": event["id"], "title": event["event_type"], "type": "event", "content": event["description"], "timestamp": event["timestamp"], "source": event["source"], "severity": event["severity"]})
    latest = query_all("SELECT timestamp,value,unit,source FROM telemetry WHERE parameter='battery_voltage' ORDER BY id DESC LIMIT 1")
    if latest:
        library.append({"id": "TEL-1032", "title": "Battery voltage telemetry", "type": "telemetry", "content": f"{latest[0]['value']:.3f} {latest[0]['unit']}", **latest[0]})
    for satellite in MISSION_SIMULATOR.satellites.values():
        for check in satellite.security_checks:
            library.append({
                "id": check["evidence_id"],
                "title": check["check"],
                "type": "security_check",
                "content": f"{check['status']}: {check['reason']}",
                "timestamp": check["timestamp"],
                "source": check["source"],
            })
    return library

@app.get("/api/evidence/{source_id}")
def get_evidence(source_id: str) -> dict[str, Any]:
    rows = query_all("SELECT id,title,type,content FROM documents WHERE id=?", (source_id,))
    if rows:
        return rows[0]
    telemetry_ids = {"TEL-1032", "TEL-LATEST"}
    if source_id in telemetry_ids:
        latest = query_all("SELECT timestamp,parameter,value,unit,source FROM telemetry WHERE parameter='battery_voltage' ORDER BY id DESC LIMIT 1")
        if latest:
            return {"id": source_id, "title": "Battery voltage telemetry", "type": "telemetry", **latest[0]}
    for satellite in MISSION_SIMULATOR.satellites.values():
        if satellite.last_message["message_id"] == source_id:
            return {"id": source_id, "title": f"{satellite.satellite_id} last received telemetry", "type": "telemetry", **satellite.last_message}
    event_rows = query_all("SELECT id,timestamp,event_type,description,severity,source FROM events WHERE id=?", (source_id,))
    if event_rows:
        return {"type": "event", **event_rows[0]}
    for satellite in MISSION_SIMULATOR.satellites.values():
        for check in satellite.security_checks:
            if check["evidence_id"] == source_id:
                return {"id": source_id, "title": check["check"], "type": "security_check", "content": f"{check['status']}: {check['reason']}", **check}
    raise HTTPException(status_code=404, detail="Evidence source not found")

@app.get("/api/audit")
def audit() -> list[dict[str, Any]]:
    return query_all("SELECT id,timestamp,action,details FROM audit_logs ORDER BY id DESC LIMIT 200")

@app.get("/api/similar-incidents/{incident_id}")
def similar_incidents(incident_id: str) -> dict[str, Any]:
    incident_detail(incident_id)
    return {"incident_id": incident_id, "results": HISTORICAL_INCIDENTS[:3]}

@app.post("/api/contact")
def contact(payload: ContactRequest) -> dict[str, Any]:
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", payload.email):
        raise HTTPException(status_code=422, detail="Enter a valid email address")
    values = [payload.name, payload.email, payload.organization, payload.message]
    if any(re.search(r"<\s*script", value, re.IGNORECASE) for value in values):
        raise HTTPException(status_code=400, detail="HTML or script content is not allowed")
    with DB_LOCK, closing(db_connection()) as connection:
        cursor = connection.execute("INSERT INTO contact_messages(name,email,organization,message,created_at) VALUES (?,?,?,?,?)", (*values, iso()))
        connection.commit()
        message_id = cursor.lastrowid
    return {"success": True, "id": message_id, "message": "Message received."}

@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    return {"currentTime": iso(), "mission": "ORBIT-X1", "running": SIMULATION["running"], "replay_step": SIMULATION["replay_step"], "latest": telemetry_latest(), "source": "SIMULATED LIVE DATA"}

async def current_stream_frame() -> dict[str, Any]:
    global STREAM_FRAME, STREAM_FRAME_AT, STREAM_SCORES
    async with STREAM_LOCK:
        current_time = now_utc().timestamp()
        if STREAM_FRAME is not None and current_time - STREAM_FRAME_AT < 0.18:
            return STREAM_FRAME
        if not SIMULATION["running"]:
            STREAM_FRAME = {"type": "status", "timestamp": iso(), "source": "SIMULATED LIVE DATA", "mission_fleet": MISSION_SIMULATOR.fleet(), "running": False}
            STREAM_FRAME_AT = current_time
            return STREAM_FRAME
        previous_timestamp = STREAM_FRAME_AT
        if SIMULATION["replay_step"] >= 0:
            if SIMULATION["tick"] % 7 == 0:
                SIMULATION["replay_step"] += 1
                if SIMULATION["replay_step"] > 18:
                    SIMULATION["replay_step"] = -1
        SIMULATION["tick"] += 1
        elapsed = max(0.18, min(0.25, current_time - previous_timestamp)) if previous_timestamp else 0.2
        MISSION_SIMULATOR.update(elapsed)
        if MISSION_SIMULATOR.get("ORBIT-X1").communication_state == "NO SIGNAL":
            STREAM_FRAME = {
                "type": "communication", "timestamp": iso(), "spacecraft_id": "ORBIT-X1",
                "source": "SIMULATED MISSION DATA", "mission_fleet": MISSION_SIMULATOR.fleet(),
                "events": query_all("SELECT id,timestamp,spacecraft_id,subsystem,event_type,description,severity,source FROM events ORDER BY timestamp DESC LIMIT 20"),
                "running": True, "replay_step": SIMULATION["replay_step"],
            }
            STREAM_FRAME_AT = current_time
            return STREAM_FRAME
        values = generate_values(SIMULATION["replay_step"])
        if not STREAM_SCORES or SIMULATION["tick"] % 5 == 0:
            STREAM_SCORES = score_anomalies(values)
        scores = STREAM_SCORES
        if SIMULATION["tick"] % 25 == 0:
            persist_tick(values, scores)
        SIMULATION["latest"] = values
        replay_events = {
            2: ("EV-204", "POWER", "CONFIGURATION_CHANGE", "Power configuration changed.", "WARNING"),
            4: ("EV-207", "POWER", "VOLTAGE_WARNING", "Battery voltage entered warning band.", "WARNING"),
            6: ("EV-208", "POWER", "VOLTAGE_CRITICAL", "Battery voltage reached critical replay threshold.", "HIGH"),
            8: ("EV-206", "COMMUNICATION", "LINK_DEGRADED", "Communication quality degraded during incident replay.", "WARNING"),
            10: ("EV-209", "ML", "ANOMALY_DETECTED", "Isolation Forest flagged telemetry deviation.", "HIGH"),
            18: ("EV-210", "INCIDENT", "INCIDENT_CREATED", "INC-024 incident replay completed.", "HIGH"),
        }
        label = replay_events.get(SIMULATION["replay_step"])
        if label:
            execute("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,?)",
                    (label[0], iso(), "ORBIT-X1", label[1], label[2], label[3], label[4], "SIMULATED LIVE DATA"))
            if SIMULATION["replay_step"] == 18:
                execute("UPDATE incidents SET status='ACTIVE',severity='HIGH' WHERE id='INC-024'")
        high_score = max((item["anomaly_score"] for item in scores.values()), default=0)
        if high_score >= 0.75:
            nearby = correlated_events(iso())
            if nearby:
                execute("UPDATE incidents SET status='ACTIVE',severity='HIGH',summary=? WHERE id='INC-024'",
                        ("Anomaly correlated with nearby event(s); temporal association does not establish causation.",))
        if SIMULATION["tick"] % 25 == 0:
            update_sim_state()
        STREAM_FRAME = {
            "type": "telemetry", "timestamp": iso(), "spacecraft_id": "ORBIT-X1",
            "source": "SIMULATED LIVE DATA", "values": values, "anomalies": scores,
            "events": query_all("SELECT id,timestamp,spacecraft_id,subsystem,event_type,description,severity,source FROM events ORDER BY timestamp DESC LIMIT 20"),
            "mission_fleet": MISSION_SIMULATOR.fleet(),
            "running": True, "replay_step": SIMULATION["replay_step"],
        }
        STREAM_FRAME_AT = current_time
        return STREAM_FRAME

@app.websocket("/ws/telemetry")
async def telemetry_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(await current_stream_frame())
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return

@app.websocket("/ws/mission")
async def mission_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            frame = await current_stream_frame()
            await websocket.send_json({
                "type": "mission",
                "timestamp": frame["timestamp"],
                "source": "SIMULATED MISSION DATA",
                "spacecraft": frame.get("mission_fleet", MISSION_SIMULATOR.fleet()),
                "ground_stations": mission_ground_stations(),
                "events": frame.get("events", []),
            })
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return

@app.websocket("/ws/telemetry/{spacecraft_id}")
async def spacecraft_telemetry_stream(websocket: WebSocket, spacecraft_id: str) -> None:
    await websocket.accept()
    try:
        satellite = MISSION_SIMULATOR.get(spacecraft_id)
    except KeyError:
        await websocket.close(code=1008, reason="Unknown spacecraft")
        return
    try:
        while True:
            await current_stream_frame()
            await websocket.send_json({
                "type": "telemetry" if satellite.communication_state == "CONNECTED" else "communication",
                "timestamp": iso(),
                "spacecraft_id": satellite.satellite_id,
                "source": "SIMULATED MISSION DATA",
                "telemetry": satellite.generate_telemetry(),
                "last_confirmed": satellite.last_message,
                "communication": satellite.communication_state,
            })
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return
