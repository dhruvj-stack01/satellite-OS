from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SatelliteSimulator:
    def __init__(self, satellite_id: str, phase_offset: float, altitude: float) -> None:
        self.satellite_id = satellite_id
        self.altitude = altitude
        self.inclination = 51.6
        self.orbital_period = 5400.0
        self.orbital_phase = phase_offset
        self.latitude = 0.0
        self.longitude = 0.0
        self.velocity = 7.66
        self.communication_state = "CONNECTED"
        self.security_state = "SIMULATED CHECKS ONLY"
        self.battery = 28.5
        self.temperature = 22.0
        self.solar_power = 520.0
        self.attitude_error = 0.18
        self._elapsed = 0.0
        self._sequence = 0
        self._power_anomaly = False
        self._security_event = False
        self._lost_at: str | None = None
        self._reconnection: dict[str, Any] | None = None
        self.security_checks: list[dict[str, str]] = []
        self.last_message: dict[str, Any] = {}
        self._set_security_checks()
        self.update(0)
        self._record_message()

    @property
    def power_anomaly(self) -> bool:
        return self._power_anomaly

    def _set_security_checks(self) -> None:
        states = {
            "Authentication": "VERIFIED",
            "Signature verification": "VERIFIED",
            "Sequence integrity": "VERIFIED",
            "Source validation": "VERIFIED",
            "Checksum": "VERIFIED",
            "Replay detection": "VERIFIED",
            "Encryption": "VERIFIED",
        }
        if self._security_event:
            states["Signature verification"] = "FAILED"
            states["Sequence integrity"] = "WARNING"
        self.security_checks = [
            {
                "evidence_id": f"SEC-{self.satellite_id[-2:]}-{index:03d}",
                "check": name,
                "status": status,
                "timestamp": utc_now(),
                "reason": (
                    "Simulated signature mismatch; compromise is not established."
                    if name == "Signature verification" and status == "FAILED"
                    else "Simulated sequence discontinuity; requires operator review."
                    if name == "Sequence integrity" and status == "WARNING"
                    else "Simulated check only; not verified against a real spacecraft."
                ),
                "source": "SIMULATED SECURITY CHECK",
            }
            for index, (name, status) in enumerate(states.items(), start=1)
        ]

    def update(self, delta_time: float) -> None:
        delta_time = max(0.0, delta_time)
        self._elapsed += delta_time
        self.orbital_phase = (self.orbital_phase + 2 * math.pi * delta_time / self.orbital_period) % (2 * math.pi)
        self.latitude = self.inclination * math.sin(self.orbital_phase)
        self.longitude = ((self.orbital_phase * 180 / math.pi + 180) % 360) - 180
        self.solar_power = 520 + 70 * math.sin(self.orbital_phase)
        if self._power_anomaly:
            self.solar_power *= 0.69
        self.battery += ((self.solar_power - 520) / 520) * 0.0008 * delta_time
        if self._power_anomaly:
            self.battery -= 0.0015 * delta_time
        self.battery = min(29.0, max(23.0, self.battery))
        self.temperature = 22 + 2.5 * math.sin(self.orbital_phase / 2) + (3 if self._power_anomaly else 0)
        self.attitude_error = 0.18 + abs(math.sin(self.orbital_phase * 1.7)) * 0.08
        self.communication_state = "NO SIGNAL" if self._lost_at else "CONNECTED"
        self.security_state = "POTENTIAL SECURITY EVENT" if self._security_event else "SIMULATED CHECKS ONLY"
        if not self._lost_at:
            self._record_message()

    def _record_message(self) -> None:
        self._sequence += 1
        self.last_message = {
            "message_id": f"TEL-{self.satellite_id[-2:]}-{self._sequence:05d}",
            "timestamp": utc_now(),
            "spacecraft_id": self.satellite_id,
            "latitude": round(self.latitude, 3),
            "longitude": round(self.longitude, 3),
            "altitude_km": round(self.altitude, 1),
            "velocity_km_s": round(self.velocity, 3),
            "telemetry": {
                "battery_voltage": round(self.battery, 3),
                "battery_temperature": round(self.temperature, 2),
                "solar_power": round(self.solar_power, 2),
                "communication_signal": round(-51 + 2.5 * math.sin(self.orbital_phase * 2), 2),
                "attitude_error": round(self.attitude_error, 3),
                "cpu_usage": round(38 + 8 * math.sin(self.orbital_phase * 1.2), 2),
                "memory_usage": round(51 + 6 * math.sin(self.orbital_phase * 0.8), 2),
                "altitude": round(self.altitude, 1),
                "velocity": round(self.velocity, 3),
                "anomaly_score": min(100, max(0, round((max(0, 28.5 - self.battery) * 18) + (max(0, 520 - self.solar_power) / 520 * 45) + (18 if self._security_event else 0)))),
            },
            "safety_assessment": self.health()["state"],
            "security_state": self.security_state,
            "source": "SIMULATED MISSION DATA",
        }

    def generate_telemetry(self) -> dict[str, Any] | None:
        if self._lost_at:
            return None
        return {**self.last_message, "communication_state": self.communication_state}

    def simulate_anomaly(self) -> None:
        self._power_anomaly = True
        self.update(0)

    def simulate_communication_loss(self) -> bool:
        if self._lost_at:
            return False
        self._record_message()
        self._lost_at = utc_now()
        self.communication_state = "NO SIGNAL"
        self._reconnection = None
        return True

    def restore_communication(self) -> dict[str, Any] | None:
        if not self._lost_at:
            return None
        before = self.last_message
        downtime_started = datetime.fromisoformat(self._lost_at.replace("Z", "+00:00"))
        downtime_seconds = max(0, int((datetime.now(timezone.utc) - downtime_started).total_seconds()))
        self._lost_at = None
        self.communication_state = "CONNECTED"
        self.update(0)
        self._record_message()
        self._reconnection = {
            "restored_at": utc_now(),
            "downtime_seconds": downtime_seconds,
            "before": before,
            "after": self.last_message,
            "gap_state_verifiable": False,
            "assessment": "Telemetry resumed; spacecraft state during the communication gap cannot be directly verified.",
        }
        return self._reconnection

    def simulate_security_event(self) -> None:
        self._security_event = True
        self._set_security_checks()
        self.update(0)

    def reset(self) -> None:
        satellite_id = self.satellite_id
        phase_offset = self.orbital_phase
        altitude = self.altitude
        self.__init__(satellite_id, phase_offset, altitude)

    def health(self) -> dict[str, Any]:
        factors = {
            "power": max(0, min(100, (self.battery - 23) / 5 * 100)),
            "thermal": max(0, min(100, (60 - self.temperature) / 40 * 100)),
            "communication": 100 if not self._lost_at else 0,
            "attitude": max(0, min(100, (0.8 - self.attitude_error) / 0.8 * 100)),
            "compute": 92.0,
            "security": 50.0 if self._security_event else 100.0,
        }
        score = round(
            factors["power"] * 0.25
            + factors["thermal"] * 0.20
            + factors["communication"] * 0.20
            + factors["attitude"] * 0.15
            + factors["compute"] * 0.10
            + factors["security"] * 0.10
        )
        state = "CRITICAL" if score < 40 else "DEGRADED" if score < 60 else "CONDITIONAL" if score < 80 else "NOMINAL"
        return {"score": score, "state": state, "weights": {"power": 25, "thermal": 20, "communication": 20, "attitude": 15, "compute": 10, "security": 10}, "factors": {key: round(value) for key, value in factors.items()}}

    def snapshot(self) -> dict[str, Any]:
        health = self.health()
        anomaly_score = min(
            100,
            round(
                (max(0, 28.5 - self.battery) * 18)
                + (max(0, 520 - self.solar_power) / 520 * 45)
                + (18 if self._security_event else 0)
                + (25 if self._lost_at else 0)
            ),
        )
        return {
            "id": self.satellite_id,
            "name": self.satellite_id,
            "mission": "SIMULATED ORBIT MODEL",
            "source": "SIMULATED MISSION DATA",
            "latitude": round(self.latitude, 3),
            "longitude": round(self.longitude, 3),
            "estimated_latitude": round(self.latitude, 3),
            "estimated_longitude": round(self.longitude, 3),
            "altitude_km": round(self.altitude, 1),
            "speed_km_s": round(self.velocity, 3),
            "communication": self.communication_state,
            "position_status": "TELEMETRY CONFIRMED" if not self._lost_at else "ESTIMATED — NOT TELEMETRY CONFIRMED",
            "safety": "UNKNOWN — LINK LOST" if self._lost_at else health["state"],
            "security": self.security_state,
            "health_score": health["score"],
            "health_state": health["state"],
            "health_factors": health["factors"],
            "anomaly_score": anomaly_score,
            "last_known_message": self.last_message,
            "security_checks": self.security_checks,
            "reconnection": self._reconnection,
            "communication_lost_at": self._lost_at,
        }


class MissionSimulator:
    def __init__(self) -> None:
        self.satellites = {
            "ORBIT-X1": SatelliteSimulator("ORBIT-X1", 0.2, 542.0),
            "ORBIT-X2": SatelliteSimulator("ORBIT-X2", 2.4, 560.0),
        }
        self.ground_stations = [
            {"id": "GS-01", "location": "India", "latitude": 19.1, "longitude": 72.9, "state": "ONLINE"},
            {"id": "GS-02", "location": "Europe", "latitude": 48.9, "longitude": 2.4, "state": "ONLINE"},
            {"id": "GS-03", "location": "Australia", "latitude": -33.9, "longitude": 151.2, "state": "STANDBY"},
        ]

    def get(self, satellite_id: str) -> SatelliteSimulator:
        satellite = self.satellites.get(satellite_id.upper())
        if satellite is None:
            raise KeyError(satellite_id)
        return satellite

    def update(self, delta_time: float) -> None:
        for satellite in self.satellites.values():
            satellite.update(delta_time)

    def fleet(self) -> list[dict[str, Any]]:
        fleet = []
        for satellite in self.satellites.values():
            item = satellite.snapshot()
            station = self.nearest_station(satellite)
            item["ground_station"] = station
            item["last_known_message"] = {
                **item["last_known_message"],
                "ground_station": station["id"] if station["visible"] else None,
            }
            fleet.append(item)
        return fleet

    def nearest_station(self, satellite: SatelliteSimulator) -> dict[str, Any]:
        candidates = []
        for station in self.ground_stations:
            lat_delta = satellite.latitude - station["latitude"]
            lon_delta = abs((satellite.longitude - station["longitude"] + 180) % 360 - 180)
            distance = math.hypot(lat_delta, lon_delta)
            candidates.append((distance, station))
        distance, station = min(candidates, key=lambda candidate: candidate[0])
        visible = distance < 42 and satellite.communication_state != "NO SIGNAL"
        return {
            **station,
            "visible": visible,
            "active": visible and satellite.communication_state == "CONNECTED",
            "signal_strength": round(max(-95, -35 - distance * 0.8), 1) if visible else None,
            "last_contact": satellite.last_message["timestamp"],
        }

    def reset(self) -> None:
        self.__init__()
