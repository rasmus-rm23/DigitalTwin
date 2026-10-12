"""What-if simulation: feed user-defined input setpoint trajectories through a trained model.

Request (from the Rust core, see `domain/simulations.rs`):
    artifact:  base64 pickled training artifact (see `training.py`)
    names:     {"<col>": "column name"}
    durationH: simulation time in hours (t = 0 .. durationH)
    stepMin:   output resolution in minutes
    profiles:  {"<col>": {mode: "fixed", value} | {mode: "points", points: [{hours, value}]}}
               one per model input
    ranges:    {"<col>": [min, max]} measured range of each input (for extrapolation warnings)

A "points" profile is linear between setpoints and held constant before the first and after
the last one. Two setpoints at the same time give a step change. Before t = 0 every input is
held at its t = 0 value, so delay and smoothing windows are defined from the start.
"""

from __future__ import annotations

import base64
import pickle
from typing import Any

import numpy as np

from .features import WINDOW_SIGMAS, delayed_smoothed

MAX_STEPS = 200_000


def profile_values(profile: dict[str, Any], hours: np.ndarray) -> np.ndarray:
    """Input values at `hours` for a fixed or setpoint profile."""
    if profile.get("mode") == "fixed":
        return np.full(np.shape(hours), float(profile["value"]))
    points = sorted(profile.get("points") or [], key=lambda p: float(p["hours"]))  # stable
    if not points:
        raise ValueError("a setpoint profile needs at least one point")
    ph = np.array([float(p["hours"]) for p in points])
    pv = np.array([float(p["value"]) for p in points])
    h = np.asarray(hours, float)
    # Last setpoint at or before h; for a step (equal times) that is the later value.
    idx = np.searchsorted(ph, h, side="right") - 1
    out = np.empty(h.shape)
    before, after = idx < 0, idx >= ph.size - 1
    out[before] = pv[0]
    out[after] = pv[-1]
    mid = ~(before | after)
    i = idx[mid]
    frac = (h[mid] - ph[i]) / (ph[i + 1] - ph[i])  # ph[i + 1] > h >= ph[i], so no zero width
    out[mid] = pv[i] + frac * (pv[i + 1] - pv[i])
    return out


class Simulator:
    """A trained model on a fixed time grid; `outputs` evaluates input profiles cheaply."""

    def __init__(self, params: dict[str, Any]):
        artifact = pickle.loads(base64.b64decode(params["artifact"]))
        if artifact.get("version") != 2:
            raise ValueError("the model was trained with an older version; retrain it")
        self.names = {int(k): v for k, v in params.get("names", {}).items()}
        duration_min = float(params["durationH"]) * 60.0
        step = float(params["stepMin"])
        if not (duration_min > 0 and step > 0):
            raise ValueError("simulation time and step must be positive")
        if duration_min / step > MAX_STEPS:
            raise ValueError(f"too many time steps (max {MAX_STEPS}); increase the step")

        self.inputs = [int(i) for i in artifact["inputs"]]
        self.models = {int(o): m for o, m in artifact["models"].items()}
        self.dyn = artifact["dynamics"]
        self.feature_inputs = {
            int(o): [int(i) for i in used] for o, used in artifact["featureInputs"].items()
        }
        self.ranges = {
            int(k): (float(v[0]), float(v[1]))
            for k, v in params.get("ranges", {}).items()
            if v and v[0] is not None and v[1] is not None
        }

        # Inputs are sampled from before t = 0 (held) to after the end, so every window fits.
        pairs = [self.dyn[f"{i}->{o}"] for o, used in self.feature_inputs.items() for i in used]
        before = max((d["delayMin"] + WINDOW_SIGMAS * d["sigmaMin"] for d in pairs), default=0.0)
        after = max((WINDOW_SIGMAS * d["sigmaMin"] for d in pairs), default=0.0)
        self.out_minutes = np.arange(0.0, duration_min + step / 2, step)
        self.in_minutes = np.arange(
            -np.ceil(before / step) * step - step, duration_min + after + 2 * step, step
        )
        self.in_hours = np.maximum(self.in_minutes, 0.0) / 60.0  # held at t = 0 before the start
        self.out_hours = self.out_minutes / 60.0

    def name(self, col: int) -> str:
        return self.names.get(col, str(col))

    def check_profiles(self, profiles: dict[int, dict[str, Any]]) -> None:
        missing = [self.name(i) for i in self.inputs if i not in profiles]
        if missing:
            raise ValueError(f"set a value or setpoints for {', '.join(missing)}")

    def outputs(self, profiles: dict[int, dict[str, Any]]) -> dict[int, np.ndarray]:
        """Predicted output values on the output grid (NaN where undefined)."""
        traj = {i: profile_values(profiles[i], self.in_hours) for i in self.inputs}
        out = {}
        for o, model in self.models.items():
            cols = []
            for i in self.feature_inputs[o]:
                d = self.dyn[f"{i}->{o}"]
                cols.append(
                    delayed_smoothed(
                        self.in_minutes, traj[i], self.out_minutes, d["delayMin"], d["sigmaMin"]
                    )
                )
            X = np.column_stack(cols)
            values = np.full(self.out_minutes.size, np.nan)
            ok = np.all(np.isfinite(X), axis=1)
            if ok.any():
                values[ok] = model.predict(X[ok])
            out[o] = values
        return out

    def range_warnings(self, profiles: dict[int, dict[str, Any]]) -> list[str]:
        warnings = []
        for i in self.inputs:
            if i not in self.ranges:
                continue
            lo, hi = self.ranges[i]
            x = profile_values(profiles[i], self.in_hours)
            if x.min() < lo or x.max() > hi:
                warnings.append(
                    f"{self.name(i)} goes outside the measured range {lo:.4g} to {hi:.4g}; "
                    "the model extrapolates there."
                )
        return warnings

    def result(self, profiles: dict[int, dict[str, Any]]) -> dict[str, Any]:
        """The JSON result of one run: time axis, input trajectories, predicted outputs."""
        outputs = self.outputs(profiles)
        return {
            "hours": self.out_hours.tolist(),
            "inputs": [
                {
                    "column": i,
                    "name": self.name(i),
                    "values": profile_values(profiles[i], self.out_hours).tolist(),
                }
                for i in self.inputs
            ],
            "outputs": [
                {"column": o, "name": self.name(o), "values": _json_values(v)}
                for o, v in outputs.items()
            ],
            "warnings": self.range_warnings(profiles),
        }


def _json_values(values: np.ndarray) -> list[float | None]:
    return [None if not np.isfinite(v) else float(v) for v in values]


def parse_profiles(raw: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {int(k): v for k, v in raw.items()}


def simulate(params: dict[str, Any]) -> dict[str, Any]:
    sim = Simulator(params)
    profiles = parse_profiles(params["profiles"])
    sim.check_profiles(profiles)
    return sim.result(profiles)
