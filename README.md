# sound_bird_

A bird sound remix machine. Generates upbeat tracks from real wild bird
recordings, or lets you build your own patterns by hand. Everything runs in the
browser with no backend and no network access at runtime.

Built as a gift for Ben.

## Layout

```
src/
  harvest_gbif.py   find remix-legal recordings via the GBIF open API
  make_clips.py     download, score and cut the best phrase from each recording
  qa.py             objective quality check on the cut clips
  fetch_photos.py   one freely licensed photo per species from Wikimedia
  check_ids.py      static check that js and markup agree on element ids
  build.py          inline everything into one self-contained HTML file
  engine.js         Web Audio graph, synth voices, bird playback
  generate.js       song generation and the shared event model
  player.js         scheduling, live playback, offline WAV rendering
  app.js            interface
  index.html        markup
  style.css         styling
  test_gen.js       headless checks on the song logic
assets/
  gbif.json         harvested candidate recordings
  raw/              cached source downloads (not needed to run)
  clips/            the cut clips plus manifest.json
dist/
  sound-bird.html   the finished single file
```

## Rebuilding

```sh
python3 src/harvest_gbif.py assets/gbif.json     # refresh candidates
python3 src/make_clips.py assets/gbif.json assets/clips
python3 src/fetch_photos.py assets/gbif.json assets/photos
python3 src/qa.py assets/clips                   # check for silence, rumble, cut-offs
node src/test_gen.js                             # check the song logic
python3 src/check_ids.py                         # check js and markup agree
python3 src/build.py dist/sound-bird.html
```

To add a bird, add a row to `SPECIES` in `harvest_gbif.py` with its scientific
name, a pack and a one-line blurb, then run the harvest and pass just that
bird's key to `make_clips.py` and `fetch_photos.py`. If its call is genuinely
low-pitched, add the key to `LOW_BIRDS` in `make_clips.py` first, or the
default high-pass will filter the call away.

`make_clips.py` caches downloads in `assets/raw/`, so re-runs are fast. Pass
bird keys as extra arguments to rebuild only those, for example:

```sh
python3 src/make_clips.py assets/gbif.json assets/clips loon kookaburra
```

## How clips get chosen

Clips are picked without anyone listening to them, so the picker uses signal
analysis. For each recording it finds contiguous phrases standing above that
recording's own noise floor, then ranks them by loudness above the floor, how
continuously filled the phrase is, and how much energy sits above the rumble
band. That last term is skipped for birds whose calls are genuinely low, like
the sage grouse and the bustard. A single loud click loses to a real call,
which a peak-only picker got wrong.

`qa.py` then flags anything that still looks like silence, rumble, or a call cut
off while still loud.

## Sound sources and licensing

All recordings come from [xeno-canto](https://xeno-canto.org), reached through
the [GBIF](https://www.gbif.org) open API, which mirrors the xeno-canto dataset
and needs no API key. Only licenses permitting derivative works are kept, so
anything marked NoDerivatives is filtered out.

Every clip in the current set is **CC BY-NC 4.0**, which means two conditions:
credit the recordist, and keep it non-commercial. Fine for a personal gift, not
fine for anything sold or running ads. Every clip credits its recordist and
links back to the original recording in the Aviary tab, which satisfies the
attribution requirement.

Photographs come from Wikimedia Commons, taking the lead image of each species
article. `fetch_photos.py` checks the license before using anything and falls
back to a Commons search when the lead image is not usable. GFDL images are
skipped: GFDL is a free license, but it obliges you to distribute its full text
alongside the work, which is not practical on a single page.

The photos are a **mix of CC BY, CC BY-SA and public domain**, and each card
names its photographer. Note that most are ShareAlike, and cropping counts as
making an adaptation. That is fine as it stands, but if this ever gets
published somewhere public, the ShareAlike terms travel with those images.

The page is set in **EB Garamond**, under the SIL Open Font License, inlined as
a data URI because the page's CSP blocks font CDNs and a linked webfont would
fail silently into a fallback. Only the Latin subset is embedded, which is
about 68 KB across the regular and italic faces. The OFL requires the license
to travel with the font, so the footer carries the notice.

## Notes

- The shoebill was requested but has no recordings on xeno-canto at all, and
  none under a free license anywhere else reachable. It is not in the set.
- The Australian bustard only had a single remix-legal recording, so it has
  fewer clips than the others.
