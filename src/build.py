#!/usr/bin/env python3
"""Inline everything into one self-contained HTML file.

Audio is embedded as base64 so the page works from a file, a private link, or
anywhere with no network and no server.
"""
import base64, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
CLIPS = os.path.join(ROOT, "assets", "clips")
PHOTOS = os.path.join(ROOT, "assets", "photos")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "sound-bird.html")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    manifest = json.load(open(os.path.join(CLIPS, "manifest.json")))

    audio, total = {}, 0
    for key, sp in manifest.items():
        keep = []
        for c in sp["clips"]:
            p = os.path.join(CLIPS, c["file"])
            if not os.path.exists(p):
                print(f"  missing {c['file']}, skipping", file=sys.stderr)
                continue
            raw = open(p, "rb").read()
            total += len(raw)
            audio[c["file"]] = base64.b64encode(raw).decode("ascii")
            keep.append(c)
        sp["clips"] = keep
    manifest = {k: v for k, v in manifest.items() if v["clips"]}

    # Photographs, inlined the same way. Only species that actually have audio
    # get one, since the rest never appear on a card.
    photos, photo_bytes = {}, 0
    ppath = os.path.join(PHOTOS, "photos.json")
    if os.path.exists(ppath):
        for key, p in json.load(open(ppath)).items():
            if key not in manifest:
                continue
            fp = os.path.join(PHOTOS, p["file"])
            if not os.path.exists(fp):
                continue
            raw = open(fp, "rb").read()
            photo_bytes += len(raw)
            photos[key] = {
                "data": "data:image/webp;base64," + base64.b64encode(raw).decode("ascii"),
                "photographer": p.get("photographer", "unknown"),
                "license": p.get("license", ""),
                "source": p.get("source", ""),
            }

    parts = [
        "<title>sound_bird_</title>",
        "<style>\n" + read(os.path.join(SRC, "style.css")) + "\n</style>",
        read(os.path.join(SRC, "index.html")),
        "<script>window.BIRD_DATA=" + json.dumps(manifest, separators=(",", ":")) + ";</script>",
        "<script>window.BIRD_AUDIO=" + json.dumps(audio, separators=(",", ":")) + ";</script>",
        "<script>window.BIRD_PHOTOS=" + json.dumps(photos, separators=(",", ":")) + ";</script>",
    ]
    for js in ("engine.js", "generate.js", "player.js", "app.js"):
        parts.append("<script>\n" + read(os.path.join(SRC, js)) + "\n</script>")

    body = "\n".join(parts)

    # The Artifact host supplies doctype, head and body, so that build is the
    # bare fragment. The standalone build is a complete page for file:// use.
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(body)

    standalone = os.path.join(os.path.dirname(out_path), "standalone.html")
    with open(standalone, "w", encoding="utf-8") as f:
        f.write('<!doctype html>\n<html lang="en">\n<head>\n'
                '<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
                '</head>\n<body>\n' + body + '\n</body>\n</html>\n')

    print(f"birds:  {len(manifest)}")
    print(f"clips:  {len(audio)}  ({total/1024:.0f} KB raw)")
    print(f"photos: {len(photos)}  ({photo_bytes/1024:.0f} KB raw)")
    print(f"artifact:   {out_path}  ({os.path.getsize(out_path)/1024/1024:.2f} MB)")
    print(f"standalone: {standalone}  ({os.path.getsize(standalone)/1024/1024:.2f} MB)")


if __name__ == "__main__":
    main()
