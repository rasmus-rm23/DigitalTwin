"""Training of process models: one regression model per output.

Request (from the Rust core, see `domain/models.rs`):
    batches:      [{key, hours: [...], columns: {"<col>": [values or null]}}]
    inputs:       [col, ...]          outputs: [col, ...]
    names:        {"<col>": "column name"}
    dynamics:     [{input, output, delayMin, sigmaMin, enabled}]   (one per input/output pair;
                  enabled = false means the input has no effect on that output and is left out)
    algorithm:    {kind: "linear" | "neuralNetwork", hiddenLayers, activation, alpha, maxIter}
    testFraction: share of each batch's duration (at its end) held out for testing
"""

from __future__ import annotations

import base64
import io
import pickle
import warnings
from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.compose import TransformedTargetRegressor
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_squared_error, r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import delayed_smoothed

ARTIFACT_VERSION = 2
MAX_PLOT_POINTS = 2000


@dataclass
class BatchData:
    key: str
    minutes: np.ndarray
    columns: dict[int, np.ndarray]


def _batches(raw: list[dict[str, Any]]) -> list[BatchData]:
    out = []
    for b in raw:
        cols = {
            int(c): np.array([np.nan if v is None else v for v in vals], float)
            for c, vals in b["columns"].items()
        }
        out.append(BatchData(b["key"], np.asarray(b["hours"], float) * 60.0, cols))
    return out


def _estimator(algorithm: dict[str, Any]):
    kind = algorithm.get("kind")
    if kind == "linear":
        regressor = make_pipeline(StandardScaler(), LinearRegression())
    elif kind == "neuralNetwork":
        layers = tuple(int(n) for n in algorithm.get("hiddenLayers") or [16]) or (16,)
        regressor = make_pipeline(
            StandardScaler(),
            MLPRegressor(
                hidden_layer_sizes=layers,
                activation=algorithm.get("activation", "relu"),
                alpha=float(algorithm.get("alpha", 1e-4)),
                max_iter=int(algorithm.get("maxIter", 500)),
                random_state=0,
            ),
        )
    else:
        raise ValueError(f"unknown model type {kind!r}")
    # Scaling the target as well helps the neural network and is harmless for OLS.
    return TransformedTargetRegressor(regressor=regressor, transformer=StandardScaler())


def _features(batch: BatchData, inputs: list[int], output: int, dyn: dict) -> np.ndarray:
    """Feature matrix (rows = batch samples) for one output; NaN where undefined."""
    cols = []
    for i in inputs:
        d = dyn[(i, output)]
        cols.append(
            delayed_smoothed(
                batch.minutes, batch.columns[i], batch.minutes, d["delayMin"], d["sigmaMin"]
            )
        )
    return np.column_stack(cols) if cols else np.empty((batch.minutes.size, 0))


def _metrics(y: np.ndarray, p: np.ndarray) -> tuple[float | None, float | None]:
    if y.size < 2:
        return None, None
    return float(r2_score(y, p)), float(np.sqrt(mean_squared_error(y, p)))


def _thin(n: int) -> np.ndarray:
    """Indices of at most MAX_PLOT_POINTS evenly spaced rows."""
    return np.unique(np.linspace(0, n - 1, min(n, MAX_PLOT_POINTS)).round().astype(int))


def train(params: dict[str, Any]) -> dict[str, Any]:
    batches = _batches(params["batches"])
    inputs = [int(c) for c in params["inputs"]]
    outputs = [int(c) for c in params["outputs"]]
    names = {int(k): v for k, v in params.get("names", {}).items()}
    dyn = {(int(d["input"]), int(d["output"])): d for d in params["dynamics"]}
    test_fraction = float(params.get("testFraction", 0.2))
    if not batches or not inputs or not outputs:
        raise ValueError("select at least one batch, one input and one output")
    for i in inputs:
        for o in outputs:
            if (i, o) not in dyn:
                raise ValueError(
                    f"missing delay/smoothing for {names.get(i, i)} -> {names.get(o, o)}"
                )

    results, models, warns = [], {}, []
    feature_inputs: dict[int, list[int]] = {}
    for o in outputs:
        # Only inputs connected to this output (e.g. not downstream of it) become features.
        used = [i for i in inputs if dyn[(i, o)].get("enabled", True)]
        if not used:
            raise ValueError(f"{names.get(o, o)}: no input is connected to this output")
        feature_inputs[o] = used
        X_parts, y_parts, test_parts, rows_per_batch = [], [], [], []
        for b in batches:
            X = _features(b, used, o, dyn)
            y = b.columns[o]
            t = b.minutes
            split = t[0] + (1.0 - test_fraction) * (t[-1] - t[0]) if t.size else 0.0
            ok = np.isfinite(y) & np.all(np.isfinite(X), axis=1)
            X_parts.append(X[ok])
            y_parts.append(y[ok])
            test_parts.append(t[ok] >= split if test_fraction > 0 else np.zeros(ok.sum(), bool))
            rows_per_batch.append((b, ok, split))
        X_all, y_all, is_test = (
            np.vstack(X_parts),
            np.concatenate(y_parts),
            np.concatenate(test_parts),
        )
        name = names.get(o, str(o))
        n_train = int((~is_test).sum())
        if n_train < max(10, len(used) + 2):
            raise ValueError(
                f"{name}: only {n_train} usable training rows. Delays plus 3 sigma may exceed the "
                "batch length, or values are missing."
            )

        model = _estimator(params["algorithm"])
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", ConvergenceWarning)
            model.fit(X_all[~is_test], y_all[~is_test])
        if any(issubclass(w.category, ConvergenceWarning) for w in caught):
            warns.append(f"{name}: the neural network did not converge; increase max iterations.")
        models[o] = model

        pred = model.predict(X_all)
        r2_tr, rmse_tr = _metrics(y_all[~is_test], pred[~is_test])
        r2_te, rmse_te = _metrics(y_all[is_test], pred[is_test])

        coefficients = None
        if params["algorithm"].get("kind") == "linear":
            coefficients = _linear_coefficients(model, used, names)

        # Measured vs predicted per batch, for plotting (thinned).
        series, offset = [], 0
        for b, ok, split in rows_per_batch:
            n = int(ok.sum())
            hours = b.minutes[ok] / 60.0
            hours = hours - (b.minutes[0] / 60.0 if b.minutes.size else 0.0)
            idx = _thin(n) if n else np.array([], int)
            series.append(
                {
                    "batch": b.key,
                    "hours": hours[idx].tolist(),
                    "measured": y_all[offset : offset + n][idx].tolist(),
                    "predicted": pred[offset : offset + n][idx].tolist(),
                    "testStartHours": (split - b.minutes[0]) / 60.0
                    if test_fraction > 0 and b.minutes.size
                    else None,
                }
            )
            offset += n

        results.append(
            {
                "column": o,
                "name": name,
                "nTrain": n_train,
                "nTest": int(is_test.sum()),
                "r2Train": r2_tr,
                "r2Test": r2_te,
                "rmseTrain": rmse_tr,
                "rmseTest": rmse_te,
                "coefficients": coefficients,
                "series": series,
            }
        )

    artifact = {
        "version": ARTIFACT_VERSION,
        "inputs": inputs,
        "featureInputs": feature_inputs,
        "dynamics": {f"{i}->{o}": dyn[(i, o)] for i in inputs for o in outputs},
        "models": models,
    }
    buf = io.BytesIO()
    pickle.dump(artifact, buf)
    return {
        "outputs": results,
        "warnings": warns,
        "artifact": base64.b64encode(buf.getvalue()).decode("ascii"),
    }


def _linear_coefficients(model, inputs: list[int], names: dict[int, str]) -> dict[str, Any]:
    """Intercept and slopes in original units (undoing input and target scaling)."""
    pipe = model.regressor_
    x_scaler, ols = pipe[0], pipe[-1]
    y_scale = float(model.transformer_.scale_[0])
    y_mean = float(model.transformer_.mean_[0])
    slopes = ols.coef_.ravel() * y_scale / x_scaler.scale_
    intercept = y_mean + y_scale * float(ols.intercept_) - float(np.dot(slopes, x_scaler.mean_))
    return {
        "intercept": intercept,
        "slopes": [
            {"column": i, "name": names.get(i, str(i)), "value": float(s)}
            for i, s in zip(inputs, slopes, strict=True)
        ],
    }
