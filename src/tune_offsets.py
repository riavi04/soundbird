#!/usr/bin/env python3
"""Estimate each clip's dominant pitch and record the shift needed to bring it
to a common reference.

Playing a melody across several species only works if they start from the same
perceived note. A kookaburra and a king penguin sit in quite different
registers, so without this the tune changes key every time the bird changes.
The offset is stored in the manifest as `tune_offset`, in semitones.
"""
import json, os, subprocess, sys
import numpy as np

SR = 22050
# Chosen to sit near the middle of the range these calls actually occupy, so
# the shifts stay small. Dragging a call more than about an octave makes it
# sludgy and unrecognisable, which defeats the point of using real birds.
TARGET_HZ = 1300.0
LO, HI = 150.0, 5000.0
CLAMP = 15             # semitones


def decode(path):
    p = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1",
                        "-ar", str(SR), "-f", "f32le", "-"], capture_output=True)
    return np.frombuffer(p.stdout, dtype=np.float32) if p.stdout else None


def dominant_hz(x):
    win, hop = 2048, 512
    if len(x) < win:
        return None
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    fr = x[idx].astype(np.float64) * np.hanning(win)
    rms = np.sqrt((fr ** 2).mean(axis=1) + 1e-12)
    # Only the loudest part of the clip carries the pitch worth matching.
    keep = rms >= np.percentile(rms, 60)
    if keep.sum() == 0:
        keep = np.ones(len(rms), bool)
    spec = np.abs(np.fft.rfft(fr[keep], axis=1)).mean(axis=0)
    freqs = np.fft.rfftfreq(win, 1 / SR)
    band = (freqs >= LO) & (freqs <= HI)
    if not band.any():
        return None
    sub = spec[band]
    f = freqs[band]
    # Parabolic interpolation around the peak bin for a finer estimate.
    k = int(np.argmax(sub))
    if 0 < k < len(sub) - 1:
        a, b, c = sub[k - 1], sub[k], sub[k + 1]
        denom = a - 2 * b + c
        delta = 0.5 * (a - c) / denom if denom != 0 else 0.0
        return float(f[k] + delta * (f[1] - f[0]))
    return float(f[k])


def main():
    d = sys.argv[1]
    mpath = os.path.join(d, "manifest.json")
    man = json.load(open(mpath))
    for key, sp in man.items():
        for c in sp["clips"]:
            p = os.path.join(d, c["file"])
            x = decode(p)
            hz = dominant_hz(x) if x is not None else None
            if not hz or hz <= 0:
                c["tune_offset"] = 0.0
                c["dominant_hz"] = None
                continue
            semis = 12.0 * np.log2(TARGET_HZ / hz)
            c["tune_offset"] = round(float(np.clip(semis, -CLAMP, CLAMP)), 2)
            c["dominant_hz"] = round(hz, 1)
        offs = [c["tune_offset"] for c in sp["clips"]]
        hzs = [c["dominant_hz"] for c in sp["clips"]]
        print(f"{key:16s} dominant {hzs}  offset {offs}", file=sys.stderr)
    json.dump(man, open(mpath, "w"), indent=1)
    print(f"\nwrote {mpath}", file=sys.stderr)


if __name__ == "__main__":
    main()
