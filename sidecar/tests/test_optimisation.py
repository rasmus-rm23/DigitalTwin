import numpy as np
import pytest
from test_simulation import points, trained_artifact

from digitaltwin_sidecar.optimisation import optimise


def two_input_artifact():
    """y1 = 2 x0 - 3 x1 + 1 and y2 = x0 + x1 (no delays)."""
    from digitaltwin_sidecar.training import train

    rng = np.random.default_rng(3)
    minutes = np.arange(0, 600.0)
    x0 = rng.uniform(0, 10, minutes.size)
    x1 = rng.uniform(0, 10, minutes.size)
    req = {
        "batches": [
            {
                "key": "B",
                "hours": (minutes / 60).tolist(),
                "columns": {
                    "0": x0.tolist(),
                    "1": x1.tolist(),
                    "2": (2 * x0 - 3 * x1 + 1).tolist(),
                    "3": (x0 + x1).tolist(),
                },
            }
        ],
        "inputs": [0, 1],
        "outputs": [2, 3],
        "names": {"0": "x0", "1": "x1", "2": "y1", "3": "y2"},
        "dynamics": [
            {"input": i, "output": o, "delayMin": 0, "sigmaMin": 0} for i in (0, 1) for o in (2, 3)
        ],
        "algorithm": {"kind": "linear"},
        "testFraction": 0.2,
    }
    return train(req)["artifact"]


def request(artifact, profiles, manipulable, objectives, limits=(), duration_h=1.0):
    return {
        "artifact": artifact,
        "names": {"0": "x0", "1": "x1", "2": "y1", "3": "y2"},
        "durationH": duration_h,
        "stepMin": 2.0,
        "profiles": profiles,
        "ranges": {},
        "manipulable": manipulable,
        "objectives": objectives,
        "limits": list(limits),
        "scales": {"2": 30.0, "3": 20.0},
        "maxSeconds": 20,
    }


FIXED = {"mode": "fixed", "value": 5.0, "points": []}


@pytest.fixture(scope="module")
def artifact():
    return two_input_artifact()


def test_maximising_a_linear_output_goes_to_the_bounds(artifact):
    res = optimise(
        request(
            artifact,
            {"0": FIXED, "1": FIXED},
            [{"column": 0, "min": 0, "max": 10}, {"column": 1, "min": 2, "max": 8}],
            [{"column": 2, "goal": "maximise", "weight": 1, "measure": "mean"}],
        )
    )
    assert res["profiles"]["0"]["value"] == pytest.approx(10, abs=1e-3)
    assert res["profiles"]["1"]["value"] == pytest.approx(2, abs=1e-3)
    obj = res["objectives"][0]
    assert obj["baseline"] == pytest.approx(2 * 5 - 3 * 5 + 1, abs=0.01)
    assert obj["value"] == pytest.approx(2 * 10 - 3 * 2 + 1, abs=0.01)
    assert res["cost"] < res["baselineCost"]
    assert res["optimised"]["inputs"][0]["values"][0] == pytest.approx(10, abs=1e-3)


def test_non_manipulable_inputs_stay_put_and_targets_are_met(artifact):
    res = optimise(
        request(
            artifact,
            {"0": FIXED, "1": {"mode": "fixed", "value": 3.0, "points": []}},
            [{"column": 0, "min": 0, "max": 10}],
            [{"column": 3, "goal": "target", "target": 9.5, "weight": 1, "measure": "end"}],
        )
    )
    assert res["profiles"]["1"]["value"] == 3.0
    assert res["profiles"]["0"]["value"] == pytest.approx(6.5, abs=0.01)
    assert res["objectives"][0]["value"] == pytest.approx(9.5, abs=0.01)


def test_output_limits_constrain_the_optimum(artifact):
    # Maximise y1 = 2 x0 - 3 x1 + 1, but keep y2 = x0 + x1 <= 6.
    res = optimise(
        request(
            artifact,
            {"0": FIXED, "1": FIXED},
            [{"column": 0, "min": 0, "max": 10}, {"column": 1, "min": 0, "max": 10}],
            [{"column": 2, "goal": "maximise", "weight": 1, "measure": "mean"}],
            limits=[{"column": 3, "min": None, "max": 6}],
        )
    )
    assert res["limitsMet"]
    assert res["profiles"]["0"]["value"] == pytest.approx(6, abs=0.02)
    assert res["profiles"]["1"]["value"] == pytest.approx(0, abs=0.02)
    assert not res["baselineLimitsMet"], "baseline x0 + x1 = 10 > 6"


def test_setpoint_values_are_optimised_at_their_times():
    # y = 3 x(t - 10 min) + 7; target y = 13 needs x = 2 at every setpoint.
    res = optimise(
        {
            "artifact": trained_artifact(),
            "names": {"0": "TI-1", "1": "AI-2"},
            "durationH": 2.0,
            "stepMin": 1.0,
            "profiles": {"0": points((0, 0), (1, 0), (2, 0))},
            "ranges": {},
            "manipulable": [{"column": 0, "min": -5, "max": 5}],
            "objectives": [
                {"column": 1, "goal": "target", "target": 13, "weight": 1, "measure": "mean"}
            ],
            "limits": [],
            "scales": {"1": 30.0},
            "maxSeconds": 20,
        }
    )
    pts = res["profiles"]["0"]["points"]
    assert [p["hours"] for p in pts] == [0, 1, 2], "times are kept"
    assert all(-5 <= p["value"] <= 5 for p in pts)
    assert res["objectives"][0]["value"] == pytest.approx(13, abs=0.02)


def test_errors_are_explained(artifact):
    base = request(
        artifact,
        {"0": FIXED, "1": FIXED},
        [{"column": 0, "min": 0, "max": 10}],
        [{"column": 2, "goal": "minimise", "weight": 1, "measure": "mean"}],
    )
    with pytest.raises(ValueError, match="manipulable"):
        optimise({**base, "manipulable": []})
    with pytest.raises(ValueError, match="goal"):
        optimise({**base, "objectives": []})
    with pytest.raises(ValueError, match="lower bound"):
        optimise({**base, "manipulable": [{"column": 0, "min": 5, "max": 5}]})
    with pytest.raises(ValueError, match="not an output"):
        optimise({**base, "objectives": [{"column": 0, "goal": "minimise"}]})
