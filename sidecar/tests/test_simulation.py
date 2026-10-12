import numpy as np
import pytest
from test_training import make_request

from digitaltwin_sidecar.simulation import profile_values, simulate
from digitaltwin_sidecar.training import train


def points(*pv):
    return {"mode": "points", "points": [{"hours": h, "value": v} for h, v in pv]}


def test_fixed_profile_is_constant():
    assert np.allclose(profile_values({"mode": "fixed", "value": 4.5}, np.array([0, 1, 9.0])), 4.5)


def test_setpoints_are_interpolated_and_held_outside():
    p = points((1, 10), (3, 30))
    h = np.array([0, 1, 2, 3, 5.0])
    assert np.allclose(profile_values(p, h), [10, 10, 20, 30, 30])


def test_setpoint_order_does_not_matter_and_one_point_is_constant():
    assert np.allclose(profile_values(points((3, 30), (1, 10)), np.array([2.0])), [20])
    assert np.allclose(profile_values(points((2, 7)), np.array([0, 5.0])), [7, 7])


def test_equal_times_give_a_step():
    p = points((0, 1), (2, 1), (2, 5), (4, 5))
    assert np.allclose(profile_values(p, np.array([1.999, 2.0, 3.0])), [1, 5, 5])


def test_empty_setpoints_are_rejected():
    with pytest.raises(ValueError, match="at least one point"):
        profile_values({"mode": "points", "points": []}, np.array([0.0]))


def trained_artifact():
    # y(t) = 3 x(t - 10 min) + 7 (see make_request)
    return train(make_request({"kind": "linear"}))["artifact"]


def request(profile, duration_h=2.0, step=1.0, ranges=None):
    return {
        "artifact": trained_artifact(),
        "names": {"0": "TI-1", "1": "AI-2"},
        "durationH": duration_h,
        "stepMin": step,
        "profiles": {"0": profile},
        "ranges": ranges or {},
    }


def test_simulation_applies_the_trained_delay_and_gain():
    # Step from 1 to 2 at t = 1 h; the output follows 10 minutes later.
    res = simulate(request(points((0, 1), (1, 1), (1, 2), (2, 2)), ranges={"0": [-5, 5]}))
    hours = np.array(res["hours"])
    y = np.array(res["outputs"][0]["values"], float)
    assert hours[0] == 0 and hours[-1] == pytest.approx(2.0)
    assert np.all(np.isfinite(y)), "inputs are held before t = 0, so t = 0 is defined"
    at = lambda h: y[np.argmin(np.abs(hours - h))]
    assert at(0.0) == pytest.approx(3 * 1 + 7, abs=0.05)
    assert at(1.1) == pytest.approx(3 * 1 + 7, abs=0.05), "not yet: delay is 10 minutes"
    assert at(1.2) == pytest.approx(3 * 2 + 7, abs=0.05)
    assert res["inputs"][0]["name"] == "TI-1" and res["inputs"][0]["values"][-1] == 2
    assert res["warnings"] == []


def test_extrapolation_is_warned():
    res = simulate(request({"mode": "fixed", "value": 9.0}, ranges={"0": [-5, 5]}))
    assert "outside the measured range" in res["warnings"][0]


def test_missing_profiles_and_bad_grids_are_rejected():
    req = request({"mode": "fixed", "value": 1.0})
    req["profiles"] = {}
    with pytest.raises(ValueError, match="TI-1"):
        simulate(req)
    with pytest.raises(ValueError, match="too many"):
        simulate(request({"mode": "fixed", "value": 1.0}, duration_h=10_000, step=0.01))
