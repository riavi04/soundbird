#!/usr/bin/env python3
"""Harvest xeno-canto bird sound candidates via the GBIF open API.

Only keeps licenses that permit remixing (excludes ND / NoDerivatives).
"""
import json, re, sys, time, urllib.parse, urllib.request

GBIF = "https://api.gbif.org/v1/occurrence/search"
XC_DATASET = "b1047888-ae52-4179-9dd5-5448ea342a24"
UA = "sound-bird-hobby-project/0.1 (personal gift project)"

# (key, common name, scientific name, pack, blurb)
SPECIES = [
    ("thicknee",   "Peruvian Thick-knee",  "Burhinus superciliaris", "weird",
     "A wide-eyed desert wader that runs rather than flies and shrieks in rattling bursts at dusk."),
    ("potoo",      "Great Potoo",          "Nyctibius grandis", "weird",
     "Sits frozen on a branch pretending to be a stump all day, then screams into the dark all night."),
    ("loon",       "Common Loon",          "Gavia immer", "classic",
     "The wavering yodel of a northern lake. Each male's yodel is unique to him, like a signature."),
    ("shoebill",   "Shoebill",             "Balaeniceps rex", "weird",
     "A five-foot prehistoric-looking stork that machine-guns its enormous bill like a woodblock."),
    ("piha",       "Screaming Piha",       "Lipaugus vociferans", "tropical",
     "A drab grey bird with one of the loudest calls in the Amazon: a rising whistle then a whip-crack."),
    ("ptarmigan",  "Willow Ptarmigan",     "Lagopus lagopus", "weird",
     "The 'awebo' bird. Males defend territory by yelling what sounds uncannily like Mexican slang."),
    ("quail",      "Common Quail",         "Coturnix coturnix", "classic",
     "Rarely seen, constantly heard. A liquid three-note 'wet-my-lips' from deep in the grass."),
    ("woodcock",   "American Woodcock",    "Scolopax minor", "weird",
     "Delivers a nasal 'peent' from the ground, then spirals into the sky on twittering wings."),
    ("kiwi",       "North Island Brown Kiwi", "Apteryx mantelli", "weird",
     "Flightless, nocturnal, nostrils on the bill tip. The male's call is a hoarse ascending whistle."),
    ("sagegrouse", "Greater Sage-Grouse",  "Centrocercus urophasianus", "weird",
     "Inflates two yellow air sacs and pops them. Sounds less like a bird than a dripping tap in a cave."),
    ("bellbird",   "White Bellbird",       "Procnias albus", "tropical",
     "The loudest bird ever measured, at 125 decibels. Sings directly at females from inches away."),
    ("penguin",    "King Penguin",         "Aptenodytes patagonicus", "weird",
     "Two-voiced trumpeting braying. Chicks find parents in a colony of thousands by voice alone."),
    ("starling",   "European Starling",    "Sturnus vulgaris", "classic",
     "A relentless mimic. Wild ones copy car alarms, phones and other birds into rambling medleys."),
    ("lyrebird",   "Superb Lyrebird",      "Menura novaehollandiae", "weird",
     "The greatest mimic alive. Copies other birds, and in some cases chainsaws and camera shutters."),
    ("kookaburra", "Laughing Kookaburra",  "Dacelo novaeguineae", "classic",
     "A giant kingfisher whose family chorus of maniacal laughter stakes out the territory at dawn."),
    ("crane",      "Siberian Crane",       "Leucogeranus leucogeranus", "classic",
     "Critically endangered. Pairs perform a synchronised duet, flute-like and carrying for miles."),
    ("bustard",    "Australian Bustard",   "Ardeotis australis", "weird",
     "Struts with an inflated throat sac hanging to its feet, producing a deep far-carrying roar."),
    ("turkey",     "Wild Turkey",          "Meleagris gallopavo", "classic",
     "The gobble carries a mile. Turkeys can also be startled into gobbling by thunder or car horns."),
]

BAD_LICENSE = re.compile(r"\bnd\b|noderiv", re.I)


def fetch(params):
    url = GBIF + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def license_ok(lic):
    if not lic:
        return False
    tail = lic.rsplit("/licenses/", 1)[-1]
    if BAD_LICENSE.search(tail):
        return False
    return "creativecommons" in lic or "publicdomain" in lic


def pretty_license(lic):
    m = re.search(r"/licenses/([a-z\-]+)/([\d.]+)", lic or "")
    if m:
        return "CC " + m.group(1).upper().replace("-", "-") + " " + m.group(2)
    if "publicdomain" in (lic or ""):
        return "Public Domain"
    return lic or "unknown"


def harvest(sci, want=25):
    out, offset = [], 0
    while len(out) < want and offset < 300:
        try:
            d = fetch({"datasetKey": XC_DATASET, "mediaType": "Sound",
                       "scientificName": sci, "limit": 100, "offset": offset})
        except Exception as e:
            print(f"   ! {e}", file=sys.stderr)
            break
        results = d.get("results", [])
        if not results:
            break
        for r in results:
            lic = r.get("license", "")
            if not license_ok(lic):
                continue
            snd = next((m for m in r.get("media", [])
                        if m.get("type") == "Sound" and m.get("identifier")), None)
            if not snd:
                continue
            ident = snd["identifier"]
            # catalogNumber carries the XC number directly. Parsing it out of
            # the media filename only works for uploads that follow the modern
            # naming convention, and the older ones do not.
            xcid = None
            cat = (r.get("catalogNumber") or "").strip()
            m = re.fullmatch(r"XC(\d+)", cat)
            if m:
                xcid = m.group(1)
            else:
                m = re.search(r"XC(\d+)", ident)
                if m:
                    xcid = m.group(1)
            out.append({
                "url": ident,
                "xc_id": xcid,
                "xc_page": f"https://xeno-canto.org/{xcid}" if xcid else None,
                "license": pretty_license(lic),
                "license_url": lic,
                "recordist": r.get("rightsHolder") or r.get("recordedBy") or "unknown",
                "country": r.get("country"),
                "locality": r.get("locality"),
                "behavior": r.get("behavior"),
            })
            if len(out) >= want:
                break
        if d.get("endOfRecords"):
            break
        offset += 100
    return out


def main():
    data = {}
    for key, common, sci, pack, blurb in SPECIES:
        cands = harvest(sci)
        data[key] = {"common": common, "scientific": sci, "pack": pack,
                     "blurb": blurb, "candidates": cands}
        print(f"{len(cands):3d}  {common}", file=sys.stderr)
        time.sleep(0.2)
    json.dump(data, open(sys.argv[1], "w"), indent=1)
    print(f"wrote {sys.argv[1]}", file=sys.stderr)


if __name__ == "__main__":
    main()
