"""Optimisation of manipulable inputs within bounds against a cost function.

Request (from the Rust core, see `domain/simulations.rs`): the `simulate` request (artifact,
names, durationH, stepMin, profiles, ranges) plus
    manipulable: [{column, min, max}]   inputs the optimiser may change, with bounds
    objectives:  [{column, goal: "minimise" | "maximise" | "target", target, weight,
                   measure: "mean" | "end"}]
    limits:      [{column, min, max}]   output limits (min/max may be null)
    scales:      {"<col>": s}           typical size of each output (its measured range)
    maxSeconds:  time budget

Decision variables: a fixed input has one value; a setpoint input has one value per setpoint
(the times stay as they are). The cost is the weighted sum of the objective terms, each scaled
by the output's typical size (target: squared distance to the target). Output limits are
penalised by the worst violation over time (scaled, linear: an exact penalty, so the optimum
lies on the limit rather than slightly past it, as a squared penalty would give).
The optimiser is differential evolution (global, within the bounds) followed by a local polish.
"""

from __future__ import annotations

import copy
import time
from typing import Any

import numpy as np
from scipy.optimize import differential_evolution

from .simulation import Simulator, parse_profiles

LIMIT_PENALTY = 1000.0
# Violations up to this share of the output's scale count as meeting the limit.
LIMIT_TOLERANCE = 1e-4
MAX_VARIABLES = 60


def _measure(values: np.ndarray, measure: str) -> float:
    ok = values[np.isfinite(values)]
    if ok.size == 0:
        return float("nan")
    return float(ok[-1] if measure == "end" else ok.mean())


class Problem:
    def __init__(self, sim: Simulator, params: dict[str, Any]):
        self.sim = sim
        self.base = parse_profiles(params["profiles"])
        sim.check_profiles(self.base)
        self.objectives = [o for o in params.get("objectives", []) if o.get("goal")]
        self.limits = [
            lim
            for lim in params.get("limits", [])
            if lim.get("min") is not None or lim.get("max") is not None
        ]
        self.scales = {int(k): float(v) for k, v in params.get("scales", {}).items()}
        known = set(sim.models)
        for o in [*self.objectives, *self.limits]:
            if int(o["column"]) not in known:
                raise ValueError(f"{sim.name(int(o['column']))} is not an output of the model")
        if not self.objectives:
            raise ValueError("give at least one output a goal (minimise, maximise or target)")

        # Decision variables: (input, setpoint index or None for a fixed value) with bounds.
        self.slots: list[tuple[int, int | None]] = []
        self.bounds: list[tuple[float, float]] = []
        for m in params.get("manipulable", []):
            col, lo, hi = int(m["column"]), float(m["min"]), float(m["max"])
            if col not in self.base:
                raise ValueError(f"{sim.name(col)} is not an input of the model")
            if not lo < hi:
                raise ValueError(f"{sim.name(col)}: the lower bound must be below the upper bound")
            p = self.base[col]
            if p.get("mode") == "fixed":
                self.slots.append((col, None))
                self.bounds.append((lo, hi))
            else:
                for k in range(len(p.get("points") or [])):
                    self.slots.append((col, k))
                    self.bounds.append((lo, hi))
        if not self.slots:
            raise ValueError("mark at least one input as manipulable")
        if len(self.slots) > MAX_VARIABLES:
            raise ValueError(
                f"too many values to optimise ({len(self.slots)}, max {MAX_VARIABLES}); "
                "use fewer setpoints"
            )

    def profiles(self, x: np.ndarray) -> dict[int, dict[str, Any]]:
        # Copy each profile on its own, so profiles that share one object stay independent.
        profiles = {col: copy.deepcopy(p) for col, p in self.base.items()}
        for (col, k), v in zip(self.slots, x, strict=True):
            if k is None:
                profiles[col]["value"] = float(v)
            else:
                profiles[col]["points"][k]["value"] = float(v)
        return profiles

    def x0(self) -> np.ndarray:
        """The current setpoints, clipped into the bounds."""
        vals = []
        for col, k in self.slots:
            p = self.base[col]
            vals.append(float(p["value"]) if k is None else float(p["points"][k]["value"]))
        return np.clip(vals, [b[0] for b in self.bounds], [b[1] for b in self.bounds])

    def scale(self, col: int) -> float:
        s = self.scales.get(col, 1.0)
        return s if s > 0 and np.isfinite(s) else 1.0

    def evaluate(self, outputs: dict[int, np.ndarray]) -> tuple[float, float]:
        """(objective, limit violation penalty)."""
        cost = 0.0
        for o in self.objectives:
            col = int(o["column"])
            v = _measure(outputs[col], o.get("measure", "mean"))
            if not np.isfinite(v):
                return float("inf"), 0.0
            s, w = self.scale(col), float(o.get("weight", 1.0))
            goal = o["goal"]
            if goal == "minimise":
                cost += w * v / s
            elif goal == "maximise":
                cost -= w * v / s
            elif goal == "target":
                cost += w * ((v - float(o["target"])) / s) ** 2
            else:
                raise ValueError(f"unknown goal {goal!r}")
        penalty = 0.0
        for lim in self.limits:
            col = int(lim["column"])
            y = outputs[col][np.isfinite(outputs[col])]
            if y.size == 0:
                continue
            worst = 0.0
            if lim.get("max") is not None:
                worst = max(worst, float(y.max()) - float(lim["max"]))
            if lim.get("min") is not None:
                worst = max(worst, float(lim["min"]) - float(y.min()))
            penalty += max(worst, 0.0) / self.scale(col)
        return cost, penalty

    def cost(self, x: np.ndarray) -> float:
        c, p = self.evaluate(self.sim.outputs(self.profiles(x)))
        return c + LIMIT_PENALTY * p

    def summary(self, outputs: dict[int, np.ndarray]) -> list[dict[str, Any]]:
        rows = []
        for o in self.objectives:
            col = int(o["column"])
            rows.append(
                {
                    "column": col,
                    "name": self.sim.name(col),
                    "measure": o.get("measure", "mean"),
                    "value": _measure(outputs[col], o.get("measure", "mean")),
                }
            )
        return rows


def optimise(params: dict[str, Any]) -> dict[str, Any]:
    sim = Simulator(params)
    problem = Problem(sim, params)
    budget = float(params.get("maxSeconds", 30.0))
    start = time.monotonic()
    timed_out = False

    def stop(*_args) -> bool:
        nonlocal timed_out
        timed_out = time.monotonic() - start > budget
        return timed_out

    baseline_out = sim.outputs(problem.base)
    res = differential_evolution(
        problem.cost,
        problem.bounds,
        x0=problem.x0(),
        seed=0,
        tol=1e-7,
        maxiter=300,
        popsize=12,
        polish=True,
        callback=stop,
    )
    best = problem.profiles(res.x)
    best_out = sim.outputs(best)
    base_cost, base_pen = problem.evaluate(baseline_out)
    best_cost, best_pen = problem.evaluate(best_out)

    warnings = []
    if timed_out:
        warnings.append(
            f"Stopped after the time limit of {budget:.0f} s; the result may not be optimal."
        )
    if best_pen > LIMIT_TOLERANCE:
        warnings.append("The output limits could not all be met within the input bounds.")

    return {
        "profiles": {str(k): v for k, v in best.items()},
        "baselineCost": base_cost + LIMIT_PENALTY * base_pen,
        "cost": best_cost + LIMIT_PENALTY * best_pen,
        "limitsMet": best_pen <= LIMIT_TOLERANCE,
        "baselineLimitsMet": base_pen <= LIMIT_TOLERANCE,
        "objectives": [
            {**b, "baseline": b["value"], "value": a["value"]}
            for b, a in zip(problem.summary(baseline_out), problem.summary(best_out), strict=True)
        ],
        "evaluations": int(res.nfev),
        "seconds": round(time.monotonic() - start, 2),
        "baseline": sim.result(problem.base),
        "optimised": sim.result(best),
        "warnings": warnings,
    }
