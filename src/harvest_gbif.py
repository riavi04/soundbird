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
     "A drab gray bird with one of the loudest calls in the Amazon: a rising whistle then a whip-crack."),
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
     "Critically endangered. Pairs perform a synchronized duet, flute-like and carrying for miles."),
    ("bustard",    "Australian Bustard",   "Ardeotis australis", "weird",
     "Struts with an inflated throat sac hanging to its feet, producing a deep far-carrying roar."),
    ("turkey",     "Wild Turkey",          "Meleagris gallopavo", "classic",
     "The gobble carries a mile. Turkeys can also be startled into gobbling by thunder or car horns."),

    ("hoatzin",    "Hoatzin",              "Opisthocomus hoazin", "weird",
     "Ferments leaves in a chamber in its gut, smells strongly of manure, and grunts and hisses about it."),
    ("capuchinbird", "Capuchinbird",       "Perissocephalus tricolor", "tropical",
     "A bald orange head on a heavy brown body, droning like a distant chainsaw idling in the canopy."),
    ("frogmouth",  "Tawny Frogmouth",      "Podargus strigoides", "weird",
     "Not an owl. Spends the day impersonating a broken branch, then calls with a soft repeated oom."),
    ("kakapo",     "Kakapo",               "Strigops habroptila", "weird",
     "A flightless night parrot. Males dig a bowl in the earth and boom into it for hours to throw the sound."),
    ("cassowary",  "Southern Cassowary",   "Casuarius casuarius", "weird",
     "Its boom sits at the very bottom of human hearing, low enough that you feel it before you hear it."),
    ("emu",        "Emu",                  "Dromaius novaehollandiae", "weird",
     "Females drum. The sound comes from an inflatable pouch in the neck and carries over a mile."),
    ("bittern",    "Eurasian Bittern",     "Botaurus stellaris", "weird",
     "Hides in the reeds and booms like someone blowing across a bottle. Can be heard three miles off."),
    ("corncrake",  "Corncrake",            "Crex crex", "weird",
     "Two hard rasps repeated all night, like a comb dragged over a matchbox, from a bird you never see."),
    ("bowerbird",  "Satin Bowerbird",      "Ptilonorhynchus violaceus", "weird",
     "Builds an avenue of sticks, decorates it with blue objects, and mimics any machinery it has heard."),
    ("guineafowl", "Helmeted Guineafowl",  "Numida meleagris", "weird",
     "A bony casque on its head and a two-note alarm it keeps up as long as anything is out of place."),
    ("peafowl",    "Indian Peafowl",       "Pavo cristatus", "weird",
     "Behind the famous tail is a scream like somebody calling for help, delivered at dawn and repeated."),

    ("bellbird3",  "Three-wattled Bellbird", "Procnias tricarunculatus", "tropical",
     "Three worm-like wattles dangle from the beak. The call is a metallic bonk heard half a mile away."),
    ("bellbirdb",  "Bearded Bellbird",     "Procnias averano", "tropical",
     "Wears a curtain of black wattles under the chin and strikes a note like a hammer on an anvil."),
    ("musicianwren", "Musician Wren",      "Cyphorhinus arada", "tropical",
     "Sings in clean intervals that sound composed, and is often mistaken for a person whistling a tune."),
    ("superbstarling", "Superb Starling",  "Lamprotornis superbus", "tropical",
     "Iridescent blue over orange, with a long creaking chattering song delivered at considerable volume."),
    ("chachalaca", "Plain Chachalaca",     "Ortalis vetula", "tropical",
     "Groups shout their own name back and forth at dawn until the whole thicket has joined in."),

    ("nightingale", "Common Nightingale",  "Luscinia megarhynchos", "classic",
     "Sings through the night in whistles, trills and deep bubbling notes. The one the poets wrote about."),
    ("cuckoo",     "Common Cuckoo",        "Cuculus canorus", "classic",
     "Two notes that name the bird. It lays eggs in other birds' nests and lets them raise the chick."),
    ("mockingbird", "Northern Mockingbird", "Mimus polyglottos", "classic",
     "Copies everything and repeats each phrase a few times before moving on. Unmated males sing all night."),
    ("raven",      "Common Raven",         "Corvus corax", "classic",
     "Croaks, knocks and bell-like gurgles. Ravens keep different calls for different companions."),
    ("magpie",     "Australian Magpie",    "Gymnorhina tibicen", "classic",
     "Not really a magpie. Its dawn carolling is an organ-like warble and one of the great bird songs."),
    ("butcherbird", "Pied Butcherbird",    "Cracticus nigrogularis", "classic",
     "Pure flute-like phrases delivered slowly before dawn. Neighbors answer back with variations."),
    ("barredowl",  "Barred Owl",           "Strix varia", "classic",
     "The hoot is usually written down as who cooks for you, who cooks for you all."),
    ("barnowl",    "Barn Owl",             "Tyto alba", "classic",
     "Does not hoot. Delivers a long harsh shriek in flight, which is where a lot of haunted houses got it."),
    ("blackbird",  "Common Blackbird",     "Turdus merula", "classic",
     "A low fluting song from a rooftop at dusk, finished off with a scratchy little flourish."),
    ("sandhill",   "Sandhill Crane",       "Antigone canadensis", "classic",
     "A rolling bugle from a windpipe coiled inside the breastbone, carrying more than two miles."),
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
