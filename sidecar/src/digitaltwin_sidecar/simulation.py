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


def simulate(params: dict[str, Any]) -> dict[str, Any]:
    artifact = pickle.loads(base64.b64decode(params["artifact"]))
    if artifact.get("version") != 2:
        raise ValueError("the model was trained with an older version; retrain it")
    names = {int(k): v for k, v in params.get("names", {}).items()}
    duration_min = float(params["durationH"]) * 60.0
    step = float(params["stepMin"])
    if not (duration_min > 0 and step > 0):
        raise ValueError("simulation time and step must be positive")
    if duration_min / step > MAX_STEPS:
        raise ValueError(f"too many time steps (max {MAX_STEPS}); increase the step")

    inputs = [int(i) for i in artifact["inputs"]]
    profiles = {int(k): v for k, v in params["profiles"].items()}
    missing = [names.get(i, str(i)) for i in inputs if i not in profiles]
    if missing:
        raise ValueError(f"set a value or setpoints for {', '.join(missing)}")
    dyn = artifact["dynamics"]
    feature_inputs = {
        int(o): [int(i) for i in used] for o, used in artifact["featureInputs"].items()
    }

    # Inputs are sampled from before t = 0 (held) to after the end, so that every window fits.
    pairs = [dyn[f"{i}->{o}"] for o, used in feature_inputs.items() for i in used]
    before = max((d["delayMin"] + WINDOW_SIGMAS * d["sigmaMin"] for d in pairs), default=0.0)
    after = max((WINDOW_SIGMAS * d["sigmaMin"] for d in pairs), default=0.0)
    out_minutes = np.arange(0.0, duration_min + step / 2, step)
    in_minutes = np.arange(
        -np.ceil(before / step) * step - step, duration_min + after + 2 * step, step
    )
    in_hours = np.maximum(in_minutes, 0.0) / 60.0  # held at the t = 0 value before the start
    trajectories = {i: profile_values(profiles[i], in_hours) for i in inputs}

    warnings = []
    for i in inputs:
        rng = params.get("ranges", {}).get(str(i))
        if rng and rng[0] is not None and rng[1] is not None:
            lo, hi = float(rng[0]), float(rng[1])
            x = trajectories[i]
            if x.min() < lo or x.max() > hi:
                warnings.append(
                    f"{names.get(i, i)} goes outside the measured range {lo:.4g} to {hi:.4g}; "
                    "the model extrapolates there."
                )

    outputs = []
    for o, model in artifact["models"].items():
        o = int(o)
        cols = [
            delayed_smoothed(
                in_minutes,
                trajectories[i],
                out_minutes,
                dyn[f"{i}->{o}"]["delayMin"],
                dyn[f"{i}->{o}"]["sigmaMin"],
            )
            for i in feature_inputs[o]
        ]
        X = np.column_stack(cols)
        values = np.full(out_minutes.size, np.nan)
        ok = np.all(np.isfinite(X), axis=1)
        if ok.any():
            values[ok] = model.predict(X[ok])
        outputs.append(
            {
                "column": o,
                "name": names.get(o, str(o)),
                "values": [None if not np.isfinite(v) else float(v) for v in values],
            }
        )

    out_hours = out_minutes / 60.0
    return {
        "hours": out_hours.tolist(),
        "inputs": [
            {
                "column": i,
                "name": names.get(i, str(i)),
                "values": profile_values(profiles[i], out_hours).tolist(),
            }
            for i in inputs
        ],
        "outputs": outputs,
        "warnings": warnings,
    }
