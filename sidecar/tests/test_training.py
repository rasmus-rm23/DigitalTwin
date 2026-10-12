import base64
import pickle

import numpy as np
import pytest

from digitaltwin_sidecar.features import delayed_smoothed
from digitaltwin_sidecar.training import train


def test_delay_only_is_a_shift():
    t = np.arange(0, 100.0)  # minutes
    x = t * 2.0
    f = delayed_smoothed(t, x, t, delay=10, sigma=0)
    assert np.all(np.isnan(f[:10])), "no input before the batch start"
    assert np.allclose(f[10:], (t[10:] - 10) * 2.0)


def test_gaussian_smoothing_preserves_linear_trend_and_smooths_noise():
    rng = np.random.default_rng(0)
    t = np.arange(0, 600.0)
    x = 0.5 * t + rng.normal(0, 5, t.size)
    f = delayed_smoothed(t, x, t, delay=0, sigma=10)
    ok = np.isfinite(f)
    assert not ok[:30].any() and not ok[-30:].any(), "window of +-3 sigma must fit in the batch"
    assert np.allclose(f[ok], 0.5 * t[ok], atol=3), "a linear trend passes through unchanged"
    assert np.std(f[ok] - 0.5 * t[ok]) < np.std(x[ok] - 0.5 * t[ok]) / 3


def test_step_is_spread_by_sigma():
    t = np.arange(0, 200.0)
    x = (t >= 100).astype(float)
    f = delayed_smoothed(t, x, t, delay=20, sigma=5)
    assert f[120] == pytest.approx(0.5, abs=0.06), "step appears half-way at the delay"
    assert f[110] < 0.05 and f[130] > 0.95


def test_duplicate_timestamps_are_averaged():
    t = np.array([0, 0, 1, 1, 2, 2], float)
    x = np.array([1, 3, 5, 7, 9, 11], float)
    f = delayed_smoothed(t, x, np.array([0.0, 1.0, 2.0]), delay=0, sigma=0)
    assert np.allclose(f, [2, 6, 10])


def make_request(algorithm, delay=10.0, sigma=0.0, test_fraction=0.2):
    rng = np.random.default_rng(1)
    batches = []
    for k in range(2):
        minutes = np.arange(0, 600.0)
        x = np.sin(minutes / 40 + k) * 5 + rng.normal(0, 0.05, minutes.size)
        y = np.full(minutes.size, np.nan)
        y[10:] = 3.0 * x[:-10] + 7.0  # true delay 10 min, gain 3, offset 7
        batches.append(
            {
                "key": f"B{k}",
                "hours": (minutes / 60).tolist(),
                "columns": {
                    "0": x.tolist(),
                    "1": [None if np.isnan(v) else float(v) for v in y],
                },
            }
        )
    return {
        "batches": batches,
        "inputs": [0],
        "outputs": [1],
        "names": {"0": "TI-1", "1": "AI-2"},
        "dynamics": [{"input": 0, "output": 1, "delayMin": delay, "sigmaMin": sigma}],
        "algorithm": algorithm,
        "testFraction": test_fraction,
    }


def test_linear_model_recovers_gain_and_offset_at_the_true_delay():
    res = train(make_request({"kind": "linear"}))
    out = res["outputs"][0]
    assert out["r2Train"] > 0.999 and out["r2Test"] > 0.999
    coef = out["coefficients"]
    assert coef["slopes"][0]["value"] == pytest.approx(3.0, abs=0.01)
    assert coef["intercept"] == pytest.approx(7.0, abs=0.05)
    assert out["nTest"] > 0 and out["nTrain"] > out["nTest"]
    s = out["series"][0]
    assert s["batch"] == "B0" and len(s["hours"]) == len(s["predicted"]) <= 2000
    assert s["testStartHours"] == pytest.approx(0.8 * 599 / 60)
    model = pickle.loads(base64.b64decode(res["artifact"]))
    assert model["inputs"] == [0] and 1 in model["models"]


def test_wrong_delay_fits_worse():
    good = train(make_request({"kind": "linear"}, delay=10))["outputs"][0]["r2Test"]
    bad = train(make_request({"kind": "linear"}, delay=40))["outputs"][0]["r2Test"]
    assert bad < good - 0.1


def test_neural_network_trains():
    algo = {"kind": "neuralNetwork", "hiddenLayers": [16], "activation": "tanh", "maxIter": 800}
    out = train(make_request(algo))["outputs"][0]
    assert out["r2Test"] > 0.95
    assert out["coefficients"] is None


def test_errors_are_explained():
    with pytest.raises(ValueError, match="usable training rows"):
        train(make_request({"kind": "linear"}, delay=700))
    req = make_request({"kind": "linear"})
    req["dynamics"] = []
    with pytest.raises(ValueError, match="missing delay"):
        train(req)


def test_unconnected_inputs_are_left_out_per_output():
    rng = np.random.default_rng(2)
    minutes = np.arange(0, 600.0)
    x = np.sin(minutes / 30) * 5
    z = rng.normal(0, 1, minutes.size)  # unrelated to y1
    y1 = 2.0 * x + 1.0
    y2 = -1.5 * z + 4.0
    req = {
        "batches": [
            {
                "key": "B",
                "hours": (minutes / 60).tolist(),
                "columns": {"0": x.tolist(), "1": z.tolist(), "2": y1.tolist(), "3": y2.tolist()},
            }
        ],
        "inputs": [0, 1],
        "outputs": [2, 3],
        "names": {"0": "x", "1": "z", "2": "y1", "3": "y2"},
        "dynamics": [
            {"input": 0, "output": 2, "delayMin": 0, "sigmaMin": 0, "enabled": True},
            {"input": 1, "output": 2, "delayMin": 0, "sigmaMin": 0, "enabled": False},
            {"input": 0, "output": 3, "delayMin": 0, "sigmaMin": 0, "enabled": False},
            {"input": 1, "output": 3, "delayMin": 0, "sigmaMin": 0},  # enabled by default
        ],
        "algorithm": {"kind": "linear"},
        "testFraction": 0.2,
    }
    res = train(req)
    y1_out, y2_out = res["outputs"]
    assert [s["name"] for s in y1_out["coefficients"]["slopes"]] == ["x"]
    assert [s["name"] for s in y2_out["coefficients"]["slopes"]] == ["z"]
    assert y1_out["coefficients"]["slopes"][0]["value"] == pytest.approx(2.0)
    assert y2_out["coefficients"]["slopes"][0]["value"] == pytest.approx(-1.5)
    artifact = pickle.loads(base64.b64decode(res["artifact"]))
    assert artifact["featureInputs"] == {2: [0], 3: [1]}

    req["dynamics"][3]["enabled"] = False
    with pytest.raises(ValueError, match="y2: no input is connected"):
        train(req)
