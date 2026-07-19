#!/usr/bin/env python3
"""Download candidate recordings, score them, and cut the best phrase from each.

Clips are chosen without listening, so selection is by signal analysis. The
picker finds contiguous phrases (regions standing above the recording's own
noise floor) and ranks them by loudness, how continuously filled they are, and
how much sits above the rumble band. A single loud click therefore loses to a
real call, which a peak-only picker got wrong.
"""
import hashlib, json, os, subprocess, sys, time, urllib.request
import numpy as np

UA = "sound-bird-hobby-project/0.1 (personal gift project)"
SR = 22050
OUT_SR = 44100
CACHE = "assets/raw"

DEFAULT_MAX = 2.5
MAX_DUR = {           # birds whose calls are genuinely long
    "loon": 3.6, "kookaburra": 4.5, "kiwi": 3.2, "penguin": 3.2,
    "crane": 3.0, "lyrebird": 3.0, "starling": 2.6, "turkey": 2.6,
    "nightingale": 3.2, "magpie": 3.4, "butcherbird": 3.2, "mockingbird": 3.0,
    "musicianwren": 3.0, "kakapo": 3.2, "cassowary": 3.2, "emu": 3.0,
    "bittern": 3.0, "bowerbird": 3.0, "superbstarling": 3.0, "raven": 2.8,
    "hoatzin": 3.0, "sandhill": 3.0, "chachalaca": 3.0, "peafowl": 3.0,
}
MIN_DUR = 0.42
# Calls that really do live in the low band, so the rumble penalty is skipped
# and the high-pass is set well below the call. A cassowary boom sits around
# 25 Hz and the default 170 Hz filter would erase it completely.
LOW_BIRDS = {"sagegrouse", "bustard", "penguin", "kiwi", "crane", "turkey", "shoebill",
             "cassowary", "emu", "bittern", "kakapo", "frogmouth", "hoatzin", "sandhill"}


def run(cmd):
    return subprocess.run(cmd, capture_output=True)


# Some uploads are hour-long soundscapes running to hundreds of megabytes.
# They are no more useful than a short recording here and cost a great deal to
# fetch, so they are skipped rather than downloaded.
MAX_BYTES = 40 * 1024 * 1024


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 2000:
        return
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        declared = r.headers.get("Content-Length")
        if declared and int(declared) > MAX_BYTES:
            raise ValueError(f"too large ({int(declared) // 1024 // 1024} MB)")
        got = 0
        with open(path, "wb") as f:
            while True:
                chunk = r.read(262144)
                if not chunk:
                    break
                got += len(chunk)
                if got > MAX_BYTES:      # servers that omit Content-Length
                    f.close()
                    os.remove(path)
                    raise ValueError("exceeded size cap mid-download")
                f.write(chunk)
    time.sleep(0.4)          # stay well under any sane rate limit


def decode(path, sr=SR):
    p = run(["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"])
    if p.returncode != 0 or not p.stdout:
        return None
    return np.frombuffer(p.stdout, dtype=np.float32)


def frames(x, win=1024, hop=256):
    if len(x) < win:
        return None, None, hop
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    fr = x[idx].astype(np.float64)
    return fr, np.sqrt((fr ** 2).mean(axis=1) + 1e-12), hop


def best_phrase(x, max_dur, low_ok):
    """Return (score, start_sample, end_sample) for the best phrase in x."""
    fr, rms, hop = frames(x)
    if rms is None or len(rms) < 8:
        return -1, 0, 0

    # Floor from the quiet tenth, not the median: in a tightly edited recording
    # the bird fills most of the file, so the median IS the call and a
    # median-based floor makes the best recordings look flat.
    floor = float(np.percentile(rms, 10))
    peak = float(rms.max())
    if peak <= 1e-6:
        return -1, 0, 0
    # Recordings containing true digital silence give a floor near zero, which
    # makes the "stands above the floor" term explode and swamp every other
    # term, letting a near-empty window win. Keep the floor meaningful.
    floor = max(floor, peak * 0.004)

    k = max(3, int(0.05 * SR / hop))
    sm = np.convolve(rms, np.ones(k) / k, mode="same")
    thr = max(floor * 2.5, peak * 0.15)

    # Contiguous regions above threshold. The merge gap is wide enough to hold
    # the separate syllables of one call together as a single phrase.
    above = sm > thr
    gap = int(0.15 * SR / hop)
    regions, i, n = [], 0, len(above)
    while i < n:
        if not above[i]:
            i += 1
            continue
        j = i
        run_end = i
        while j < n:
            if above[j]:
                run_end = j
                j += 1
            elif j - run_end <= gap:
                j += 1
            else:
                break
        regions.append((i, run_end))
        i = j
    if not regions:
        # Nothing crosses the threshold, which happens when the whole file is
        # roughly one continuous call. Treat it all as a single phrase.
        regions = [(0, len(sm) - 1)]

    # Spectral share above the rumble band, computed once for the whole file.
    spec = np.abs(np.fft.rfft(fr * np.hanning(fr.shape[1]), axis=1))
    freqs = np.fft.rfftfreq(fr.shape[1], 1 / SR)
    lowband = freqs < 300
    tot = spec.sum(axis=1) + 1e-9
    lowfrac = spec[:, lowband].sum(axis=1) / tot

    max_frames = int(max_dur * SR / hop)
    best = (-1, 0, 0)
    for (a, b) in regions:
        if b - a < 2:
            continue
        # Long phrases get trimmed to the loudest window of allowed length.
        if b - a > max_frames:
            csum = np.cumsum(np.concatenate([[0.0], sm[a:b + 1]]))
            widths = max_frames
            best_off, best_e = 0, -1
            for off in range(0, (b - a) - widths + 1, max(1, widths // 8)):
                e = csum[off + widths] - csum[off]
                if e > best_e:
                    best_e, best_off = e, off
            a2, b2 = a + best_off, a + best_off + widths
        else:
            a2, b2 = a, b

        # A short syllable is still a usable one-shot, so pad it out to the
        # minimum length instead of discarding it. The quiet padding lowers the
        # filled score on its own, so isolated blips still rank below real calls.
        min_frames = int(MIN_DUR * SR / hop)
        if b2 - a2 < min_frames:
            mid = (a2 + b2) // 2
            b2 = min(len(sm) - 1, mid + min_frames // 2)
            a2 = max(0, b2 - min_frames)

        seg = sm[a2:b2 + 1]
        if seg.size < 2:
            continue
        dur = (b2 - a2) * hop / SR
        # Capped so that past a healthy margin above the floor, extra contrast
        # stops buying anything and how full the window is decides the winner.
        loud = min(float(seg.mean() / (floor + 1e-9)), 25.0)
        filled = float((seg > seg.max() * 0.18).mean())     # continuously sounding
        lf = float(lowfrac[a2:b2 + 1].mean())
        tone = 1.0 if low_ok else float(np.clip(1.3 - lf * 1.6, 0.15, 1.0))
        length_bonus = float(np.clip(dur / 0.8, 0.5, 1.2))
        # Fill is raised to a power so it dominates: a window that is loud but
        # mostly empty loses decisively to a slightly quieter one that is full
        # of call. A flat "0.35 + filled" term let near-silent windows win.
        score = loud * (filled ** 1.6) * tone * length_bonus
        if score > best[0]:
            best = (score, a2 * hop, min(len(x), b2 * hop + 1024))

    if best[0] < 0:
        return -1, 0, 0
    s, e = best[1], best[2]
    if (e - s) / SR < MIN_DUR:
        e = min(len(x), s + int(MIN_DUR * SR))
    return best[0], int(s), int(e)


def cut(src, dst, start_s, dur_s, low=False):
    hp = "22" if low else "170"
    af = (f"highpass=f={hp},afade=t=in:st=0:d=0.015,"
          f"afade=t=out:st={max(0.02, dur_s - 0.05):.3f}:d=0.05,"
          f"loudnorm=I=-15:TP=-1.5:LRA=11")
    p = run(["ffmpeg", "-v", "quiet", "-y", "-ss", f"{start_s:.3f}", "-t", f"{dur_s:.3f}",
             "-i", src, "-af", af, "-ac", "1", "-ar", str(OUT_SR),
             "-codec:a", "libmp3lame", "-b:a", "96k", dst])
    return p.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 500


def main():
    data = json.load(open(sys.argv[1]))
    outdir = sys.argv[2]
    only = set(sys.argv[3:]) or None
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    mpath = os.path.join(outdir, "manifest.json")
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}

    for key, sp in data.items():
        if only and key not in only:
            continue
        seen, cands = set(), []
        for c in sp.get("candidates", []):
            if c["url"] in seen:
                continue
            seen.add(c["url"])
            cands.append(c)
        # Enough variety to pick a good phrase without pulling a lot of data
        # from a volunteer-run archive.
        cands = cands[:6]
        if not cands:
            print(f"!! {key}: no candidates", file=sys.stderr)
            continue

        low_ok = key in LOW_BIRDS
        max_dur = MAX_DUR.get(key, DEFAULT_MAX)
        scored = []
        for i, c in enumerate(cands):
            # Keyed by the URL, not the position in the candidate list: if a
            # re-harvest reorders candidates, position-keyed files would map to
            # the wrong recording and the credits would be wrong.
            tag = hashlib.sha1(c["url"].encode()).hexdigest()[:10]
            raw = os.path.join(CACHE, f"{key}_{tag}.mp3")
            try:
                download(c["url"], raw)
            except Exception as e:
                print(f"   dl fail {key}_{i}: {e}", file=sys.stderr)
                continue
            x = decode(raw)
            if x is None or len(x) < SR // 2:
                continue
            penalty = 1.0 if len(x) / SR < 90 else 0.7
            score, s, e = best_phrase(x, max_dur, low_ok)
            if score <= 0:
                continue
            scored.append((score * penalty, s, e, raw, c))

        if not scored:
            print(f"!! {key}: nothing usable", file=sys.stderr)
            continue
        scored.sort(key=lambda t: -t[0])

        clips, used_src = [], set()
        for score, s, e, raw, c in scored:
            if len(clips) >= 3:
                break
            if raw in used_src:
                continue
            used_src.add(raw)
            dst = os.path.join(outdir, f"{key}_{len(clips)}.mp3")
            dur = (e - s) / SR
            if not cut(raw, dst, s / SR, dur, low=low_ok):
                continue
            clips.append({
                "file": os.path.basename(dst), "duration": round(dur, 3),
                "score": round(float(score), 2), "xc_id": c.get("xc_id"),
                "source": c.get("xc_page") or c.get("url"),
                "recordist": c.get("recordist"), "license": c.get("license"),
                "license_url": c.get("license_url"), "country": c.get("country"),
            })
        if clips:
            manifest[key] = {"common": sp["common"], "scientific": sp["scientific"],
                             "pack": sp["pack"], "blurb": sp["blurb"], "clips": clips}
            summary = ", ".join("{}s".format(c["duration"]) for c in clips)
            print(f"OK {key}: {len(clips)} clips [{summary}]", file=sys.stderr)
            # Written per species: an interrupted run must not leave new mp3
            # files sitting next to stale metadata from a previous run.
            json.dump(manifest, open(mpath, "w"), indent=1)
    json.dump(manifest, open(mpath, "w"), indent=1)
    print(f"wrote {mpath} ({len(manifest)} birds)", file=sys.stderr)


if __name__ == "__main__":
    main()
