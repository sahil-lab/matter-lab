#!/usr/bin/env python3
"""Generates high-precision reference values of the Boys function for the @matterlab/quantum tests.

    F_m(T) = integral_0^1 t^(2m) exp(-T t^2) dt = gamma(m + 1/2, T) / (2 T^(m + 1/2))

Run inside a throw-away container from the repository root (PowerShell):

    docker run --rm -v "${PWD}\\packages\\quantum:/work" python:3.12-slim `
        bash -c "pip install -q mpmath && python /work/tools/gen_boys_reference.py"

Output: packages/quantum/test/fixtures/boys_reference.json

Values are computed with mpmath at 50 significant digits from the lower incomplete gamma function
and, as an independent check inside this script, by direct numerical quadrature of the defining
integral. Arguments T are stored as JSON numbers (exact doubles); values as 25-digit strings.
"""

import datetime
import json
import os
import platform
import random

import mpmath as mp

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(os.path.dirname(HERE), "test", "fixtures", "boys_reference.json")

MAX_ORDER = 8
mp.mp.dps = 50


def boys(m, t):
    """t is a Python float; mp.mpf(float) is exact, so the reference belongs to that exact double."""
    if t == 0.0:
        return mp.mpf(1) / (2 * m + 1)
    x = mp.mpf(t)
    a = m + mp.mpf(1) / 2
    return mp.gammainc(a, 0, x) / (2 * x**a)


def boys_quadrature(m, t):
    x = mp.mpf(t)
    # The integrand is concentrated in t < a few / sqrt(T); split the interval there.
    edge = min(mp.mpf(1), 8 / mp.sqrt(x)) if t > 0 else mp.mpf(1)
    breaks = [mp.mpf(0), edge / 4, edge / 2, edge]
    if edge < 1:
        breaks.append(mp.mpf(1))
    return mp.quad(lambda u: u ** (2 * m) * mp.exp(-x * u * u), breaks)


def arguments():
    special = [
        0.0, 1e-300, 1e-16, 1e-12, 1e-8, 1e-5, 1e-3, 0.01, 0.024999, 0.025, 0.025001, 0.05, 0.074999, 0.075, 0.1, 0.3, 0.5,
        1.0, 2.0, 3.141592653589793, 5.0, 7.5, 10.0, 12.3456, 15.0, 17.775, 20.0, 25.0, 29.99, 30.0, 33.3, 35.9, 35.974999,
        35.975, 35.999999, 36.0, 36.000001, 36.5, 38.0, 40.0, 45.0, 50.0, 60.0, 79.9, 80.0, 80.1, 100.0, 150.0, 500.0, 1e3, 1e4, 1e5, 1e6, 1e8,
    ]
    rng = random.Random(20261113)
    uniform = [rng.uniform(0.0, 40.0) for _ in range(250)]
    log_uniform = [10 ** rng.uniform(-6.0, 4.0) for _ in range(150)]
    return sorted(set(special + uniform + log_uniform))


def main():
    ts = arguments()
    values = []
    worst_check = mp.mpf(0)
    for index, t in enumerate(ts):
        row = [boys(m, t) for m in range(MAX_ORDER + 1)]
        if index % 9 == 0 and t <= 1e4:
            for m in (0, 3, MAX_ORDER):
                quadrature = boys_quadrature(m, t)
                worst_check = max(worst_check, abs(quadrature - row[m]) / row[m])
        values.append([mp.nstr(v, 25) for v in row])
    if worst_check > mp.mpf(10) ** -25:
        raise RuntimeError(f"gamma-function and quadrature values disagree (relative {mp.nstr(worst_check, 5)})")

    fixture = {
        "description": "Boys function F_m(T) for m = 0..maxOrder; values[i][m] belongs to t[i]. 25 significant digits.",
        "generator": "packages/quantum/tools/gen_boys_reference.py",
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "versions": {"mpmath": mp.__version__, "python": platform.python_version()},
        "precisionDigits": mp.mp.dps,
        "selfCheck": f"largest relative difference between incomplete-gamma and quadrature values: {mp.nstr(worst_check, 3)}",
        "maxOrder": MAX_ORDER,
        "t": ts,
        "values": values,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as handle:
        json.dump(fixture, handle, indent=0)
        handle.write("\n")
    print(f"Wrote {OUT_PATH}: {len(ts)} arguments x {MAX_ORDER + 1} orders (mpmath {mp.__version__}); self-check {mp.nstr(worst_check, 3)}")


if __name__ == "__main__":
    main()
