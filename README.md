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
python3 src/qa.py assets/clips                   # check for silence, rumble, cut-offs
node src/test_gen.js                             # check the song logic
python3 src/build.py dist/sound-bird.html
```

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
and needs no API key. Only licences permitting derivative works are kept, so
anything marked NoDerivatives is filtered out.

Every clip in the current set is **CC BY-NC 4.0**, which means two conditions:
credit the recordist, and keep it non-commercial. Fine for a personal gift, not
fine for anything sold or running ads. Every clip credits its recordist and
links back to the original recording in the Aviary tab, which satisfies the
attribution requirement.

## Notes

- The shoebill was requested but has no recordings on xeno-canto at all, and
  none under a free licence anywhere else reachable. It is not in the set.
- The Australian bustard only had a single remix-legal recording, so it has
  fewer clips than the others.
