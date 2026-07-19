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

  // The random draw happens either way, so overriding the tempo does not
  // reshuffle the rest of the song: the same seed keeps its arrangement and
  // only the speed changes.
  const autoBpm = Math.round(rnd.f(m.bpm[1], m.bpm[0]));
  const bpm = opts.bpm ? Math.round(opts.bpm) : autoBpm;
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
  // Hats are the main source of clutter, so their density follows the mood
  // rather than being fixed. This is what drumDensity is for.
  const hatK = Math.max(2, Math.round((rnd.chance(0.5) ? 8 : 11) * m.drumDensity));
  const hatPat = euclid(hatK, 16, rnd.i(4));
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

  // Lanes are cast into roles rather than all improvising at once. The lead
  // states the hook on the strong beats, the answer replies between them, and
  // anything further back is quiet texture. Random euclidean patterns on every
  // lane produced no downbeat and therefore nothing to hear a pulse against.
  const LEAD_STEPS = [
    [0, 4, 8, 12], [0, 4, 7, 12], [0, 3, 8, 12],
    [0, 4, 8, 11, 14], [0, 6, 8, 12], [0, 4, 8],
  ];
  const ANSWER_STEPS = [
    [2, 6, 10, 14], [6, 14], [2, 10, 14], [4, 10, 12], [6, 10, 14],
  ];
  const ROLE_GAIN = { lead: 1.0, answer: 0.82, texture: 0.6 };

  // Every lane learns all three parts. Which part it plays is decided per
  // section, so the bird carrying the tune changes as the song goes on instead
  // of one species being the whole theme from start to finish.
  function hitsFor(steps, motif, fixed, melodic, role) {
    return steps.map((s, n) => ({
      step: s,
      semi: melodic ? motif[n % motif.length] : fixed,
      // Accent the downbeat so the bar has an audible edge.
      gain: ROLE_GAIN[role] * (s === 0 ? 1.0 : s % 4 === 0 ? 0.92 : 0.78),
    }));
  }

  const lanes = chosen.map((b, i) => {
    const motif = makeMotif(scale, m.pitchRange, 6);
    const fixed = rnd.pick(scale);
    // Rotated by whole eighths so texture still lands on the grid.
    const k = Math.max(1, Math.round((1 + rnd.i(3)) * m.birdDensity));
    const texPat = euclid(k, 16, rnd.i(4) * 2);
    const texSteps = [];
    for (let s = 0; s < 16; s++) if (texPat[s]) texSteps.push(s);

    return {
      id: `lane${i}`,
      bird: b.key,
      common: b.common,
      clip: rnd.i(b.clipCount),
      patterns: {
        lead: hitsFor(rnd.pick(LEAD_STEPS), motif, fixed, true, "lead"),
        answer: hitsFor(rnd.pick(ANSWER_STEPS), motif, fixed, rnd.chance(0.6), "answer"),
        texture: hitsFor(texSteps, motif, fixed, rnd.chance(0.25), "texture"),
      },
      pan: laneCount === 1 ? 0 : (i / (laneCount - 1)) * 1.1 - 0.55,
      muted: false,
      solo: false,
      gain: 1,
    };
  });

  // A shuffled running order for the lead, so each section is fronted by a
  // different bird and over a whole song most of the flock gets a turn.
  const leadOrder = lanes.map((_, i) => i);
  for (let i = leadOrder.length - 1; i > 0; i--) {
    const j = rnd.i(i + 1);
    const t = leadOrder[i]; leadOrder[i] = leadOrder[j]; leadOrder[j] = t;
  }

  const schedule = sections.map((sec, si) => {
    const roles = {};
    const n = lanes.length;
    const lead = leadOrder[si % n];
    roles[lanes[lead].id] = "lead";
    if (sec.intensity >= 0.5 && n > 1) {
      roles[lanes[leadOrder[(si + 1) % n]].id] = "answer";
    }
    const wantTexture = sec.intensity >= 0.9 ? 3 : sec.intensity >= 0.6 ? 2 : 0;
    let added = 0;
    for (let k = 2; k < n && added < wantTexture; k++) {
      const id = lanes[leadOrder[(si + k) % n]].id;
      if (roles[id]) continue;
      roles[id] = "texture";
      added++;
    }
    return roles;
  });

  return {
    seed, mood: moodKey, bpm, swing: m.swing, bars: totalBars,
    sections, scale, root, chords,
    kickPat, snarePat, hatPat, bassPat,
    arp: rnd.f(1) < m.arp,
    reverb: m.reverb, delay: m.delay,
    support: m.support, birdGain: m.birdGain, clipSteps: m.clipSteps,
    maxPerStep: m.maxPerStep,
    lanes, schedule,
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

  // Everything synthesised is scaled back by `support`: it is here to hold the
  // beat together underneath the birds, not to compete with them.
  const sup = song.support ?? 0.75;

  // Drums. The kick and snare are kept honest because they are what makes the
  // pulse audible; the busier hats are pulled further down.
  if (sec.name !== "intro" || I > 0.3) {
    if (song.kickPat[step] && I >= 0.4) {
      out.push({ type: "kick", gain: 0.95 * (0.6 + 0.4 * I) * sup });
    }
    if (song.snarePat[step] && I >= 0.55) out.push({ type: "snare", gain: 0.55 * I * sup });
    if (song.hatPat[step] && I >= 0.35 && (step % 2 === 0 || I > 0.75)) {
      out.push({ type: "hat", gain: (step % 4 === 0 ? 0.26 : 0.15) * I * sup,
                 open: step % 8 === 6 && I > 0.8 });
    }
  }
  if (isFill && step % 2 === 0) {
    out.push({ type: "snare", gain: (0.3 + 0.08 * (step - 12)) * sup });
  }

  // Bass
  if (song.bassPat[step] && I >= 0.5) {
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    out.push({ type: "bass", midi: chord[0] - 12, dur: 0.2, gain: 0.42 * I * sup });
  }

  // Pad, once every two bars
  if (step === 0 && bar % 2 === 0) {
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    out.push({ type: "pad", midis: chord.map((c) => c + 12),
               dur: (60 / song.bpm) * 8, gain: 0.075 * (0.5 + I) * sup });
  }

  // Arp sparkle, on the offbeat only and well back in the mix.
  if (song.arp && I >= 0.9 && step % 4 === 3) {
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    const note = chord[(step + bar) % chord.length] + 24;
    out.push({ type: "pluck", midi: note, gain: 0.055 * sup });
  }

  // Birds. Each lane plays whichever part this section assigned it.
  const roles = (song.schedule && song.schedule[secIdx]) || {};
  const birds = [];
  for (const lane of song.lanes) {
    const role = roles[lane.id];
    if (!role) continue;
    const hits = lane.patterns[role] || [];
    for (const h of hits) {
      if (h.step !== step) continue;
      // Thin out lanes in quiet sections instead of muting them outright.
      if (I < 0.6 && (h.step % 4 !== 0)) continue;
      birds.push({
        type: "bird", lane: lane.id, birdKey: lane.bird, clip: lane.clip,
        semitones: h.semi,
        gain: h.gain * (0.55 + 0.45 * I) * (song.birdGain ?? 1),
        pan: lane.pan,
      });
    }
  }
  // Hold the line on how many land together, keeping the loudest. Without this
  // the extra lanes fill every gap again and the pulse disappears.
  const cap = song.maxPerStep ?? 3;
  if (birds.length > cap) {
    birds.sort((a, b) => b.gain - a.gain);
    birds.length = cap;
  }
  for (const b of birds) out.push(b);

  return out;
}
