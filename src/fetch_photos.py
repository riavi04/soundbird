#!/usr/bin/env python3
"""Fetch one photograph per species from Wikipedia/Wikimedia Commons.

Takes the lead image of the species article, checks that its license actually
permits reuse, then crops and compresses it small enough to inline into the
page. Credits are kept alongside so each card can attribute its photographer.
"""
import html, io, json, os, re, sys, time, urllib.parse, urllib.request
from PIL import Image

WIKI = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
UA = "sound-bird-hobby-project/0.1 (personal gift project; contact ria@prism-global.com)"

OUT_W, OUT_H = 480, 300
QUALITY = 66

# Anything that does not permit reuse is skipped rather than shown. GFDL is a
# free license but obliges you to ship its full text with the work, which is
# not practical on a single page, so those are passed over too.
BAD_LIC = re.compile(r"fair use|non-free|copyright|gfdl|gnu", re.I)
GOOD_LIC = re.compile(r"^(cc[ -]|public domain|cc0)", re.I)


def api(base, params):
    params.update({"format": "json", "formatversion": "2"})
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def strip_html(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    return html.unescape(s).strip()


def lead_image(title):
    """Return the File: title of the article's lead image."""
    try:
        d = api(WIKI, {"action": "query", "titles": title, "prop": "pageimages",
                       "piprop": "name", "redirects": "1"})
    except Exception as e:
        print(f"   ! wiki lookup failed: {e}", file=sys.stderr)
        return None
    pages = d.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None
    name = pages[0].get("pageimage")
    return "File:" + name if name else None


def commons_info(file_title):
    try:
        d = api(COMMONS, {"action": "query", "titles": file_title, "prop": "imageinfo",
                          "iiprop": "url|extmetadata|mime", "iiurlwidth": str(OUT_W * 2)})
    except Exception as e:
        print(f"   ! commons lookup failed: {e}", file=sys.stderr)
        return None
    pages = d.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None
    ii = (pages[0].get("imageinfo") or [{}])[0]
    if not ii:
        return None
    em = ii.get("extmetadata", {})
    g = lambda k: (em.get(k) or {}).get("value", "")
    return {
        "url": ii.get("thumburl") or ii.get("url"),
        "mime": ii.get("mime", ""),
        "descpage": ii.get("descriptionurl"),
        "artist": strip_html(g("Artist")) or "unknown",
        "license": strip_html(g("LicenseShortName")) or "unknown",
        "license_url": g("LicenseUrl"),
    }


def search_commons(term, limit=8):
    """Fallback when the article's lead image is not usable: look for another
    photograph of the species on Commons and take the first freely licensed one."""
    try:
        d = api(COMMONS, {"action": "query", "list": "search",
                          "srsearch": f"{term} filetype:bitmap", "srnamespace": "6",
                          "srlimit": str(limit)})
    except Exception:
        return None
    for r in d.get("query", {}).get("search", []):
        title = r["title"]
        if re.search(r"map|range|distribution|diagram|egg|skull|specimen|stamp",
                     title, re.I):
            continue
        info = commons_info(title)
        if not info or not info.get("url"):
            continue
        if not info["mime"].startswith("image"):
            continue
        if BAD_LIC.search(info["license"]) or not GOOD_LIC.match(info["license"]):
            continue
        return info
    return None


def process(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
    im = Image.open(io.BytesIO(raw))
    if im.mode in ("RGBA", "P", "LA"):
        im = im.convert("RGB")
    # Cover-crop to the card's aspect ratio, biased slightly above centre
    # because the bird is usually in the upper half of a wildlife photo.
    tw, th = OUT_W, OUT_H
    sw, sh = im.size
    scale = max(tw / sw, th / sh)
    nw, nh = round(sw * scale), round(sh * scale)
    im = im.resize((nw, nh), Image.LANCZOS)
    left = (nw - tw) // 2
    top = max(0, int((nh - th) * 0.40))
    im = im.crop((left, top, left + tw, top + th))
    im.save(dest, "WEBP", quality=QUALITY, method=6)
    return os.path.getsize(dest)


def main():
    gbif = json.load(open(sys.argv[1]))
    outdir = sys.argv[2]
    only = set(sys.argv[3:]) or None
    os.makedirs(outdir, exist_ok=True)
    ppath = os.path.join(outdir, "photos.json")
    photos = json.load(open(ppath)) if os.path.exists(ppath) else {}

    total = 0
    for key, sp in gbif.items():
        if only and key not in only:
            continue
        if key in photos and os.path.exists(os.path.join(outdir, photos[key]["file"])):
            total += photos[key].get("bytes", 0)
            continue
        sci, common = sp["scientific"], sp["common"]
        ft = lead_image(sci) or lead_image(common)
        info = commons_info(ft) if ft else None
        usable = (info and info.get("url") and info["mime"].startswith("image")
                  and not BAD_LIC.search(info["license"])
                  and GOOD_LIC.match(info["license"]))
        if not usable:
            why = info["license"] if info else "no lead image"
            print(f"   {key}: lead image unusable ({why}), searching Commons",
                  file=sys.stderr)
            info = search_commons(sci) or search_commons(common)
        if not info or not info.get("url"):
            print(f"!! {key}: no freely licensed photo found", file=sys.stderr)
            continue
        dest = os.path.join(outdir, f"{key}.webp")
        try:
            size = process(info["url"], dest)
        except Exception as e:
            print(f"!! {key}: image processing failed: {e}", file=sys.stderr)
            continue
        photos[key] = {
            "file": os.path.basename(dest), "bytes": size,
            "photographer": info["artist"][:120],
            "license": info["license"],
            "license_url": info["license_url"],
            "source": info["descpage"],
        }
        total += size
        print(f"OK {key}: {size // 1024} KB  {info['license']}  {info['artist'][:44]}",
              file=sys.stderr)
        json.dump(photos, open(ppath, "w"), indent=1)
        time.sleep(0.25)

    json.dump(photos, open(ppath, "w"), indent=1)
    print(f"\n{len(photos)} photos, {total / 1024:.0f} KB total", file=sys.stderr)


if __name__ == "__main__":
    main()
