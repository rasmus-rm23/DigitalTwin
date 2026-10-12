"""Dynamic input features: time delay plus Gaussian smoothing.

For an output sampled at time t, the feature for an input with delay tau and spread sigma is
the Gaussian-weighted average of the input around t - tau:

    f(t) = sum_s w(s) x(s) / sum_s w(s),   w(s) = exp(-(s - (t - tau))^2 / (2 sigma^2))

truncated at +-3 sigma. With sigma = 0 it is the input interpolated at t - tau. A feature is
only defined when the whole window lies inside the batch, so the first tau + 3 sigma (and,
for large sigma, the last 3 sigma) of a batch yield no training rows.

Times are in minutes.
"""

from __future__ import annotations

import numpy as np

WINDOW_SIGMAS = 3.0


def _collapse_duplicates(t: np.ndarray, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Sorted unique times with the mean of finite values at each time (NaN if none)."""
    ok = np.isfinite(t) & np.isfinite(x)
    t, x = t[ok], x[ok]
    if t.size == 0:
        return t, x
    order = np.argsort(t, kind="stable")
    t, x = t[order], x[order]
    ut, inverse = np.unique(t, return_inverse=True)
    sums = np.bincount(inverse, weights=x, minlength=ut.size)
    counts = np.bincount(inverse, minlength=ut.size)
    return ut, sums / counts


def delayed_smoothed(
    t: np.ndarray, x: np.ndarray, targets: np.ndarray, delay: float, sigma: float
) -> np.ndarray:
    """Feature values at `targets` (minutes) for input samples (t, x). NaN where undefined."""
    ut, ux = _collapse_duplicates(np.asarray(t, float), np.asarray(x, float))
    out = np.full(np.shape(targets), np.nan)
    if ut.size == 0:
        return out
    centre = np.asarray(targets, float) - delay
    half = WINDOW_SIGMAS * sigma
    inside = (centre - half >= ut[0]) & (centre + half <= ut[-1])

    if sigma <= 0 or ut.size == 1:
        out[inside] = np.interp(centre[inside], ut, ux)
        return out

    # Resample on a uniform grid, convolve with a Gaussian kernel, then read off at the centres.
    diffs = np.diff(ut)
    step = float(np.median(diffs[diffs > 0])) if np.any(diffs > 0) else sigma / 10
    step = min(step, sigma / 4)  # at least 4 grid points per sigma
    grid = np.arange(ut[0], ut[-1] + step / 2, step)
    values = np.interp(grid, ut, ux)
    k = np.arange(-int(np.ceil(half / step)), int(np.ceil(half / step)) + 1) * step
    kernel = np.exp(-0.5 * (k / sigma) ** 2)
    kernel /= kernel.sum()
    smooth = np.convolve(values, kernel, mode="same")
    out[inside] = np.interp(centre[inside], grid, smooth)
    return out
