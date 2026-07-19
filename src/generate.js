/* Song generation: turns a seed + mood + bird pool into a deterministic song
   object. Nothing here touches the audio graph, so the same song can be played
   live, edited, or rendered offline. */

const SECTION_PLAN = [
  { name: "intro",  bars: 4, intensity: 0.35 },
  { name: "rise",   bars: 4, intensity: 0.6 },
  { name: "mainA",  bars: 8, intensity: 1.0 },
  { name: "break",  bars: 4, intensity: 0.4 },
  { name: "mainB",  bars: 8, intensity: 1.0 },
  { name: "outro",  bars: 4, intensity: 0.3 },
];

const KICK_PATS = [
  [1,0,0,0, 0,0,1,0, 0,0,1,0, 0,0,0,0],
  [1,0,0,1, 0,0,1,0, 0,0,1,0, 0,1,0,0],
  [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,1,0,0],
  [1,0,0,0, 0,0,1,0, 0,1,0,0, 1,0,0,0],
];
const SNARE_PATS = [
  [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
  [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,1,0],
  [0,0,0,0, 1,0,0,1, 0,0,0,0, 1,0,0,0],
];

const NAME_ADJ = ["Nocturnal","Electric","Velvet","Paper","Glass","Midnight","Hollow",
  "Gilded","Feral","Lunar","Tidal","Copper","Slow","Static","Pale","Wild"];
const NAME_NOUN = ["Continuum","Trap","Circuit","Interval","Machine","Signal","Ritual",
  "Procession","Lullaby","Protocol","Dispatch","Frequency","Hour","Assembly","Chorus",
  "Migration","Descent","Bloom","Telegram","Parade"];

function trackName(birdNames) {
  const b = rnd.pick(birdNames).split(" ").pop();
  const n = rnd.pick(NAME_NOUN);
  const roll = rnd.i(4);
  if (roll === 0) return `${b} ${n} No. ${1 + rnd.i(19)}`;
  if (roll === 1) return `${rnd.pick(NAME_ADJ)} ${b}`;
  if (roll === 2) return `${n} of the ${b}`;
  return `${b} ${n}`;
}

/* A short motif reused with variation is what makes a lane sound composed
   rather than sprayed. */
function makeMotif(scale, range, len) {
  const notes = [];
  let idx = rnd.i(scale.length);
  for (let i = 0; i < len; i++) {
    idx += rnd.i(3) - 1;
    idx = Math.max(0, Math.min(scale.length - 1, idx));
    let oct = 0;
    if (rnd.chance(0.3)) oct = rnd.chance(0.5) ? 12 : -12;
    let semi = scale[idx] + oct;
    semi = Math.max(range[0], Math.min(range[1], semi));
    notes.push(semi);
  }
  return notes;
}

function generateSong(seed, moodKey, birds, opts = {}) {
  const m = MOODS[moodKey] || MOODS.upbeat;
  seed = seed == null ? (Math.random() * 4294967295) >>> 0 : seed >>> 0;
  rnd.seed(seed);

  const bpm = Math.round(rnd.f(m.bpm[1], m.bpm[0]));
  const barDur = (60 / bpm) * 4;
  const target = opts.seconds || 60;
  let bars = Math.round(target / barDur / 4) * 4;
  bars = Math.max(20, Math.min(44, bars));

  // Fixed top and tail, remaining bars split between the two main sections.
  const fixed = 16;
  const mainTotal = Math.max(8, bars - fixed);
  const sections = [];
  let cursor = 0;
  for (const s of SECTION_PLAN) {
    let len = s.bars;
    if (s.name === "mainA") len = Math.ceil(mainTotal / 2);
    if (s.name === "mainB") len = Math.floor(mainTotal / 2);
    sections.push({ ...s, bars: len, startBar: cursor });
    cursor += len;
  }
  const totalBars = cursor;

  const scale = m.scale;
  const root = 48 + rnd.i(5);                  // low C..E, bass register
  const kickPat = rnd.pick(KICK_PATS);
  const snarePat = rnd.pick(SNARE_PATS);
  const hatPat = euclid(rnd.chance(0.5) ? 8 : 11, 16, rnd.i(4));
  const bassPat = euclid(4 + rnd.i(4), 16, rnd.i(3));

  // Chords are root/fifth/octave stacks: no thirds, so nothing ever clashes
  // with a pitched bird call landing on top of them.
  const degrees = [0, rnd.pick([5, 7]), rnd.pick([3, 5]), rnd.pick([7, 10, 2])];
  const chords = degrees.map((d) => [root + d, root + d + 7, root + d + 12]);

  // Lanes
  const pool = birds.slice();
  const laneCount = Math.max(2, Math.min(m.maxLanes, pool.length));
  const chosen = [];
  for (let i = 0; i < laneCount && pool.length; i++) {
    chosen.push(pool.splice(rnd.i(pool.length), 1)[0]);
  }

  const lanes = chosen.map((b, i) => {
    const melodic = i < 2 ? rnd.chance(0.75) : rnd.chance(0.35);
    const k = Math.max(1, Math.round((2 + rnd.i(5)) * m.birdDensity));
    const pattern = euclid(k, 16, rnd.i(8));
    const motif = makeMotif(scale, m.pitchRange, 8);
    const hits = [];
    let mi = 0;
    for (let s = 0; s < 16; s++) {
      if (!pattern[s]) continue;
      const semi = melodic ? motif[mi++ % motif.length]
                           : (rnd.chance(0.25) ? rnd.pick(scale) : motif[0]);
      hits.push({
        step: s,
        semi,
        gain: 0.55 + rnd.f(0.4),
      });
    }
    return {
      id: `lane${i}`,
      bird: b.key,
      common: b.common,
      clip: rnd.i(b.clipCount),
      melodic,
      hits,
      pan: laneCount === 1 ? 0 : (i / (laneCount - 1)) * 1.2 - 0.6,
      // Which sections this lane appears in, so the arrangement breathes.
      enter: i === 0 ? 0 : rnd.i(3),
      muted: false,
      solo: false,
      gain: 1,
    };
  });

  return {
    seed, mood: moodKey, bpm, swing: m.swing, bars: totalBars,
    sections, scale, root, chords,
    kickPat, snarePat, hatPat, bassPat,
    arp: rnd.f(1) < m.arp,
    reverb: m.reverb, delay: m.delay,
    lanes,
    name: trackName(chosen.map((c) => c.common)),
    seconds: totalBars * barDur,
  };
}

/* The sequencer's own event source: a flat looping grid, no arrangement. */
function patternEvents(song, absStep) {
  const len = song.patternBars * STEPS_PER_BAR;
  const step = ((absStep % len) + len) % len;
  const out = [];
  const d = song.drums;
  if (d.kick[step])  out.push({ type: "kick", gain: 0.95 });
  if (d.snare[step]) out.push({ type: "snare", gain: 0.6 });
  if (d.hat[step])   out.push({ type: "hat", gain: step % 4 === 0 ? 0.32 : 0.2, open: false });
  if (d.bass[step])  out.push({ type: "bass", midi: song.root, dur: 0.22, gain: 0.5 });
  for (const lane of song.lanes) {
    if (!lane.cells[step]) continue;
    out.push({
      type: "bird", lane: lane.id, birdKey: lane.bird, clip: lane.clip,
      semitones: lane.semi, gain: 0.9, pan: lane.pan,
    });
  }
  return out;
}

/* Playback and rendering both go through here, so the two modes stay in step. */
function eventsFor(song, absStep) {
  return song.kind === "pattern" ? patternEvents(song, absStep) : eventsForStep(song, absStep);
}

/* Intensity for a given bar, plus which section we are in. */
function sectionAt(song, bar) {
  for (const s of song.sections) {
    if (bar >= s.startBar && bar < s.startBar + s.bars) return s;
  }
  return song.sections[song.sections.length - 1];
}

/* The single source of truth for what happens on a step. Live playback and
   offline render both call this, which is why exports match what he heard. */
function eventsForStep(song, absStep) {
  const out = [];
  const bar = Math.floor(absStep / STEPS_PER_BAR);
  const step = absStep % STEPS_PER_BAR;
  const sec = sectionAt(song, bar);
  const I = sec.intensity;
  const secIdx = song.sections.indexOf(sec);
  const barInSec = bar - sec.startBar;
  const isFill = barInSec === sec.bars - 1 && step >= 12 && I >= 0.6;

  // Drums
  if (sec.name !== "intro" || I > 0.3) {
    if (song.kickPat[step] && I >= 0.4) out.push({ type: "kick", gain: 0.95 * (0.6 + 0.4 * I) });
    if (song.snarePat[step] && I >= 0.55) out.push({ type: "snare", gain: 0.6 * I });
    if (song.hatPat[step] && I >= 0.35) {
      out.push({ type: "hat", gain: (step % 4 === 0 ? 0.34 : 0.2) * I, open: step % 8 === 6 && I > 0.8 });
    }
  }
  if (isFill && step % 2 === 0) out.push({ type: "snare", gain: 0.35 + 0.1 * (step - 12) });

  // Bass
  if (song.bassPat[step] && I >= 0.5) {
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    out.push({ type: "bass", midi: chord[0] - 12, dur: 0.2, gain: 0.5 * I });
  }

  // Pad, once every two bars
  if (step === 0 && bar % 2 === 0) {
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    out.push({ type: "pad", midis: chord.map((c) => c + 12), dur: (60 / song.bpm) * 8, gain: 0.1 * (0.5 + I) });
  }

  // Arp sparkle in the busy sections
  if (song.arp && I >= 0.9 && step % 2 === 1) {
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    const note = chord[(step + bar) % chord.length] + 24;
    out.push({ type: "pluck", midi: note, gain: 0.09 });
  }

  // Birds
  song.lanes.forEach((lane, li) => {
    if (secIdx < lane.enter) return;
    if (I < 0.4 && li > 1) return;
    for (const h of lane.hits) {
      if (h.step !== step) continue;
      // Thin out lanes in quiet sections instead of muting them outright.
      if (I < 0.6 && (h.step % 4 !== 0)) continue;
      out.push({
        type: "bird", lane: lane.id, birdKey: lane.bird, clip: lane.clip,
        semitones: h.semi, gain: h.gain * (0.55 + 0.45 * I), pan: lane.pan,
      });
    }
  });

  return out;
}
